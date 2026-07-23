#!/usr/bin/env bash
# Launch the Modoki Electron editor (dev mode, HMR via the Vite dev server).
#
#   scripts/launch-editor.sh [project-dir]
#
# - Pins the Electron backend to a fixed loopback port (MODOKI_BACKEND_PORT) so the
#   Modoki MCP server has a stable target for the FULL toolset (capture/tap/drag/
#   render need the Electron backend, not the Vite dev server).
# - Clears any stray Vite dev server (5173); main now OWNS the Vite process so
#   "Open Project" can re-root it live (the renderer loads the shell + the open
#   project's game code + assets from it). main spawns it rooted at MODOKI_PROJECT.
# - Builds the esbuild main/preload bundle, then launches Electron in the background.
# - An EXPLICIT [project-dir] arg HARD-forces that project (wins over the editor's
#   last-opened "recents" memory) — if you name a project, you get that project.
#   Bare launches (no arg) reopen your last-opened project (recents), falling back
#   to the dev default. To force soft/seed-only behavior for an arg, set
#   MODOKI_PROJECT_SOFT=1. A pre-set MODOKI_PROJECT env still hard-wins over the arg.
#
# Prints the backend URL to point MODOKI_BACKEND at.
set -euo pipefail

# engine/scripts/ → repo root (npm/package.json + node_modules live there).
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

# MODOKI_MULTI=1 launches an ADDITIONAL editor alongside running ones: it skips
# the single-instance cleanup (no pkill, no dev:stop) and lets main auto-pick free
# Vite + backend ports (findFreePort) so nothing clashes. Default (unset) keeps the
# single-instance behavior: relaunch replaces the prior editor on the stable 5179.
MULTI="${MODOKI_MULTI:-}"
# In multi mode leave the backend port unset so each editor auto-picks a free one.
if [ -n "$MULTI" ]; then BACKEND_PORT="${MODOKI_BACKEND_PORT:-}"; else BACKEND_PORT="${MODOKI_BACKEND_PORT:-5179}"; fi
PROJECT="${1:-}"
# An explicitly-named project HARD-forces itself (MODOKI_PROJECT), which wins over
# recents in main's resolveInitialProject (envProject → recents → envDefault): if you
# type a project, you open THAT project, not whatever you had open last. A bare launch
# passes nothing, so recents win (reopen last project) → dev default. MODOKI_PROJECT_SOFT=1
# downgrades the arg to a seed-only default (old behavior). A pre-set MODOKI_PROJECT env
# (CI/build) is left untouched and still hard-wins over the arg.
# (A `${PROJECT:+VAR=val}` env-prefix from a shell *expansion* is NOT treated as an
# assignment by bash — it becomes a bogus command — so export it explicitly instead.)
if [ -n "$PROJECT" ]; then
  if [ -n "${MODOKI_PROJECT_SOFT:-}" ]; then
    export MODOKI_PROJECT_DEFAULT="$PROJECT"
  elif [ -z "${MODOKI_PROJECT:-}" ]; then
    export MODOKI_PROJECT="$PROJECT"
  fi
fi
# Per-instance logs so parallel editors (multiple worktrees, or MULTI mode) don't
# clobber each other's log — keyed on the pinned backend port (distinct per
# worktree: main 5179 / work-ai 5180), falling back to this launcher's PID when the
# port is auto-picked (MULTI mode). Without this every editor writes the same
# /tmp/modoki-editor.log and you read the wrong instance's output.
LOG_TAG="${BACKEND_PORT:-$$}"
VITE_LOG="/tmp/modoki-vite-${LOG_TAG}.log"
EDITOR_LOG="/tmp/modoki-editor-${LOG_TAG}.log"

