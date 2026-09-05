/** Generate a reusable `.prefab.json` from a 2D skinning rig — the "instantiable
 *  character" wrapping the `SkinnedSprite2D` + `Bone2D` bind-pose subtree that
 *  references the rig asset. Reuses the prefab serialization + the (free) prefab
 *  drag-drop, so a generated rig drops into scenes as a linked instance — no custom
 *  rig-drop code, and edits to the prefab propagate to every instance.
 *
 *  The rig (`.rig2d.json`) is the low-level asset (mesh/bones/weights, like a
 *  mesh/material); the prefab is the placeable thing (mirrors mesh ↔ prefab in 3D). */

import { registerAsset, getGuidForPath } from '../../runtime/loaders/assetManifest';
import { type Rig2DFile } from '../../runtime/loaders/rig2dCache';
import { coerceRigBones } from '../../runtime/skinning/rig2dTypes';
import { spawnEntitySubtree, type SubtreeSpec } from '../undo/entityActions';
import { deleteEntity } from '../../runtime/core/ecs/entityUtils';
import { serializePrefab, setPrefabCache, type PrefabFile } from './prefab';
import { migrateUIAnchorZIndexStructured } from '../../runtime/loaders/uiAnchorZIndexMigration';
import { writeAssetFile, deleteAssetFile } from '../panels/assetOps';
import { pushAction, type UndoAction } from '../undo/undoManager';
import { reportUndoFailure } from '../undo/undoFailure';

/** Build the SkinnedSprite2D + Bone2D subtree spec for a rig. The root sits at its
 *  local origin — a prefab is placed relative to its instantiation parent. */
export function buildRigSubtree(rigGuid: string, bonesRaw: Rig2DFile['bones'], rootName: string): SubtreeSpec {
  const bones = coerceRigBones(bonesRaw);
  const boneNode = (i: number): SubtreeSpec => ({
    traits: [
      { name: 'Transform', data: { x: bones[i].x, y: bones[i].y, rz: bones[i].rot } },
      { name: 'Bone2D', data: { name: bones[i].name } },
      { name: 'EntityAttributes', data: { name: bones[i].name, layer: '2d' } },
    ],
    children: bones.map((_, j) => j).filter((j) => bones[j].parent === i).map(boneNode),
  });
  return {
    traits: [
      { name: 'Transform', data: {} },
      { name: 'SkinnedSprite2D', data: { rig: rigGuid } },
      { name: 'EntityAttributes', data: { name: rootName, layer: '2d' } },
    ],
    children: bones.map((_, i) => i).filter((i) => bones[i].parent < 0).map(boneNode),
  };
}

/** Generate (or UPDATE) a `.prefab.json` asset from a rig: spawn the subtree
 *  temporarily, serialize it to a prefab, delete the temp entities, then write +
 *  register the asset (one undo entry). No scene entities are left behind — the result
 *  is a draggable prefab.
 *
 *  When a prefab already exists at `savePath`, its GUID is PRESERVED (the new bind pose
 *  is written under the same identity) so instances already placed in scenes stay linked
 *  and pick up the change — it's a real update, not a replace that orphans instances.
 *  (Structural changes still only propagate to instances that haven't overridden the
 *  affected part, same as any prefab edit.)
 *
 *  Returns `{ path, updated }` (`updated` = an existing prefab was overwritten in place),
 *  or null on failure. */
export async function makeRigPrefabAsset(
  rigPath: string, rigDef: Rig2DFile, savePath: string, rootName: string,
): Promise<{ path: string; updated: boolean } | null> {
  const rigGuid = getGuidForPath(rigPath) ?? rigDef.id;
  if (!rigGuid) return null;
  const bones = coerceRigBones(rigDef.bones);
  if (!bones.length) { console.warn('[skinPrefab] rig has no bones to prefab'); return null; }

  // Reuse the existing prefab's IDENTITY so placed instances stay linked (update in
  // place). Only mint a fresh GUID when there's no prefab at this path yet.
  const existingId = getGuidForPath(savePath) || undefined;
  // Snapshot the current on-disk content so undo RESTORES the prior prefab (an update
  // must not delete a prefab that predated it). Absent ⇒ this was a fresh create.
  let prevContent: string | null = null;
  if (existingId) {
    try { const r = await fetch(savePath); if (r.ok) prevContent = await r.text(); } catch { /* treat as create */ }
  }

  // Spawn → serialize → delete: reuse the exact prefab serialization without leaving
  // a scene instance. All synchronous, so the temp entities never render.
  const rootId = spawnEntitySubtree(0, buildRigSubtree(rigGuid, rigDef.bones, rootName));
  if (rootId == null) return null;
  const prefab = serializePrefab(rootId, existingId);
  deleteEntity(rootId);
  if (!prefab) return null;

  const content = JSON.stringify(prefab, null, 2);
  if (!(await writeAssetFile(savePath, content))) return null;
  const cacheKey = prefab.id ?? savePath;
  if (prefab.id) registerAsset(prefab.id, savePath, 'prefab');
  setPrefabCache(cacheKey, prefab);

  const updated = prevContent != null;
  const label = `${updated ? 'Update' : 'Make'} prefab "${rootName}"`;
  const action: UndoAction = {
    label,
    undo: async () => {
      if (prevContent != null) {
        // Restore the prior prefab content. Only update the cache if the write
        // actually landed — a failed write must not leave the in-memory cache
        // reverted while the file on disk still holds the newer version (#308).
        if (!(await writeAssetFile(savePath, prevContent))) {
          reportUndoFailure({ direction: 'Undo', label, detail: `"${savePath}" was not restored` });
          return;
        }
        // Migrate before seeding the cache — getPrefabSource returns early on a cache hit, so an
        // un-migrated object here poisons override detection for the rest of the session (the
        // same raw-JSON-cache-seed defect fixed in prefabEdit.ts's openPrefabForEditing).
        try {
          const restored = JSON.parse(prevContent) as PrefabFile;
          for (const entry of restored.entities ?? []) migrateUIAnchorZIndexStructured(entry);
          setPrefabCache(cacheKey, restored);
        } catch { setPrefabCache(cacheKey, null); }
      } else {
        if (!(await deleteAssetFile(savePath))) {
          reportUndoFailure({ direction: 'Undo', label, detail: `"${savePath}" was not deleted` });
          return;
        }
        setPrefabCache(cacheKey, null);
      }
    },
    redo: async () => {
      if (!(await writeAssetFile(savePath, content))) {
        reportUndoFailure({ direction: 'Redo', label, detail: `"${savePath}" was not written` });
        return;
      }
      if (prefab.id) registerAsset(prefab.id, savePath, 'prefab');
      setPrefabCache(cacheKey, prefab);
    },
  };
  pushAction(action);
  return { path: savePath, updated };
}
