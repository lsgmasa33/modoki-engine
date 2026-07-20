#!/usr/bin/env bash
# Build a signed + notarized + stapled macOS distributable WITHOUT putting any
# secret on the command line.
#
#   npm run dist:notarized
#
# Loads Apple notarization credentials from `.env.notarize` (gitignored; copy
# .env.notarize.example to create it) and runs the normal `npm run dist`. The
# afterSign hook (engine/scripts/notarize.cjs) notarizes + staples the .app and
# the afterAllArtifactBuild hook (engine/scripts/staple-dmg.cjs) does the .dmg —
# both auto-detect the API-key trio from the env.
#
# Why a file, not inline env: an app-specific password (or API key) passed on the
# command line is visible in `ps`/shell history. Reading it from a gitignored
# file keeps it off both.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

ENV_FILE="${MODOKI_NOTARIZE_ENV:-.env.notarize}"
if [ ! -f "$ENV_FILE" ]; then
  echo "[dist-notarized] ERROR: $ENV_FILE not found." >&2
  echo "[dist-notarized] Copy .env.notarize.example to .env.notarize and fill in your" >&2
  echo "[dist-notarized] App Store Connect API key trio (see that file for how to get one)." >&2
  exit 1
fi

# Export every assignment in the env file. `set -a` makes sourced vars exported.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Resolve a repo-relative .p8 path to absolute (electron-builder runs hooks with
# varying cwd; @electron/notarize + notarytool want a real path).
if [ -n "${APPLE_API_KEY:-}" ] && [ "${APPLE_API_KEY#/}" = "$APPLE_API_KEY" ]; then
  export APPLE_API_KEY="$REPO/$APPLE_API_KEY"
fi

if [ -n "${APPLE_API_KEY:-}" ]; then
  if [ ! -f "$APPLE_API_KEY" ]; then
    echo "[dist-notarized] ERROR: APPLE_API_KEY points at a missing file: $APPLE_API_KEY" >&2
    exit 1
  fi
  echo "[dist-notarized] using App Store Connect API key (id ${APPLE_API_KEY_ID:-?})"
elif [ -n "${APPLE_ID:-}" ]; then
  echo "[dist-notarized] using app-specific password for ${APPLE_ID}"
else
  echo "[dist-notarized] ERROR: $ENV_FILE has neither APPLE_API_KEY nor APPLE_ID creds." >&2
  exit 1
fi

exec npm run dist