# 1. Stop ONLY this repo's prior editor + the Vite it owns — matched by this
#    repo's ABSOLUTE paths so a sibling git worktree's editor (a DIFFERENT path,
#    e.g. ~/Projects/modoki-ai/...) is never touched. (The old cleanup matched the
#    editor by RELATIVE path `engine/electron/dist/main.cjs` and stopped Vite via
#    `npm run dev:stop`, which curls /api/exit on the shared ports 5173-5176 — both
#    killed OTHER worktrees' editors. Multi-worktree bug.) main spawns Vite from
#    `$REPO/node_modules/vite/bin/vite.js` and stops it on quit; the second pkill
#    sweeps any straggler if a prior editor died uncleanly. We launch the editor
#    with its absolute main.cjs (step 3) so the first pkill can match it precisely.
#    Skipped in multi mode (run several editors of the SAME repo side by side).
#
#    WINDOWS: `pkill -f` matches against the command LINE, which MSYS/Git-Bash
#    cannot see for native Windows processes — `ps -W` lists electron.exe by
#    executable path only, with zero argument text. So the pattern never matched,
#    the `|| true` swallowed it silently, and the old editor survived to hold the
#    pinned port (main then refuses to drift → a modal "port already in use"
#    error). Match on the real command line via CIM there instead; still scoped to
#    THIS repo's absolute path, so a sibling clone's editor is never touched.
kill_repo_process() { # $1 = absolute path fragment identifying this repo's process
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      local pat_m pat_w
      # MSYS converts a unix path to a MIXED-mode path (E:/a/b) when it hands an
      # argument to a native exe, so that is the form that actually appears in
      # electron's command line — NOT the backslash form `cygpath -w` returns.
      # Match BOTH so either spelling is caught. (`\` is not a -like wildcard.)
      pat_m="$(cygpath -m "$1" 2>/dev/null || echo "$1")"
      pat_w="$(cygpath -w "$1" 2>/dev/null || echo "$1")"
      # Exclude THIS powershell process: the pattern is part of its own command
      # line, so an unfiltered query matches itself and kills the killer.
      powershell.exe -NoProfile -NonInteractive -Command \
        "Get-CimInstance Win32_Process | Where-Object { \$_.ProcessId -ne \$PID -and (\$_.CommandLine -like '*$pat_m*' -or \$_.CommandLine -like '*$pat_w*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" \
        >/dev/null 2>&1 || true
      ;;
    *)
      pkill -f "$1" 2>/dev/null || true
      ;;
  esac
}

if [ -z "$MULTI" ]; then
  kill_repo_process "$REPO/engine/electron/dist/main.cjs"
  kill_repo_process "$REPO/node_modules/vite/bin/vite.js"
  # Windows releases a listening socket a beat after the owning process dies;
  # too short a wait and the relaunch races the port it just freed.
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) sleep 2 ;; *) sleep 0.5 ;; esac
fi

# 2. Build the Electron main/preload bundle.
echo "[launch-editor] building electron bundle…"
npm run electron:build >/dev/null 2>&1

# 3. Launch Electron in the background. Pass the ABSOLUTE main.cjs path so the
#    process is identifiable by THIS repo's path (the repo-scoped pkill in step 1
#    relies on it). With a pinned backend port (single-instance default) export it;
#    in multi mode leave it unset so main auto-picks free ports.
: > "$EDITOR_LOG"
echo "[launch-editor] launching editor (${BACKEND_PORT:+backend port $BACKEND_PORT}${BACKEND_PORT:+, }${BACKEND_PORT:-auto ports}${PROJECT:+, project $PROJECT})…"
[ -n "$BACKEND_PORT" ] && export MODOKI_BACKEND_PORT="$BACKEND_PORT"
# CDP remote-debugging port — lets CDP tooling attach to the renderer (inject console
# errors, read React fiber state, catch WGSL validation, capture the TRUE framebuffer)
# WITHOUT a manual relaunch. Chromium binds it to 127.0.0.1 only, so it's local-dev only.
# This editor is agent-first, so CDP is ON BY DEFAULT in dev too (matching the packaged
# app, which defaults on via cdp.ts's opt-out model):
#   - An explicit MODOKI_CDP_PORT always wins (validated 1..65535; junk → warn + off).
#     Chromium parses junk as 0 → an ephemeral/random port that silently diverges from
#     what main reports, so reject an invalid value loudly instead of guessing.
#   - Unset + a PINNED backend port ⇒ derive a per-clone-safe default: 9222 + (backend
#     − 5179), so 5179→9222, 5180→9223, 5181→9224 — distinct per clone, so two clones
#     side by side never collide on the CDP port (the documented cross-clone gotcha).
#   - Unset + an AUTO backend port (MULTI mode) ⇒ CDP off: there's no stable per-clone
#     anchor to derive from, and several editors would race one port. Set MODOKI_CDP_PORT
#     explicitly to force it there.
# (mirrors cdp.ts isValidCdpPort: an integer in 1..65535.)
valid_cdp_port() { echo "${1:-}" | grep -qE '^[0-9]+$' && [ "${1:-0}" -ge 1 ] && [ "${1:-0}" -le 65535 ]; }
CDP_ARG=""
CDP_PORT=""
if [ -n "${MODOKI_CDP_PORT:-}" ]; then
  if valid_cdp_port "$MODOKI_CDP_PORT"; then
    CDP_PORT="$MODOKI_CDP_PORT"
  else
    echo "[launch-editor] WARNING: ignoring invalid MODOKI_CDP_PORT='${MODOKI_CDP_PORT}' (want an integer 1..65535) — CDP off."
  fi
