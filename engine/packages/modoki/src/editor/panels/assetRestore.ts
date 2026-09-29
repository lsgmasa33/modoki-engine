/** The ONE owner for a file an undo or redo PUTS BACK at a path a step before it trashed (#1844).
 *
 *  Such a restore goes through `/api/write-file`, the generic write route, which does not rebuild the manifest inline:
 *  only the routes that delete, move, duplicate or save-as do (M2, docs/prefabs.md § "A prefab named by PATH through the
 *  renderer manifest"). And it is the editor's OWN write, so the watcher sends no `scene-changed` for it and nothing
 *  invalidates or refetches the loader's entry. The delete had pruned the file's guid from the renderer's manifest (its
 *  inline rebuild) and evicted the prefab from the editor cache (`applyAssetPathMoves`); the loader's entry stays while
 *  its scene owns it (#1834 is blocked on #1862), but a scene that let go of it and took it back remembered a 404. So
 *  until the watcher's debounced push, the restored file's guid resolves to nothing — an Apply's undo read the prefab's path as
 *  the raw guid and was refused, a scene step re-created nothing — and an owned prefab stays out of the loader's cache.
 *
 *  ⚠️ **The manifest is loaded from the rescan's REPLY, not left to the push.** The routes that rebuild inline are safe
 *  because their push and their later `applyMovesInRenderer` relay go down one ordered channel to the renderer. A restore
 *  has no later relay, and the push (Vite's ws, Electron's IPC) is not ordered against the HTTP reply the step awaits — so
 *  an inline rebuild in `/api/write-file` would pass the in-process fuzzer (whose push is synchronous) and still race in
 *  the editor. The reply is loaded ADDITIVELY: a restore only brings files back, so registering what the scan found is the
 *  whole job, and a pruning load here would be a second prune authority (packaged Electron has none, `agentBridge.ts`) that
 *  could drop the guid of a file a concurrent route wrote after the scan was taken (close-out review). A push landing
 *  after the reply is a scan too, and removes only what it no longer finds.
 *
 *  ⚠️ **No refusal of its own.** The undo manager's GATE (`undoRefusedReason`) refuses the states where a restore would
 *  matter — Play, a scene switch landing, Stop's restore — BEFORE it pops the entry (a subset of `whyWorldNotAuthored`:
 *  a restore serializes nothing, so the rest does not apply; do not lean on the gate for a step that does), so Cmd+Z works once the world settles.
 *  A refusal thrown from inside the step DROPS the entry for good, and the gate deliberately lets a step through in
 *  states where a file restore is safe — an entry pushed in the current preview session, a failed Stop restore — so such
 *  a check lost the delete's undo there (close-out review, reproduced through `undoStep`). A restore does not serialize
 *  the live world, which is what "not savable" guards.
 *
 *  ONE rescan per step, not per file: the full scan is the cost (`scanAllAssets`), and a step restores N files at once.
 *
 *  The sites (the sibling sweep, #1844): the delete's undo (`makeDeleteUndo`, its own-sidecar overwrite included — that
 *  puts the snapshot's GUID back) and the import's redo (`makeFileImportUndo`). The other re-creates go through
 *  `commitPrefabWrite`, which registers the document's guid itself (`seatCaches`) and seats the caches; every Replace/Apply
 *  undo writes under `ifMatch`, so an absent file refuses rather than being re-created. */

import { backendFetch } from '../backend/editorBackend';
import { loadManifestJson } from '../../runtime/loaders/assetManifest';
import { refetchOwnedPrefab } from '../../runtime/loaders/meshTemplateCache';

export type ReannounceResult =
  | { ok: true }
  | { ok: false; error: string };

/** Tell the renderer about `paths`, which this step just put back: ONE rescan, whose reply is loaded into the manifest
 *  (additively), then a refetch of each restored prefab a scene owns. The refetch runs even when the rescan
 *  failed — it is by path, and needs no manifest. A failed rescan is returned for the caller to report: the files ARE
 *  back, and the next watcher push brings the manifest level. */
export async function reannounceRestoredFiles(paths: readonly string[]): Promise<ReannounceResult> {
  if (paths.length === 0) return { ok: true };
  let result: ReannounceResult = { ok: true };
  try {
    const res = await backendFetch('/api/rescan-assets', { method: 'POST' });
    if (!res.ok) result = { ok: false, error: `the rescan answered ${res.status}` };
    else loadManifestJson(await res.json() as Parameters<typeof loadManifestJson>[0]);
  } catch (e) {
    result = { ok: false, error: `the rescan failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  for (const p of paths) if (p.endsWith('.prefab.json')) refetchOwnedPrefab(p);
  return result;
}
