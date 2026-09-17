#!/usr/bin/env bash
# Build the PINNED macOS msdf-atlas-gen that Modoki provisions and bundles (#1327).
#
# Why this exists: Chlumsky publishes msdf-atlas-gen prebuilt for Windows only. Before #1327 the
# macOS release job ran `brew install msdf-atlas-gen`, and Homebrew has no bottle for the runner's
# macOS, so every release COMPILED it against whatever msdfgen/freetype/libpng Homebrew had that
# day — and every dev machine ran its own hand-installed copy. A font conversion's cache key never
# names that binary, so one hash covered different bytes (the #1297 mechanism).
#
# This script builds it ONCE from sha256-pinned source tarballs, linking every non-system library
# STATICALLY, so the output is a single self-contained binary (only libc++/libSystem/libz from the
# OS). Its CMake options mirror the Homebrew formula (no Skia, no Artery Font) so the pinned build
# bakes what the bundle used to. The resulting tarball is uploaded ONCE as a release asset on the
# public modoki-engine repo (a prerelease, so the editor's updater ignores it), and its sha256 goes
# into CONVERSION_CLI_PINS (engine/toolchain/conversionCliProvision.ts) — installs and release.yml
# download that asset and never run this script.
#
# Usage: engine/scripts/build-msdf-atlas-gen-macos.sh <out-dir>
#   → <out-dir>/msdf-atlas-gen-<ver>-macos-arm64.tar.gz  (contains msdf-atlas-gen/msdf-atlas-gen)
# Needs: macOS arm64, Xcode command-line tools, cmake, curl. Nothing from Homebrew is linked —
# the script ignores /opt/homebrew and /usr/local when finding packages, and checks the result.
set -euo pipefail

