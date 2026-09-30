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

import { seatCaches, prefabPathOf, prefabTextIsDocument, stateRaisedMark } from './prefabCommit';
import { type PrefabFile } from './prefab';
import { preloadNestedPrefabs, getCachedPrefabSync, prefabNestingReader } from './prefabCache';
import { rebaseStaleInstances } from './prefabRebuild';
import { parkPrefab, parkedPrefab, parkedPrefabEntry, discardDirtyAssets, assetWritesSettled } from './dirtyAssets';
import { jsonFileBody, backendFetch } from '../backend/editorBackend';
import { expandedPrefabRefs, prefabNests } from '../../runtime/loaders/prefabNesting';
import { UndoRefusedError } from '../undo/undoFailure';
import { isGuid } from '../../runtime/loaders/assetManifest';
import { localIdCounter, type CountedDoc } from '../../runtime/core/localIdCounter';

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

/** What the editor holds for the prefab `source` names NOW: its park when one is there, else its cached document. A
 *  document neither holds is `undefined` (a trash evicts both; a cold cache never read it). What the restore compares the
 *  step against, and, with no park, what it takes the file to hold. */
export function documentNow(source: string): PrefabFile | undefined {
  return (parkedPrefab(prefabPathOf(source)) ?? getCachedPrefabSync(source)) as PrefabFile | undefined;
}

/** Refused, before anything changes, when a restore would put back a document the write door would not let through
 *  (#1877 C1). The restore seats and parks a document that Save later writes, so it asks what a write asks, not only
 *  whether THIS document moved on:
 *  - the editor holds another document for one of `restores` than the step left: a prefab-edit save, a later write that
 *    is not on this stack, or an outside change the watcher brought in. The step restores what IT changed; putting its
 *    side back over somebody else's would lose that change at the next Save. The #1664/#1679 precondition, asked of
 *    memory rather than of the file;
 *  - the file is gone (`gone`: an Assets trash since the step, which cannot be undone). Restored, the park brought the
 *    trashed prefab back at the next Save, behind a "changed on disk" prompt that was false. Unity brings no deleted
 *    asset back through an undo either;
 *  - a restored document contains itself (I16), through a prefab changed outside this stack — B's prefab edit placed an
 *    A after an Apply took B out of A, and the undo put B back. `commitPrefabWrites` asks this at the one door every
 *    WRITE passes; a restore passes no door until Save, which then refused for good. Read through the restored set first,
 *    as the commit reads through its batch. */
export function prefabRestoreRefusal(restores: readonly PrefabRestore[], gone: ReadonlySet<string> = new Set()): UndoRefusedError | null {
  for (const r of restores) {
    const path = prefabPathOf(r.source);
    const name = path.split('/').pop() ?? path;
    const now = documentNow(r.source);
    if (!now && gone.has(path)) {
      // A trash unregisters the asset, so `path` may be the guid: the prefab is named by its document then.
      const what = isGuid(path) ? `"${r.from.name ?? path}" (${path})` : path;
      return new UndoRefusedError(`${what} was deleted since this step, so it was left deleted.`, `${isGuid(path) ? r.from.name ?? path : name} was deleted since, and was left deleted`);
    }
    if (!now || sameDocument(now, r.from)) continue;
    return new UndoRefusedError(
      `${path} changed since this step (a prefab-edit save, another write, or an outside change), so it was left as it is.`,
      `${name} changed since, and was left as it is`,
    );
  }
  return restoreCycleRefusal(restores);
}

/** I16 at the restore: refused when a restored document would contain itself, read through the restored set first (a
 *  cycle across two documents of one step), then the editor's documents — as `commitPrefabWrites` reads through its
 *  batch. See {@link prefabRestoreRefusal}. */
export function restoreCycleRefusal(restores: readonly PrefabRestore[]): UndoRefusedError | null {
  const guidOf = (r: PrefabRestore) => r.doc.id ?? (isGuid(r.source) ? r.source : undefined);
  const batch = new Map(restores.flatMap((r) => { const g = guidOf(r); return g ? [[g, r.doc] as const] : []; }));
  const nesting = prefabNestingReader();
  const read = (g: string) => batch.get(g) ?? nesting(g);
  for (const r of restores) {
    const guid = guidOf(r);
    if (!guid || !expandedPrefabRefs(r.doc.entities).some((ref) => prefabNests(guid, ref, read))) continue;
    const path = prefabPathOf(r.source);
    const name = path.split('/').pop() ?? path;
    return new UndoRefusedError(
      `${path} would contain itself once restored (a prefab it nests now contains it), so it was left as it is.`,
      `${name} would contain itself, and was left as it is`,
    );
  }
  return null;
}

/** The paths of `restores` whose file is gone, asked only of a document no cache or park holds: an Assets trash evicts
 *  both, and a cached one was read from a file this editor has not seen removed. A probe that fails reads as present,
 *  so an unreachable backend refuses nothing here. */
async function goneFiles(restores: readonly PrefabRestore[]): Promise<Set<string>> {
  const gone = new Set<string>();
  for (const r of restores) {
    const path = prefabPathOf(r.source);
    if (documentNow(r.source)) continue;
    try {
      const res = await backendFetch(`/api/exists?path=${encodeURIComponent(path)}`);
      if (res.ok && ((await res.json()) as { exists?: boolean }).exists === false) gone.add(path);
    } catch { /* unreachable: present */ }
  }
  return gone;
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
  // The file probe FIRST (#1877 close-out review): awaited after the settle, a Save that began during its round trip was
  // not waited for, which reopened the window the settle closes.
  const gone = await goneFiles(restores);
  await assetWritesSettled(restores.map((r) => prefabPathOf(r.source)));
  const refused = prefabRestoreRefusal(restores, gone);
  if (refused) throw refused;
  const sources = new Set<string>();
  for (const r of restores) {
    const path = prefabPathOf(r.source);
    const doc = clone(r.doc);
    // A document read from a file that carried no id keeps the one the manifest gave it: Save would otherwise mint a new
    // one and unlink every instance (#1264's rule, as the forward write's).
    if (!doc.id && isGuid(r.source)) doc.id = r.source;
    // What the file holds: the park's own record when one is there — the file has not been written since it was parked —
    // else what the editor holds, which the refusal above has just matched against the side the step left. The EDITOR's
    // copy, not `r.from`: the same document, but a Save since the step wrote the mark the editor holds, which can be
    // higher than the one the step recorded (an undo parked a raised mark and Cmd+S wrote it). `r.from` stated the lower
    // one, and the next Apply reused an undone row's number (#1877 S1). `r.from` only when no cache holds the document.
    const park = parkedPrefabEntry(path);
    const now = documentNow(r.source);
    const onDisk = park?.onDisk ?? (now ? clone(now) : r.from);
    // The localId mark never goes down (I4, #1774): the restored document is OLDER than the one the step left, and a
    // row the step added took a number at or above the old mark. Every reader of the park mints from it (Create
    // Prefab's Replace, the model re-import, the rigged regenerate, the agent's create, prefab edit), and with the old
    // mark a new row reused the undone row's number (#1872 close-out review). Raised to what the file holds and what the
    // step left — `sameDocument` ignores the mark, so the restore's own comparisons are unchanged. Stated only when it
    // is higher than the document's own counter: a step that added no row leaves the document exactly as it was.
    const mark = Math.max(localIdCounter(onDisk as CountedDoc), localIdCounter(r.from), now ? localIdCounter(now as CountedDoc) : 0);
    if (mark > localIdCounter(doc)) stateRaisedMark(doc, mark);
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
