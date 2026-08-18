/** 3D material-property dirty signal — the sibling of `text/textDirty.ts`, for the same reason.
 *
 *  The editor's SceneView is RENDER-ON-DEMAND: its idle gate (SceneView.tsx, F2) submits a GPU
 *  frame only when something marks it dirty, and every source it subscribes to is an ECS-level
 *  event — a trait write, a structural change, a world swap, a play-state edge, an editor-store
 *  change. `materialInstanceSystem` fits none of them: it writes a NUMBER straight onto a
 *  THREE.Material (opacity/color/roughness/map offset) on a per-entity clone. No trait is written,
 *  no store changes, so nothing armed the gate and the viewport kept showing the pre-change frame
 *  indefinitely.
 *
 *  That is invisible to every data-level check — `get_scene_state` reports the authored override,
 *  the clone genuinely carries the new value, and only the PIXELS are stale. It is also invisible
 *  to `modoki_capture_viewport`, which is `webContents.capturePage()`: a screenshot of the window,
 *  not a forced render (measured 2026-08-18 — painting a visible material red left the capture
 *  byte-identical until a camera move re-armed the gate).
 *
 *  The 2D path already had its own version of this (`broker2D.markEntity2DMaterialDirty`, which
 *  gates the Pixi redraw); this is the 3D half that was missing.
 *
 *  Marked only on an ACTUAL value change, so a constant-source override costs one frame and then
 *  lets the viewport settle back to zero GPU submits — the whole point of the idle gate. A
 *  time/curve-driven override changes every frame and therefore redraws every frame, which is
 *  what it is asking for. */

const listeners = new Set<() => void>();

/** Signal that a 3D material property changed outside the ECS write path. O(1).
 *
 *  PUSH ONLY — deliberately NOT the version-counter half of `textDirty.ts`. That sibling exports
 *  `getTextDirtyVersion` because two renderers genuinely fold it into a per-entity cache key to
 *  force a text relayout; nothing needs a pull here, and shipping an unread counter would invite a
 *  future caller to compare against a number no one maintains.
 *
 *  A throwing listener is CONTAINED (the `modelLoadNotify` precedent), and the call site is why
 *  this one matters more than its sibling's: `markTextDirty` fires from async loader callbacks,
 *  whereas this fires from inside `materialInstanceSystem`'s per-frame `updateEach`. An escaping
 *  throw there would take out the ECS system loop for the frame — an observer must not be able to
 *  break the simulation, and it must not be able to starve the observers after it either. */
export function markMaterial3DDirty(): void {
  for (const l of listeners) {
    try { l(); } catch (err) { console.error('[materialDirty] listener threw', err); }
  }
}

/** Subscribe to dirty bumps (e.g. to arm a render-on-demand gate). Returns an unsubscribe. */
export function onMaterial3DDirty(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
