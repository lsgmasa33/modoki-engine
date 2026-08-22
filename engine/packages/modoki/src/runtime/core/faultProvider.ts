/** Deliberate NATIVE fault triggers, as a provider slot (#278).
 *
 *  ## Why a slot rather than a direct call
 *
 *  The faults are raised by `capacitor-game-debug`, which `@modoki/engine` does NOT depend on —
 *  the plugin is a dependency of the app shell, not of the engine package. So the debug menu (which
 *  lives in the package) declares the seam and the app shell installs the implementation, the same
 *  shape the debug bridge already uses. In the editor, on the web, and in a playable ad nothing
 *  provides it and the Device tab says so instead of offering buttons that cannot work.
 *
 *  ## Why native faults exist at all
 *
 *  #275 proved the JS half of crash reporting end to end and could not reach anything else. An ANR
 *  is unreachable from JS by construction — Android's WebView renderer is a separate sandboxed
 *  process, so blocking the JS thread for 8 s raises nothing (measured 8002 ms, nothing reported) —
 *  and a signal crash or an uncaught Java exception each take a different route into the crash
 *  reporter than `globalErrors.ts` can produce. Three pipelines; proving one says nothing about the
 *  other two. */

import { createProviderSlot } from './providerSlot';

/** The fault shapes a platform may be able to raise. Mirrors `FaultKind` in
 *  capacitor-game-debug's definitions.ts — that plugin is the implementation, this is the seam,
 *  and the two lists are kept in sync by `faultKinds.test.ts`. */
export type FaultKind = 'crash' | 'anr' | 'uncaught';

export interface FaultProvider {
  /** Which kinds THIS platform can raise. Android: all three. iOS: `crash` only — it has no ANR
   *  (the watchdog fires on launch/suspend transitions, not a foreground hang) and Crashlytics does
   *  not report hangs at all. An empty list means "native, but nothing supported". */
  supported(): FaultKind[];
  /** Raise the fault. **A resolved promise means ACCEPTED, never "it happened"** — on `crash` and
   *  `uncaught` the process is gone before JS resumes, so the call may never settle either way. The
   *  oracle is the crash console, not this return value. */
  trigger(kind: FaultKind, opts?: { blockMs?: number }): Promise<void>;
}

export const faultProvider = createProviderSlot<FaultProvider>('faultProvider');

/** Human-readable label + what the shape actually proves. Shared by the Device tab and any other
 *  surface that lists the probes, so the wording lives in one place. */
export const FAULT_LABELS: Record<FaultKind, { label: string; detail: string }> = {
  crash: {
    label: 'Native crash',
    detail: 'Android: SIGSEGV. iOS: EXC_BAD_ACCESS. Kills the app — the report uploads on the NEXT launch.',
  },
  anr: {
    // No duration in the text on purpose: the block length is the NATIVE side's constant
    // (DEFAULT_ANR_BLOCK_MS), and a number repeated here is a code constant shadowing another one
    // — it goes stale the first time the native default moves. The steps are what the operator
    // needs; the exact seconds are not.
    label: 'ANR (block main thread)',
    detail: 'Android only. Blocks the real main looper. TAP THE SCREEN to raise the ANR, then choose “Close app” — a block that ends on its own is never reported.',
  },
  uncaught: {
    label: 'Uncaught Java exception',
    detail: 'Android only. The canonical Android fatal — a different handler from the SDK’s own synthetic crash.',
  },
};
