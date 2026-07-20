/** Cached entity name-index for the Animation Editor's hot paths.
 *
 *  Resolving a relative name-path (record hook, live-value read, the
 *  outside-root warning, the Add-Property tree) needs a `byId` map and a
 *  name-keyed child map. Building those from `getAllEntities()` is expensive
 *  (it scans every trait of every entity), and the record hook fires per-axis
 *  per-frame during a gizmo drag — so we cache the index and rebuild it only
 *  when the scene structure actually changes (`getStructureVersion()` bumps on
 *  entity add/remove/reparent/rename). During a drag the hierarchy is stable,
 *  so the same index is reused every frame. */

import { getAllEntities, getStructureVersion } from '../../runtime/ecs/entityUtils';
import type { AttrNode } from './recording';

export interface AnimEntityIndex {
  byId: Map<number, AttrNode>;
  /** parentId → (childName → child id). Last writer wins on duplicate names. */
  childrenByParent: Map<number, Map<string, number>>;
}

let cached: AnimEntityIndex | null = null;
let cachedVersion = -1;

/** Get the entity index, rebuilding only when the scene structure changed. */
export function getAnimEntityIndex(): AnimEntityIndex {
  const v = getStructureVersion();
  if (cached && v === cachedVersion) return cached;
  const byId = new Map<number, AttrNode>();
  const childrenByParent = new Map<number, Map<string, number>>();
  for (const e of getAllEntities()) {
    byId.set(e.id, { id: e.id, name: e.name, parentId: e.parentId });
    let bucket = childrenByParent.get(e.parentId);
    if (!bucket) { bucket = new Map(); childrenByParent.set(e.parentId, bucket); }
    bucket.set(e.name, e.id);
  }
  cached = { byId, childrenByParent };
  cachedVersion = v;
  return cached;
}

/** Drop the cached index. Version-gating already rebuilds it on a structure change,
 *  but this gives an explicit teardown hook (and HMR cleanup) so a stale index built
 *  against a disposed world is never served — mirrors lastAnimationClip's dispose. (F7) */
export function clearAnimEntityIndex(): void {
  cached = null;
  cachedVersion = -1;
}

// HMR: clear the module-level cache so a hot reload doesn't serve an index built
// against the previous module instance / a disposed world.
if (import.meta.hot) {
  import.meta.hot.dispose(() => clearAnimEntityIndex());
}

/** Resolve a relative name-path from `rootId` to a concrete entity id, or null.
 *  "" resolves to the root itself. */
export function resolvePathToEntityId(index: AnimEntityIndex, rootId: number, path: string): number | null {
  if (!path) return rootId;
  let cur = rootId;
  for (const seg of path.split('/')) {
    if (!seg) continue;
    const next = index.childrenByParent.get(cur)?.get(seg);
    if (next === undefined) return null;
    cur = next;
  }
  return cur;
}
