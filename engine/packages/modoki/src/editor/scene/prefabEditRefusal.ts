/** The ONE refusal for a prefab-edit gesture that would leave the edited prefab unsavable (#1817, #1836).
 *
 *  A prefab-edit save writes the root's subtree and nothing else (`serializePrefabEditWorld` finds the root by its
 *  sentinel guid and serializes under it). So the edit world has exactly ONE top-level authored entity — the root — and a
 *  gesture breaks the save in one of three ways:
 *  - it takes the root away: deleting it or an ancestor of it (in 2D the root sits under the `__PrefabEditStage`
 *    scaffold), or moving it. Every save then failed "prefab root not found" (#1836);
 *  - it puts an authored entity OUTSIDE the root: a create, paste, duplicate (of the root itself, too) or prefab drop at
 *    the top level or under a scaffold, or a reparent of one of the root's entities out of it. The save silently dropped
 *    it — the user's work gone with no error (hub widening of #1836);
 *  - it nests the edited prefab inside itself: an instance of it, or of any prefab that transitively contains it,
 *    dropped, pasted or duplicated anywhere in the world. The save wrote a file containing itself, which every later load
 *    overflowed the stack on (#1817).
 *
 *  And the scaffolding (`__PrefabEdit*`: the lights, the environment, the 2D stage) never goes INTO the root, moved or
 *  pasted: the save would write it into the prefab (close-out review).
 *
 *  Unity's Prefab Mode refuses all of these. Asked INSIDE each forward choke point — `deleteEntitiesWithUndo`,
 *  `reparentEntity`/`planReparent`, `createEntityWithUndo`, `duplicateEntity`, `pasteEntityCopy`,
 *  `instantiatePrefabInstance` — so the Hierarchy, the Inspector, the Assets panel, the keyboard and every agent op get
 *  it however they arrive, as `sceneMoveRefusal` is asked inside `moveEntityToScene` (#1757). Placed as a gate on the
 *  gesture, not in undo/redo code: a refused gesture pushes no entry. A placement's REDO re-runs
 *  `instantiatePrefabInstance` and so meets it too; the undo wrapper drops that step with its notice
 *  (`prefabInstantiateUndo.ts`), as it drops a stale read.
 *
 *  Ground truth is the WORLD, not the `editingPrefab` store flag (`prefabEditWorld.ts` says why): the edited prefab is
 *  the one the loaded synthetic scene names, and the root is the entity carrying `PREFAB_EDIT_ROOT_GUID`. Outside a
 *  prefab-edit world every gesture is allowed. A leaf: `prefab.ts` asks it too, so it reads the prefab cache through the
 *  reader its caller hands in rather than importing `prefab.ts`. */

import { getAllEntities, type EntityInfo } from '../../runtime/core/ecs/entityUtils';
import { PREFAB_EDIT_ROOT_GUID, SCAFFOLD_PREFIX } from './prefabEditGuids';
import { PREFAB_EDIT_SCENE_PREFIX, prefabEditWorldPath } from './prefabEditWorld';
import { prefabNests, type NestingReader } from '../../runtime/loaders/prefabNesting';

import { PrefabEditRefusalError, type PrefabEditRefusal, type PrefabEditRefusalReason } from './prefabEditRefusalError';
export { PrefabEditRefusalError, type PrefabEditRefusal, type PrefabEditRefusalReason };

/** What a gesture is about to do, in the terms the refusal needs. */
export type PrefabEditGesture =
  /** Delete these entities (and their subtrees). */
  | { kind: 'delete'; ids: readonly number[] }
  /** Move `id` under `parentId` (0 = the top level). */
  | { kind: 'reparent'; id: number; parentId: number }
  /** Add an entity under `parentId` (0 = the top level): a create, a paste, a duplicate, a prefab placement. `prefabs`
   *  names every prefab the added subtree expands, read through `read`. `scaffold`: the added subtree is a copy of the
   *  edit world's scaffolding (a `__PrefabEdit*` entity), which never goes into the root. */
  | { kind: 'add'; parentId: number; prefabs?: readonly string[]; read?: NestingReader; scaffold?: boolean };

