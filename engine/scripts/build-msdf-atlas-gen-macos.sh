#!/usr/bin/env bash
# Build the PINNED macOS msdf-atlas-gen that Modoki provisions and bundles (#1327).
#
# Why this exists: Chlumsky publishes msdf-atlas-gen prebuilt for Windows only. Before #1327 the
# macOS release job ran `brew install msdf-atlas-gen`, and Homebrew has no bottle for the runner's
# macOS, so every release COMPILED it against whatever msdfgen/freetype/libpng Homebrew had that
# day — and every dev machine ran its own hand-installed copy. A font conversion's cache key never
# names that binary, so one hash covered different bytes (the #1297 mechanism).
#
# This script builds it ONCE, the way upstream builds its Windows release: the msdfgen submodule
# plus vcpkg for the dependencies, WITH Skia geometry preprocessing (owner, 2026-09-17 — the Windows
# build has Skia, and Homebrew's did not, so the two platforms resolved overlapping contours by
# different algorithms). vcpkg is pinned to a release tag (see VCPKG_TAG for why that one), which pins every port (Skia, FreeType,
# libpng) to that tag's version, and everything links STATICALLY, so the output is one
# self-contained binary (only libc++/libSystem and system frameworks Skia links — AppKit, OpenGL,
# ApplicationServices — from the OS; zlib is vcpkg's, static). Artery Font export is off — the
# importer never asks for it, and its submodule is not in the release tarball.
#
# The resulting tarball is uploaded ONCE as a release asset on the public modoki-engine repo (a
# prerelease, so the editor's updater ignores it), and its sha256 goes into CONVERSION_CLI_PINS
# (engine/toolchain/conversionCliProvision.ts) — installs and release.yml download that asset and
# never run this script.
#
# Usage: engine/scripts/build-msdf-atlas-gen-macos.sh <out-dir>
#   → <out-dir>/msdf-atlas-gen-<ver>-skia-macos-arm64.tar.gz  (contains msdf-atlas-gen/msdf-atlas-gen)
# Needs: macOS arm64, Xcode command-line tools, cmake, git, curl. Takes a while — Skia is built from
# source (vcpkg's binary cache makes a re-run fast). Nothing from Homebrew is linked; the result is
# checked for that.
set -euo pipefail

MSDF_ATLAS_VER=1.4
MSDF_ATLAS_SHA=57db9548b30905b18640ceab5011144e9d362f33a53748bef6be53dd743c9992
MSDFGEN_VER=1.13 # the submodule commit msdf-atlas-gen v1.4 pins is msdfgen v1.13
MSDFGEN_SHA=93cd1ad8918c1a78c5c96e82d4f4c77f0eb86c2e7e8579a0967e54196c4b7167
# The last vcpkg release whose Skia port is m144. Skia m146 (vcpkg 2026.03.18 on) REMOVED SkPath's edit
# methods (cubicTo, …) that msdfgen 1.13's resolve-shape-geometry.cpp calls, so any later tag fails the
# compile until msdfgen moves to SkPathBuilder. Check `ports/skia/vcpkg.json` at a tag before bumping.
VCPKG_TAG=2026.02.27
# Electron 43's floor — the bundled binary must run wherever the editor does.
DEPLOYMENT_TARGET=12.0

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "macOS arm64 only" >&2; exit 1; }
[ $# -eq 1 ] || { echo "usage: $0 <out-dir>" >&2; exit 2; }
mkdir -p "$1"
OUT_DIR="$(cd "$1" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/msdf-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
SRC="$WORK/msdf-atlas-gen"
mkdir -p "$SRC/msdfgen"

fetch() { # <url> <sha256> <dest-dir>
  curl -fsSL "$1" -o "$WORK/dl.tar.gz"
  echo "$2  $WORK/dl.tar.gz" | shasum -a 256 -c - >/dev/null
  tar -xf "$WORK/dl.tar.gz" -C "$3" --strip-components 1
  rm -f "$WORK/dl.tar.gz"
}
fetch "https://github.com/Chlumsky/msdf-atlas-gen/archive/refs/tags/v${MSDF_ATLAS_VER}.tar.gz" "$MSDF_ATLAS_SHA" "$SRC"
fetch "https://github.com/Chlumsky/msdfgen/archive/refs/tags/v${MSDFGEN_VER}.tar.gz" "$MSDFGEN_SHA" "$SRC/msdfgen"

echo "bootstrapping vcpkg ${VCPKG_TAG}…"
git clone -q --depth 1 --branch "$VCPKG_TAG" https://github.com/microsoft/vcpkg "$WORK/vcpkg"
"$WORK/vcpkg/bootstrap-vcpkg.sh" -disableMetrics >/dev/null

# Static libraries, arm64, the editor's deployment floor.
mkdir -p "$WORK/triplets"
cat >"$WORK/triplets/arm64-osx-modoki.cmake" <<EOF
set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Darwin)
set(VCPKG_OSX_ARCHITECTURES arm64)
set(VCPKG_OSX_DEPLOYMENT_TARGET ${DEPLOYMENT_TARGET})
EOF

echo "building msdf-atlas-gen ${MSDF_ATLAS_VER} with Skia (vcpkg builds Skia first — this is the slow part)…"
LOG="$WORK/build.log"
{ VCPKG_ROOT="$WORK/vcpkg" cmake -S "$SRC" -B "$SRC/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TOOLCHAIN_FILE="$WORK/vcpkg/scripts/buildsystems/vcpkg.cmake" \
    -DVCPKG_OVERLAY_TRIPLETS="$WORK/triplets" \
    -DVCPKG_TARGET_TRIPLET=arm64-osx-modoki \
    -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" \
    -DMSDF_ATLAS_USE_VCPKG=ON -DMSDF_ATLAS_USE_SKIA=ON -DMSDF_ATLAS_NO_ARTERY_FONT=ON &&
  cmake --build "$SRC/build" --parallel; } >"$LOG" 2>&1 || { tail -60 "$LOG" >&2; exit 1; }

BUILT="$(find "$SRC/build" -type f -name msdf-atlas-gen -perm -u+x | head -1)"
[ -n "$BUILT" ] || { echo "error: no msdf-atlas-gen executable in the build tree" >&2; exit 1; }
# Refuse an artifact that still links anything outside the OS.
if otool -L "$BUILT" | tail -n +2 | grep -Ev '^[[:space:]]+/usr/lib/|^[[:space:]]+/System/' ; then
  echo "error: $BUILT links a non-system library (above) — refusing to package it" >&2
  exit 1
fi
# Refuse a build that silently lost Skia: its banner names it.
"$BUILT" -version | tee "$WORK/version.txt"
grep -q 'Skia' "$WORK/version.txt" || { echo "error: the build does not report Skia" >&2; exit 1; }

STAGE="$WORK/stage/msdf-atlas-gen"
mkdir -p "$STAGE"
cp "$BUILT" "$STAGE/msdf-atlas-gen"
strip -x "$STAGE/msdf-atlas-gen"
# Ad-hoc sign: an unsigned arm64 binary is killed on launch. The release pack re-signs it for real.
codesign --force --sign - "$STAGE/msdf-atlas-gen"
TARBALL="$OUT_DIR/msdf-atlas-gen-${MSDF_ATLAS_VER}-skia-macos-arm64.tar.gz"
# No build-machine user/group in the headers of a public asset.
tar --uid 0 --gid 0 --uname '' --gname '' -czf "$TARBALL" -C "$WORK/stage" msdf-atlas-gen
shasum -a 256 "$TARBALL"
