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

# Outside the repo (see note above) and PER CLONE: a bare /tmp/modoki-pkg-test is shared,
# so two clones building at once stomp each other's .app — and since the reap below now
# matches this exact path, a shared dir would also put them back to killing each other.
PATHS="$REPO/engine/scripts/packagedAppPaths.mjs"
# Native temp dir via the helper, NOT a literal /tmp: Git Bash's MSYS path conversion rewrites a
# bare "/tmp" into the MSYS root, so the built app would land somewhere electron-builder and the
# launched process disagree about (smoke-packaged.sh hit this first — same `tmpdir` call).
OUT="$(node "$PATHS" tmpdir)/modoki-pkg-test-$(basename "$REPO")"
# WHERE the app lands and WHAT the binary is called differ per platform — macOS gets
# `mac-arm64/<name>.app/Contents/MacOS/<name>`, Windows `win-unpacked/<name>.exe`. Both are
# resolved by packagedAppPaths.mjs so this script carries no platform table. It used to hardcode
# the mac path, which made the script unusable on Windows: it built fine and then died with
# `ERROR: app not built at /tmp/…/mac-arm64/Modoki Editor.app` (measured 2026-08-02 while trying
# to reproduce a packaged-only bug on the Windows clone — the workaround was launching the exe by
# hand, which is exactly the friction this script exists to remove).
APPDIR="$(node "$PATHS" "$OUT" appDir)"

# Kill any prior packaged/dev editor OF THIS CLONE. Both patterns used to be
# clone-agnostic and reaped every clone on the machine (#69): "Modoki Editor.app/…" is the
# product name every clone's packaged app shares, and "engine/electron/dist/main.cjs" is a
# RELATIVE fragment — the exact multi-clone bug launch-editor.sh fixed in its own cleanup
# (see its step-1 comment) and which survived here. Match absolute paths instead, so a
# sibling clone's editor is never touched.
#
# `${VAR:?msg}` (not a bare `$VAR`), because the guard `reapScoping.test.ts` runs is a
# TEXT scan — it can see the pattern starts with "$" but not what that variable expands to
# at runtime. `set -euo pipefail` above already aborts on most failures, but that does not
# cover a variable that is merely EMPTY (unset ≠ empty) — an empty $REPO would silently
# collapse the pattern to "/engine/electron/dist/main.cjs", matching every clone's dev editor
# on this machine. `${VAR:?msg}` catches empty too, and aborts the expansion (hence the whole
# command) unconditionally — regardless of set -e — which is the point: this must fail
# LOUD, not fail open into a machine-wide pkill.
# The packaged reap goes through the helper (`kill <appDir>`), which carries the same
# empty/short-appDir guard in JS — see killPackaged's comment — because `pkill` does not exist on
# Windows at all; there it is `taskkill /IM`. The bash `${VAR:?msg}` form is kept on the line below,
# which is still a genuine POSIX-only pkill.
node "$PATHS" kill "${APPDIR:?refusing to reap with an empty APPDIR — that pattern would match every clone}" 2>/dev/null || true
pkill -f "${REPO:?refusing to reap with an empty REPO — that pattern would match every clone}/engine/electron/dist/main.cjs" 2>/dev/null || true
npm run dev:stop >/dev/null 2>&1 || true
sleep 0.5

echo "[test-packaged] building unsigned packaged app → $OUT (no codesign, no dmg)…"
npm run build:electron
# --dir = no dmg; CSC_IDENTITY_AUTO_DISCOVERY=false = no signing; output OUTSIDE repo.
CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder --dir \
  -c.directories.output="$OUT"

# Re-resolve AFTER the build: before it, `resolvePackagedApp` can only return its best-guess
# candidate (nothing exists yet to probe), so this is the first point the answer is authoritative.
BIN="$(node "$PATHS" "$OUT" bin)"
[ -x "$BIN" ] || { echo "[test-packaged] ERROR: app not built at $BIN"; exit 1; }

# PIN the Vite log per clone, the same way launch-editor.sh does, and print THAT — this
# banner used to name a bare `modoki-vite.log` it never set, so it was reporting devServer's
# default rather than a path this script controls. Native (forward-slashed) via tmpdir, not
# a literal /tmp: the app opens it as a native process and MSYS never rewrites env vars.
export MODOKI_VITE_LOG="${MODOKI_VITE_LOG:-$(node "$PATHS" tmpdir)/modoki-vite-packaged-$(basename "$REPO").log}"

echo "[test-packaged] launching packaged app${PROJECT:+ on $MODOKI_PROJECT}…"
echo "[test-packaged]   app:      $BIN   (outside repo → faithful resolution)"
echo "[test-packaged]   vite log: $MODOKI_VITE_LOG"
echo "[test-packaged]   main-process logs stream below. Ctrl-C to stop."
echo "──────────────────────────────────────────────────────────────"
exec "$BIN"
