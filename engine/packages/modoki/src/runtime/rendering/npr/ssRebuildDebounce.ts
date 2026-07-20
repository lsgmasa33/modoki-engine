/** Super-sample-scale rebuild debouncer (npr-F9).
 *
 *  An NPR `superSampleScale` change is the one `setConfig` case that can't be
 *  applied to a live pipeline — it resizes every render target, so the Scene3D
 *  driver must `dispose()` + reconstruct the whole `NPRPostProcess` (re-running
 *  the MRT pass build + two `RenderPipeline`s + the `ParticlePassNode`, i.e. a
 *  shader recompile). Dragging the SS-scale slider fires a new value almost every
 *  frame, so a naive "rebuild whenever the value differs" thrashes compiles and
 *  can stutter on a fragile first-compile renderer.
 *
 *  This coalescer makes the driver wait until the target scale has held *steady*
 *  for a short window before committing the (expensive) rebuild — so a drag that
 *  sweeps 1→2→3→4 in successive frames recompiles once, at the value the slider
 *  settled on, instead of three times mid-drag. Cheap uniform updates are
 *  unaffected (the driver applies those every frame regardless); only the
 *  structural rebuild is debounced.
 *
 *  Frame-count based (not wall-clock) so it stays deterministic and needs no
 *  injected clock — the driver ticks it once per rendered frame. */

/** Default settle window in frames (~0.2s @60fps): long enough to swallow a
 *  drag's intermediate values, short enough to feel instant on release. */
export const DEFAULT_SS_REBUILD_SETTLE_FRAMES = 12;

export class SuperSampleRebuildDebouncer {
  /** The scale currently live in the built pipeline. */
  private applied: number;
  /** A pending target that differs from `applied` and hasn't settled yet, or
   *  null when no rebuild is in flight. */
  private pending: number | null = null;
  /** Frames the current `pending` value has held unchanged. */
  private heldFrames = 0;
  private readonly settleFrames: number;

  constructor(initialScale: number, settleFrames = DEFAULT_SS_REBUILD_SETTLE_FRAMES) {
    this.applied = initialScale;
    this.settleFrames = Math.max(1, settleFrames);
  }

  /** The scale baked into the live pipeline. */
  get appliedScale(): number {
    return this.applied;
  }

  /** Feed this frame's desired scale; returns `true` once — on the frame the
   *  target has held steady for `settleFrames` — to tell the driver to rebuild.
   *  Returns `false` while still settling, when the value matches the applied
   *  scale, or on any frame after the rebuild was already signalled.
   *
   *  Call exactly once per rendered frame. */
  tick(desiredScale: number): boolean {
    if (desiredScale === this.applied) {
      // Slider returned to the live value mid-settle — cancel the pending rebuild.
      this.pending = null;
      this.heldFrames = 0;
      return false;
    }
    if (desiredScale !== this.pending) {
      // New (or first) pending target — restart the settle countdown at 1 (this
      // frame counts as the first held frame).
      this.pending = desiredScale;
      this.heldFrames = 1;
    } else {
      // Same pending target as last frame — accumulate hold time.
      this.heldFrames++;
    }
    if (this.heldFrames >= this.settleFrames) {
      this.applied = this.pending;
      this.pending = null;
      this.heldFrames = 0;
      return true;
    }
    return false;
  }
}
