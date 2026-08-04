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
#   MODOKI_BACKEND_PORT=5180 engine/scripts/resave-scenes.sh games/sling   # a worker clone
#
# Afterwards ALWAYS review with:
#   node engine/scripts/check-scene-churn.mjs <same projects>
#
# ⚠️ DO NOT sweep a project whose game code SPAWNS ENTITIES OR MUTATES STATE ON LOAD (#124).
#    `save-all` persists the LIVE world, so anything the game created while the scene
#    sat open is baked into the scene file. Measured on games/chess: ~70 runtime entities
#    (highlights, rank labels, pieces) plus a live progress-bar value written into
#    chess.scene.json. games/space-invader is excluded for a different reason (#123) — the
#    manifest rebuild DROPPED a still-referenced asset held on a game-specific trait
#    (SpaceInvaderAssets.catvaderAnim), which the build then cannot see.
#    check-scene-churn.mjs catches both classes; run it before you stage anything.
#    Prefabs are not covered at all (#125): load-scene has no prefab equivalent.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PORT=${MODOKI_BACKEND_PORT:-5179}
BE="http://127.0.0.1:${PORT}"
cd "$ROOT"

[ $# -gt 0 ] || { echo "usage: $0 <project>... (e.g. games/sling)" >&2; exit 2; }

for PROJ in "$@"; do
  echo "=== $PROJ ==="
  [ -d "$ROOT/$PROJ" ] || { echo "  no such project"; continue; }

  # Repo-scoped launcher — never touches a sibling clone's editor.
  MODOKI_BACKEND_PORT="$PORT" engine/scripts/launch-editor.sh "$PROJ" > /tmp/resave-launch.log 2>&1

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
    *) echo "  FAILED to open (identity: ${ident:-none})"; tail -5 /tmp/resave-launch.log; continue;;
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
