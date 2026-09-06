/** Wait for two animation frames, but never longer than `timeoutMs` (#682).
 *
 *  `App.tsx`'s boot sequence awaits two chained `requestAnimationFrame`s twice — once so
 *  Scene3D/Game/UIRenderer mount before the asset manifest loads, once so `syncRenderables` has a
 *  frame to place runtime-generated content before the loading overlay is dismissed. Both used to
 *  be unbounded: `await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(()
 *  => r())))`. A dead rAF chain (the frame loop STALLED or went UNRECOVERABLE — see
 *  `getFrameLoopHealth()`) means neither callback ever fires, so that await hangs the boot sequence
 *  FOREVER behind the opaque `LoadingOverlay`. On a 2D/UI-only project (no `bootScenePath` render-
 *  paint gate ahead of it), the second call site is the ONLY gate before the OTA boot-confirm and
 *  the overlay dismissal — so a dead rAF there is a permanent black screen and a bundle the native
 *  watchdog then rolls back.
 *
 *  Same race-a-timeout shape as `engine/app/debug/layoutSettle.ts`'s `layoutSettleReport` — a
 *  timed-out boot is a smaller loss than one that never finishes. Pure and dependency-free so it is
 *  directly unit-testable (`App.tsx` itself carries no tests — its DECISIONS live in plain .ts
 *  helpers beside it, per the editor-panel convention this boot sequence follows too).
 *
 *  Returns which branch of the race actually won — `'timeout'` vs `'frames'`, mirroring
 *  `waitForScenePaint`'s `ScenePaintOutcome` shape — rather than a bare `Promise<void>` that made
 *  every caller unable to tell the two apart (#682 close-out, LOW 6). The bounded wait alone was
 *  not the whole fix: a caller that cannot see `'timeout'` cannot warn on it, and — the worse half
 *  — `App.tsx` was calling `confirmShellBoot()` unconditionally right after this, so the very
 *  "permanent black screen" this file's header describes stopped being what the native watchdog
 *  saw: boot completed (on the timeout, not a real frame) and was confirmed as GOOD, exactly
 *  backwards from the rollback that header still describes.
 *
 *  ⚠️ **A HIDDEN document is not a dead loop, and must not be charged as one.** rAF is throttled to
 *  near-zero while `document.visibilityState === 'hidden'` — an OTA relaunch that lands backgrounded
 *  (or a launch that never gets foregrounded inside the first `timeoutMs`) would otherwise blow the
 *  ceiling every time, report `'timeout'`, and skip `confirmShellBoot()` — but the boot attempt was
 *  already counted native-side, so nothing gets credited and a good bundle can roll back for a
 *  reason that has nothing to do with it painting. `frameDriver.ts`'s own `getFrameLoopHealth()`
 *  carries a distinct `'hidden'` status for exactly this reason and deliberately does not call it a
 *  stall — this file mirrors that call, at the primitive level, via `visibilitychange` rather than
 *  importing the engine: the timeout clock is armed only while the document is visible, is paused
 *  (not merely delayed) the moment it goes hidden, and is RE-ARMED for a fresh full `timeoutMs` the
 *  moment it becomes visible again, so a backgrounded window gets the same fair shot at landing two
 *  frames as a foregrounded one would. The already-pending rAF chain is untouched by any of this —
 *  a callback that is already requested keeps waiting and fires for real once the tab foregrounds,
 *  same as it always would; only the ceiling that would otherwise race it is what pauses/resumes.
 *  A chain that is genuinely dead (STALLED or UNRECOVERABLE per `getFrameLoopHealth()`) is unaffected
 *  by any of this — the document is visible in that case, so the ceiling runs and still fires
 *  `'timeout'` exactly as before, and `App.tsx` still skips `confirmShellBoot()` on it.
 *
 *  (The irony worth flagging: this round wires `getFrameLoopHealth()` into eleven other consumers,
 *  and this is the one call site that actually needed the hidden/stalled distinction. It doesn't
 *  need the import to get it — `document.visibilityState` is the same primitive that function reads
 *  internally, and reading it here directly keeps this file free of the engine-package dependency
 *  its "pure and dependency-free" design goal above calls for.) */
export function waitTwoFramesBounded(timeoutMs: number): Promise<'frames' | 'timeout'> {
  return new Promise<'frames' | 'timeout'>((resolve) => {
    const hasDocument = typeof document !== 'undefined';
    const isHidden = () => hasDocument && document.visibilityState === 'hidden';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (result: 'frames' | 'timeout') => {
      if (settled) return; // a late rAF or a timer that raced the other resolution — no-op
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (hasDocument) document.removeEventListener('visibilitychange', onVisibilityChange);
      resolve(result);
    };

    // (Re-)arms the ceiling for a fresh `timeoutMs` window. Called once up front (when the
    // document starts out visible) and again every time `onVisibilityChange` sees the document
    // come back into view — never while hidden, so the clock cannot expire during a background
    // stretch it was never meant to measure.
    const armTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        // Expired WHILE hidden (setTimeout keeps running in a backgrounded tab, just throttled)
        // — this is not evidence of a dead loop, so don't resolve. `onVisibilityChange` re-arms a
        // fresh ceiling the moment the document is visible again; if it never is, this simply
        // never fires again, which is correct — there is nothing to time out against.
        if (isHidden()) return;
        finish('timeout');
      }, timeoutMs);
    };

    const onVisibilityChange = () => {
      if (isHidden()) {
        // Cancel the ceiling outright rather than merely declining to resolve on it — an
        // overdue timer left pending across the hide would otherwise race the fresh one
        // `armTimer()` sets on resume, and per spec `visibilityState` flips to 'visible'
        // BEFORE this handler's task is queued, so the overdue callback can be delivered
        // first and fire `'timeout'` for a page that had been visible for 0ms.
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      } else {
        armTimer();
      }
    };

    if (hasDocument) document.addEventListener('visibilitychange', onVisibilityChange);
    if (!isHidden()) armTimer(); // starts out visible (or no `document` at all, e.g. tests) — arm now

    requestAnimationFrame(() => requestAnimationFrame(() => finish('frames')));
  });
}
