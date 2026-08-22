/** The doc an asset editor should OPEN with, when an unsaved write is already parked for it.
 *
 *  Persistence is manual (`docs/mcp-persistence.md`): the agent asset ops — `particle-set`,
 *  `anim-set-clip`, `anim-add-key`, `timeline-set`, `timeline-add-clip` — apply their change to
 *  the live cache and PARK the write in the dirty-asset registry, where it stays until Save All.
 *  So between the edit and the save, the file on disk still holds the PRE-edit doc.
 *
 *  Every asset panel opens by fetching that file. Measured on `games/3d-test` (QA-CTX-0008): a
 *  `modoki_timeline_add_clip` that reported `{ok:true, tracks:1, items:1}` and read back through
 *  `modoki_read_asset_def` as one track was reduced to `tracks: []` the moment the Timeline
 *  Editor was opened on it — the panel's own fetch of the on-disk file re-seeded the live cache
 *  with the pre-edit doc, silently discarding the edit from everything that reads the cache,
 *  while `unsaved:true` and the parked write both stayed. The panel then SHOWS a document that
 *  disagrees with what Save All would write, which is the worst of the three states.
 *
 *  So: a panel asks here first, and only falls back to the file when nothing is pending. The
 *  caller must still mark the returned doc as the saved baseline — it is parked, not written, and
 *  a panel autosave firing on open would commit an edit the human never chose to save. */

import { peekDirtyAsset, markAssetDirty } from '../scene/dirtyAssets';
import type { AssetSchemaType } from '../../runtime/assets/assetSchemas';

/** The parked (unsaved) doc for `path`, or null when nothing is pending for it. `type` is
 *  checked rather than assumed: the registry is keyed by path alone, and handing a particle def
 *  to the timeline normalizer would produce a confident, empty document. */
export function pendingAssetDoc(path: string | undefined, type: AssetSchemaType): unknown | null {
  if (!path) return null;
  const pending = peekDirtyAsset(path);
  if (!pending || pending.type !== type || pending.data == null) return null;
  return pending.data;
}

/**
 * Open ON the parked write: put the panel's normalized copy into the registry, keeping the
 * ORIGINAL origin, and leave the saved baseline alone.
 *
 * ⚠️ This exists because the five panels used to call `markSaved(doc)` here instead, and that is
 * a lie with two p0 consequences. The parked doc is **not on disk** — that is the whole reason
 * this module exists — so naming it the saved baseline makes `useParkedAssetDoc`'s reconciliation
 * branch fire on the next run (`value === savedRef.current`) and DISCARD the pending write. The
 * end state is the worst one available: the panel shows the edit, disk holds the old document,
 * the registry is empty, and the badge reads `Saved ✓`, so Cmd+S writes nothing and the edit dies
 * at the next reload with no error.
 *
 *   - `EhE6JQkHRYttDGeGmtPK` — an AGENT parks a clip edit, the human re-opens the clip, edit gone.
 *   - `1MCF9DFktot8hXsgBuWp` — a human parks a panel edit, then RENAMES the asset, edit gone.
 *
 * They were filed as separate bugs with different triggers; both run through this one line. The
 * rename is not special — repointing the panel changes its `path`, which re-runs the load effect,
 * which took this branch.
 *
 * Why re-park rather than simply not marking: the panel NORMALIZES the parked doc into a fresh
 * object, so the registry's entry and the panel's `value` would no longer be the same object. The
 * hook's "already parked by whoever put this exact object there" branch keys on identity, so it
 * would miss, fall through, and re-park under origin `'panel'` — relabelling an agent write, which
 * sends `replace:true` at flush and deletes the top-level fields the drop-key guard refuses.
 * Re-parking the normalized object under the original origin keeps identity and origin both true.
 *
 * The old comment justified `markSaved` with "the autosave must not commit it on open". There is
 * no autosave — #259 replaced it with this registry — so the reason had outlived the mechanism.
 */
export function adoptParkedDoc(path: string, type: AssetSchemaType, doc: unknown): void {
  const pending = peekDirtyAsset(path);
  markAssetDirty(path, type, doc, pending?.origin ?? 'panel');
}
