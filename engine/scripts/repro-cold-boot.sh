#!/usr/bin/env bash
# Cold-boot repro loop for the PACKAGED editor (#21).
#
# #21: the first boot after an install/upgrade can crash the renderer with
# "<module> does not provide an export named …". Rare (1-in-6 on a real Windows install),
# never seen on a WARM relaunch, and mitigated but not root-caused — EditorBootBoundary
# does one capped reload on that signature instead of painting the red error screen.
#
# WHAT MAKES A BOOT "COLD": Vite's dep-optimize cache lives at <userData>/vite-cache
# (see the MODOKI_VITE_CACHEDIR block in engine/electron/main.ts), so a FRESH
# --user-data-dir has no pre-bundle and esbuild must run its full scan. That reproduces
# the install-time condition without wiping the shared `Modoki Editor` profile a human
# actually uses — which clean-packaged-cache.mjs would destroy (recents, layouts, prefs).
# Do NOT "simplify" this to a cache wipe of the real profile.
#
# WHY IT LIVES HERE, AND WHO SHOULD RUN IT: 30 iterations on macOS (2026-08-03, v0.3.6)
# came back 30/30 clean — at the observed Windows rate that has p≈0.4%, so the rate is
# materially lower on macOS and this loop is unlikely to pay off here. It is kept for the
# **Windows clone**, where the bug was actually seen and where the leading theory lives
# (one-time Defender/SmartScreen read latency over a freshly extracted app.asar.unpacked,
# which a Mac structurally cannot exercise). See docs/build.md § "Cold-boot crash (#21)".
#
# Usage (build the app first — npm run dist:dir, or reuse the smoke build):
#   N=30 engine/scripts/repro-cold-boot.sh
#   OUT=/path/to/an/app/output/dir PROJECT=games/3d-test N=12 engine/scripts/repro-cold-boot.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PATHS="$REPO/engine/scripts/packagedAppPaths.mjs"

# Derive the default from packagedAppPaths' tmpdir, NOT `${TMPDIR:-/tmp}`. They are not the
# same place on macOS ($TMPDIR is /var/folders/…, /tmp is /private/tmp), and smoke-packaged.sh
# builds under the former — so the naive default silently resolved a DIFFERENT, day-old app
# and reported it green. That is the same "manufactures a test that proves nothing" failure
# clean-packaged-cache.mjs documents. Share the helper so this and the smoke gate agree.
# Keep this basename IN LOCKSTEP with smoke-packaged.sh's OUT — that agreement is the whole
# point of the paragraph above, and it is invisible: nothing fails when the two drift, the
# reused app is simply the wrong one. Both are per clone now (the temp dir is machine-wide),
# so the discriminator has to match too, not just the prefix.
OUT="${OUT:-$(node "$PATHS" tmpdir)/modoki-pkg-smoke-$(basename "$REPO")}"
OUT="${OUT%/}"
PROJECT="${PROJECT:-games/3d-test}"
N="${N:-12}"
# Outside the human-editor range (5179 main / 5180 ai / 5181 ai2) so a run cannot drive,
# or be confused for, a live editor on this machine.
PORT="${PORT:-5188}"
RUNDIR="${RUNDIR:-$OUT/repro21-runs}"

BIN="$(node "$PATHS" "$OUT" bin 2>/dev/null || true)"
# -f not -x: -x is unreliable for a Windows .exe under Git Bash (same reason smoke-packaged.sh
# uses existence). A missing build is the common first-run mistake, so say how to fix it.
[ -n "$BIN" ] && [ -f "$BIN" ] || {
  echo "FAIL: no packaged app under $OUT"
  echo "  Build one first:  npm run dist:dir -- -c.directories.output=$OUT"
  exit 1
}

# STALENESS GUARD. A cold-boot result is only meaningful about the code you think you built,
# and an old app under a reused output dir looks identical to a fresh one. Compare the packaged
# binary against this tree's build:electron output and say so loudly — a warning, not a hard
# fail, because deliberately re-running against a known-good older build is legitimate.
STALE_MSG="$(node -e '
  const fs = require("fs");
  const [bin, main] = process.argv.slice(1);
  try {
    const b = fs.statSync(bin).mtimeMs, m = fs.statSync(main).mtimeMs;
    if (m > b) {
      const hrs = ((m - b) / 3.6e6).toFixed(1);
      process.stdout.write(`packaged app is ${hrs}h OLDER than engine/electron/dist/main.cjs — rebuild, or you are testing stale code`);
    }
  } catch { /* no dist/ yet, or an unreadable bin — nothing to compare, stay quiet */ }
