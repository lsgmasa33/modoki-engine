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
import { serializePrefab, setPrefabCache, classifyExistingPrefabId, type PrefabFile } from './prefab';
import { migrateUIAnchorZIndexStructured } from '../../runtime/loaders/uiAnchorZIndexMigration';
import { writeAssetFile, replaceFileIfMatch, readPriorDocument } from '../panels/assetOps';
import { jsonFileBody } from '../backend/editorBackend';
import { pushAction, type UndoAction } from '../undo/undoManager';
import { reportUndoFailure, fileChangedRefusal } from '../undo/undoFailure';

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

  // Reuse the existing prefab's IDENTITY so placed instances stay linked (update in place). Only
  // mint a fresh GUID when there's no prefab at this path yet.
  //
  // ⚠️ This asked the MANIFEST only (`getGuidForPath`) until #1468. A prefab the scanner has not
  // indexed yet is on disk with an id this build never saw, so the update minted a fresh guid over
  // it and unlinked every placed instance — the on-disk fallback exists precisely for that case.
  // Going through the shared classifier also means an unreadable file (a 500, corrupt bytes, one a
  // newer build wrote) stops the update instead of being treated as a free path.
  const existing = await classifyExistingPrefabId(savePath);
  if (existing.kind === 'refuse') { console.error(`[skinPrefab] not updating ${savePath} — ${existing.reason}`); return null; }
  const existingId = existing.kind === 'known' ? existing.id : undefined;
  // Snapshot the current on-disk content so undo RESTORES the prior prefab (an update
  // must not delete a prefab that predated it). Absent ⇒ this was a fresh create.
  //
  // ⚠️ Read from the FILE (`readPriorDocument`), and an unreadable one is not a create (#1679 close-out review): it
  // used to fall through to "create", so the undo TRASHED the prefab this update had replaced — #1264's shape. It now
  // reports and leaves the file. A manifest id whose file is gone (a 404, or the SPA fallback's HTML) is a create.
  const prior = await readPriorDocument(savePath);
  const prevContent: string | null = typeof prior === 'string' ? prior : null;
  const prevUnreadable = prior === null;

  // Spawn → serialize → delete: reuse the exact prefab serialization without leaving
  // a scene instance. All synchronous, so the temp entities never render.
  const rootId = spawnEntitySubtree(0, buildRigSubtree(rigGuid, rigDef.bones, rootName));
  if (rootId == null) return null;
  const prefab = serializePrefab(rootId, existingId);
  deleteEntity(rootId);
  if (!prefab) return null;

  const content = jsonFileBody(prefab);
  if (!(await writeAssetFile(savePath, content))) return null;
  const cacheKey = prefab.id ?? savePath;
  if (prefab.id) registerAsset(prefab.id, savePath, 'prefab');
  setPrefabCache(cacheKey, prefab);

  const updated = prevContent != null || prevUnreadable; // an unreadable prefab was still there: an update, not a create
  const label = `${updated ? 'Update' : 'Make'} prefab "${rootName}"`;
  // ⚠️ Every half carries a PRECONDITION (#1679), the same four as Create Prefab's (assetOps.ts): the prefab file is
  // global, and this entry outlives a later save of it (open the skin prefab, edit, Cmd+S, then Cmd+Z here). Each
  // half changes the file only while it holds what the other half left there, and otherwise REFUSES before anything
  // moved (`fileChangedRefusal`, the #1664 shape). `applied` tracks which half last landed: an undo that reported a
  // failed write left `content` on disk, so the redo after it must expect `content`, not the restored bytes.
  let applied = true;
  const action: UndoAction = {
    label,
    undo: async () => {
      if (prevUnreadable) {
        reportUndoFailure({ direction: 'Undo', label, detail: `the prefab this update replaced could not be read before it, so it cannot be restored: "${savePath}" was left as it is` });
        return;
      }
      // Restore the prior prefab content, or delete a fresh create. Only update the cache if the
      // file change actually landed — a failed write must not leave the in-memory cache reverted
      // while the file on disk still holds the newer version (#308).
      const wrote = await replaceFileIfMatch(savePath, prevContent, content);
      if (wrote === 'conflict') throw fileChangedRefusal([savePath]);
      if (wrote !== 'ok') {
        reportUndoFailure({ direction: 'Undo', label, detail: `"${savePath}" was not ${prevContent != null ? 'restored' : 'deleted'}` });
        return;
      }
      if (prevContent != null) {
        // Migrate before seeding the cache — getPrefabSource returns early on a cache hit, so an
        // un-migrated object here poisons override detection for the rest of the session (the
        // same raw-JSON-cache-seed defect fixed in prefabEdit.ts's openPrefabForEditing).
        try {
          const restored = JSON.parse(prevContent) as PrefabFile;
          for (const entry of restored.entities ?? []) migrateUIAnchorZIndexStructured(entry);
          setPrefabCache(cacheKey, restored);
        } catch { setPrefabCache(cacheKey, null); }
      } else {
        setPrefabCache(cacheKey, null);
      }
      applied = false;
    },
    redo: async () => {
      const wrote = await replaceFileIfMatch(savePath, content, applied ? content : prevContent);
      if (wrote === 'conflict') throw fileChangedRefusal([savePath]);
      if (wrote !== 'ok') {
        reportUndoFailure({ direction: 'Redo', label, detail: `"${savePath}" was not written` });
        return;
      }
      if (prefab.id) registerAsset(prefab.id, savePath, 'prefab');
      setPrefabCache(cacheKey, prefab);
      applied = true;
    },
  };
  pushAction(action);
  return { path: savePath, updated };
}
