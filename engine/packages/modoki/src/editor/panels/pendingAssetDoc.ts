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

import { peekDirtyAsset } from '../scene/dirtyAssets';
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
