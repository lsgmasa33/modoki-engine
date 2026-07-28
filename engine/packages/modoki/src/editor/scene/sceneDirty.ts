/** Per-scene dirty tracking for multi-scene save (scene-loading.md
 *  Phase 12, M2). `hasUnsavedChanges()` (serialize.ts) answers "is there ANY unsaved
 *  live-world work" for the destructive load_scene/new_scene guard — this module adds
 *  a second, finer-grained question `saveAll` needs: "which SPECIFIC BASE scenes does
 *  that work belong to". A field edit on a base entity must mark the base dirty so
 *  saveAll knows to write its file too.
 *
 *  Only BASE scenes are ever tracked here — an entity with an empty `sourceScene`
 *  (Phase 3's "empty means primary" rule) resolves to nothing and is skipped. The
 *  primary itself doesn't need this: `saveAll` always attempts it via `saveScene`,
 *  driven by the existing global edit-version (`hasUnsavedChanges`), independent of
 *  this module. That is also what keeps this module's own dependency footprint light
 *  — no `SceneManager` import, so pulling it into `entityActions.ts` (a foundational,
 *  widely-mocked module) doesn't drag SceneManager's heavy loader-cache graph into
 *  every unit test that touches a trait edit. Scenes are tracked by guid, matching
 *  `EntityAttributes.sourceScene`'s own values directly. */

import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';

const dirtySceneGuids = new Set<string>();

/** Mark a scene (by guid) dirty directly. Prefer `resolveAffectedScenes` + this when
 *  you already know the guid; use `markSceneDirtyForEntity` when you only have a live
 *  entity id. */
export function markSceneDirty(guid: string): void {
  if (guid) dirtySceneGuids.add(guid);
}

/** A live entity's raw `EntityAttributes.sourceScene` — '' (falsy) for a primary-owned
 *  entity or one with no EntityAttributes at all. Deliberately NOT resolved to the
 *  primary's own real guid (see the module doc comment for why). */
function rawSourceScene(entityId: number): string {
  const meta = getTraitByName('EntityAttributes');
  const entity = meta ? findEntity(entityId) : null;
  const data = entity?.has(meta!.trait) ? (entity.get(meta!.trait) as { sourceScene?: string }) : undefined;
  return data?.sourceScene || '';
}

/** Resolve the set of BASE scene guids a batch of LIVE entity ids belongs to, deduped
 *  (a primary-owned entity contributes nothing — see the module doc comment). Call
 *  this BEFORE a structural mutation (delete, reparent) that could destroy the entity
 *  or change its sourceScene — resolving after the fact may read stale/gone data.
 *  Field edits don't change sourceScene, so resolving before or after is equivalent
 *  for those, but "before" is the uniform, always-safe convention. */
export function resolveAffectedScenes(entityIds: number[]): string[] {
  const guids = new Set<string>();
  for (const id of entityIds) {
    const g = rawSourceScene(id);
    if (g) guids.add(g);
  }
  return [...guids];
}

/** Mark the scene a single live entity belongs to as dirty. Convenience wrapper over
 *  `resolveAffectedScenes` + `markSceneDirty` for the common one-entity case. */
export function markSceneDirtyForEntity(entityId: number): void {
  for (const g of resolveAffectedScenes([entityId])) markSceneDirty(g);
}

/** Clear one scene's dirty flag — call after successfully writing its file. */
export function clearSceneDirty(guid: string): void {
  dirtySceneGuids.delete(guid);
}

/** Every scene guid with unsaved live-world edits pending. Read-only snapshot copy —
 *  callers must go through `markSceneDirty`/`clearSceneDirty`, never mutate this. */
export function dirtySceneGuidsSnapshot(): ReadonlySet<string> {
  return new Set(dirtySceneGuids);
}

export function isSceneDirty(guid: string): boolean {
  return dirtySceneGuids.has(guid);
}

/** Reset all dirty tracking — call on a scene load/new-scene, mirroring
 *  `markSceneSaved()`'s "the freshly loaded world matches disk" baseline. A stale
 *  dirty guid from the PREVIOUS chain (e.g. a base scene no longer in the new chain)
 *  must not linger and cause a later saveAll to try writing a scene that isn't loaded. */
export function clearAllSceneDirty(): void {
  dirtySceneGuids.clear();
}
