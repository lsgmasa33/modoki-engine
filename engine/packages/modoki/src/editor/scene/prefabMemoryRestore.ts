/** The undo and redo of a prefab WRITE — Apply to Prefab, Create Prefab's Replace, a rig-prefab update — restore the
 *  document IN MEMORY, and Save writes it (#1868, owner ruling D1 = Park; docs/prefabs.md § "Undo changes memory, Save
 *  writes files"). Unity's Apply writes the file and its undo (INFERRED) rewrites it; Modoki's writes are HTTP round
 *  trips, and an undo that awaited one was a window the rest of the editor ran in (#1833), a file that could change under
 *  the step (#1664, #1821), a half-applied step to report (#1823) — every one of them gone when no file is written.
 *
 *  So a restore is: both caches hold the document (`seatCaches`, as a write's would), the caller rebuilds its own live
 *  state, every other live frame is rebased onto it, and the document is PARKED in the dirty-asset registry — or its park
 *  is dropped, when it is what the file already holds (a redo back to what the forward write put there). Nothing is
 *  written and no scene is saved. */

import { seatCaches, prefabPathOf, prefabTextIsDocument } from './prefabCommit';
import { type PrefabFile } from './prefab';
import { preloadNestedPrefabs, getCachedPrefabSync } from './prefabCache';
import { rebaseStaleInstances } from './prefabRebuild';
import { parkPrefab, parkedPrefab, parkedPrefabEntry, discardDirtyAssets, assetWritesSettled } from './dirtyAssets';
import { jsonFileBody } from '../backend/editorBackend';
import { UndoRefusedError } from '../undo/undoFailure';
import { isGuid } from '../../runtime/loaders/assetManifest';

export interface PrefabRestore {
  /** The prefab's guid — resolved to wherever the file is NOW, so a Rename since the step does not strand it (#1868 hub
   *  call e) — or a path, for a document with no guid. */
  source: string;
  /** The document to restore. */
  doc: PrefabFile;
  /** The document the step LEFT: what the editor must hold now (else the restore refuses), and what the file holds when
   *  nothing is parked for it. */
  from: PrefabFile;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sameDocument = (a: unknown, b: PrefabFile): boolean => prefabTextIsDocument(jsonFileBody(a), b);

/** Refused, before anything changes, when the editor holds another document for one of `restores` than the step left:
 *  a prefab-edit save, a later write that is not on this stack, or an outside change the watcher brought in. The step
 *  restores what IT changed; putting its side back over somebody else's would lose that change at the next Save. The
 *  #1664/#1679 precondition, asked of memory rather than of the file. */
export function prefabRestoreRefusal(restores: readonly PrefabRestore[]): UndoRefusedError | null {
  for (const r of restores) {
    const path = prefabPathOf(r.source);
    const now = parkedPrefab(path) ?? getCachedPrefabSync(r.source);
    if (!now || sameDocument(now, r.from)) continue;
    const name = path.split('/').pop() ?? path;
    return new UndoRefusedError(
      `${path} changed since this step (a prefab-edit save, another write, or an outside change), so it was left as it is.`,
      `${name} changed since, and was left as it is`,
    );
  }
  return null;
}

/** Restore each of `restores` in memory, as ONE step — see the module comment. `rebuild`: the caller's own live state
 *  (Apply's world snapshot, Replace's tag), run once the caches hold every document and before the rebase. Throws the
 *  refusal before anything changes. */
export async function restorePrefabsInMemory(
  restores: readonly PrefabRestore[],
  opts: { rebuild?: () => void | Promise<void>; rebase?: boolean } = {},
): Promise<void> {
  // A Save writing one of these prefabs is waited for (close-out review F1), as an asset-document step waits: until its
  // write lands, the park's baseline says what the file held BEFORE it, and a redo back to that document read as "back to
  // the file" and dropped the park — leaving the file on the saved document and the editor on the redone one, clean.
  await assetWritesSettled(restores.map((r) => prefabPathOf(r.source)));
  const refused = prefabRestoreRefusal(restores);
  if (refused) throw refused;
  const sources = new Set<string>();
  for (const r of restores) {
    const path = prefabPathOf(r.source);
    const doc = clone(r.doc);
    // A document read from a file that carried no id keeps the one the manifest gave it: Save would otherwise mint a new
    // one and unlink every instance (#1264's rule, as the forward write's).
    if (!doc.id && isGuid(r.source)) doc.id = r.source;
    // What the file holds: the park's own record when one is there — the file has not been written since it was parked —
    // else the side the step left, which the refusal above has just matched against the editor.
    const park = parkedPrefabEntry(path);
    const onDisk = park?.onDisk ?? r.from;
    seatCaches(path, r.source, doc.id, doc);
    // Not dropped when the file changed under the park (the watcher kept it): `onDisk` no longer says what the file holds,
    // so the park stays for Save, whose precondition meets the change and asks (close-out review F2).
    if (sameDocument(onDisk, doc) && !park?.fileChanged) discardDirtyAssets([path]);
    else parkPrefab(path, doc, onDisk);
    sources.add(r.source); sources.add(path);
    if (doc.id) sources.add(doc.id);
  }
  for (const r of restores) await preloadNestedPrefabs(r.doc);
  await opts.rebuild?.();
  if (opts.rebase !== false) await rebaseStaleInstances({ sources });
}
