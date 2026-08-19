#!/usr/bin/env bash
#
# Stop THIS clone's Electron editor — the counterpart `launch-editor.sh` never had (#129).
#
# Why it exists: before this, nothing stopped a launched editor.
#   - `npm run dev:stop` killed the Vite the EDITOR owns and left the editor running, so
#     the app window stayed up with a dead dev server behind it. That presents as "the
#     game is broken", not as "something was stopped" — it once read as a game bug and
#     cost a debugging session. (Fixed too: dev:stop now leaves that Vite alone.)
#   - `POST <backend>/api/exit` 404s. `/api/exit` is a VITE dev-server route, so it lives
#     on the Vite port (5175), not on the backend port (5181) that MODOKI_BACKEND and the
#     launch banner advertise. Aiming it at the port you were told to use cannot work.
# So the only reliable stop was `kill <pid>` by hand, looked up by eye.
#
# Repo-scoped, like the launcher: every reap matches THIS repo's absolute paths, so a
# sibling clone's editor is never touched (#69). Stopping the Electron main process first
# is what makes this clean — the editor owns its Vite and stops it on quit, and the
# launcher's background waiter gets to write its EXIT line to ~/.modoki/editor-launches.log.
#
# Usage:
#   engine/scripts/stop-editor.sh          # stop this clone's editor
#   npm run editor:stop
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=lib/repo-reap.sh
. "$REPO/engine/scripts/lib/repo-reap.sh"

MAIN="$REPO/engine/electron/dist/main.cjs"
VITE="$REPO/node_modules/vite/bin/vite.js"

if ! reap_repo_alive "$MAIN" && ! reap_repo_alive "$VITE"; then
  echo "[stop-editor] no editor running for this clone ($REPO)."
  exit 0
fi

echo "[stop-editor] stopping this clone's editor: $REPO"
reap_repo_process "$MAIN"

# Give Electron a graceful window to run its exit hooks — that is what takes its OWN Vite
# down with it, and what makes the launch log's EXIT line appear. Poll rather than sleeping
# a flat interval so a clean quit returns immediately.
#
# The window is 15s, not the 5s it was. A SIGKILL is not just a blunt stop here: Chromium
# commits the localStorage LevelDB on a CLEAN SHUTDOWN, so forcing discards every write since
# the last commit — the saved panel layout, panel/expansion state, and the game's
# `@editor`-namespace PlayerPrefs. Measured 2026-08-19 (docs/player-prefs.md § Gotchas): a
# value confirmed present in localStorage survives a graceful stop and is GONE after a
# SIGKILL, at 0s and at 8s after the write, so waiting for the flush is not an option — only
# letting the process exit on its own is.
#
# 5s turned out to be short enough that a healthy-but-slow exit hit the force path twice in
# one session. The trade is deliberately one-sided: a genuinely wedged editor now costs 10
# extra seconds and still dies, while a healthy one keeps state you would otherwise re-set by
# hand.
GRACEFUL_POLLS=60   # × 0.25s = 15s
for _ in $(seq 1 $GRACEFUL_POLLS); do
  reap_repo_alive "$MAIN" || break
  sleep 0.25
done

if reap_repo_alive "$MAIN"; then
  # Say what forcing COSTS. A layout that silently reverts reads as the editor losing your
  # work at random; naming it here is the difference between a known trade and a mystery.
  echo "[stop-editor] editor did not exit gracefully after ${GRACEFUL_POLLS}×0.25s — forcing."
  echo "[stop-editor]   ⚠️  A forced stop discards this editor's UNCOMMITTED localStorage:"
  echo "[stop-editor]       saved layout, panel state, and the game's @editor PlayerPrefs."
  echo "[stop-editor]       Chromium only commits those on a clean exit. Not a crash — see"
  echo "[stop-editor]       docs/player-prefs.md § Gotchas."
  reap_repo_force "$MAIN"
fi

# Let the Vite the editor owns finish dying before calling it orphaned. Electron's SIGTERM hook
# SIGKILLs its child (devServer.ts installExitHook), but the child is not reaped the instant the
# parent is — measured, the main process is gone within one 0.25s poll while its Vite lags. Both
# outcomes have been observed on this machine: sometimes the Vite is gone by the second poll,
# sometimes it outlives the whole 3s window and really is left behind. So this wait is not a
# formality and the sweep below is not dead code; the wait exists so a SLOW-but-clean teardown
# is not announced as an orphan, which is the kind of message-that-misdescribes-reality this
# issue was filed about.
for _ in $(seq 1 12); do
  reap_repo_alive "$VITE" || break
  sleep 0.25
done

# The genuine straggler case: the editor died without reaping its child, or was already gone and
# left its Vite behind. Scoped to this repo, so it cannot hit a sibling clone — and by now there
# is no editor of OURS left to own it.
if reap_repo_alive "$VITE"; then
  echo "[stop-editor] sweeping the orphaned dev server it left behind."
  reap_repo_process "$VITE"
  sleep 0.5
  reap_repo_alive "$VITE" && reap_repo_force "$VITE"
fi

echo "[stop-editor] Done."
