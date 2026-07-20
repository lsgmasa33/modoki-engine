/** SceneView 3D viewport idle render gate (extracted for testability).
 *
 *  The editor's 3D viewport drives a single persistent WebGPU renderer in one rAF
 *  loop. On a static idle scene we skip the whole ECS→Three sync + GPU submit — but
 *  ONLY when nothing that affects the rendered image changed. A missed "dirty" source
 *  shows a visibly stale viewport (e.g. the 3D grid still visible after switching to
 *  2D/UI mode, or a device letterbox not applied), which is far worse than a few wasted
 *  frames. This module isolates that gate so its contract is unit-testable instead of
 *  buried inline in the component.
 *
 *  Countdown, not a boolean: several async resource loaders in scene3DSync poll
 *  "not ready — retry next frame" (mesh templates, streamed textures) with no completion
 *  callback, so a single post-dirty frame can miss them. Drawing for `grace` frames after
 *  the last event lets them converge; a truly static viewport then settles to 0 submits. */

import { useEffect } from 'react';

export const DIRTY_GRACE = 60; // ~1s @60fps

export interface ViewportDirtyGate {
  /** Re-arm the gate: draw for `grace` more frames. */
  markDirty: () => void;
  /** Per-frame decision. `live` (running sim / particle or skeletal preview) and
   *  `controlsMoving` (OrbitControls still settling) force a draw. Otherwise draws
   *  only while frames remain. Decrements the countdown when it returns true. */
  shouldDraw: (live: boolean, controlsMoving: boolean) => boolean;
  /** Frames remaining in the grace window (diagnostics / tests). */
  frames: () => number;
}

export function createViewportDirtyGate(grace: number = DIRTY_GRACE): ViewportDirtyGate {
  let dirtyFrames = grace; // draw the first burst (initial load + texture settle)
  return {
    markDirty: () => { dirtyFrames = grace; },
    shouldDraw: (live, controlsMoving) => {
      if (!live && !controlsMoving && dirtyFrames <= 0) return false;
      if (dirtyFrames > 0) dirtyFrames--;
      return true;
    },
    frames: () => dirtyFrames,
  };
}

/** Re-arm the gate whenever any value in `deps` changes.
 *
 *  REGRESSION GUARD: the SceneView view mode (3D ↔ 2D/UI) and layer toggles are
 *  component-local React props, NOT editor-store fields, so they do NOT flow through
 *  `useEditorStore.subscribe(markViewportDirty)` like selection/gizmo/gameRect do.
 *  Without this re-arm, switching mode on an idle scene leaves the renderer holding the
 *  previous mode's scissor/viewport/camera + helper visibility — a half-broken frame
 *  (most obvious with a device preset selected, where the 2D letterbox differs sharply
 *  from the 3D full viewport). Keep mode/layers in this dep list. */
export function useRearmDirtyOnChange(markDirty: () => void, deps: unknown[]): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { markDirty(); }, deps);
}
