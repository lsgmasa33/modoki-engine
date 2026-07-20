#!/usr/bin/env bash
# Fast + FAITHFUL packaged-app smoke test.
#
# Builds the SAME app structure as a dmg install (Contents/Resources/app.asar +
# app.asar.unpacked, production-only node_modules) but skips the two slow steps —
# code-signing (~14k-file codesign) and dmg packaging — so the loop is ~20s, not
# ~7 min. Use it to iterate on packaged-only bugs (the .bin/vite spawn, missing
# deps in the prod tree, Vite-in-prod boot, white-screen-on-launch).
#
#   engine/scripts/test-packaged.sh [project-dir]
#
# CRITICAL: the app is built to /tmp (OUTSIDE the repo). If it were built under the
# repo, the packaged app's Node resolution would walk up and find the REPO's
# node_modules — masking "dependency excluded from the package" bugs that only bite
# a real /Applications install. Building outside the repo reproduces the install
# faithfully.
#
# Launches the real Electron binary from the terminal (main-process logs stream
# live). Ctrl-C to stop. Use `npm run dist` for the final signed/notarized artifact.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
PROJECT="${1:-}"
[ -n "$PROJECT" ] && export MODOKI_PROJECT="$(cd "$PROJECT" && pwd)"

OUT="/tmp/modoki-pkg-test"   # outside the repo — see note above
APP="$OUT/mac-arm64/Modoki Editor.app"

# Kill any prior packaged/dev editor + free the Vite port (--strictPort 5173).
pkill -f "Modoki Editor.app/Contents/MacOS" 2>/dev/null || true
pkill -f "engine/electron/dist/main.cjs" 2>/dev/null || true
npm run dev:stop >/dev/null 2>&1 || true
sleep 0.5

echo "[test-packaged] building unsigned .app → $OUT (no codesign, no dmg)…"
npm run build:electron
# --dir = no dmg; CSC_IDENTITY_AUTO_DISCOVERY=false = no signing; output OUTSIDE repo.
CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder --dir \
  -c.directories.output="$OUT"

[ -x "$APP/Contents/MacOS/Modoki Editor" ] || { echo "[test-packaged] ERROR: app not built at $APP"; exit 1; }

echo "[test-packaged] launching packaged app${PROJECT:+ on $MODOKI_PROJECT}…"
echo "[test-packaged]   app:      $APP   (outside repo → faithful resolution)"
echo "[test-packaged]   vite log: /tmp/modoki-vite.log"
echo "[test-packaged]   main-process logs stream below. Ctrl-C to stop."
echo "──────────────────────────────────────────────────────────────"
exec "$APP/Contents/MacOS/Modoki Editor"
