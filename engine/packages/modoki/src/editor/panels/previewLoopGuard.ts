/** A per-run guard for a ▶ preview panel's own rAF loop (#810 follow-up).
 *
 *  `TimelineEditor` and `AnimationEditor` each drive a ▶ preview with their own
 *  `requestAnimationFrame` loop, and both read the SAME shared store flag
 *  (`useEditorStore((s) => s.isPreviewPlaying)`) to know whether to run at all.
 *
 *  A displacement notification (`registerModeOwnerDisplaced`, `playMode.ts`) fires OUTSIDE the
 *  loop's closure — synchronously, from `enterPreviewMode`/`enterScrubMode`, possibly on the very
 *  frame the OTHER panel's loop just started — and must stop THIS panel's rAF loop WITHOUT
 *  touching that shared flag. The first pass at #810 had the displaced callback call
 *  `setPreviewPlaying(false)`, which is not "stop my panel" — it is "stop the global preview",
 *  and both panels' preview effects are keyed on it. With both panels docked, one ▶ press could
 *  stop itself: Animation enters first (no notify, nothing owned it yet), Timeline's async
 *  session-open resolves and takes the mode, displacing Animation — whose callback then flipped
 *  the shared flag off, tearing down BOTH loops, including the one that had JUST started.
 *
 *  So displacement must cancel only the displaced panel's OWN loop, leaving the flag (and
 *  therefore the surviving owner's loop) alone. This guard is the mechanism: it holds the
 *  currently in-flight rAF id so an outside caller can cancel it synchronously, plus a `stopped`
 *  flag the tick must check BEFORE rescheduling — a plain `cancelAnimationFrame` alone loses the
 *  race against a tick that is already queued, since the tick reschedules itself unconditionally
 *  the moment it runs. Checking `stopped` first closes that door regardless of timing: however
 *  the tick got invoked, it will not requestAnimationFrame again once `stop()` has run. */
export interface PreviewLoopGuard {
  /** True once `stop()` has run for THIS guard. The tick must check this before its own
   *  `requestAnimationFrame` call and return without rescheduling when it is true. */
  readonly stopped: boolean;
  /** Record the currently in-flight rAF id, so `stop()` can cancel it synchronously. Call this
   *  every time the tick (re)schedules itself. */
  arm(raf: number): void;
  /** Cancel the in-flight frame (if any) and stop all future rescheduling. Idempotent. */
  stop(): void;
}

export function createPreviewLoopGuard(): PreviewLoopGuard {
  let raf = 0;
  let stopped = false;
  return {
    get stopped() { return stopped; },
    arm(next: number): void { raf = next; },
    stop(): void {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
