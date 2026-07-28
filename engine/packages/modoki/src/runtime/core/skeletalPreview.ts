/** skeletalPreview — editor-only "preview skeletal animation while stopped" signal.
 *
 *  By design the skeletal mixer is frozen whenever the global play-state isn't
 *  `playing` (scene3DSync `syncSkinnedModels`): a stopped editor sits at the
 *  bind/static pose so bones stay hand-posable and authoring is determinism-clean.
 *  But the Animation editor's ▶ preview needs the bound rig's baked clips to
 *  animate live in the viewport while NOT in Play mode.
 *
 *  This module is the bridge. The EDITOR (SceneView, which may legally read the
 *  wall clock) computes a per-frame delta and calls `setSkeletalPreview(true, dt)`
 *  each frame the Animation-editor transport is playing; the RUNTIME sync
 *  (`syncSkinnedModels` / `syncBones`) reads it with no wall-clock of its own, so
 *  the determinism guard stays satisfied. In a shipped game nothing ever sets it,
 *  so `skeletalPreviewDelta()` is 0 and behaviour is unchanged (frozen-while-stopped).
 *
 *  Why a module-level singleton (mirrors `playState`): both 3D viewports
 *  (editor SceneView + GameView Scene3D) run on the one frame driver and each owns
 *  an independent mixer clone; reading the same per-frame delta advances each
 *  clone exactly once per frame. */

let _active = false;
let _dt = 0;

/** Set by the editor each preview frame. `dt` is this frame's wall-clock delta
 *  (seconds, already clamped by the caller); ignored when `active` is false. */
export function setSkeletalPreview(active: boolean, dt: number): void {
  _active = active;
  _dt = active ? dt : 0;
}

/** True while the Animation-editor transport is previewing skeletal animation
 *  with the sim stopped/paused. `syncBones` treats this like "playing" so the
 *  mixer pose is read back to bone Transforms instead of being clobbered. */
export function isSkeletalPreviewing(): boolean {
  return _active;
}

/** The mixer advance (seconds) for this preview frame, or 0 when not previewing. */
export function skeletalPreviewDelta(): number {
  return _active ? _dt : 0;
}
