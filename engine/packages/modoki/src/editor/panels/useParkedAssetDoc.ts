/** Park an asset panel's document in the dirty-asset registry, and report whether it is unsaved.
 *
 *  Replaces `useDebouncedSave` (#259). The five asset editors used to POST their document to disk
 *  on a 400ms trailing debounce, which was a second persistence contract for the same file: it
 *  collided with the registry the agent ops park in, left no undo entry, and wrote committed files
 *  behind the human's back. Now the panel parks and Cmd+S is the write.
 *
 *  ⚠️ **PARKING IS SYNCHRONOUS, and dropping the debounce is a fix, not a simplification.** The
 *  old hook cleared its pending timer in the effect cleanup, so the last ≤400 ms of edits were
 *  discarded when the panel unmounted — edit a curve, close the tab, and the write never happened.
 *  It survived only because it was invisible: the def lives in the editor store, so reopening the
 *  panel took the `if (existing) markSaved(existing)` branch and marked the never-written document
 *  as the SAVED baseline, after which nothing could save it. Parking is a `Map.set`: there is no
 *  I/O to coalesce, so there is nothing to defer, and a window that used to lose 400 ms of edits
 *  would now lose them from the only path to disk.
 *
 *  `markSaved` is the load-baseline half and is why merely OPENING an asset does not dirty it: the
 *  load effect (which is declared above this hook, hence the ref dance in each panel) records the
 *  just-loaded document as already-persisted. Every later value — a field edit, an undo, a redo,
 *  all of which rewrite the store's def — differs from it and parks.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { markAssetDirty, subscribeDirtyAssets, isAssetDirty } from '../scene/dirtyAssets';
import type { AssetSchemaType } from '../../runtime/assets/assetSchemas';

/**
 * @param value the panel's live document (from the editor store), or null when nothing is open
 * @param path  the asset's path, or undefined when nothing is open
 * @param type  which schema the document conforms to — the flush validates against it
 * @returns `markSaved(value)` to seed the load baseline, and `dirty` for the panel's indicator
 */
export function useParkedAssetDoc<T>(
  value: T | null | undefined,
  path: string | undefined,
  type: AssetSchemaType,
): { markSaved: (value: T) => void; dirty: boolean } {
  const savedRef = useRef<T | null>(null);
  const markSaved = useCallback((v: T) => { savedRef.current = v; }, []);

  useEffect(() => {
    if (value == null || value === savedRef.current || !path) return; // nothing to park
    markAssetDirty(path, type, value, 'panel');
  }, [value, path, type]);

  // Subscribed, not read plainly: a save empties the registry without touching any panel state, so
  // a bare read would leave the indicator on "Unsaved" over a file that is on disk — stale in the
  // one direction that misleads. (getSnapshot returns a boolean, so React can compare it.)
  const dirty = useSyncExternalStore(
    subscribeDirtyAssets,
    useCallback(() => isAssetDirty(path), [path]),
    useCallback(() => isAssetDirty(path), [path]),
  );

  return { markSaved, dirty };
}

/** The panel's save-status text. One wording for all five editors, and a function rather than a
 *  component so it carries a test — the panels themselves are `.tsx` and by repo policy do not
 *  (CLAUDE.md). Says what is TRUE of the file, never what a debounce is about to do: the old
 *  "Saving… / Saved ✓ / Auto-save" reported an autosave that no longer exists. */
export function saveStatusLabel(dirty: boolean): string {
  return dirty ? 'Unsaved ● ⌘S' : 'Saved ✓';
}
