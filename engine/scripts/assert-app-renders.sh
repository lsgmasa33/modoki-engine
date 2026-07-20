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
BIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="$(cd "${2:-$REPO/games/3d-test}" && pwd)"
VITELOG="$(mktemp -t modoki-render-vite)"; APPLOG="$(mktemp -t modoki-render-app)"
PORT=5179

[ -x "$BIN" ] || { echo "[render] FAIL: no executable at $BIN"; exit 1; }
pkill -f "$(basename "$APP")/Contents/MacOS" 2>/dev/null || true
# The packaged app relocates Vite's dep cache to userData; clear it so this run re-optimizes
# against the shipped config (a stale cache could mask or fake the resolution result).
rm -rf "$HOME/Library/Application Support/modoki-app/vite-cache" 2>/dev/null || true
sleep 0.5

echo "[render] launching $(basename "$APP") headless (project: $PROJECT)"
MODOKI_PROJECT="$PROJECT" MODOKI_BACKEND_PORT="$PORT" MODOKI_VITE_LOG="$VITELOG" MODOKI_NO_AUTOUPDATE=1 "$BIN" >"$APPLOG" 2>&1 &
PID=$!

entities=0
for i in $(seq 1 60); do
  kill -0 $PID 2>/dev/null || { echo "[render] FAIL: app exited early (${i}s)"; tail -15 "$APPLOG"; exit 1; }
  entities=$(curl -s -m 2 "http://127.0.0.1:$PORT/api/scene-state" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("entityCount",0))' 2>/dev/null || echo 0)
  [ "${entities:-0}" -gt 0 ] 2>/dev/null && break
  sleep 1
done
sleep 3   # let any renderer-side import/transform error surface after world load

fail=0
if [ "${entities:-0}" -le 0 ] 2>/dev/null; then echo "[render] FAIL: renderer never answered (entityCount=$entities)"; tail -20 "$APPLOG"; fail=1
else echo "[render] ok: renderer mounted, scene loaded (entityCount=$entities)"; fi

VITE_ERR=$(grep -iE "Failed to resolve import|Internal server error|Pre-transform error|Cannot find module" "$VITELOG" 2>/dev/null | sort -u)
if [ -n "$VITE_ERR" ]; then echo "[render] FAIL: Vite resolve/transform errors:"; echo "$VITE_ERR" | sed 's/^/    /' | head -10; fail=1
else echo "[render] ok: no Vite resolve/transform errors"; fi

CONSOLE_ERR=$(curl -s -m 3 "http://127.0.0.1:$PORT/api/console-logs" 2>/dev/null | grep -iE "\[uncaught\]|\[unhandledrejection\]" | head -10)
if [ -n "$CONSOLE_ERR" ]; then echo "[render] FAIL: renderer console errors:"; echo "$CONSOLE_ERR" | sed 's/^/    /'; fail=1
else echo "[render] ok: no renderer console errors"; fi

kill $PID 2>/dev/null || true
[ "$fail" = 0 ] && { echo "[render] PASS ✅"; exit 0; } || { echo "[render] FAILED ❌"; exit 1; }
