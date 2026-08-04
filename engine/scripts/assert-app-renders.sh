#!/usr/bin/env bash
# Assert an ALREADY-BUILT packaged .app boots with a CLEAN renderer — the release-time
# gate against "blank editor window" packaging bugs (e.g. the @zappar/msdf-generator
# out-of-tree dep-cache resolution failure). Unlike smoke-packaged.sh this does NOT build;
# it tests the .app you point it at (so release.yml can gate the signed artifact it just
# produced, no redundant rebuild).
#
# FAILS on ANY of:
#   - the ECS world never loaded entities — scene-state relays THROUGH the renderer, so
#     entityCount>0 already proves the renderer mounted and answered
#   - a Vite resolve/transform error in the dev-server log (the deterministic signal of the
#     packaged-cache import failure — shows as a blocking overlay, renderer never mounts)
#   - a renderer console error (uncaught/unhandledrejection, captured by agentBridge)
#
#   engine/scripts/assert-app-renders.sh "<path/to/Foo.app>" [project-dir]
# Exit 0 = clean; non-zero = the packaged renderer is broken (details printed).
set -uo pipefail

APP="${1:?usage: assert-app-renders.sh <app-path> [project-dir]}"
PATHS="$(cd "$(dirname "$0")" && pwd)/packagedAppPaths.mjs"
# The executable inside the app dir we were HANDED differs per platform (.app bundle vs the
# unpacked dir that directly contains the .exe) — resolved by packagedAppPaths.mjs so this script
# carries no platform table. It used to hardcode Contents/MacOS, which made the release-time render
# gate macOS-only — which is why the Windows release shipped ungated until #94. Both release jobs
# now call this: macOS hands it the .app, Windows hands it release/win-unpacked.
BIN="$(node "$PATHS" binIn "$APP")"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# `pwd -W` (MSYS native form), not bare `pwd` — the SAME trap smoke-packaged.sh documents at its
# own PROJECT line: Git Bash rewrites paths in ARGUMENTS but never in ENV VARS, and the project
# reaches the app as MODOKI_PROJECT. A bare `pwd` hands the Windows app `/e/Projects/…`, which it
# cannot resolve, so it boots perfectly and loads NO SCENE — and this gate then fails with
# `entityCount=0`, which reads like a broken renderer rather than a bad path. Measured 2026-08-02.
PROJECT="$(cd "${2:-$REPO/games/3d-test}" && { pwd -W 2>/dev/null || pwd; })"
# `mktemp -t <prefix>` (no X's) is BSD/macOS syntax. GNU mktemp — which Git Bash ships — REJECTS
# it ("too few X's in template"), leaving both vars EMPTY and the script failing three lines later
# on `: No such file or directory`. The explicit-template form works on both.
VITELOG="$(mktemp "${TMPDIR:-/tmp}/modoki-render-vite.XXXXXX")"
APPLOG="$(mktemp "${TMPDIR:-/tmp}/modoki-render-app.XXXXXX")"
# A throwaway Chromium profile — see the --user-data-dir note at the launch below. Explicit
# template for the same GNU-mktemp reason as the two lines above.
USERDATA="$(mktemp -d "${TMPDIR:-/tmp}/modoki-render-ud.XXXXXX")"
# Per-clone, and OUTSIDE the human-editor range (#69). This used to be a hardcoded 5179 —
# the main clone's own editor backend port — so running this harness while your editor was
# up simply failed: the packaged app PINS MODOKI_BACKEND_PORT and refuses to drift (E6).
# Derived from the repo path so two clones don't collide either, in its own high block
# (38900-39099) — a tight 10-slot range next to the editor ports was tried first and
# produced an ACTUAL collision between two clones on this machine. RENDER_BACKEND_PORT
# overrides.
PORT="${RENDER_BACKEND_PORT:-$(node "$REPO/engine/scripts/clonePort.mjs" 38900 200 "$REPO")}"

[ -x "$BIN" ] || { echo "[render] FAIL: no executable at $BIN"; exit 1; }
# Scope the reap to the app path we were HANDED, not its basename: every clone's packaged
# app is called "Modoki Editor", so a basename match reaches a sibling clone's app (#69).
#
# `${APP:?msg}`, not a bare `$APP`. This script only sets `set -uo pipefail` (no `-e` — see
# the header), and even `set -e` would not help here anyway: it catches a FAILING command,
# not a variable that is merely EMPTY (APP is already guarded against empty/unset by the
# `${1:?usage: ...}` at its assignment above, but that guard lives at a DIFFERENT line than
# the reap — belt-and-braces here matches the pattern used at every other reap site in this
# repo, so a future edit that decouples APP's assignment from that check can't silently
# reopen the hole). `${VAR:?msg}` aborts the expansion unconditionally on empty/unset,
# independent of set -e — an empty APP must fail loud here rather than being handed to the
# helper as a machine-wide "kill every packaged instance" (its documented no-appDir mode).
# Via the helper, which scopes to the app PATH on both platforms — `pkill` does not exist on
# Windows (there it is a Win32_Process filter on ExecutablePath), and `killPackaged` carries the
# same empty/short-appDir refusal that the bash `${VAR:?msg}` form gives here.
node "$PATHS" kill "${APP:?refusing to reap with an empty APP — that pattern would match every clone}" 2>/dev/null || true
# NOTE: no clearViteCache here. `win` routed the old hardcoded macOS-only
# `rm -rf ~/Library/.../vite-cache` through the helper to make it cross-platform; this branch
# removed the need for it entirely by giving the launch its own --user-data-dir (see below), so
# the dep cache is empty by construction every run. Clearing the SHARED profile would now be both
# a no-op for this gate and a write into the human's real editor state.
sleep 0.5

