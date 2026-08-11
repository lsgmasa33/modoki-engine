/** Re-entrancy guard for the boot ramp probe (#188).
 *
 *  ── THE BUG THIS EXISTS FOR, BECAUSE IT KILLED A PHONE ────────────────────────────────────
 *  The probe needs a renderer, so it calls `makeWebGPURenderer`. `makeWebGPURenderer` resolves
 *  the quality tier before allocating its drawing buffer — it must, since `antialias` is baked in
 *  at construction. And resolving the tier is *where the probe is invoked from*. So:
 *
 *      makeWebGPURenderer → resolveActiveTier → runBootRampProbe → makeWebGPURenderer → …
 *
 *  Unbounded recursion, one renderer construction per level. An iPhone 13 mini died ~80 ms in,
 *  with WebKit killing the tab outright.
 *
 *  ⚠️ **AND IT WAS INVISIBLE EVERYWHERE IT WAS TESTED.** A desktop resolves `'desktop'` and never
 *  reaches the probe branch at all, so the Mac, the editor and headless Chromium all ran the
 *  probe happily hundreds of times. The recursion is reachable ONLY on `formFactor: 'mobile'` —
 *  which is the only hardware the probe exists for. Every green check was green for a reason that
 *  did not apply to the target.
 *
 *  ── WHY A SEPARATE MODULE FOR ONE BOOLEAN ─────────────────────────────────────────────────
 *  So the invariant is testable. Buried as a `let` inside `scene3DSync` it would be reachable
 *  only through a real renderer on a real phone — the exact conditions that made the bug expensive
 *  to find. Here it is a named concept with a unit test, and the call site reads as what it is.
 *
 *  This is NOT a tier-resolution cache. `resolveActiveTier` already early-outs on an
 *  already-resolved tier; this guards the window BEFORE any tier exists, which is precisely when
 *  the recursion happens. */

/** A COUNT, not a boolean.
 *
 *  ⚠️ A bare flag is wrong the moment two probes can overlap: the first to finish clears it in its
 *  `finally` while the second is still running, and the recursion window this module exists to
 *  close reopens mid-probe — with a renderer already under construction inside it. `shareTierResolution`
 *  below now makes overlap unreachable through the one caller, but the guard should not depend on
 *  its caller staying correct: that dependency is what made this an iPhone-killer the first time. */
let probing = 0;

/** Is a boot probe currently running? While true, tier resolution must NOT start another one. */
export function isProbeInFlight(): boolean {
  return probing > 0;
}

/** Run `fn` with the probe-in-flight flag set, clearing it however `fn` ends.
 *
 *  `finally`, not a trailing assignment: the probe is explicitly allowed to throw (a failed probe
 *  must never block rendering), and a flag left stuck `true` by a throw would permanently disable
 *  probing for the process — a silent, once-per-install failure that no test would notice. */
export async function withProbeInFlight<T>(fn: () => Promise<T>): Promise<T> {
  probing += 1;
  try {
    return await fn();
  } finally {
    probing -= 1;
  }
}

// ── The OTHER way the probe runs twice: not recursion, but a race ─────────────────────────

let sharedResolution: Promise<void> | null = null;

/** Coalesce concurrent tier resolutions onto ONE run.
 *
 *  ⚠️ THE FLAG ABOVE DOES NOT COVER THIS, and the difference is worth stating precisely: it stops
 *  a call that arrives from INSIDE the probe (recursion). This stops two callers that arrive from
 *  OUTSIDE it, in the same tick, before either has set the flag — two surfaces each creating a
 *  renderer on a cold start. Both would clear every early-out (`getActiveQualityTier()` is still
 *  null, `probing` is still false, and both `getDeviceCaps()` and the probe are awaited), and both
 *  would run a launch-blocking probe.
 *
 *  That was survivable while the probe ran once ever and wrote the same verdict twice. Since the
 *  verdict refines across launches it is not: both runs read the SAME prior samples, so the second
 *  write discards the first's reading — the device pays two probes and banks one sample. On a Y6
 *  that is ~4.5 s of blocked launch to learn what 2.2 s would have.
 *
 *  ⚠️ **The caller MUST check {@link isProbeInFlight} BEFORE calling this.** A re-entrant call
 *  handed to this function would await the promise that is waiting for it — a deadlocked launch,
 *  which is worse than the recursion it replaced. */
export function shareTierResolution(run: () => Promise<void>): Promise<void> {
  if (sharedResolution) return sharedResolution;
  // `finally`, for the same reason as `withProbeInFlight`: a rejected resolution must not leave a
  // permanently-settled promise in the slot, or every later surface would await a failure forever.
  sharedResolution = run().finally(() => { sharedResolution = null; });
  return sharedResolution;
}

/** Test seam only. */
export function resetProbeInFlightForTest(): void {
  probing = 0;
  sharedResolution = null;
}
