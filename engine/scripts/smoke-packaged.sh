#!/usr/bin/env bash
# Headless packaged-app SMOKE TEST — the automated gate for packaged-only bugs.
#
# Builds the faithful packaged .app (unsigned, --dir, OUTSIDE the repo so Node
# resolution can't leak into the repo's node_modules), launches it headless, and
# FAILS on ANY of:
#   - the ECS world never loaded entities (scene didn't load)
#   - a Vite resolve/transform error in the dev-server log (renderer-side import
#     failure — these show as a blocking overlay in the window but DON'T stop the
#     backend world from loading, so an entity-count check alone misses them)
#   - a renderer console error (uncaught/unhandledrejection, captured by agentBridge)
#
# This is the lesson from the dmg whack-a-mole: "entities loaded" is necessary but
# NOT sufficient — you must also assert the renderer booted clean.
#
#   engine/scripts/smoke-packaged.sh [project-dir]   # default: games/3d-test
# Exit 0 = clean; non-zero = a packaged-only failure (details printed).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
# NATIVE path, not POSIX. MSYS rewrites POSIX-looking ARGUMENTS when calling a native
# program, but never ENV VARS — and the project reaches the app as MODOKI_PROJECT, so a
# Git-Bash "/e/Projects/..." left the packaged app unable to find the project at all
# (it booted fine and simply loaded no scene). `pwd -W` is the MSYS native form; it
# fails on macOS/Linux, where plain pwd is already native.
PROJECT="$(cd "${1:-games/3d-test}" && { pwd -W 2>/dev/null || pwd; })"

# Where the .app/.exe lands, how to kill a leftover, and the native temp dir all differ
# per platform — resolved by engine/scripts/packagedAppPaths.mjs so this script carries no
# platform table. Paths must be NATIVE, not POSIX: electron-builder and the launched
# Electron binary are native processes, so a Git-Bash "/tmp/..." is meaningless to them
# (MODOKI_VITE_LOG in particular is opened by the app, not by this shell).
PATHS="$REPO/engine/scripts/packagedAppPaths.mjs"
TMPBASE="$(node "$PATHS" tmpdir)"
OUT="$TMPBASE/modoki-pkg-test"
VITELOG="$TMPBASE/modoki-smoke-vite.log"; APPLOG="$TMPBASE/modoki-smoke-app.log"
BUILDLOG="$TMPBASE/modoki-smoke-build.log"
# Dedicated port OUTSIDE the human-editor range (5179 main / 5180 ai / 5181 ai2) so a
# throwaway smoke build (e.g. from `npm run verify:packaged`) can't collide with a
# sibling clone's live dev editor — the packaged app pins MODOKI_BACKEND_PORT and
# refuses to drift, so a clash would just fail the smoke. Overridable if needed.
PORT="${SMOKE_BACKEND_PORT:-5188}"

node "$PATHS" kill 2>/dev/null || true
npm run dev:stop >/dev/null 2>&1 || true
node "$PATHS" clearViteCache 2>/dev/null || true
sleep 0.5

echo "[smoke] building faithful packaged app → $OUT"
rm -rf "$OUT"
npm run build:electron >"$BUILDLOG" 2>&1 || { echo "[smoke] FAIL: build:electron"; tail -20 "$BUILDLOG"; exit 1; }
CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder --dir -c.directories.output="$OUT" >>"$BUILDLOG" 2>&1 \
  || { echo "[smoke] FAIL: electron-builder"; tail -20 "$BUILDLOG"; exit 1; }

APP="$(node "$PATHS" "$OUT" appDir)"
BIN="$(node "$PATHS" "$OUT" bin)"
# -x is unreliable for a Windows .exe under Git Bash; existence is the portable check.
[ -f "$BIN" ] || { echo "[smoke] FAIL: app not built (expected $BIN)"; tail -20 "$BUILDLOG"; exit 1; }

echo "[smoke] launching headless (project: $PROJECT)"
: > "$VITELOG"; : > "$APPLOG"
MODOKI_PROJECT="$PROJECT" MODOKI_BACKEND_PORT="$PORT" MODOKI_VITE_LOG="$VITELOG" MODOKI_NO_AUTOUPDATE=1 "$BIN" >"$APPLOG" 2>&1 &
PID=$!

entities=0
for i in $(seq 1 50); do
  kill -0 $PID 2>/dev/null || { echo "[smoke] FAIL: app exited early (${i}s)"; tail -15 "$APPLOG"; exit 1; }
  # node, not python3 — python is not present on a stock Windows dev box (and is not a
  # dependency of this repo anywhere else).
  entities=$(curl -s -m 2 "http://127.0.0.1:$PORT/api/scene-state" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).entityCount??0))}catch{process.stdout.write("0")}})' 2>/dev/null || echo 0)
  [ "${entities:-0}" -gt 0 ] 2>/dev/null && break
  sleep 1
done
# Give the renderer a moment to surface any import/transform errors after world load.
sleep 3

# ── assertions ──────────────────────────────────────────────
fail=0
if [ "${entities:-0}" -le 0 ] 2>/dev/null; then echo "[smoke] FAIL: scene never loaded (entityCount=$entities)"; fail=1
else echo "[smoke] ok: scene loaded (entityCount=$entities)"; fi

VITE_ERR=$(grep -iE "Failed to resolve import|Internal server error|Pre-transform error|Cannot find module" "$VITELOG" 2>/dev/null | sort -u)
if [ -n "$VITE_ERR" ]; then echo "[smoke] FAIL: Vite errors (renderer-side):"; echo "$VITE_ERR" | sed 's/^/    /' | head -10; fail=1
else echo "[smoke] ok: no Vite resolve/transform errors"; fi

# Parse the JSON rather than grepping it: /api/console-logs answers on ONE line that
# includes a `"byLevel":{...,"error":N}` summary, so a bare `grep -i error` matched that
# counter and dumped the entire log blob — it could never distinguish a real error from
# the tally, and reported a failure whether or not one existed.
CONSOLE_ERR=$(curl -s -m 3 "http://127.0.0.1:$PORT/api/console-logs" 2>/dev/null | node "$REPO/engine/scripts/smokeConsoleErrors.mjs" 2>/dev/null)
if [ -n "$CONSOLE_ERR" ]; then echo "[smoke] FAIL: renderer console errors:"; echo "$CONSOLE_ERR" | sed 's/^/    /'; fail=1
else echo "[smoke] ok: no renderer console errors"; fi

# bash `kill` on a native Windows process started from Git Bash does not reliably
# terminate it, and a survivor would hold the CDP port the CSP probe needs next.
kill $PID 2>/dev/null || true
node "$PATHS" kill 2>/dev/null || true
sleep 1

# ── CSP gate (separate boot, CDP-based — the render checks above can't see it) ──
# A CSP-blocked CDN script (MediaPipe wasm loader for chess/llm-test) doesn't blank
# the editor, so the render assertions pass while the on-device-LLM path is broken.
echo "[smoke] asserting prod CSP on the built app…"
if node "$REPO/engine/scripts/assert-app-csp.mjs" "$APP" "$PROJECT"; then
  echo "[smoke] ok: prod CSP correct"
else
  echo "[smoke] FAIL: prod CSP regression (see [csp] output above)"; fail=1
fi

[ "$fail" = 0 ] && { echo "[smoke] PASS ✅"; exit 0; } || { echo "[smoke] FAILED ❌"; exit 1; }
