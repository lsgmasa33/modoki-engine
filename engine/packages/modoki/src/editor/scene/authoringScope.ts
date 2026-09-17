/** Authoring scope — which live entities an EDITOR reader may treat as authored content.
 *
 *  ⚠️ Deliberately its own module, not a pair of exports on `entityUtils`: most editor tests mock
 *  `entityUtils` with an explicit object literal, so an export added there arrives `undefined` in
 *  every one of them and the guard silently does nothing (the mock lists what it lists). Living
 *  here, this code is REAL in those tests while the `findEntity` it calls is still the mock's.
 *
 *  ⚠️ It lives in `editor/`, not in `runtime/core/`, because the layer rule is right about what it
 *  is: "authoring input" is an editor concept, and an L0 core primitive may not import a trait. It
 *  does not belong beside `subtreeIds` however neatly it reads there. */

import { findEntity, type EntityInfo } from '../../runtime/core/ecs/entityUtils';
import { collectSubtreeIds } from '../../runtime/core/ecs/subtreeCollect';
import { Transient } from '../../runtime/core/traits/Transient';

/** Every entity a `Transient` tag excludes from AUTHORING: each tagged entity **and its whole
 *  subtree**. Pure over a flat entity list, like `subtreeIds`.
 *
 *  ⚠️ **The one place that answers "is this entity authored, or a live runtime artifact?"** — and
 *  it is one place on purpose. The walk below existed as two near-identical hand-rolled copies
 *  (`serializeScene` and `captureInstanceStructure`), and the two readers that never grew a copy
 *  are exactly the two defects this replaces: `collectInstanceRoots` handed a scrub/pool instance
 *  to `rebuildInstance`, which rebuilt it WITHOUT the tag and so made a preview artifact
 *  serializable (#1301); `serializePrefab` wrote pooled rows into a new `.prefab.json` as ordinary
 *  authored members (#1306). Both measured, not theorised.
 *
 *  ⚠️ **The subtree is the load-bearing half, not the tag.** Only the ROOT of a generated subtree
 *  is tagged (see `Transient.ts`, and `spawnPrefabInstance`, which tags the instance root and
 *  leaves its members untagged when the spawn ran outside a system tick). A reader that filters on
 *  `has(Transient)` alone therefore keeps the members and drops their parent — which is worse than
 *  not filtering at all, because it writes an orphaned half-subtree.
 *
 *  ⚠️ **It is NOT gated on run mode.** A UIEntries pool runs at `UI_ENTRIES` (270), above
 *  `TRANSFORM` (200), so `runPipeline` keeps ticking it while the sim is STOPPED. "Only during
 *  Play" is the wrong mental model and was the reason two readers looked unreachable; the
 *  measurement is in docs/prefabs.md § Authoring scope. */
export function collectTransientSubtreeIds(flat: EntityInfo[]): Set<number> {
  const roots: number[] = [];
  for (const e of flat) if (findEntity(e.id)?.has(Transient)) roots.push(e.id);
  if (roots.length === 0) return new Set();
  return new Set(collectSubtreeIds(flat.map((e) => [e.id, e.parentId] as const), roots));
}

/** `flat` minus every `Transient` subtree — the list a reader should walk when it is treating the
 *  live tree as AUTHORING input (what to serialize, what to turn into a prefab, which instances an
 *  authoring edit fans out to). Returns `flat` itself when nothing is tagged, so the common case
 *  allocates nothing. */
export function filterAuthoringVisible(flat: EntityInfo[]): EntityInfo[] {
  const excluded = collectTransientSubtreeIds(flat);
  return excluded.size ? flat.filter((e) => !excluded.has(e.id)) : flat;
}

/** The ONE sentence for "this gesture left runtime entities out", used by every reader that
 *  surfaces it: `serializePrefab`'s console line, the Create Prefab toast on both human entry
 *  points, the agent op's `warnings`, and the prefab-edit save. Three hand-written wordings of it
 *  existed for about an hour (close-out review F5) while a docblock claimed there was one.
 *
 *  `count` is what THIS SELECTION lost — never a world-wide tally. See `authoringEntitiesFor`.
 *
 *  ⚠️ "of the prefab" is load-bearing, not filler: collapsing four wordings into one dropped the
 *  OBJECT from all four, and the agent — which reads a bare `warnings[]` with no surrounding
 *  context — was left with "N runtime entities were left out" of nothing (re-review finding 6). */
export function runtimeExcludedMessage(count: number): string {
  return `${count} runtime entit${count === 1 ? 'y was' : 'ies were'} left out of the prefab — pooled rows and preview spawns are generated at runtime, not authored content.`;
}
