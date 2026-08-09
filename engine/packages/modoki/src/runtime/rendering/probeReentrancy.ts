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

let probing = false;

/** Is a boot probe currently running? While true, tier resolution must NOT start another one. */
export function isProbeInFlight(): boolean {
  return probing;
}

/** Run `fn` with the probe-in-flight flag set, clearing it however `fn` ends.
 *
 *  `finally`, not a trailing assignment: the probe is explicitly allowed to throw (a failed probe
 *  must never block rendering), and a flag left stuck `true` by a throw would permanently disable
 *  probing for the process — a silent, once-per-install failure that no test would notice. */
export async function withProbeInFlight<T>(fn: () => Promise<T>): Promise<T> {
  probing = true;
  try {
    return await fn();
  } finally {
    probing = false;
  }
}

/** Test seam only. */
export function resetProbeInFlightForTest(): void {
  probing = false;
}
