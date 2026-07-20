/** Frame-driver callback key minting for the editor viewports (editor-sceneview F5/F6).
 *
 *  Frame callbacks are stored in a `Map<string, …>` (frameDriver). Two viewport instances that
 *  computed the SAME key would clobber each other, and the first one's cleanup would then
 *  unregister the SURVIVOR — leaving a renderer with no frame loop (a black/stale viewport).
 *
 *  - The 3D viewport uses a module-monotonic counter (not `Date.now()`, which collided on
 *    same-millisecond remounts under StrictMode / fast-mode toggle / HMR — F5).
 *  - The 2D Canvas2DLayer keys by its Canvas2D entity id ALONE (not entity-id + pixel size),
 *    so a resize/zoom doesn't re-register the callback or restart the ref-counted driver (F6).
 *    One key per canvas entity is already unique across the mounted layers. */

let nextEditorFrameId = 0;

/** A fresh, never-repeating key for a 3D editor viewport instance. */
export function mintEditor3DFrameKey(): string {
  return `editor-3d-${nextEditorFrameId++}`;
}

/** The stable frame key for a Canvas2D layer — keyed by entity id only (F6). */
export function editor2DFrameKey(canvasEntityId: number): string {
  return `editor-2d-${canvasEntityId}`;
}

/** Frame key for the Pixi-migration chrome overlay canvas (Phase 3). Distinct from
 *  `editor2DFrameKey` so, even if both the DOM Canvas2DLayer and the chrome canvas were ever
 *  mounted for the same entity, their draw callbacks can't clobber each other. */
export function editor2DChromeFrameKey(canvasEntityId: number): string {
  return `editor-2d-chrome-${canvasEntityId}`;
}