export const PREFAB_EDIT_REFUSAL_TEXT: Record<PrefabEditRefusalReason, string> = {
  'root-removed': 'The prefab root cannot be deleted in prefab edit: the save writes the root and everything under it. Delete its children instead, or exit prefab edit.',
  'root-moved': 'The prefab root cannot be moved in prefab edit: it is the one top-level entity the save writes.',
  'outside-root': 'Prefab edit keeps everything under the prefab root: the save writes only the root and what is under it, so an entity outside it would be silently lost. Put it under the root.',
  'self-nesting': 'A prefab cannot contain itself: this holds an instance of the prefab being edited.',
  'scaffold': 'The prefab-edit lights, environment and stage are editor scaffolding, not part of the prefab: they stay outside the root, where the save does not write them.',
};

/** Why `gesture` is refused in the prefab-edit world, or null when it may run (or no prefab-edit world is loaded). */
export function prefabEditRefusal(gesture: PrefabEditGesture): PrefabEditRefusal | null {
  const world = prefabEditWorldPath();
  if (!world) return null;
  const all = getAllEntities();
  const root = all.find((e) => e.guid === PREFAB_EDIT_ROOT_GUID);
  // No root: the save already refuses ("prefab root not found"), and there is nothing left to protect.
  if (!root) return null;
  const byId = new Map(all.map((e) => [e.id, e]));
  const refuse = (reason: PrefabEditRefusalReason): PrefabEditRefusal => ({ reason, text: PREFAB_EDIT_REFUSAL_TEXT[reason] });

  switch (gesture.kind) {
    case 'delete': {
      const ids = new Set(gesture.ids);
      // The root itself, or anything above it (the 2D stage scaffold), which would take the root with it.
      for (let cur: EntityInfo | undefined = root; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
        if (ids.has(cur.id)) return refuse('root-removed');
      }
      return null;
    }
    case 'reparent': {
      if (gesture.id === root.id) return gesture.parentId === root.parentId ? null : refuse('root-moved');
      // Only an entity the save writes can be lost by a move out of the root. From outside, the scaffolding (by its
      // `SCAFFOLD_PREFIX` name, as a paste asks) never goes INTO the root, where the save would write an editor-only light
      // into the prefab; anything else outside it is authored work stranded there, and moving it in is its rescue.
      if (underRoot(gesture.id, root.id, byId)) return inRoot(gesture.parentId, root.id, byId) ? null : refuse('outside-root');
      return inRoot(gesture.parentId, root.id, byId) && byId.get(gesture.id)?.name.startsWith(SCAFFOLD_PREFIX) ? refuse('scaffold') : null;
    }
    case 'add': {
      if (!inRoot(gesture.parentId, root.id, byId)) return refuse('outside-root');
      if (gesture.scaffold) return refuse('scaffold');
      const edited = world.slice(PREFAB_EDIT_SCENE_PREFIX.length);
      const read = gesture.read ?? (() => null);
      if (gesture.prefabs?.some((ref) => prefabNests(edited, ref, read))) return refuse('self-nesting');
      return null;
    }
  }
}

/** Is `id` the root or inside its subtree? */
function inRoot(id: number, rootId: number, byId: ReadonlyMap<number, EntityInfo>): boolean {
  return id === rootId || underRoot(id, rootId, byId);
}

/** Is `id` strictly below the root? */
function underRoot(id: number, rootId: number, byId: ReadonlyMap<number, EntityInfo>): boolean {
  const seen = new Set<number>();
  for (let cur = byId.get(id); cur && cur.parentId && !seen.has(cur.id); cur = byId.get(cur.parentId)) {
    seen.add(cur.id);
    if (cur.parentId === rootId) return true;
  }
  return false;
}

/** Ask the refusal, and throw it when there is one. */
export function assertPrefabEditAllows(gesture: PrefabEditGesture): void {
  const refusal = prefabEditRefusal(gesture);
  if (refusal) throw new PrefabEditRefusalError(refusal);
}
