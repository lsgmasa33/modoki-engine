#!/usr/bin/env bash
# Relaunch the Modoki editor for the CURRENT git worktree, on the backend port
# that worktree owns (see CLAUDE.md "Git Worktree" table). One command works in
# either checkout — the port is derived from the branch, so you can't accidentally
# launch on the other worktree's port and collide.
#
#   engine/scripts/relaunch-editor.sh [project-dir]
#
#   main     branch → backend 5179   (default)
#   work-ai  branch → backend 5180
#   (any other branch → 5179)
#
# [project-dir] defaults to games/3d-test; pass another to open a different game,
# e.g.  npm run editor -- games/space-console
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
case "$BRANCH" in
  work-ai) PORT=5180 ;;
  *)       PORT=5179 ;;
esac

PROJECT="${1:-games/3d-test}"
echo "[relaunch-editor] worktree branch '$BRANCH' → backend $PORT, project $PROJECT"
MODOKI_BACKEND_PORT="$PORT" exec bash "$REPO/engine/scripts/launch-editor.sh" "$PROJECT"
