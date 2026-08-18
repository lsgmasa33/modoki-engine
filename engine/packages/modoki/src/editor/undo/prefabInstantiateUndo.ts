/** Undo entry for "instantiate a prefab into the scene".
 *
 *  Shared by the Hierarchy drop-handler and the Assets-panel instantiate path so
 *  the two cannot drift. The Assets copy previously closed over a `const` root id
 *  while its `redo` spawned a fresh instance into a new local id — so after
 *  undo→redo→undo the second undo deleted the dead original and ORPHANED the
 *  redo-spawned instance (prefab F3). Keeping the live instance id in a single
 *  mutable slot here makes that impossible: undo always tears down whatever is
 *  currently live, redo re-instantiates and updates the slot.
 *
 *  Redo RESTORES THE ORIGINAL GUIDS, it does not just re-spawn. `respawn()` runs
 *  the ordinary instantiate path, which mints a fresh guid per entity — so an
 *  undo+redo used to hand the user a visually identical subtree under a brand-new
 *  identity (measured: guid 45cd77c4… became b0b3c186… on redo, QA-ASSET-0018).
 *  Under the GUID-only-refs design that silently orphans every reference minted
 *  against the entity in between, with nothing on screen to show for it, so the
 *  captured guids are stamped back over the respawned subtree below. */
import type { UndoAction } from './undoManager';
import { entityRef, type EntityRef } from './entityRef';
import { getAllEntities, readTraitData, writeTraitField, findEntity, type EntityInfo }
  from '../../runtime/core/ecs/entityUtils';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntityByGuid, indexEntityGuid } from '../../runtime/core/ecs/world';

/** Structural address of one entity within an instantiated subtree, e.g.
 *  `""` (the root) or `"Arm#0/Hand#1"`. Keyed by NAME + sibling index rather than by
 *  position in a flat list so a prefab that gained or lost a child between the undo and
 *  the redo still re-identifies the children it does still have, instead of shifting every
 *  guid one slot along — which would be worse than minting fresh ones. */
type SubtreePath = string;

/** Walk `rootId`'s subtree depth-first in a canonical order (siblings by sortOrder, then
 *  name, then id — the same order the Hierarchy shows), returning each entity's id and
 *  structural path. Both instantiations of one prefab produce the same paths. */
function subtreePaths(rootId: number, flat: EntityInfo[]): { id: number; path: SubtreePath }[] {
  const childrenByParent = new Map<number, EntityInfo[]>();
  for (const e of flat) {
    if (e.parentId > 0) {
      let arr = childrenByParent.get(e.parentId);
      if (!arr) { arr = []; childrenByParent.set(e.parentId, arr); }
      arr.push(e);
    }
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id - b.id);
  }
  const out: { id: number; path: SubtreePath }[] = [];
  const walk = (id: number, path: SubtreePath) => {
    out.push({ id, path });
    const kids = childrenByParent.get(id) ?? [];
    kids.forEach((k, i) => walk(k.id, `${path}${path ? '/' : ''}${k.name}#${i}`));
  };
  if (flat.some((e) => e.id === rootId)) walk(rootId, '');
  return out;
}

/** Snapshot the subtree's guids by structural path. Reads only — prefab instantiation
 *  already mints a guid per entity, and an entity that somehow has none is simply not
 *  recorded (there is no identity to preserve). */
function captureSubtreeGuids(rootId: number): Map<SubtreePath, string> {
  const eaMeta = getTraitByName('EntityAttributes');
  const out = new Map<SubtreePath, string>();
  if (!eaMeta) return out;
  for (const { id, path } of subtreePaths(rootId, getAllEntities())) {
    const guid = (readTraitData(id, eaMeta)?.guid as string) || '';
    if (guid) out.set(path, guid);
  }
  return out;
}

/** Stamp the captured guids back onto a freshly respawned subtree, matching by structural
 *  path. Skips a guid another live entity still holds — re-using it would put two entities
 *  under one identity, which is strictly worse than the fresh guid the respawn already
 *  gave this one. */
function restoreSubtreeGuids(rootId: number, captured: Map<SubtreePath, string>): void {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta || captured.size === 0) return;
  for (const { id, path } of subtreePaths(rootId, getAllEntities())) {
    const want = captured.get(path);
    if (!want) continue;
    const current = (readTraitData(id, eaMeta)?.guid as string) || '';
    if (current === want) continue;
    const holder = findEntityByGuid(want);
    if (holder && holder.id() !== id) continue;
    writeTraitField(id, eaMeta, 'guid', want);
    const ent = findEntity(id);
    if (ent) indexEntityGuid(ent);
  }
}

export function makePrefabInstantiateAction(opts: {
  label: string;
  /** Entity id from the initial (pre-`pushAction`) instantiation. */
  initialId: number;
  /** Re-instantiate the prefab; return the new root id, or `null` if it could
   *  not be spawned (e.g. the prefab file was deleted between undo and redo) — in
   *  which case the live id is left unchanged, matching the original
   *  early-return behavior (nothing new exists to track). */
  respawn: () => Promise<number | null>;
  /** Tear down the live instance. Safe to call with a stale id (no-op). */
  remove: (id: number) => void;
}): UndoAction {
  // Track the live instance by a guid-based ref (not a raw id) so undo still
  // tears down the right entity after a world rebuild (Play→Stop). The instance
  // root carries a stable guid from instantiation (prefab.ts mints one).
  let currentRef: EntityRef = entityRef(opts.initialId);
  // Captured at action-creation time, refreshed after every redo so a subsequent
  // undo→redo keeps restoring the SAME identities rather than the last respawn's.
  let capturedGuids = captureSubtreeGuids(opts.initialId);
  return {
    label: opts.label,
    // Resolve by guid; fall back to the last-known id if it can't (remove is safe
    // to call on a stale/dead id — a no-op — matching the original contract).
    undo: () => { opts.remove(currentRef.resolve() ?? currentRef.rawId); },
    redo: async () => {
      const id = await opts.respawn();
      if (id == null) return;
      restoreSubtreeGuids(id, capturedGuids);
      capturedGuids = captureSubtreeGuids(id);
      currentRef = entityRef(id);
    },
  };
}
