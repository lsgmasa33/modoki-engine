/** Place a prefab from its asset PATH into the scene, with its undo step: the human's three instantiate gestures
 *  (the Assets panel's "Instantiate", a drop on the Hierarchy, the Inspector's "Instantiate Prefab") in one place.
 *
 *  They were three copies of the same fetch → `instantiatePrefabInstance` → `pushAction`, and #1752 made the copies a
 *  liability: a placement can now be REFUSED ({@link StalePrefabRead} — the prefab was written while it was being
 *  read), and the refusal has to reach the user as a toast from every one of them, and never escape as an unhandled
 *  rejection. One flow, so a fourth gesture cannot forget it. The agent's `prefab instantiate` reads through
 *  `getPrefabSource` and answers in its reply rather than a toast, so it stays in `agentEditorOps.ts`. */
import { admitPrefabDocument } from '../../runtime/loaders/documentIdentity';
import { frameRepeatRefusal, nestedDocReader } from '../../runtime/loaders/frameRepeat';
import { deleteEntity } from '../../runtime/core/ecs/entityUtils';
import { parseAssetJson, isMissingAsset } from '../../runtime/loaders/assetFetch';
import { migrateUIAnchorZIndexStructured } from '../../runtime/loaders/uiAnchorZIndexMigration';
import { pushAction } from '../undo/undoManager';
import { makePrefabInstantiateAction } from '../undo/prefabInstantiateUndo';
import { useEditorStore } from '../store/editorStore';
import { type PrefabFile } from './prefab';
import { parkedPrefabRead, getPrefabSource } from './prefabCache';
import { instantiatePrefabInstance } from './prefabInstantiate';
import { entityRef } from '../undo/entityRef';
import { capturePrefabRead, StalePrefabRead } from './prefabRead';
import { PrefabEditRefusalError } from './prefabEditRefusal';
import { UndoRefusedError } from '../undo/undoFailure';
import { resolveGuidToPath } from '../../runtime/loaders/assetManifest';

/** Where the placed prefab lives NOW, for a redo: by the document's own guid, as Unity's instance names its prefab
 *  asset by GUID, and at the path it was placed from only when the manifest has no entry. A Rename in Assets is not
 *  undoable (#1868, owner ruling D2), so a redo can run after the file moved, and the recorded path then names nothing
 *  ("its file was most likely deleted" about a file that was only renamed). */
export function placedPrefabPath(guid: string | undefined, path: string): string {
  return (guid && resolveGuidToPath(guid)) || path;
}

/** The redo read ANOTHER prefab than the one placed: the recorded path (the fallback) now holds a different document —
 *  the placed prefab was deleted and another renamed onto its name. Placing it would put a different prefab in the scene
 *  under this step's label, so the redo refuses instead (the step is dropped with this notice, #1664's contract). */
export function placedPrefabRefusal(placedId: string | undefined, read: { id?: string } | null, at: string): UndoRefusedError | null {
  if (!placedId || !read || read.id === placedId) return null;
  return new UndoRefusedError(
    `${at} holds another prefab now (${read.id ?? 'no id'}, not ${placedId}): the one this step placed was deleted, so it was not placed again.`,
    'the prefab this step placed was deleted — it was not placed again',
  );
}

/** The file at `path`, or null when it is gone. The read token is the caller's, taken before this fetch. */
async function readPrefabFile(path: string): Promise<PrefabFile | null> {
  // A parked prefab places as the park (#1868) — the document its other instances show and Save will write.
  const parked = parkedPrefabRead(path);
  if (parked) return parked;
  try {
    const raw = await parseAssetJson(await fetch(path), path) as PrefabFile;
    // Read as every seat reads it (`fetchPrefabSource`; #1937 C-A): admitted — a keyless template node spawns with the key
    // the caches hold, so the frame's record is the cached document and a scene override on that key applies — and a
    // document declaring an identifier twice is not placed. Then the zIndex migration every editor read runs: the
    // expansion no longer migrates rows itself (#1783), so a placement that skipped it would drop a legacy `UIAnchor.zIndex`.
    if (!raw) return raw;
    const admitted = admitPrefabDocument(raw);
    if ('refusal' in admitted) {
      // Refused, with its own toast (as a parent that is gone is): the first placement places nothing, a redo drops its step.
      throw new UndoRefusedError(`${path} was not placed: ${admitted.refusal}`, 'the prefab file is damaged — it was not placed');
    }
    const prefab = admitted.doc;
    // …and a key two prefab files give one frame (#1933 L5), refused as the scene load refuses it.
    const repeat = frameRepeatRefusal(prefab, await nestedDocReader(prefab, (g) => getPrefabSource(g)));
    if (repeat) throw new UndoRefusedError(`${path} was not placed: ${repeat}`, 'the prefab file is damaged — it was not placed');
    for (const entry of prefab.entities ?? []) migrateUIAnchorZIndexStructured(entry);
    return prefab;
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
    // By guid, resolved after the instantiate's own awaits (#1793 review): a world rebuilt during them re-numbers it.
    const rootId = await instantiatePrefabInstance(prefab, path, parentRef ? () => parentRef.require() : 0, readAt);
    if (!rootId) { console.error(`[${opts.tag}] "${prefab.name}" produced no instance`); return null; }
    opts.onPlaced?.(rootId);
    console.log(`[${opts.tag}] Instantiated prefab "${prefab.name}"${parentId ? ` under parent ${parentId}` : ''}`);
    pushAction(makePrefabInstantiateAction({
      label: `Instantiate "${prefab.name}"`,
      initialId: rootId,
      // A refusal here throws out of the redo, which drops the step with its own notice (`prefabInstantiateUndo.ts`).
      respawn: async (rootGuid) => {
        const at = placedPrefabPath(prefab.id, path);
        const again = capturePrefabRead(at);
        const p = await readPrefabFile(at);
        if (!p) return null;
        const other = placedPrefabRefusal(prefab.id, p, at);
        if (other) throw other;
        // Required after the read, right before the spawn: a parent that is gone, or is a placeholder now, refuses the
        // redo (owner ruling R) rather than landing the instance at the scene root or under another entity.
        const id = await instantiatePrefabInstance(p, at, parentRef ? () => parentRef.require() : 0, again, rootGuid);
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
    // The parent the drop was aimed at is gone, or a Missing Prefab now, or not live (#1793): refused, with its own text.
    if (e instanceof UndoRefusedError) {
      console.warn(`[${opts.tag}] ${e.message}`);
      useEditorStore.getState().showToast(e.toast, 'warn');
      return null;
    }
    console.error(`[${opts.tag}] Instantiate failed:`, e);
    return null;
  }
}
