/** Place a prefab from its asset PATH into the scene, with its undo step: the human's three instantiate gestures
 *  (the Assets panel's "Instantiate", a drop on the Hierarchy, the Inspector's "Instantiate Prefab") in one place.
 *
 *  They were three copies of the same fetch → `instantiatePrefabInstance` → `pushAction`, and #1752 made the copies a
 *  liability: a placement can now be REFUSED ({@link StalePrefabRead} — the prefab was written while it was being
 *  read), and the refusal has to reach the user as a toast from every one of them, and never escape as an unhandled
 *  rejection. One flow, so a fourth gesture cannot forget it. The agent's `prefab instantiate` reads through
 *  `getPrefabSource` and answers in its reply rather than a toast, so it stays in `agentEditorOps.ts`. */
import { deleteEntity } from '../../runtime/core/ecs/entityUtils';
import { parseAssetJson, isMissingAsset } from '../../runtime/loaders/assetFetch';
import { pushAction } from '../undo/undoManager';
import { makePrefabInstantiateAction } from '../undo/prefabInstantiateUndo';
import { useEditorStore } from '../store/editorStore';
import { instantiatePrefabInstance, type PrefabFile } from './prefab';
import { entityRef } from '../undo/entityRef';
import { capturePrefabRead, StalePrefabRead } from './prefabRead';
import { PrefabEditRefusalError } from './prefabEditRefusal';

/** The file at `path`, or null when it is gone. The read token is the caller's, taken before this fetch. */
async function readPrefabFile(path: string): Promise<PrefabFile | null> {
  try {
    return await parseAssetJson(await fetch(path), path) as PrefabFile;
  } catch (e) {
    if (isMissingAsset(e)) return null;
    throw e;
  }
}

/** Spawn an instance of the prefab at `path` (under `parentId`, or at the world root) and push its undo step. Resolves
 *  the new root id, or null when nothing was placed — the file is gone, the placement was refused (toasted), or it
 *  failed (logged). Never rejects. `onPlaced`/`onRemoved` run on the first placement and on every redo / undo. */
export async function placePrefabFromPath(path: string, opts: {
  /** The panel, for the console lines: `[Hierarchy] …`. */
  tag: string;
  parentId?: number;
  onPlaced?: (rootId: number) => void;
  onRemoved?: () => void;
}): Promise<number | null> {
  const parentId = opts.parentId ?? 0;
  // The parent by guid, for the redo (#1793): the raw id it held named, after a rebuild (reopen, Play→Stop, Apply),
  // whatever entity holds that id now, and the redo parented the instance under it, or under itself.
  const parentRef = parentId ? entityRef(parentId) : null;
  try {
    // Taken BEFORE the fetch: a write landing during the fetch is inside the read too (#1752).
    const readAt = capturePrefabRead(path);
    const prefab = await readPrefabFile(path);
    if (!prefab) { console.warn(`[${opts.tag}] ${path} is gone; nothing was instantiated`); return null; }
    const rootId = await instantiatePrefabInstance(prefab, path, parentId, readAt);
    if (!rootId) { console.error(`[${opts.tag}] "${prefab.name}" produced no instance`); return null; }
    opts.onPlaced?.(rootId);
    console.log(`[${opts.tag}] Instantiated prefab "${prefab.name}"${parentId ? ` under parent ${parentId}` : ''}`);
    pushAction(makePrefabInstantiateAction({
      label: `Instantiate "${prefab.name}"`,
      initialId: rootId,
      // A refusal here throws out of the redo, which drops the step with its own notice (`prefabInstantiateUndo.ts`).
      respawn: async () => {
        const again = capturePrefabRead(path);
        const p = await readPrefabFile(path);
        if (!p) return null;
        // Required after the read, right before the spawn: a parent that is gone, or is a placeholder now, refuses the
        // redo (owner ruling R) rather than landing the instance at the scene root or under another entity.
        const id = await instantiatePrefabInstance(p, path, parentRef ? parentRef.require() : 0, again);
        opts.onPlaced?.(id);
        return id;
      },
      remove: (id) => { deleteEntity(id); opts.onRemoved?.(); },
    }));
    return rootId;
  } catch (e) {
    // A prefab-edit refusal (#1817, #1836) reaches the user the same way: a placement outside the root, or of a prefab
    // that contains the one being edited.
    if (e instanceof StalePrefabRead || e instanceof PrefabEditRefusalError) {
      console.warn(`[${opts.tag}] ${e.message}`);
      useEditorStore.getState().showToast(e.message, 'warn');
      return null;
    }
    console.error(`[${opts.tag}] Instantiate failed:`, e);
    return null;
  }
}
