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
# ── The SECOND SPELLING (#913) ────────────────────────────────────────────────────────────────
#
# Every matcher here compares OUR pattern against a string we do NOT control: the command line a
# foreign process was LAUNCHED with. So there is nothing to canonicalise on the other side, and
# canonicalising only ours is strictly worse — it breaks the ordinary case that works today while
# fixing the symlinked one. The only correct shape is to match a SET of spellings, which is what
# #908 landed for `dev:stop` in JS and this brings to the bash reaps.
#
# The clone's two spellings are its LOGICAL path (bash `pwd`, which keeps the symlink) and its
# PHYSICAL one (`pwd -P`). A launcher run through a symlinked clone puts the logical spelling in
# its children's argv; a stopper invoked another way may derive the physical one, and vice versa.
# Registering both here means the callers below inherit it — deliberately NOT a second argument on
# every call, because stop-editor.sh alone reaps at eight sites and a missed one is a silent
# partial fix, which is the very defect class this is fixing.
#
# ⚠️ **Two sequential invocations, NEVER an alternation.** `pkill -f` takes an ERE, so a pattern
# built as "$A|$B" with either side empty collapses to something matching EVERY PROCESS ON THE
# MACHINE — #69's disaster reintroduced by the fix meant to prevent it. Guarding the operands is
# not enough on its own; the shape has to be incapable of it.
MODOKI_REAP_ROOT="${MODOKI_REAP_ROOT:-}"
MODOKI_REAP_ROOT_PHYS="${MODOKI_REAP_ROOT_PHYS:-}"

# Callers register their clone's two root spellings ONCE, before any reap.
reap_repo_register_roots() { # $1 = logical root (pwd), $2 = physical root (pwd -P)
  MODOKI_REAP_ROOT="${1:-}"
  MODOKI_REAP_ROOT_PHYS="${2:-}"
}

# The alternate spelling of a pattern, or NOTHING when there is no distinct one.
#
# Prints nothing rather than echoing $1 back: callers run "the pattern, then whatever this
# prints", so returning $1 would reap the same pattern twice. Every precondition is a guard
# against widening the match — unregistered, identical spellings, a non-absolute root, or a
# pattern not under the registered root all yield no second reap at all.
reap_alt_pattern() { # $1 = absolute path fragment built from the LOGICAL root
  [ -n "${MODOKI_REAP_ROOT}" ] || return 0
  [ -n "${MODOKI_REAP_ROOT_PHYS}" ] || return 0
  [ "${MODOKI_REAP_ROOT}" != "${MODOKI_REAP_ROOT_PHYS}" ] || return 0
  case "${MODOKI_REAP_ROOT_PHYS}" in /*) ;; *) return 0 ;; esac
  case "$1" in "${MODOKI_REAP_ROOT}"/*) ;; *) return 0 ;; esac
  printf '%s' "${MODOKI_REAP_ROOT_PHYS}${1#"${MODOKI_REAP_ROOT}"}"
}

reap_repo_process() { # $1 = absolute path fragment identifying this repo's process
  _reap_repo_process_one "$1"
  local alt; alt="$(reap_alt_pattern "$1")"
  [ -n "$alt" ] && _reap_repo_process_one "$alt"
  return 0
}

_reap_repo_process_one() { # $1 = one exact spelling
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

# True while any process matching the fragment is still alive.
#
# WINDOWS: this used to `return 1` unconditionally, on the reasoning that the CIM reap above is
# already a forced stop so the POLLING callers can treat it as done. That is true of the polling
# loops and false of every other caller — and `stop-editor.sh` opens with
# `if ! reap_repo_alive MAIN && ! reap_repo_alive VITE; then echo "no editor running"; exit 0`.
# With a constant false, that guard always fired: `npm run editor:stop` printed "no editor
# running for this clone" and exited 0 WITHOUT STOPPING ANYTHING, on every Windows run, while
# the editor and its Vite carried on. The sanctioned way to stop an editor was a no-op that
# reported success. Measured on the win clone: electron.exe and vite.js both still up
# immediately after a "Done."-free clean exit, still serving 5173.
#
# So answer the question for real, with the same CIM query and the same absolute-path scoping
# the reap uses (a sibling clone is never matched). `$PID` excludes this powershell itself,
# whose own command line contains the pattern.
reap_repo_alive() { # $1 = the same absolute path fragment
  if _reap_repo_alive_one "$1"; then return 0; fi
  local alt; alt="$(reap_alt_pattern "$1")"
  [ -n "$alt" ] && _reap_repo_alive_one "$alt"
}

_reap_repo_alive_one() { # $1 = one exact spelling
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      local pat_m pat_w n
      pat_m="$(cygpath -m "$1" 2>/dev/null || echo "$1")"
      pat_w="$(cygpath -w "$1" 2>/dev/null || echo "$1")"
      n="$(powershell.exe -NoProfile -NonInteractive -Command \
        "@(Get-CimInstance Win32_Process | Where-Object { \$_.ProcessId -ne \$PID -and (\$_.CommandLine -like '*$pat_m*' -or \$_.CommandLine -like '*$pat_w*') }).Count" \
        2>/dev/null | tr -d '\r\n ')"
      [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null
      ;;
    *) pgrep -f "$1" >/dev/null 2>&1 ;;
  esac
}

# SIGKILL the stragglers, for a caller that already gave them a graceful window.
reap_repo_force() { # $1 = the same absolute path fragment
  _reap_repo_force_one "$1"
  local alt; alt="$(reap_alt_pattern "$1")"
  [ -n "$alt" ] && _reap_repo_force_one "$alt"
  return 0
}

_reap_repo_force_one() { # $1 = one exact spelling
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) reap_repo_process "$1" ;;
    *) pkill -9 -f "$1" 2>/dev/null || true ;;
  esac
}
