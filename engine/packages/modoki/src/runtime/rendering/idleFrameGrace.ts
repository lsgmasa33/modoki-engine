/** The idle gate's grace window for `Scene3D` — how many more frames a surface that is not playing
 *  keeps drawing after something changed.
 *
 *  A paused or stopped surface stops submitting once nothing is dirty; the swapchain holds the last
 *  presented frame. It is a frame COUNTDOWN rather than a boolean because `scene3DSync`'s async
 *  loaders poll "not ready — retry next frame" with no completion callback, so a short run of frames
 *  past each dirty event is what lets them converge.
 *
 *  ⚠️ **Only a SUBMITTED frame spends grace (#1252).** A frame a compile holds back draws nothing, so
 *  it has used none of the window. When held frames spent it, a paused surface held for more than the
 *  window stopped running the frame at all: it stopped renewing the loading overlay's wait
 *  (`heldFramePaintWait`) and stopped observing a compile gate's ceiling release, and the overlay
 *  lifted over a canvas that had not drawn. Every hold is bounded — a gate by its ceiling, a stage
 *  session by its own, a scene-pass borrow by being checked before this gate — so a held surface
 *  cannot spin here forever. */

export interface IdleFrameGrace {
  /** Something changed: draw a full window of frames again. */
  markDirty(): void;
  /** True when this frame should be skipped — nothing forces a draw and the window is spent. */
  shouldIdle(alwaysDraw: boolean): boolean;
  /** This frame reached the GPU. */
  submitted(): void;
}

export function createIdleFrameGrace(frames: number): IdleFrameGrace {
  let remaining = frames; // the first window covers the initial load + texture settle
  return {
    markDirty() { remaining = frames; },
    shouldIdle(alwaysDraw) { return !alwaysDraw && remaining <= 0; },
    submitted() { if (remaining > 0) remaining--; },
  };
}