echo "[render] launching $(basename "$APP") headless (project: $PROJECT)"
# --user-data-dir ISOLATES this gate, and REPLACES the hand-rolled
# `rm -rf "$HOME/Library/Application Support/Modoki Editor/vite-cache"` that stood here.
# That line existed because the packaged app relocates Vite's dep cache into userData and a
# stale one could mask or fake the resolution result — a fresh profile cannot hold a stale
# cache at all, and this no longer reaches into the human's real profile by hardcoded path.
#
# The isolation matters beyond the cache: resolveUserDataDir (engine/electron/userDataDir.ts)
# scopes the profile per CLONE only for DEV, so every packaged run on a machine shared one
# profile — and `modoki-last-scene:<project name>` is keyed by project NAME with a
# clone-ABSOLUTE value. Measured in the sibling smoke gate 2026-08-02: a run restored ANOTHER
# clone's scene, `/@fs` correctly 403'd it, and the console-error assertion below (which this
# script also has) failed for a reason unrelated to the artifact under test. On a CI runner
# the profile is fresh anyway; this makes a LOCAL run of the release gate trustworthy too.
# shouldOverrideUserData() deliberately stands down when this switch is passed.
MODOKI_PROJECT="$PROJECT" MODOKI_BACKEND_PORT="$PORT" MODOKI_VITE_LOG="$VITELOG" MODOKI_NO_AUTOUPDATE=1 "$BIN" "--user-data-dir=$USERDATA" >"$APPLOG" 2>&1 &
PID=$!

entities=0
for i in $(seq 1 60); do
  kill -0 $PID 2>/dev/null || { echo "[render] FAIL: app exited early (${i}s)"; tail -15 "$APPLOG"; exit 1; }
  # `node`, not `python3` — matching smoke-packaged.sh. Python is not a dependency of this repo and
  # is absent on a stock Windows box; worse, Windows ships an App-Execution-Alias STUB at
  # `WindowsApps/python3` that `command -v` FINDS but which only prints "Python was not found" and
  # exits non-zero. The `|| echo 0` then swallowed it, so every poll returned 0 and this gate failed
  # with `entityCount=0` — reading as a dead renderer rather than a missing interpreter.
  entities=$(curl -s -m 2 "http://127.0.0.1:$PORT/api/scene-state" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).entityCount??0))}catch{process.stdout.write("0")}})' 2>/dev/null || echo 0)
  [ "${entities:-0}" -gt 0 ] 2>/dev/null && break
  sleep 1
done
sleep 3   # let any renderer-side import/transform error surface after world load

fail=0
if [ "${entities:-0}" -le 0 ] 2>/dev/null; then echo "[render] FAIL: renderer never answered (entityCount=$entities)"; tail -20 "$APPLOG"; fail=1
else echo "[render] ok: renderer mounted, scene loaded (entityCount=$entities)"; fi

# Exclude Vite's self-healing dep-optimizer reload: when the optimizer re-bundles mid-load
# (e.g. @modoki/engine's Canvas2DMount chunk re-hashes), an in-flight request for the old
# chunk logs "Pre-transform error: ... which is in the optimize deps directory" and Vite then
# forces a full page reload — transient, and the renderer still mounts (entityCount proves it).
# The genuine packaging bug this gate catches ("Failed to resolve import"/"Cannot find module")
# is NOT self-healing and additionally leaves entityCount=0, so this exclusion keeps it intact.
VITE_ERR=$(grep -iE "Failed to resolve import|Internal server error|Pre-transform error|Cannot find module" "$VITELOG" 2>/dev/null \
  | grep -viE "which is in the optimize deps directory" | sort -u)
if [ -n "$VITE_ERR" ]; then echo "[render] FAIL: Vite resolve/transform errors:"; echo "$VITE_ERR" | sed 's/^/    /' | head -10; fail=1
else echo "[render] ok: no Vite resolve/transform errors"; fi

CONSOLE_ERR=$(curl -s -m 3 "http://127.0.0.1:$PORT/api/console-logs" 2>/dev/null | grep -iE "\[uncaught\]|\[unhandledrejection\]" | head -10)
if [ -n "$CONSOLE_ERR" ]; then echo "[render] FAIL: renderer console errors:"; echo "$CONSOLE_ERR" | sed 's/^/    /'; fail=1
else echo "[render] ok: no renderer console errors"; fi

kill $PID 2>/dev/null || true
[ "$fail" = 0 ] && { echo "[render] PASS ✅"; exit 0; } || { echo "[render] FAILED ❌"; exit 1; }
