/** UI-tree dirty flag + editor dirty-subscriber registry — extracted out of `ui/uiTreeStore.ts`
 *  (P7 C3) since it's a plain global signal (same shape as `core/playState.ts`), not a UI-owned
 *  concept: `animation/sampleClip.ts` and `input/inputSystem.ts` both need to call `markUIDirty`
 *  without reaching into the `ui/` subsystem for it. `uiTreeStore.ts` re-exports everything here
 *  for backward compatibility, and remains the sole reader of `isUIDirty`/`clearUIDirty` (its
 *  `uiTreeProjection` is still the only place that rebuilds the tree). */

let _dirty = true; // Start dirty so the first frame builds the tree

// Editor dirty subscriber set — Inspector, UIResizeOverlay, etc. subscribe for event-driven refresh.
const _editorDirtyListeners = new Set<() => void>();
let _singleEditorCb: (() => void) | null = null;

/** Subscribe to editor dirty notifications. Returns an unsubscribe function. */
export function onEditorDirty(fn: () => void): () => void {
  _editorDirtyListeners.add(fn);
  return () => { _editorDirtyListeners.delete(fn); };
}

/** Legacy single-callback API for backward compat (Inspector). */
export function setEditorDirtyCallback(fn: (() => void) | null) {
  if (_singleEditorCb) _editorDirtyListeners.delete(_singleEditorCb);
  _singleEditorCb = fn;
  if (fn) _editorDirtyListeners.add(fn);
}

function notifyEditorDirty() {
  for (const fn of _editorDirtyListeners) fn();
}

/** Mark the UI tree as needing a rebuild. Called from writeTraitField, deleteEntity, a world
 *  swap, etc. Cost: setting a boolean + notifying editor subscribers. */
export function markUIDirty() {
  _dirty = true;
  notifyEditorDirty();
}

/** Read-then-clear the dirty flag. Only `uiTreeProjection` should call this — it is the single
 *  place that rebuilds the tree and must own the read/clear pairing. */
export function isUIDirty(): boolean {
  return _dirty;
}

export function clearUIDirty(): void {
  _dirty = false;
}
