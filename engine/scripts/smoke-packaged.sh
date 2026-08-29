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
# PER CLONE, for the same reason test-packaged.sh is (#69): the temp dir is machine-wide,
# so these bare names were shared by every clone — and this script `rm -rf`s OUT and
# USERDATA before building into them. Two clones running `verify:packaged` at once would
# delete each other's build mid-run, and the smoke would report on whichever .app won the
# race. The PORT below and the throwaway profile were already per-clone; the PATHS were the
# gap. `$(basename "$REPO")` is the same discriminator test-packaged.sh uses.
#
# …and a distinct BASENAME from test-packaged.sh, which builds at
# `modoki-pkg-test-<clone>`. Sharing the per-clone name would be a WITHIN-clone collision
# in place of the cross-clone one: `editor:packaged` is test-packaged.sh `exec`ing a
# long-lived interactive editor out of that dir, and this script reaps packaged apps and
# `rm -rf "$OUT"`s before it builds — so a smoke run would delete the app the owner is
# sitting in front of. Different job, different dir.
CLONE="$(basename "$REPO")"
OUT="$TMPBASE/modoki-pkg-smoke-$CLONE"
VITELOG="$TMPBASE/modoki-smoke-vite-$CLONE.log"; APPLOG="$TMPBASE/modoki-smoke-app-$CLONE.log"
BUILDLOG="$TMPBASE/modoki-smoke-build-$CLONE.log"
# A THROWAWAY Chromium profile for the launch leg — see the --user-data-dir note at the
# launch below. Not under the packaged product name: `killPackaged`'s no-appDir fallback
# reaps on `Modoki Editor.app/Contents/`, and Electron repeats --user-data-dir in every
# helper's command line, so a profile path containing that substring would make our own
# helpers reapable by a machine-wide clean (the #69 signature, in reverse).
USERDATA="$TMPBASE/modoki-smoke-userdata-$CLONE"
# Dedicated port OUTSIDE the human-editor range (5179 main / 5180 ai / 5181 ai2) so a
# throwaway smoke build (e.g. from `npm run verify:packaged`) can't collide with a
# sibling clone's live dev editor — the packaged app pins MODOKI_BACKEND_PORT and
# refuses to drift, so a clash would just fail the smoke.
# Also PER CLONE (#69): a single shared 5188 meant two clones could not run this at the
# same time, for the same reason. A dedicated high block (38600-38799) rather than a tight
# range next to the editor ports — 10 slots was tried first and produced an ACTUAL
# collision between two clones on this machine (birthday problem: ~30% for 4 clones in 10
# slots), which defeats the point. A clash is still possible but rare and LOUD, and
# SMOKE_BACKEND_PORT overrides.
PORT="${SMOKE_BACKEND_PORT:-$(node "$REPO/engine/scripts/clonePort.mjs" 38600 200 "$REPO")}"

node "$PATHS" kill 2>/dev/null || true
npm run dev:stop >/dev/null 2>&1 || true
# A fresh profile per run, which SUBSUMES the `clearViteCache` this replaces: that dropped
# the stale packaged Vite dep-cache (baked against whichever tree last ran, and unwritable
# inside a signed bundle) out of the SHARED profile. An empty profile cannot hold a stale
# cache at all — and it no longer reaches into the real one to do it.
rm -rf "${USERDATA:?}"
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

# #326: the packaged app must SHIP the CJS Vite config. Without it a real Build press falls back
# to the ESM config, whose loader writes node_modules/.vite-temp inside the signed bundle. The
# stager skips gracefully when esbuild is unresolvable, so its absence is otherwise silent — and
# this smoke never presses Build, so the file-list check below cannot see that regression. This
# line is what covers it.
# The resources dir differs per platform (macOS nests it in the .app), so test BOTH layouts
# rather than branching on `uname` — one of them is always the right one, and a layout change
# would otherwise turn this into a silent pass on whichever platform it stopped matching.
if [ -f "$APP/Contents/Resources/app.asar.unpacked/engine/vite.config.cjs" ] \
  || [ -f "$APP/resources/app.asar.unpacked/engine/vite.config.cjs" ]; then
  echo "[smoke] ok: packaged Vite config staged (#326)"
else
  echo "[smoke] FAIL: engine/vite.config.cjs is missing from the bundle — a Build press would"
  echo "             write .vite-temp inside the signed app (#326). Check stage-vite-config.cjs."
  fail_staged=1
fi

# Snapshot the bundle BEFORE the app runs, so the assertion after teardown can prove the packaged
# editor wrote nothing inside its own signed application. NOTE what this does and does not cover:
# it sees writes made at BOOT (the class fixed in 3df0e65d4 / ed17ff8a2), not writes made by a
# project BUILD — this harness never presses Build. The build path is QA-PKG-0009 step 7.
BUNDLELIST="$TMPBASE/modoki-pkg-bundle-$CLONE.txt"
node "$REPO/engine/scripts/assertBundleUnchanged.mjs" snapshot "$APP" "$BUNDLELIST" \
  || { echo "[smoke] FAIL: could not snapshot the bundle"; exit 1; }

