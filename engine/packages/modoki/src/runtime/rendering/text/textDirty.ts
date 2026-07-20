/** Text relayout dirty-signal — mirrors `markUIDirty` (uiTreeStore). Bumped when
 *  something that affects laid-out text changes OUTSIDE the per-entity trait hash
 *  the renderers already track each frame:
 *   - an async font atlas finishes loading (text that was waiting can now lay out),
 *   - a dynamic provider generates a new glyph + grows its atlas (Phase 7).
 *
 *  The renderers compare a stored version to {@link getTextDirtyVersion} and force a
 *  full text re-evaluation when it changed. A monotonic counter (not a boolean) so
 *  multiple observers each detect the change exactly once. */

let _version = 0;
const listeners = new Set<() => void>();

/** Signal that laid-out text may be stale and should be rebuilt next frame. O(1). */
export function markTextDirty(): void {
  _version++;
  for (const l of listeners) l();
}

/** The current dirty version — renderers store the last value they acted on and
 *  re-evaluate when it differs. */
export function getTextDirtyVersion(): number {
  return _version;
}

/** Subscribe to dirty bumps (e.g. to schedule a repaint). Returns an unsubscribe. */
export function onTextDirty(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
