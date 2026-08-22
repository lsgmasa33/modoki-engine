#!/usr/bin/env bash
#
# Round-trip every prefab of one or more projects through the editor's PREFAB-EDIT mode
# (open -> save -> exit), migrating each `.prefab.json` to the CURRENT serializer format so
# a later edit is a true no-op.
#
# The prefab sibling of engine/scripts/resave-scenes.sh, and it exists for the same reason:
# a committed prefab drifts behind the serializer (blank-string fields the writer now
# compacts away, default-value elision), so the FIRST time anyone edits one in the editor
# that single edit lands as a whole-file rewrite — sha churn that buries the real change in
# review. One pass converges; it is idempotent thereafter.
#
# Why this needs its own script (#125): `resave-scenes.sh` drives `load-scene` -> `save-all`,
# and there is no prefab equivalent — a prefab is only re-serialized as a side effect of
# EDITING it. Measured: after re-saving all 50 scenes on 2026-08-04, `git status` showed zero
# .prefab.json modifications. Prefab-edit mode is the missing round-trip, exposed to the relay
# as `prefab` -> prefabAction 'edit-open' | 'edit-save' | 'edit-exit'.
#
# Usage:
#   engine/scripts/resave-prefabs.sh games/sling demos/forest-camp
#   MODOKI_BACKEND_PORT=5181 engine/scripts/resave-prefabs.sh games/sling   # a worker clone
#
# Afterwards ALWAYS review with:
#   node engine/scripts/check-prefab-churn.mjs <same projects>
#
# ⚠️ SAME #124 HAZARD AS THE SCENE SWEEP, plus one extra of its own.
#    (1) Entering prefab-edit SAVES THE CURRENT SCENE first — deliberately, so the return
#        trip's reload-from-disk cannot destroy unsaved work (prefabEdit.ts). That is a real
#        scene write per prefab, so a project whose game code mutates authored state on load
#        would bake it. `games/chess` + `games/llm-test` are excluded below for exactly this,
#        and the script REFUSES them rather than trusting the operator to remember.
#    (2) The synthetic edit world runs the pipeline like any other scene, so a stopped-mode
#        system writing to a PREFAB entity would bake too. Nothing tags that as authored-vs-
#        runtime, but the #124 save-time warning fires on it — read the editor console.
#    check-prefab-churn.mjs catches both classes (entities/traits/values gained or lost);
#    run it before you stage anything.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PORT=${MODOKI_BACKEND_PORT:-5179}
BE="http://127.0.0.1:${PORT}"
# Per clone, keyed on the backend port — /tmp is machine-wide, so a bare name lets two
# clones sweeping at once overwrite each other's launch output, and this file is only ever
# read on the `FAILED to open` branch below (i.e. when a sibling's log misleads most).
LAUNCH_LOG="/tmp/resave-prefabs-launch-${PORT}.log"
cd "$ROOT"

# Projects whose game code mutates authored state on load (#124). Their scenes are still on
# the legacy format for that reason, and every prefab-edit open would re-save one.
EXCLUDED="games/chess games/llm-test"

[ $# -gt 0 ] || { echo "usage: $0 <project>... (e.g. games/sling)" >&2; exit 2; }

# Say which editor this will drive, up front. MODOKI_BACKEND_PORT defaults to 5179 — the MAIN
# clone's port — so running this from a worker clone without setting it launches an editor on
# a port that is not this clone's lane (measured: it did exactly that here on the first run).
# The launcher is repo-scoped so it can't kill a SIBLING clone's editor, but it can squat the
# port that clone expects to bind, and every later MCP call aimed at 5181 then finds nothing.
echo "[resave-prefabs] driving backend ${BE} (clone: ${ROOT##*/}, branch: $(git -C "$ROOT" branch --show-current 2>/dev/null))"

fail=0
for PROJ in "$@"; do
  echo "=== $PROJ ==="
  [ -d "$ROOT/$PROJ" ] || { echo "  no such project"; fail=1; continue; }
  case " $EXCLUDED " in
    *" $PROJ "*)
      echo "  REFUSED — excluded for #124 (its game code mutates authored state on load, and"
      echo "  entering prefab-edit saves the current scene). See this script's header."
      fail=1; continue;;
  esac

  # Repo-scoped launcher — never touches a sibling clone's editor.
  MODOKI_BACKEND_PORT="$PORT" engine/scripts/launch-editor.sh "$PROJ" > "$LAUNCH_LOG" 2>&1

  # Match the FULL projectRoot, not a bare substring (see resave-scenes.sh) — a future
  # `games/court-2` would make a loose match open the wrong project and rewrite its prefabs.
  ident=""; ready=""; st=""
  for _ in $(seq 1 60); do
    ident=$(curl -s --max-time 3 "$BE/api/identity" 2>/dev/null)
    case "$ident" in *"\"projectRoot\":\"$ROOT/$PROJ\""*) break;; esac
    sleep 2
  done
  case "$ident" in
    *"\"projectRoot\":\"$ROOT/$PROJ\""*) ;;
    *) echo "  FAILED to open (identity: ${ident:-none})"; tail -5 "$LAUNCH_LOG"; fail=1; continue;;
  esac

  # The backend answers before the renderer window exists, but edit-open needs the RENDERER —
  # gating only on the backend races and the first prefab fails with "timed out waiting for
  # the renderer".
  for _ in $(seq 1 60); do
    st=$(curl -s --max-time 5 "$BE/api/editor-state" 2>/dev/null)
    case "$st" in *'"scenePath"'*) ready=1; break;; esac
    sleep 2
  done
  [ -n "$ready" ] || { echo "  renderer never came up (last: ${st:-none})"; fail=1; continue; }

  # Served paths from the asset manifest — the same addressing edit-open takes. Reading the
  # manifest rather than globbing the filesystem keeps this honest about what the OPEN PROJECT
  # actually exposes (a prefab under a root the project doesn't serve isn't editable here).
  prefabs=$(curl -s "$BE/api/scan-assets" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
    (JSON.parse(s).assets||[]).filter(a=>a.type==="prefab").forEach(a=>console.log(a.path))
  }catch(e){}})')
  [ -n "$prefabs" ] || { echo "  no prefabs"; continue; }

  while IFS= read -r p; do
    body=$(node -e 'console.log(JSON.stringify({action:"prefab",prefabAction:"edit-open",path:process.argv[1],force:true}))' "$p")
    op=$(curl -s -X POST "$BE/api/editor-action" -H 'Content-Type: application/json' -d "$body")
    case "$op" in *'"ok":true'*) ;; *) echo "  OPEN FAILED $p -> $op"; fail=1; continue;; esac
    sleep 1
    sv=$(curl -s -X POST "$BE/api/editor-action" -H 'Content-Type: application/json' \
           -d '{"action":"prefab","prefabAction":"edit-save"}')
    case "$sv" in *'"ok":true'*) echo "  saved $p";; *) echo "  SAVE FAILED $p -> $sv"; fail=1;; esac
    # Always leave edit mode, even after a failed save: the next edit-open would otherwise
    # enter from the SYNTHETIC prefab world, whose scene path is null.
    curl -s -X POST "$BE/api/editor-action" -H 'Content-Type: application/json' \
      -d '{"action":"prefab","prefabAction":"edit-exit"}' > /dev/null
    sleep 1
  done <<< "$prefabs"
done

exit $fail
