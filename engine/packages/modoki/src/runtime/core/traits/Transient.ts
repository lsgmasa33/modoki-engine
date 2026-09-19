/** Transient — marker trait for entities that must live in the world (render, participate
 *  in physics) but NEVER be written to the scene file. The editor's serializer
 *  (`serialize.ts` — Cmd+S AND the Play snapshot) skips a Transient entity AND its whole
 *  subtree (walked by parentId), so only the ROOT of a generated subtree needs the tag.
 *
 *  Two canonical uses:
 *   - Content DERIVED from an authored source that is the single source of truth — a
 *     procedurally-generated arena from a painted `.level.json`, a debug-viz overlay, a
 *     spawned particle burst — anything a system regenerates from data on load, so baking
 *     it into the scene would bloat the file and create a second, drifting copy of the truth.
 *   - Anything SPAWNED while the run-mode was not `stopped` (a scrub/preview/play spawn, e.g.
 *     a Timeline control track instantiating a prefab), so a preview/scrub mutation can't leak
 *     into a saved scene — the guarantee is structural, not vigilance (preview-mode refactor).
 *
 *  ⚠️ **Honoured through ONE predicate, not by each reader's own walk** — `collectTransientSubtreeIds`
 *  / `filterAuthoringVisible` (`editor/scene/authoringScope.ts`). Every editor reader that treats the
 *  live tree as AUTHORING input asks it: `serializeScene`, `captureInstanceStructure`,
 *  `collectInstanceRoots` (Apply-to-Prefab's fan-out) and `serializePrefab` (Create Prefab). The
 *  last two had no check at all until #1301/#1306, and the two that did carried near-identical
 *  copies of the walk — which is how the misses went unnoticed. A new reader asks the predicate;
 *  it does not write a third copy. See docs/prefabs.md § Authoring scope.
 *
 *  ⚠️ This tag is NOT only a Play-mode thing. A UIEntries pool runs above `TRANSFORM`, so it
 *  spawns, recycles and destroys tagged rows while the sim is STOPPED. The measurement behind that
 *  claim lives in docs/prefabs.md § Authoring scope — one copy, so re-measuring updates one place.
 *
 *  Carries no data; purely a "do not serialize" flag. Deliberately UNREGISTERED (not in
 *  `registerTraits`) — a pure runtime marker checked by trait identity (`entity.has(Transient)`),
 *  never via the name-based trait registry. Because the registry cannot see it, the two respawns of
 *  the SAME entity — the base-scene carry and delete→undo — carry it explicitly
 *  (`core/carriedMarkers.ts`, #1427); a copy does not.
 *
 *  Distinct from Persistent, which SURVIVES scene swaps. An entity CAN carry both, and a runtime one
 *  usually does: every spawn inside a system tick is tagged Transient, so a player a game system
 *  spawns and marks Persistent is carried across the swap and still never saved. */

import { trait } from 'koota';

export const Transient = trait({});