elif [ -n "$BACKEND_PORT" ] && echo "$BACKEND_PORT" | grep -qE '^[0-9]+$'; then
  DERIVED=$((9222 + BACKEND_PORT - 5179))
  if valid_cdp_port "$DERIVED"; then
    CDP_PORT="$DERIVED"
  fi
fi
[ -n "$CDP_PORT" ] && CDP_ARG="--remote-debugging-port=${CDP_PORT}"
nohup ./node_modules/.bin/electron $CDP_ARG "$REPO/engine/electron/dist/main.cjs" >"$EDITOR_LOG" 2>&1 &
EDITOR_PID=$!

# 4. Wait for the backend to announce itself, then report.
#    A timeout is a FAILURE, not a success. The old loop only errored when the
#    process DIED — but a startup error (e.g. "port already in use") leaves
#    Electron ALIVE showing a modal dialog, so the loop simply ran out and fell
#    through to the "✓ Editor running" banner with an empty PORT backfilled from
#    $BACKEND_PORT. That reported a healthy editor that had never started.
READY=""
for _ in $(seq 1 60); do
  if grep -q "backend listening on" "$EDITOR_LOG"; then READY=1; break; fi
  kill -0 "$EDITOR_PID" 2>/dev/null || { echo "[launch-editor] ERROR: editor exited early (see $EDITOR_LOG)"; tail -5 "$EDITOR_LOG"; exit 1; }
  sleep 0.5
done
if [ -z "$READY" ]; then
  echo "[launch-editor] ERROR: editor never announced its backend within 30s (see $EDITOR_LOG)"
  echo "[launch-editor]        it is still running (pid $EDITOR_PID) — likely a startup error dialog."
  grep -iE "error|already in use|refusing" "$EDITOR_LOG" | tail -5 || tail -5 "$EDITOR_LOG"
  exit 1
fi

PORT="$(grep -oE 'listening on http://127.0.0.1:[0-9]+' "$EDITOR_LOG" | grep -oE '[0-9]+$' | head -1 || true)"
echo
echo "[launch-editor] ✓ Editor running (pid $EDITOR_PID)."
echo "[launch-editor]   Backend:      http://127.0.0.1:${PORT:-$BACKEND_PORT}"
echo "[launch-editor]   MCP target:   MODOKI_BACKEND=http://127.0.0.1:${PORT:-$BACKEND_PORT}  (full toolset)"
if [ -n "$CDP_PORT" ]; then
  echo "[launch-editor]   CDP:          http://127.0.0.1:${CDP_PORT}  (renderer remote-debugging)"
else
  echo "[launch-editor]   CDP:          off (auto backend port; set MODOKI_CDP_PORT to enable)"
fi
echo "[launch-editor]   Log:          $EDITOR_LOG"