MSDF_ATLAS_VER=1.4
MSDF_ATLAS_SHA=57db9548b30905b18640ceab5011144e9d362f33a53748bef6be53dd743c9992
MSDFGEN_VER=1.13
MSDFGEN_SHA=93cd1ad8918c1a78c5c96e82d4f4c77f0eb86c2e7e8579a0967e54196c4b7167
FREETYPE_VER=2.14.3
FREETYPE_SHA=36bc4f1cc413335368ee656c42afca65c5a3987e8768cc28cf11ba775e785a5f
LIBPNG_VER=1.6.58
LIBPNG_SHA=28eb403f51f0f7405249132cecfe82ea5c0ef97f1b32c5a65828814ae0d34775
TINYXML2_VER=11.0.0
TINYXML2_SHA=5556deb5081fb246ee92afae73efd943c889cef0cafea92b0b82422d6a18f289
# Electron 43's floor — the bundled binary must run wherever the editor does.
export MACOSX_DEPLOYMENT_TARGET=12.0

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "macOS arm64 only" >&2; exit 1; }
[ $# -eq 1 ] || { echo "usage: $0 <out-dir>" >&2; exit 2; }
mkdir -p "$1"
OUT_DIR="$(cd "$1" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/msdf-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PREFIX="$WORK/prefix"
SRC="$WORK/src"
mkdir -p "$PREFIX" "$SRC"

fetch() { # <url> <sha256> <name>
  curl -fsSL "$1" -o "$SRC/$3"
  echo "$2  $SRC/$3" | shasum -a 256 -c - >/dev/null
  mkdir -p "$SRC/${3%%.tar.*}"
  tar -xf "$SRC/$3" -C "$SRC/${3%%.tar.*}" --strip-components 1
}
fetch "https://github.com/Chlumsky/msdf-atlas-gen/archive/refs/tags/v${MSDF_ATLAS_VER}.tar.gz" "$MSDF_ATLAS_SHA" msdf-atlas-gen.tar.gz
fetch "https://github.com/Chlumsky/msdfgen/archive/refs/tags/v${MSDFGEN_VER}.tar.gz" "$MSDFGEN_SHA" msdfgen.tar.gz
fetch "https://downloads.sourceforge.net/project/freetype/freetype2/${FREETYPE_VER}/freetype-${FREETYPE_VER}.tar.xz" "$FREETYPE_SHA" freetype.tar.xz
fetch "https://downloads.sourceforge.net/project/libpng/libpng16/${LIBPNG_VER}/libpng-${LIBPNG_VER}.tar.xz" "$LIBPNG_SHA" libpng.tar.xz
fetch "https://github.com/leethomason/tinyxml2/archive/refs/tags/${TINYXML2_VER}.tar.gz" "$TINYXML2_SHA" tinyxml2.tar.gz

# Every package is found ONLY in our prefix: a Homebrew dylib picked up here would make the binary
# depend on the build machine again, which is the whole defect.
COMMON=(
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_OSX_ARCHITECTURES=arm64
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET"
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
  -DCMAKE_PREFIX_PATH="$PREFIX"
  -DCMAKE_IGNORE_PREFIX_PATH="/opt/homebrew;/usr/local"
  -DBUILD_SHARED_LIBS=OFF
)
build() { # <src-dir> <cmake args...>
  local dir="$1"; shift
  local log="$dir/build.log"
  echo "building $(basename "$dir")…"
  { cmake -S "$dir" -B "$dir/build" "${COMMON[@]}" "$@" &&
    cmake --build "$dir/build" --parallel &&
    cmake --install "$dir/build"; } >"$log" 2>&1 || { tail -40 "$log" >&2; exit 1; }
}

# freetype: FT_DISABLE_ZLIB uses freetype's own bundled inflate, so the static lib carries no
# dependency its consumers' FindFreetype would have to know about. PNG/HarfBuzz/Brotli/BZip2 only
# serve bitmap/colour glyphs and shaping, which an outline-based atlas never touches.
build "$SRC/freetype" -DFT_DISABLE_ZLIB=ON -DFT_DISABLE_BZIP2=ON -DFT_DISABLE_PNG=ON \
  -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BROTLI=ON
build "$SRC/libpng" -DPNG_SHARED=OFF -DPNG_STATIC=ON -DPNG_TESTS=OFF -DPNG_TOOLS=OFF -DPNG_FRAMEWORK=OFF
build "$SRC/tinyxml2" -Dtinyxml2_BUILD_TESTING=OFF
build "$SRC/msdfgen" -DMSDFGEN_USE_VCPKG=OFF -DMSDFGEN_USE_SKIA=OFF -DMSDFGEN_INSTALL=ON \
  -DMSDFGEN_BUILD_STANDALONE=OFF -DMSDFGEN_DYNAMIC_LIBRARY=OFF
build "$SRC/msdf-atlas-gen" -DMSDF_ATLAS_USE_VCPKG=OFF -DMSDF_ATLAS_MSDFGEN_EXTERNAL=ON \
  -DMSDF_ATLAS_USE_SKIA=OFF -DMSDF_ATLAS_NO_ARTERY_FONT=ON -DMSDF_ATLAS_INSTALL=ON \
  -DMSDF_ATLAS_DYNAMIC_LIBRARY=OFF -DCMAKE_CXX_STANDARD=17

BUILT="$PREFIX/bin/msdf-atlas-gen"
# Refuse an artifact that still links anything outside the OS.
if otool -L "$BUILT" | tail -n +2 | grep -Ev '^[[:space:]]+/usr/lib/|^[[:space:]]+/System/' ; then
  echo "error: $BUILT links a non-system library (above) — refusing to package it" >&2
  exit 1
fi
"$BUILT" -version

STAGE="$WORK/stage/msdf-atlas-gen"
mkdir -p "$STAGE"
cp "$BUILT" "$STAGE/msdf-atlas-gen"
strip -x "$STAGE/msdf-atlas-gen"
# Ad-hoc sign: an unsigned arm64 binary is killed on launch. The release pack re-signs it for real.
codesign --force --sign - "$STAGE/msdf-atlas-gen"
TARBALL="$OUT_DIR/msdf-atlas-gen-${MSDF_ATLAS_VER}-macos-arm64.tar.gz"
tar -czf "$TARBALL" -C "$WORK/stage" msdf-atlas-gen
shasum -a 256 "$TARBALL"
