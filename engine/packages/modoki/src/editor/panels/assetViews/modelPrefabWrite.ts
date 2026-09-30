/** The model import's prefab write (`ModelAssetView.tsx`'s Import / Re-import), the decision half: read what is at the
 *  path now, merge a rigged re-import over it, and write over exactly that (#1692, I10). A plain module so the rule is
 *  testable without mounting the panel. */

import type { PrefabFile } from '../../scene/prefab';
import { mergeRiggedPrefab } from '../../scene/prefabSerialize';
import { commitPrefabWrite, parsePrefabBytes, prefabConflictReason } from '../../scene/prefabCommit';
import { readPriorDocument } from '../assetOps';

export type ModelPrefabWrite =
  /** Something is at the path and it could not be read: nothing was written, rather than overwriting it blind. */
  | { unreadable: true }
  | { unreadable?: false; ok: boolean; error?: string };

/** Write `prefab` (freshly serialized from the import) at `prefabPath`.
 *
 *  - `exists`: a prefab is there already, so the write is conditional on what it holds, read fresh — a prefab changed
 *    since (a save in prefab edit, an outside edit) is left as it is.
 *  - `rigged`: a rigged re-import refreshes the skeleton from source, but the user's prefab edits (a child hung on a
 *    bone, an added Animator) must survive, so the fresh skeleton is merged over the existing document, bones matched
 *    by NAME (`mergeRiggedPrefab`). A PARKED prefab is that document (#1868, #1872: `readPriorDocument` takes the park
 *    first): a merge over the file dropped the edits the editor shows from what it wrote. */
export async function writeModelPrefab(prefabPath: string, prefab: PrefabFile, o: { exists: boolean; rigged: boolean }): Promise<ModelPrefabWrite> {
  const prior = o.exists ? await readPriorDocument(prefabPath) : undefined;
  if (prior === null) return { unreadable: true };
  let doc = prefab;
  if (typeof prior === 'string' && o.rigged) {
    const existing = parsePrefabBytes(prior);
    if (existing && Array.isArray(existing.entities)) doc = mergeRiggedPrefab(prefab, existing);
  }
  // ONE step (#1692): the write, both caches (by the stable GUID too, so both resolve it), and a rebuild of every placed
  // instance — a rigged regenerate's added bones used to reach them only at the next reload, while the next save
  // captured them against the old rows. ⚠️ Nothing is cached unless the write landed: a scene load short-circuits on a
  // runtime cache hit, so seating bytes that never reached disk would keep serving them for as long as a scene owns it.
  const committed = await commitPrefabWrite(prefabPath, doc, { expected: prior ?? null });
  // A conflict carries no `error` of its own: its reason is said here, so the panel's log names the cause.
  const error = committed.ok ? undefined : committed.conflict ? prefabConflictReason(prefabPath).reason : committed.error;
  return { ok: committed.ok, ...(error ? { error } : {}) };
}
