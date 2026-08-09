# Repo-scoped process reaping — sourced, not executed.
#
# Several clones of this repo share one machine (CLAUDE.md § Clones) and all run binaries
# with identical names from identically-shaped relative paths. So every reap here matches
# an ABSOLUTE path belonging to ONE clone; a product name or a relative fragment like
# `engine/electron/dist/main.cjs` would kill every clone's editor (#69, guarded by
# engine/tests/architecture/reapScoping.test.ts).
#
# Lives in its own file because `launch-editor.sh` (which reaps a prior editor before
# relaunching) and `stop-editor.sh` (which reaps the current one) need the SAME matcher —
# and the Windows branch below is subtle enough that two copies would drift.

# Stop this repo's processes matching an absolute path fragment. SIGTERM only: callers
# that need a force pass follow up with reap_repo_force.
#
# WINDOWS: `pkill -f` matches against the command LINE, which MSYS/Git-Bash cannot see for
# native Windows processes — `ps -W` lists electron.exe by executable path only, with zero
# argument text. So the pattern never matched, the `|| true` swallowed it silently, and the
# old editor survived to hold the pinned port (main then refuses to drift → a modal "port
# already in use" error). Match on the real command line via CIM there instead; still scoped
# to THIS repo's absolute path, so a sibling clone's editor is never touched.
reap_repo_process() { # $1 = absolute path fragment identifying this repo's process
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      local pat_m pat_w
      # MSYS converts a unix path to a MIXED-mode path (E:/a/b) when it hands an argument
      # to a native exe, so that is the form that actually appears in electron's command
      # line — NOT the backslash form `cygpath -w` returns. Match BOTH so either spelling
      # is caught. (`\` is not a -like wildcard.)
      pat_m="$(cygpath -m "$1" 2>/dev/null || echo "$1")"
      pat_w="$(cygpath -w "$1" 2>/dev/null || echo "$1")"
      # Exclude THIS powershell process: the pattern is part of its own command line, so an
      # unfiltered query matches itself and kills the killer.
      powershell.exe -NoProfile -NonInteractive -Command \
        "Get-CimInstance Win32_Process | Where-Object { \$_.ProcessId -ne \$PID -and (\$_.CommandLine -like '*$pat_m*' -or \$_.CommandLine -like '*$pat_w*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" \
        >/dev/null 2>&1 || true
      ;;
    *)
      pkill -f "$1" 2>/dev/null || true
      ;;
  esac
}

# True while any process matching the fragment is still alive. Unix-only signal (`pgrep`);
# on Windows the CIM reap above is already a forced stop, so callers treat it as done.
reap_repo_alive() { # $1 = the same absolute path fragment
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 1 ;;
    *) pgrep -f "$1" >/dev/null 2>&1 ;;
  esac
}

# SIGKILL the stragglers, for a caller that already gave them a graceful window.
reap_repo_force() { # $1 = the same absolute path fragment
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) reap_repo_process "$1" ;;
    *) pkill -9 -f "$1" 2>/dev/null || true ;;
  esac
}
