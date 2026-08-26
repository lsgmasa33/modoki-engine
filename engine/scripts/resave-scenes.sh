#!/usr/bin/env bash
#
# Round-trip every scene of one or more projects through the editor (load -> save),
# migrating them to the CURRENT serializer format so a later save is a true no-op.
#
# Why this exists: committed scenes drift behind the serializer (compaction of default
# values, the A10 `rootInstanceId` runtime-id -> GUID fix, resource-manifest rebuilds).
# Until a scene is re-saved once, any incidental save produces a huge diff — sha churn
# that buries real edits in review. One pass converges; it is idempotent thereafter
# (verified byte-identical across fresh editor processes).
#
# Usage:
#   engine/scripts/resave-scenes.sh games/sling demos/forest-camp
#   MODOKI_BACKEND_PORT=5180 engine/scripts/resave-scenes.sh games/sling   # override (no longer required)
#
# Afterwards ALWAYS review with:
#   node engine/scripts/check-scene-churn.mjs <same projects>
#
# ⚠️ DO NOT sweep a project whose game code MUTATES AUTHORED STATE ON LOAD (#124).
#    `save-all` persists the LIVE world. The SPAWN half of this is fixed — an entity spawned
#    from inside a system tick is tagged Transient at the spawn site and never serialized
#    (docs/scene-loading.md, the provenance rule) — so games/chess no longer bakes its ~70
#    runtime entities. The MUTATION half — a stopped-mode system writing to an AUTHORED
#    entity, which no tag can reach — is fixed too, but only for a projection that opts in
#    with `pauseWhileStopped` (chess + llm-test do; verified live, their load→save is now
#    semantically a no-op). The hazard therefore remains OPEN for any other project: a save
#    now WARNS, naming each authored field a system rewrote while stopped, so read the
#    editor console before trusting a sweep. (games/space-invader was also excluded, for #123 — the manifest
#    rebuild dropped an asset ref held on a game-specific trait. Fixed by the generic guid
#    sweep in collectResourceRefsFromEntities; it is re-saved and no longer excluded.)
#    check-scene-churn.mjs catches the runtime-entity class, and compares the resource
#    manifest by IDENTITY — a dropped ref the scene still references fails it (exit 1).
#    Run it before you stage anything.
#    Prefabs are covered by a sibling script, not this one: engine/scripts/resave-prefabs.sh
#    (#125) — load-scene has no prefab equivalent, so prefabs round-trip through prefab-edit
#    mode instead.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# PORT used to default to 5179 — the HUB's pinned port — so a bare run from a worker
# clone drove the HUB's editor over HTTP instead of failing (#349). Derive from the
# clone directory instead; unlike the launcher's "auto ports" degrade, an empty
# result here would build a nonsense `http://127.0.0.1:` URL and fail confusingly
# deep inside the curl loop below, so fail loud up front instead.
PORT="${MODOKI_BACKEND_PORT:-$(node "$ROOT/engine/scripts/editorPorts.mjs" backend "$ROOT" || true)}"
[ -n "$PORT" ] || { echo "[resave-scenes] '$(basename "$ROOT")' is not a known clone and MODOKI_BACKEND_PORT is unset — refusing to guess which editor to drive. Set MODOKI_BACKEND_PORT explicitly." >&2; exit 2; }
BE="http://127.0.0.1:${PORT}"
# Per clone, keyed on the backend port like every other editor-adjacent temp path here:
# /tmp is machine-wide, so a bare name means two clones resaving at once overwrite each
# other's launch output — and the only time this file is read is the `FAILED to open`
# branch below, i.e. precisely when tailing a sibling's log sends you the wrong way.
LAUNCH_LOG="/tmp/resave-launch-${PORT}.log"
cd "$ROOT"

[ $# -gt 0 ] || { echo "usage: $0 <project>... (e.g. games/sling)" >&2; exit 2; }

for PROJ in "$@"; do
  echo "=== $PROJ ==="
  [ -d "$ROOT/$PROJ" ] || { echo "  no such project"; continue; }

  # Repo-scoped launcher — never touches a sibling clone's editor.
  MODOKI_BACKEND_PORT="$PORT" engine/scripts/launch-editor.sh "$PROJ" > "$LAUNCH_LOG" 2>&1

  # Match the FULL projectRoot, not a bare substring: `games/court` is a substring of
  # nothing here today, but a future `games/court-2` would make a loose match open the
  # wrong project and silently rewrite its scenes.
  ident=""; ready=""; st=""
  for _ in $(seq 1 60); do
    ident=$(curl -s --max-time 3 "$BE/api/identity" 2>/dev/null)
    case "$ident" in *"\"projectRoot\":\"$ROOT/$PROJ\""*) break;; esac
    sleep 2
  done
  case "$ident" in
    *"\"projectRoot\":\"$ROOT/$PROJ\""*) ;;
    *) echo "  FAILED to open (identity: ${ident:-none})"; tail -5 "$LAUNCH_LOG"; continue;;
  esac

  # The backend answers before the renderer window exists, but load-scene needs the
  # RENDERER — gating only on the backend races, and the first scene of every project
  # fails with "timed out waiting for the renderer".
  for _ in $(seq 1 60); do
    st=$(curl -s --max-time 5 "$BE/api/editor-state" 2>/dev/null)
    case "$st" in *'"scenePath"'*) ready=1; break;; esac
    sleep 2
  done
  [ -n "$ready" ] || { echo "  renderer never came up (last: ${st:-none})"; continue; }

  scenes=$(curl -s "$BE/api/scenes" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s).scenes.forEach(x=>console.log(x.path))}catch(e){}})')
  [ -n "$scenes" ] || { echo "  no scenes"; continue; }

  while IFS= read -r p; do
    body=$(node -e 'console.log(JSON.stringify({action:"load-scene",path:process.argv[1],force:true}))' "$p")
    ld=$(curl -s -X POST "$BE/api/editor-action" -H 'Content-Type: application/json' -d "$body")
    case "$ld" in *'"ok":true'*) ;; *) echo "  LOAD FAILED $p -> $ld"; continue;; esac
    sleep 1
    sv=$(curl -s -X POST "$BE/api/editor-action" -H 'Content-Type: application/json' -d '{"action":"save-all"}')
    case "$sv" in *'"ok":true'*) echo "  saved $p";; *) echo "  SAVE FAILED $p -> $sv";; esac
  done <<< "$scenes"
done
