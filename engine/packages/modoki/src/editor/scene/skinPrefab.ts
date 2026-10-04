/** Generate a reusable `.prefab.json` from a 2D skinning rig — the "instantiable
 *  character" wrapping the `SkinnedSprite2D` + `Bone2D` bind-pose subtree that
 *  references the rig asset. Reuses the prefab serialization + the (free) prefab
 *  drag-drop, so a generated rig drops into scenes as a linked instance — no custom
 *  rig-drop code, and edits to the prefab propagate to every instance.
 *
 *  The rig (`.rig2d.json`) is the low-level asset (mesh/bones/weights, like a
 *  mesh/material); the prefab is the placeable thing (mirrors mesh ↔ prefab in 3D). */

import { getGuidForPath } from '../../runtime/loaders/assetManifest';
import { type Rig2DFile } from '../../runtime/loaders/rig2dCache';
import { coerceRigBones } from '../../runtime/skinning/rig2dTypes';
import { spawnEntitySubtree, type SubtreeSpec } from '../undo/entityActions';
import { deleteEntity } from '../../runtime/core/ecs/entityUtils';
import { type PrefabFile } from './prefab';
import { classifyExistingPrefabId } from './prefabCache';
import { serializeRebuildOver } from './prefabSerialize';
import { commitPrefabWrite, parsePrefabBytes, parkPrefabChanges } from './prefabCommit';
import { readPriorDocument } from '../panels/assetOps';
import { pushAction, type UndoAction } from '../undo/undoManager';

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
  // ⚠️ Read through `readPriorDocument` (the file, or the park below), and an unreadable one is not a create (#1679 close-out review): it
  // used to fall through to "create", so the undo TRASHED the prefab this update had replaced — #1264's shape. It is
  // not a free overwrite either (#1692, I10): the update is conditional on what it read, so an unreadable prefab
  // REFUSES the update and is left as it is. A manifest id whose file is gone (a 404, or the SPA fallback's HTML) is a
  // create.
  // A parked prefab is updated over the PARK (#1868 D-i, `readPriorDocument` takes it first), as Create Prefab's Replace
  // is: it is what the editor shows and Save would write, so the update is conditional on it and its undo restores it.
  const prior = await readPriorDocument(savePath);
  if (prior === null) { console.error(`[skinPrefab] not updating ${savePath} — it could not be read, so it would be overwritten blind`); return null; }
  const prevContent: string | null = prior ?? null;

  // Spawn → serialize → delete: reuse the exact prefab serialization without leaving
  // a scene instance. All synchronous, so the temp entities never render.
  const rootId = spawnEntitySubtree(0, buildRigSubtree(rigGuid, rigDef.bones, rootName));
  if (rootId == null) return null;
  // A rebuild over the old file (#1782): a bone keeps its row by its path in the rig, a new one goes above the mark (#1774).
  const prefab = serializeRebuildOver(rootId, existingId, prevContent);
  deleteEntity(rootId);
  if (!prefab) return null;

  // ONE step (#1692): over what was read at the path (I10), then both caches, then a rebuild of every placed instance
  // — an update keeps the guid precisely so they pick it up, and they used to stay expanded from the old bind pose
  // until a reload, with the next save capturing them against the wrong rows (#1685's sibling).
  const written = await commitPrefabWrite(savePath, prefab, { expected: prevContent });
  if (!written.ok) {
    console.error(`[skinPrefab] ${savePath} was not written — ${written.conflict ? 'it changed on disk since it was read, and was left as it is' : written.error ?? 'the write failed'}`);
    return null;
  }
  const updated = prevContent != null;
  // A fresh make is a new asset, saved on creation (Unity: "Unity automatically saves new assets"), and nothing in memory
  // changed that an undo could put back — so it pushes no entry (#1868; #1855's last remnant). An undo that trashed it
  // was a file write on undo.
  if (!updated) return { path: savePath, updated };
  /** `prevContent` as every reader parses it — the document the undo restores. */
  const restored = (): PrefabFile => parsePrefabBytes(prevContent);
  const label = `Update prefab "${rootName}"`;
  const guid = prefab.id!;
  // Each half restores the prefab IN MEMORY (#1868, D1 = Park): both caches, a rebase of every placed instance, and the
  // document parked for Save, which writes it. By the prefab's guid, so a Rename since finds it where it is (hub call e).
  // Refused, before anything changes, when the editor holds another document than the other half left (a prefab-edit
  // save of the rig prefab since, an outside change) — the #1679 precondition, asked of memory.
  const action: UndoAction = {
    label,
    // A parked document's edit that also rebuilds the live frames placed from it (undoManager.ts). The park's rebase
    // reprojects each of them from its records (`commitPrefabChanges`), so it keeps every record (#2001 S8b).
    _isFileDirect: true, _rebasesLiveFrames: true,
    undo: () => parkPrefabChanges([{ source: guid, doc: restored(), from: prefab }]),
    redo: () => parkPrefabChanges([{ source: guid, doc: prefab, from: restored() }]),
  };
  pushAction(action);
  return { path: savePath, updated };
}
