#!/usr/bin/env bash
# Stop the standalone Vite dev server for THIS repo only (`npm run dev`).
#
# Repo-scoped: matched by this repo's own node_modules vite path, so it NEVER
# touches a sibling git worktree's dev server. (It used to first curl /api/exit on
# the shared ports 5173-5176 — which killed whatever dev server was on them,
# including OTHER worktrees' editors. That blind port loop is removed; it was the
# multi-worktree bug.) The Electron editor OWNS + stops the Vite it spawned on
# quit, so this doesn't target that one — quit the editor to stop it.
set -uo pipefail

# Repo root (engine/scripts → two up): node_modules/.bin/vite lives there.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pids=$(pgrep -f "${ROOT}/node_modules/.bin/vite" || true)
if [ -n "${pids}" ]; then
  echo "Stopping this repo's dev server: ${pids}"
  # shellcheck disable=SC2086
  kill ${pids} 2>/dev/null || true   # SIGTERM (graceful)
  sleep 1
  # shellcheck disable=SC2086
  kill -9 ${pids} 2>/dev/null || true # SIGKILL any straggler
fi
echo "Done."
