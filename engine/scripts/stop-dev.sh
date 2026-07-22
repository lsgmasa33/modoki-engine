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

# The lookup + kill live in Node so this works on every platform. `pgrep` does not exist
# in Git Bash (this script printed "Done." and killed nothing on Windows), and the old
# forward-slash pattern could not have matched the real Windows command line
# (`...\node_modules\.bin\\..\vite\bin\vite.js`) even where pgrep is present.
node "${ROOT}/engine/scripts/stopDevServer.mjs" "${ROOT}"
