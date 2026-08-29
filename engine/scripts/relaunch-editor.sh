#!/usr/bin/env bash
# Relaunch the Modoki editor for the CURRENT clone, on the backend port that clone
# owns (see CLAUDE.md "Clones" table). One command works in every clone — the port
# is derived from the CLONE DIRECTORY, so you can't accidentally launch on another
# clone's port and collide.
#
#   engine/scripts/relaunch-editor.sh [project-dir]
#
# The clone → port table is NOT duplicated here — see `editorPorts.mjs`. It used to
# be a `case "$BRANCH" in …` table in this file, keyed on the BRANCH rather than the
# directory, and it went stale: `work-ai3` and `work-qa` were never added, so both
# fell through to the `*` case and got 5179 — the HUB's port — same bug as the
# other three copies #349 fixed. Keying on the directory instead of the branch also
# means a clone temporarily checked out to another branch still gets its own port.
#
# [project-dir] defaults to games/3d-test; pass another to open a different game,
# e.g.  npm run editor -- games/space-console
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
# An unknown clone directory yields empty, which is the correct degrade (auto ports) —
# launch-editor.sh treats an empty MODOKI_BACKEND_PORT exactly the way MULTI mode does.
# `|| true` INSIDE the substitution, not after it: after it, the `|| true` is plain TEXT
# appended to the value ("5180 || true"), and under `set -e` a missing node would kill
# this script outright instead of degrading. Both mistakes were made here first.
PORT="$(node "$REPO/engine/scripts/editorPorts.mjs" backend "$REPO" || true)"

PROJECT="${1:-games/3d-test}"
echo "[relaunch-editor] clone '$(basename "$REPO")' (branch '$BRANCH') → backend ${PORT:-auto}, project $PROJECT"
# Only EXPORT the pin when there is one. Setting it empty is not neutral: launch-editor.sh's
# `${MODOKI_BACKEND_PORT:-…}` treats empty as unset and re-derives, so the unknown-clone
# warning would print twice — once here, once there — reading like two separate faults.
if [ -n "$PORT" ]; then
  MODOKI_BACKEND_PORT="$PORT" exec bash "$REPO/engine/scripts/launch-editor.sh" "$PROJECT"
else
  exec bash "$REPO/engine/scripts/launch-editor.sh" "$PROJECT"
fi