' "$BIN" "$REPO/engine/electron/dist/main.cjs" 2>/dev/null || true)"
[ -n "$STALE_MSG" ] && echo "[repro21] ⚠️  WARNING: $STALE_MSG"

mkdir -p "$RUNDIR"
echo "[repro21] app:     $BIN"
echo "[repro21] project: $PROJECT   iterations: $N   logs: $RUNDIR"

hits=0; clean=0; other=0

for i in $(seq 1 "$N"); do
  UD="$(mktemp -d "${TMPDIR:-/tmp}/modoki-repro21-XXXXXX")"
  APPLOG="$RUNDIR/run-$i.app.log"; VITELOG="$RUNDIR/run-$i.vite.log"; CONSOLE="$RUNDIR/run-$i.console.json"
  : > "$APPLOG"; : > "$VITELOG"; : > "$CONSOLE"

  MODOKI_PROJECT="$PROJECT" MODOKI_BACKEND_PORT="$PORT" MODOKI_VITE_LOG="$VITELOG" \
    MODOKI_NO_AUTOUPDATE=1 "$BIN" "--user-data-dir=$UD" >"$APPLOG" 2>&1 &
  PID=$!

  entities=0
  for _ in $(seq 1 90); do
    kill -0 $PID 2>/dev/null || break          # died — the interesting case; fall through to reporting
    entities=$(curl -s -m 2 "http://127.0.0.1:$PORT/api/scene-state" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).entityCount??0))}catch{process.stdout.write("0")}})' 2>/dev/null || echo 0)
    [ "${entities:-0}" -gt 0 ] 2>/dev/null && break
    sleep 1
  done
  sleep 3   # let a post-load import error surface before we look

  curl -s -m 3 "http://127.0.0.1:$PORT/api/console-logs" > "$CONSOLE" 2>/dev/null || true

  SIG=$(grep -lE "does not provide an export named" "$APPLOG" "$VITELOG" "$CONSOLE" 2>/dev/null | tr '\n' ' ')
  BOUNDARY=$(grep -hoE "EditorBootBoundary.*" "$APPLOG" "$CONSOLE" 2>/dev/null | head -2)
  # Expected to be 1 every iteration here: a fresh profile has no .vite-cache-build sig, so the
  # build-signature check always fires. On a REUSED profile it must be 0 — that is the asar-mtime
  # regression guard (an mtime-keyed sig never matches itself and wipes on every boot).
  WIPED=$(grep -c "cleared stale Vite dep-cache" "$APPLOG" 2>/dev/null || echo 0)

  if [ -n "$SIG" ]; then
    hits=$((hits+1)); echo "run $i: ★ REPRO — stale-export signature in: $SIG (cacheWipe=$WIPED)"
    [ -n "$BOUNDARY" ] && echo "         $BOUNDARY"
  elif [ "${entities:-0}" -gt 0 ] 2>/dev/null; then
    clean=$((clean+1)); echo "run $i: ok  entityCount=$entities (cacheWipe=$WIPED)"
  else
    other=$((other+1)); echo "run $i: ??  no scene, no signature (cacheWipe=$WIPED) — see run-$i.app.log"
    tail -5 "$APPLOG" | sed 's/^/         /'
  fi

  # bash `kill` does not reliably terminate a native Windows process started from Git Bash,
  # and a survivor would hold $PORT for the next iteration — same reason smoke-packaged.sh
  # falls back to the helper. Scoped to this app dir, never a bare product-name pkill (#69).
  kill $PID 2>/dev/null || true
  wait $PID 2>/dev/null
  node "$PATHS" kill 2>/dev/null || true
  rm -rf "$UD"
  sleep 1
done

echo
echo "=== #21 repro: $N runs — repro=$hits  clean=$clean  other=$other  (logs: $RUNDIR) ==="
[ "$hits" -gt 0 ] && exit 1 || exit 0
