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
 *
 *  ⚠️ **That baseline has to ADVANCE when a save writes the parked doc, or undo breaks.** The
 *  comparison is by identity, so while the baseline named the doc the panel OPENED, undoing back to
 *  that value after a save compared equal and parked nothing: the panel showed the reverted doc, the
 *  file kept the saved one, `unsavedChanges` read false, and Cmd+S was a no-op — the revert could
 *  not be saved at all. Reported by the owner (2026-08-19) on a moved keyframe, which is the most
 *  ordinary undo there is: "undo what I just did", right after saving it. The debounced autosave
 *  this hook replaced advanced its own baseline on every successful write; parking moved the write
 *  into the registry, so the advance now comes from there (`getLastFlushedAsset`).
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  markAssetDirty, subscribeDirtyAssets, isAssetDirty, getLastFlushedAsset, peekDirtyAsset,
  discardDirtyAssets,
} from '../scene/dirtyAssets';
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
  /** The exact doc this panel last handed to the registry — the thing a flush would have written. */
  const parkedRef = useRef<T | null>(null);
  const markSaved = useCallback((v: T) => { savedRef.current = v; }, []);

  useEffect(() => {
    if (value == null || !path) return;
    if (value === savedRef.current) {
      // ⚠️ Back to what is on disk — so there is nothing to save, and any park of OURS must go.
      // Early-returning without dropping it is the mirror of the bug that started this: undo a
      // keyframe with no save in between and the registry still holds the un-done edit, so the
      // panel shows the reverted clip, the indicator says Unsaved, and Cmd+S writes the value the
      // human just undid — reporting success. (The agent twin has always done this reconciliation:
      // `pushAssetUndo` re-parks `before` when a write was pending and DISCARDS otherwise.)
      //
      // Only ours: compared by identity against what we parked, so an agent's park for the same
      // path — which we did not make and cannot judge — survives.
      if (parkedRef.current !== null && peekDirtyAsset(path)?.data === parkedRef.current) {
        discardDirtyAssets([path]);
      }
      parkedRef.current = null;
      return;
    }
    // Already parked, by whoever put this exact object there. An agent op (`particle_set`,
    // `anim_set_clip`, …) applies its def through the same store action the panel reads, so the
    // panel's `value` becomes the agent's object — and re-parking it here would relabel an AGENT
    // write as `'panel'`, which sends `replace:true` at flush and DELETES top-level fields the
    // drop-key guard exists to refuse. The same call would then be guarded or not depending on
    // whether a panel happened to be open on that asset.
    const alreadyParked = peekDirtyAsset(path);
    if (alreadyParked?.data === value) {
      // ⚠️ ADOPT ONLY OUR OWN PARK. `parkedRef` means "the doc THIS PANEL parked", and it is what
      // the reconciliation branch above discards by identity — so adopting an AGENT's object here
      // handed that branch someone else's write to throw away. Bug `EhE6JQkHRYttDGeGmtPK` (p0):
      // an agent parked a clip edit while the panel was open, the human re-opened the clip, and
      // the write was dropped while the panel went on showing it with a `Saved ✓` badge and disk
      // kept the old document. Nothing errored; the edit died at the next reload.
      //
      // Re-opening is what fires it: that path NORMALIZES the parked doc into a fresh object and
      // seeds it as the baseline, so `value === savedRef.current` on the following run and the
      // discard branch matches. Re-rendering with the SAME object does not re-run this effect at
      // all, which is why the obvious repro passes and the real one does not.
      parkedRef.current = alreadyParked.origin === 'panel' ? value : null;
      return;
    }
    parkedRef.current = value;
    markAssetDirty(path, type, value, 'panel');
  }, [value, path, type]);

  // A save wrote OUR parked doc → that doc is the file now, so it becomes the baseline.
  //
  // Matched by IDENTITY against what this panel parked, not merely by "the path was written". Two
  // cases depend on the difference: a panel that opens on an already-flushed asset must not adopt a
  // stale doc and dirty itself on open, and an edit made while a save was in flight must keep its
  // OWN park (the flush wrote the older doc, so the newer one is still unsaved and must stay so).
  const flushed = useSyncExternalStore(
    subscribeDirtyAssets,
    useCallback(() => getLastFlushedAsset(path), [path]),
    useCallback(() => getLastFlushedAsset(path), [path]),
  );
  useEffect(() => {
    if (flushed != null && flushed === parkedRef.current) {
      savedRef.current = parkedRef.current;
      parkedRef.current = null;
    }
  }, [flushed]);

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