echo "[smoke] launching headless (project: $PROJECT)"
: > "$VITELOG"; : > "$APPLOG"
# --user-data-dir ISOLATES THIS LEG. resolveUserDataDir (engine/electron/userDataDir.ts)
# scopes the profile per CLONE only for DEV; packaged returns the one shared
# `<appData>/Modoki Editor`, on the correct premise that a shipped app is installed once.
# This gate breaks that premise — four clones each build and smoke their OWN packaged app,
# so they shared one profile, and `modoki-last-scene:<project name>` is keyed by project
# NAME while its value is a clone-ABSOLUTE path. Measured 2026-08-02: a run here restored
# ai2's remembered scene, `/@fs` (scoped to this clone's root) correctly 403'd it, and the
# gate reported FAILED — the boot itself was fine, since loadFirstScene self-heals to
# config.scenePath, but the recovery leaves a console error and this script counts any
# console error as fatal. shouldOverrideUserData() stands down when this switch is passed,
# exactly so a harness can do this; assert-app-csp.mjs already did, which is why the CSP
# leg was hermetic and this one was not.
MODOKI_PROJECT="$PROJECT" MODOKI_BACKEND_PORT="$PORT" MODOKI_VITE_LOG="$VITELOG" MODOKI_NO_AUTOUPDATE=1 "$BIN" "--user-data-dir=$USERDATA" >"$APPLOG" 2>&1 &
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

# ── the packaged editor must provision its OWN Node (#89) ──
# `ensureNodeProvisioned()` CATCHES its own failure and falls back to system npm, so a
# dev box (which has npm) looks perfectly healthy: the editor boots, the scene loads,
# every assertion above passes. That is not hypothetical — a bare `tar` on Windows
# resolved to Git's GNU tar, which cannot read a zip and reads `C:\…` as a remote host,
# so the packaged Windows editor could NEVER extract its toolchain (2effb33b) while this
# script reported PASS ✅ for however long it had been broken. An END USER has no system
# Node, so for them the fallback is not a fallback — it is a dead build.
#
# Assert the PINNED version, not merely that some provisioning line appeared: the log
# embeds PINNED_NODE.version, so comparing against the repo's pin also catches a stale
# packaged build (shipping an older pin than the tree claims). Read the pin from source
# rather than duplicating it here — a hard-coded copy is exactly the drift this catches.
PIN="$(sed -n "s/^  version: '\(v[0-9][0-9.]*\)',*$/\1/p" "$REPO/engine/toolchain/nodeProvision.ts" | head -1)"
if [ -z "$PIN" ]; then
  # Never let a broken extraction make the assertion vacuous — an empty PIN would turn the
  # grep below into "match any provisioning line at all", silently weakening the gate.
  echo "[smoke] FAIL: could not read PINNED_NODE.version from engine/toolchain/nodeProvision.ts"; fail=1
elif grep -q "Node provisioning failed" "$APPLOG" 2>/dev/null; then
  echo "[smoke] FAIL: Node provisioning failed — the packaged editor fell back to system npm:"
  grep "Node provisioning failed" "$APPLOG" | sed 's/^/    /' | head -3; fail=1
elif ! grep -q "provisioned Node $PIN " "$APPLOG" 2>/dev/null; then
  echo "[smoke] FAIL: no 'provisioned Node $PIN' line — the pinned toolchain never came up."
  grep -i "provisioned Node" "$APPLOG" | sed 's/^/    got: /' | head -3; fail=1
else echo "[smoke] ok: provisioned Node $PIN"; fi

# bash `kill` on a native Windows process started from Git Bash does not reliably
# terminate it, and a survivor would hold the CDP port the CSP probe needs next.
kill $PID 2>/dev/null || true
node "$PATHS" kill 2>/dev/null || true
# A fixed `sleep 1` here raced teardown against the CSP leg's own boot: nothing confirmed
# the first instance was actually gone before the second one started, so on a slow
# shutdown (log flush, GPU process teardown) the CSP leg could boot while a survivor was
# still mid-exit. Poll for the PID's actual death instead — bounded, so a genuinely stuck
# process still fails loud rather than hanging the gate forever. `kill -0` is portable
# (works under Git Bash for a process bash itself knows about); it does not need GNU tools.
DEAD=0
for i in $(seq 1 20); do
  kill -0 $PID 2>/dev/null || { DEAD=1; break; }
  sleep 0.5
done
[ "$DEAD" = 1 ] || echo "[smoke] WARNING: first instance (pid $PID) still alive 10s after kill — proceeding anyway, CSP leg may race it"

# ── CSP gate (separate boot, CDP-based — the render checks above can't see it) ──
# A CSP-blocked CDN script (MediaPipe wasm loader for chess/llm-test) doesn't blank
# the editor, so the render assertions pass while the on-device-LLM path is broken.
echo "[smoke] asserting prod CSP on the built app…"
if node "$REPO/engine/scripts/assert-app-csp.mjs" "$APP" "$PROJECT"; then
  echo "[smoke] ok: prod CSP correct"
else
  echo "[smoke] FAIL: prod CSP regression (see [csp] output above)"; fail=1
fi

# ── the app must not have written inside its OWN bundle at BOOT (#326) ──
# Last, so it covers BOTH boots above (the render leg and the CSP leg). A write in here is
# invisible to every assertion above — the app works perfectly and merely breaks its own code
# signature, which only `codesign`/`spctl` see, by which point notarization is gone.
# ⚠️ BOOT only. Nothing here presses Build, so a build-time writer is out of scope for this
# check — that is what the staged-config assertion above and QA-PKG-0009 step 7 are for.
if node "$REPO/engine/scripts/assertBundleUnchanged.mjs" assert "$APP" "$BUNDLELIST"; then :; else fail=1; fi
[ "${fail_staged:-0}" = 0 ] || fail=1

[ "$fail" = 0 ] && { echo "[smoke] PASS ✅"; exit 0; } || { echo "[smoke] FAILED ❌"; exit 1; }
