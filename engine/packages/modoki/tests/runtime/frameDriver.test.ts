/** frameDriver unit tests (modoki package) — FPS capping via rAF simulation, uncapped mode. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  // Ensure rAF/cAF exist (jsdom may not provide them)
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
  if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function getDriver() {
  return import('../../src/runtime/rendering/frameDriver');
}

/** Wire GPU-loss detection the way a viewport does since #802: per-renderer, through the shared
 *  `rendererLossHandling` contract, NOT as a side effect of `setActiveRendererHandle` (which now
 *  arms nothing fault-related — it keeps only its registrants-stack/KTX2 role). Returns the fake
 *  canvas so a test can fire `webglcontextlost` on it, plus the composed detach.
 *
 *  ⚠️ Both GPU-fault tests below USED to reach the detection path via `setActiveRendererHandle`
 *  alone. After #802 that call armed nothing, so their `handler` was never assigned and
 *  `handler?.()` became a silent no-op — which left one of them failing and the OTHER passing
 *  VACUOUSLY (its assertion is "no GPU fault is mentioned", which holds trivially when no fault
 *  was ever recorded). This helper is what makes them exercise the real sequence again. */
async function attachViewportDetection(renderer?: { domElement: unknown }) {
  const activeRenderer = await import('../../src/runtime/core/activeRenderer');
  const { attachRendererLossHandling } = await import('../../src/runtime/rendering/rendererLossHandling');
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const domElement = renderer?.domElement ?? {
    addEventListener: (t: string, cb: (e: unknown) => void) => { (listeners[t] ??= []).push(cb); },
    removeEventListener: (t: string, cb: (e: unknown) => void) => {
      listeners[t] = (listeners[t] ?? []).filter((fn) => fn !== cb);
    },
  };
  const r = { domElement } as never;
  const detachLoss = attachRendererLossHandling(
    { canvas: domElement as HTMLCanvasElement, device: undefined },
    { label: 'test-viewport', isStale: () => false, ...activeRenderer.makeViewportLossPolicy({ renderer: r, isStale: () => false }) },
  );
  const detachUncaptured = activeRenderer.attachUncapturedErrorListener(r);
  return {
    /** Fire a real `webglcontextlost` — `attachContextLossListeners` calls `preventDefault()`. */
    loseContext: () => { for (const cb of [...(listeners.webglcontextlost ?? [])]) cb({ preventDefault: () => {} }); },
    detach: () => { detachLoss(); detachUncaptured(); },
  };
}

describe('frameDriver FPS capping', () => {
  it('skips callbacks when timestamp is within the frame interval', async () => {
    // Capture the rAF callback so we can simulate it
    let frameCallback: ((t: number) => void) | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frameCallback = cb as (t: number) => void;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
    setTargetFPS(60); // ~16.67ms interval

    let callCount = 0;
    registerFrameCallback('test', () => callCount++, 0);
    startFrameDriver();

    // Simulate: first frame at t=0 — should fire (initializes lastFrameTime)
    frameCallback!(0);
    const firstCount = callCount;

    // Simulate: frame at t=5 — within interval, should skip
    frameCallback!(5);
    expect(callCount).toBe(firstCount);

    // Simulate: frame at t=20 — past interval, should fire
    frameCallback!(20);
    expect(callCount).toBe(firstCount + 1);

    stopFrameDriver();
  });

  it('runs every callback when targetFPS is 0 (uncapped)', async () => {
    let frameCallback: ((t: number) => void) | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frameCallback = cb as (t: number) => void;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
    setTargetFPS(0);

    let callCount = 0;
    registerFrameCallback('test', () => callCount++, 0);
    startFrameDriver();

    // Every frame should fire regardless of timing
    frameCallback!(0);
    frameCallback!(1);
    frameCallback!(2);
    expect(callCount).toBe(3);

    stopFrameDriver();
  });

  it('maintains priority order during rAF execution', async () => {
    let frameCallback: ((t: number) => void) | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frameCallback = cb as (t: number) => void;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
    setTargetFPS(0);

    const order: string[] = [];
    registerFrameCallback('render', () => order.push('render'), 20);
    registerFrameCallback('ecs', () => order.push('ecs'), 0);
    registerFrameCallback('3d', () => order.push('3d'), 10);

    startFrameDriver();
    frameCallback!(0);

    expect(order).toEqual(['ecs', '3d', 'render']);

    stopFrameDriver();
  });

  describe('error isolation (regression for H5)', () => {
    it('a throwing callback does not stop sibling callbacks in the same frame', async () => {
      let frameCallback: ((t: number) => void) | null = null;
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
        frameCallback = cb as (t: number) => void;
        return 1;
      });
      vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
      // silence the expected error log
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
      setTargetFPS(0);

      const order: string[] = [];
      registerFrameCallback('boom', () => { order.push('boom'); throw new Error('intentional'); }, 0);
      registerFrameCallback('after', () => order.push('after'), 10);

      startFrameDriver();
      frameCallback!(0);

      expect(order).toEqual(['boom', 'after']);
      expect(errSpy).toHaveBeenCalled();

      stopFrameDriver();
    });

    it('auto-unregisters a callback after 10 consecutive throws', async () => {
      let frameCallback: ((t: number) => void) | null = null;
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
        frameCallback = cb as (t: number) => void;
        return 1;
      });
      vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
      setTargetFPS(0);

      let invocations = 0;
      registerFrameCallback('boom', () => { invocations++; throw new Error('always fails'); }, 0);

      startFrameDriver();
      // Run 12 frames — after 10 throws the callback should be unregistered,
      // so frames 11 and 12 don't invoke it again.
      for (let i = 0; i < 12; i++) frameCallback!(i);

      expect(invocations).toBe(10);

      stopFrameDriver();
    });

    it('error count resets after a successful call', async () => {
      let frameCallback: ((t: number) => void) | null = null;
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
        frameCallback = cb as (t: number) => void;
        return 1;
      });
      vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
      setTargetFPS(0);

      let shouldThrow = true;
      let invocations = 0;
      registerFrameCallback('flaky', () => {
        invocations++;
        if (shouldThrow) throw new Error('first 9 frames fail');
      }, 0);

      startFrameDriver();
      // 9 throws — under the auto-unregister threshold
      for (let i = 0; i < 9; i++) frameCallback!(i);
      // recover for one frame — resets the error counter
      shouldThrow = false;
      frameCallback!(9);
      // throw again for 10 more frames — should NOT be unregistered yet
      shouldThrow = true;
      for (let i = 10; i < 19; i++) frameCallback!(i);

      // 9 (throws) + 1 (success) + 9 (throws) = 19 invocations, all completed
      expect(invocations).toBe(19);

      stopFrameDriver();
    });
  });

  it('frame() calls requestAnimationFrame for the next frame', async () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
    setTargetFPS(0);

    startFrameDriver();
    // First call is from startFrameDriver
    expect(rafSpy).toHaveBeenCalledTimes(1);

    // Simulate the frame callback — it should schedule the next frame
    const frameCallback = rafSpy.mock.calls[0][0] as (t: number) => void;
    frameCallback(0);
    expect(rafSpy).toHaveBeenCalledTimes(2);

    stopFrameDriver();
  });
});

/** A SUPERSEDED rAF chain retires itself instead of running a second, duplicate loop (#573).
 *
 *  This is the only behaviour `runFrame`'s liveness check exists for, and nothing covered it: the
 *  existing cases drive only the CURRENT chain's callback, so deleting the check outright left
 *  them green. A duplicate live chain double-steps every registered system — every physics tick,
 *  every animation advance, twice per frame — which is why the check is there.
 *
 *  Production cadence: `armLoop` runs again while a chain is already armed. The frame-driver
 *  watchdog does exactly that when it decides a chain has stalled, and a re-arm racing an
 *  in-flight callback is precisely the case it cannot avoid.
 */
describe('frameDriver — a superseded chain', () => {
  it('retires an OLD chain\'s callback instead of double-stepping', async () => {
    const armed: Array<(t: number) => void> = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      armed.push(cb as (t: number) => void);
      return armed.length;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { registerFrameCallback, startFrameDriver, stopFrameDriver, setTargetFPS } = await getDriver();
    setTargetFPS(0); // uncapped — so a fired frame always runs the callback

    let ticks = 0;
    registerFrameCallback('test', () => ticks++, 0);

    startFrameDriver();
    const oldChain = armed[0];              // chain 1's callback
    expect(oldChain).toBeDefined();

    // Re-arm: stop then start is the ordinary route to a second chain.
    stopFrameDriver();
    startFrameDriver();
    const armedAfterRearm = armed.length;

    // The OLD chain's callback finally fires — it was already queued when the re-arm happened.
    oldChain(1000);

    expect(ticks, 'a retired chain must not step the systems').toBe(0);
    expect(armed.length, 'and must not reschedule itself').toBe(armedAfterRearm);

    stopFrameDriver();
  });
});

/**
 * Stall-watchdog ESCALATION (#590 Phase 1 — docs/plans/ios-rendering-update-wedge.md). On iOS,
 * a WebGL context loss makes WKWebView permanently stop delivering `requestAnimationFrame` —
 * JS/timers/the native bridge stay alive, paint just never resumes. Re-arming (the old repair)
 * cannot fix that, and used to retry forever while flooding the crash reporter. These tests drive
 * the watchdog's real `setInterval` via fake timers and the injectable clock (`setManualNow`/
 * `advanceManual`) so the 3s/12s thresholds are exercised deterministically, with no real
 * wall-clock involved.
 */
describe('frameDriver — stall watchdog escalation (#590)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vi.useRealTimers();
    const { restoreRealClock } = await import('../../src/runtime/core/clock');
    restoreRealClock();
  });

  /** The per-attempt "FRAME LOOP STALLED" texts only — excludes the separate, one-shot
   *  "FRAME LOOP UNRECOVERABLE" message (both contain "FRAME LOOP", so this must be specific). */
  function stallTexts(): string[] {
    return errSpy.mock.calls
      .map((args: unknown[]) => args[0])
      .filter((a: unknown): a is string => typeof a === 'string' && a.includes('FRAME LOOP STALLED'));
  }

  it('a sustained slow-but-alive rAF (~4900ms per delivery, well past the 3s stall threshold) ' +
     'RECOVERS and never escalates — the defect-5 regression guard', async () => {
    // THE important test here. A naive "re-arm whenever stalled" fix — or the right fix without
    // gating `recoveryAttempts` to whole STALL_MS periods — declares this device unrecoverable
    // and tells a player with a merely slow phone to restart a game that is working fine.
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);

    // A rAF mock where EVERY request — the initial arm, a natural reschedule, or a watchdog
    // re-arm — takes exactly DELIVER_MS from ITS OWN scheduling point to fire, matching a
    // genuinely slow-but-alive device (not a fixed global cadence, which would never expose the
    // supersession bug: a re-arm's replacement request must ALSO be slow for defect 5 to bite).
    const DELIVER_MS = 4900; // > STALL_MS (3000), comfortably < UNRECOVERABLE_AFTER_ATTEMPTS*STALL_MS (12000)
    let current = 0;
    const state: { pending: ((t: number) => void) | null } = { pending: null };
    let scheduledAt = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      state.pending = cb as (t: number) => void;
      scheduledAt = current;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getDriver();
    setTargetFPS(0);
    let unrecoverableFired = 0;
    onFrameLoopUnrecoverable(() => { unrecoverableFired++; });

    startFrameDriver(); // arms at t=0 → requestAnimationFrame captured, scheduledAt=0

    let deliveries = 0;
    for (let step = 0; step < 30; step++) { // 30s of simulated time — many delivery cycles
      current += 1000;
      advanceManual(1000);
      if (state.pending && current >= scheduledAt + DELIVER_MS) {
        const cb = state.pending;
        state.pending = null;
        cb(current); // the "browser" finally delivers — reschedules itself inside runFrame()
        deliveries++;
      }
      vi.advanceTimersByTime(1000); // drives the watchdog's setInterval(checkStall, 1000)
    }

    expect(unrecoverableFired).toBe(0);
    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    // NOT just "unrecoverable never got declared" — the device must actually have gotten to
    // PAINT repeatedly. A supersession-starved chain (defect 5, undoing the `frameSinceArm`
    // gate) would never deliver a single frame here — 30s of an *alive* device with no re-arm
    // ever outrunning its own DELIVER_MS gives it roughly 30000/DELIVER_MS deliveries; assert
    // comfortably fewer than that so the check isn't brittle, but definitely more than zero or
    // one (which would mean it's on the edge of starving, not genuinely recovering repeatedly).
    expect(deliveries).toBeGreaterThanOrEqual(4);
  });

  it('recoveryAttempts no longer resets mid-outage — logging goes quiet past MAX_REPORTED_ATTEMPTS (defect 2)', async () => {
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth } = await getDriver();
    setTargetFPS(0);
    startFrameDriver();

    // Advance to just past the 3rd STALL_MS boundary (9s) — MAX_REPORTED_ATTEMPTS(3) reached.
    for (let i = 0; i < 9; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    expect(stallTexts()).toHaveLength(3); // logged 3 times, not once per watchdog tick (9 ticks)
    expect(getFrameLoopHealth().recoveryAttempts).toBe(3);

    // One more STALL_MS period (to 12s) — this crosses into UNRECOVERABLE, a SEPARATE message,
    // not a 4th "attempt" log.
    for (let i = 0; i < 3; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(stallTexts()).toHaveLength(3); // still just the 3 "attempt" messages
    expect(getFrameLoopHealth().unrecoverable).toBe(true);
  });

  it('a re-arm\'s grace period does not mask an ONGOING outage (defect 2, precise timing)', async () => {
    // A narrower probe than the "never resets" test above: that one uses a chain that never
    // delivers even once, so `armLoop()` (and its grace-period-granting `armedAt` refresh) never
    // actually runs — it can't tell "judge on real frames" from "judge on arm-grace" apart,
    // because in that scenario the two clocks coincide throughout. This one forces exactly ONE
    // legitimate re-arm (the chain ran once, then died), so `armedAt` DOES get refreshed once,
    // and only `msSinceRealFrame()` (ignoring that refresh) reads the outage correctly from then
    // on. Judging on `msSinceProgress()` instead — the old bug — restarts the grace period at
    // the re-arm and delays `recoveryAttempts` by a full `STALL_MS`.
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { pending = cb as (t: number) => void; return 1; });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth } = await getDriver();
    setTargetFPS(0);
    startFrameDriver();

    advanceManual(10);
    const cb = pending!;
    cb(10); // one real frame, then this chain never fires again

    // t=4000: first detection (attempt 1) — also re-arms (the chain DID run once), refreshing
    // `armedAt` to ~4000. t=7000: a SECOND STALL_MS has now elapsed since the real frame at
    // t=10 — recoveryAttempts must reach 2 here. Judged on the arm-grace clock instead, `since`
    // at t=7000 would read only ~3000ms (since the t=4000 re-arm), i.e. still attempt 1.
    for (let i = 0; i < 7; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    expect(getFrameLoopHealth().recoveryAttempts).toBe(2);
  });

  it('resume after a long hidden period does NOT declare unrecoverable (false-positive regression)', async () => {
    // A player backgrounding the app (a phone call, an app switch) leaves `documentHidden()`
    // true for many watchdog ticks — each of which resets `stalledSince`/`recoveryAttempts` but
    // never touches `lastFrameAt`. The FIRST tick after returning therefore sees a huge `since`
    // in one shot (`stalledSince` is null, so it's judged via `msSinceProgress()`), and without
    // the clamp `Math.floor(since / STALL_MS)` can leap straight past
    // `UNRECOVERABLE_AFTER_ATTEMPTS` — declaring a perfectly healthy, resuming app unrecoverable
    // with zero re-arms ever attempted.
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    let rafCalls = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      pending = cb as (t: number) => void;
      rafCalls++;
      return rafCalls;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    // This package's vitest config runs in the 'node' environment by default (no jsdom), so
    // there is no real `document` — `documentHidden()` reads `typeof document !== 'undefined'`,
    // which needs SOMETHING at `globalThis.document`. A plain mutable stub is enough.
    const hadDocument = 'document' in globalThis;
    const savedDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: { visibilityState: string } }).document = { visibilityState: 'visible' };

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    // Frames running normally for a couple of ticks.
    for (let i = 0; i < 2; i++) {
      advanceManual(1000);
      const cb = pending!; pending = null;
      cb(0);
      vi.advanceTimersByTime(1000);
    }
    expect(getFrameLoopHealth().status).toBe('running');

    // Background the app for ~20s — no rAF delivery at all, and the watchdog's own ticks see
    // `documentHidden()` and reset `stalledSince`/`recoveryAttempts` each time.
    (globalThis as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
    for (let i = 0; i < 20; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    // Foreground again — the FIRST post-gap watchdog tick sees a huge `since` in one shot.
    (globalThis as { document: { visibilityState: string } }).document.visibilityState = 'visible';
    advanceManual(1000);
    vi.advanceTimersByTime(1000);

    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(fired).toBe(0);
    expect(getFrameLoopHealth().recovered).toBeGreaterThan(0); // it DID re-arm, not surrender

    // Once rAF actually delivers again, health returns fully to normal.
    const cb = pending!;
    expect(cb).toBeDefined();
    advanceManual(10);
    cb(0);
    vi.advanceTimersByTime(1000);
    const health = getFrameLoopHealth();
    expect(health.status).toBe('running');
    expect(health.recoveryAttempts).toBe(0);

    if (hadDocument) (globalThis as { document?: unknown }).document = savedDocument;
    else delete (globalThis as { document?: unknown }).document;
  });

  it('a long main-thread block does not escalate on the first tick (frameSinceArm true)', async () => {
    // Same false-positive shape as the hidden-tab case, without the visibility change: a heavy
    // scene load or shader compile blocks the main thread long enough that by the time the
    // watchdog's delayed `setInterval` tick finally runs, `since` is already enormous. One
    // detection observing a huge `since` while `frameSinceArm` is true must re-arm, never declare.
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    let rafCalls = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      pending = cb as (t: number) => void;
      rafCalls++;
      return rafCalls;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    // One real frame establishes `frameSinceArm = true` and a recent `lastFrameAt`.
    advanceManual(10);
    const cb = pending!;
    cb(10);

    // The main thread blocks for 20s in one go — the wall clock jumps, but the watchdog's
    // `setInterval` only fires ONCE catching up (we advance fake-timer time by exactly one
    // WATCHDOG_INTERVAL_MS, so exactly one `checkStall()` runs, seeing the full 20s jump).
    advanceManual(20000);
    vi.advanceTimersByTime(1000);

    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(fired).toBe(0);
    expect(getFrameLoopHealth().recovered).toBeGreaterThan(0); // re-armed, not surrendered
  });

  it('a chain already dead BEFORE a hidden gap does not skip straight to unrecoverable ' +
     '(isolates outageDetectedAt re-baselining from the frameSinceArm gate)', async () => {
    // `frameSinceArm` is false in this scenario throughout (the chain never delivers a single
    // frame), so the `!frameSinceArm` escalation gate does NOT protect it — whatever protection
    // exists here comes from `outageDetectedAt` re-baselining alone. Without it, `recoveryAttempts`
    // would be derived straight from the huge absolute `since` on the first post-hidden tick and
    // land at `attempts >= UNRECOVERABLE_AFTER_ATTEMPTS` in that ONE detection.
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const hadDocument = 'document' in globalThis;
    const savedDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: { visibilityState: string } }).document = { visibilityState: 'visible' };

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    for (let i = 0; i < 4; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); } // attempt 1 by t=3000

    (globalThis as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
    for (let i = 0; i < 20; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); } // 20s hidden

    (globalThis as { document: { visibilityState: string } }).document.visibilityState = 'visible';
    advanceManual(1000);
    vi.advanceTimersByTime(1000); // first post-hidden tick — `since` is huge in one shot

    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(fired).toBe(0);

    if (hadDocument) (globalThis as { document?: unknown }).document = savedDocument;
    else delete (globalThis as { document?: unknown }).document;
  });

  it('a real frame just before a SECOND long block does not skip straight to unrecoverable ' +
     '(isolates the frameSinceArm gate from outageDetectedAt re-baselining)', async () => {
    // Constructed so re-baselining is not what saves this case: three prior detections (all with
    // `frameSinceArm` false, so none of them re-armed, and none of them healthy-reset either)
    // already brought `recoveryAttempts` to 3 WITHOUT ever clearing `outageDetectedAt` — it is
    // still pinned to the very FIRST detection. Then ONE real frame delivers (`frameSinceArm`
    // becomes true) — but no watchdog tick observes it before a second long block hits, so
    // `stalledSince`/`outageDetectedAt` are STILL not reset (only a watchdog TICK seeing
    // `since < STALL_MS` clears them, and none runs in this gap). The next detection therefore
    // measures from that stale, minutes-old `outageDetectedAt` and jumps `recoveryAttempts` WAY
    // past `UNRECOVERABLE_AFTER_ATTEMPTS` in one shot — re-baselining alone cannot prevent this,
    // because nothing here ever re-baselined. Only the `!frameSinceArm` gate stops it: a frame DID
    // run since the current arm, so the honest read is "still plausibly alive", not "give up".
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { pending = cb as (t: number) => void; return 1; });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    // Three detections, 3000ms apart, none of them re-arming (the chain hasn't delivered yet).
    for (let i = 0; i < 9; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(getFrameLoopHealth().recoveryAttempts).toBe(3);

    // The SAME original (never re-armed) pending callback finally fires, late, at t=9500.
    advanceManual(500);
    const cb = pending!;
    cb(9500);
    expect(getFrameLoopHealth().recovered).toBe(0); // this was a natural delivery, not a re-arm

    // A second long block: the wall clock jumps 20s, the watchdog's setInterval catches up in
    // exactly one tick.
    advanceManual(20000);
    vi.advanceTimersByTime(1000);

    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(fired).toBe(0);
  });

  it('escalation after a 20s hidden gap takes ~9s from DETECTION, not 4s from resume ' +
     '(regression: the clamp described in review as a no-op)', async () => {
    // Measured on the reviewed build: hidden 8s/20s/60s all declared unrecoverable 4 REAL
    // seconds after resume — a `Math.min(attempt, recoveryAttempts + 1)` "clamp" that always
    // equals `recoveryAttempts + 1` (the guard above it already proved `attempt > recoveryAttempts`)
    // is just `recoveryAttempts++` once per 1000ms watchdog tick once `since` is already several
    // `STALL_MS` units stale — the gate meant to space attempts 3s apart never engages once
    // `since` is already far ahead of `recoveryAttempts`. This test is the hole the earlier
    // "one tick after resume, then return" tests left: it walks the FULL interval and pins it.
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // never delivers again
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const hadDocument = 'document' in globalThis;
    const savedDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: { visibilityState: string } }).document = { visibilityState: 'visible' };

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    (globalThis as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
    for (let i = 0; i < 20; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); } // 20s hidden
    (globalThis as { document: { visibilityState: string } }).document.visibilityState = 'visible';

    // t=21000 (relative +1s from resume): the FIRST post-hidden tick — detection, attempt 1.
    advanceManual(1000);
    vi.advanceTimersByTime(1000);
    expect(getFrameLoopHealth().unrecoverable, 'must not fire on the very first post-gap tick').toBe(false);

    // t=25000 (+4s from resume, +4s from detection): the old build had ALREADY declared
    // unrecoverable by here (measured 4s after resume). It must still be false.
    for (let i = 0; i < 4; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(getFrameLoopHealth().unrecoverable, 'still false at 4s past resume').toBe(false);

    // t=29000 (+8s from resume, +8s from detection): still false.
    for (let i = 0; i < 4; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(getFrameLoopHealth().unrecoverable, 'still false at 8s past resume').toBe(false);
    expect(fired).toBe(0);

    // t=30000 (+9s from the t=21000 detection): attempt 4 — NOW it gives up.
    advanceManual(1000);
    vi.advanceTimersByTime(1000);
    expect(getFrameLoopHealth().unrecoverable, '~9s after detection, the outage is genuinely dead').toBe(true);
    expect(fired).toBe(1);

    if (hadDocument) (globalThis as { document?: unknown }).document = savedDocument;
    else delete (globalThis as { document?: unknown }).document;
  });

  it('a chain delivering every 4900ms across a hidden-gap resume never escalates at all ' +
     '(defect-5 regression, now exercised across a discontinuity)', async () => {
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    const DELIVER_MS = 4900;
    let current = 0;
    const state: { pending: ((t: number) => void) | null } = { pending: null };
    let scheduledAt = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      state.pending = cb as (t: number) => void;
      scheduledAt = current;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const hadDocument = 'document' in globalThis;
    const savedDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: { visibilityState: string } }).document = { visibilityState: 'visible' };

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getDriver();
    setTargetFPS(0);
    let unrecoverableFired = 0;
    onFrameLoopUnrecoverable(() => { unrecoverableFired++; });
    startFrameDriver();

    let deliveries = 0;
    function step() {
      current += 1000;
      advanceManual(1000);
      if (state.pending && current >= scheduledAt + DELIVER_MS) {
        const cb = state.pending;
        state.pending = null;
        cb(current);
        deliveries++;
      }
      vi.advanceTimersByTime(1000);
    }

    for (let i = 0; i < 10; i++) step(); // 10s of the slow-but-alive cadence, healthy

    // Now a 20s hidden gap mid-stream, with rAF simply not delivering while hidden (realistic:
    // a backgrounded tab gets no rAF callbacks at all, slow or otherwise).
    (globalThis as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
    for (let i = 0; i < 20; i++) { current += 1000; advanceManual(1000); vi.advanceTimersByTime(1000); }
    (globalThis as { document: { visibilityState: string } }).document.visibilityState = 'visible';

    for (let i = 0; i < 20; i++) step(); // resume the same slow-but-alive cadence

    expect(unrecoverableFired).toBe(0);
    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(deliveries).toBeGreaterThan(2); // it kept actually painting throughout

    if (hadDocument) (globalThis as { document?: unknown }).document = savedDocument;
    else delete (globalThis as { document?: unknown }).document;
  });

  it('the stall message text is byte-identical across repeated emissions (defect 1)', async () => {
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS } = await getDriver();
    setTargetFPS(0);
    startFrameDriver();

    for (let i = 0; i < 6; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    const texts = stallTexts();
    expect(texts).toHaveLength(2); // attempts at 3s and 6s
    expect(texts[0]).toEqual(texts[1]); // byte-identical — NOT a substring check
    // STALL_MS is a compile-time CONSTANT, so it may legitimately appear in the text — what must
    // NOT appear is the varying elapsed time or attempt number the old message interpolated.
    expect(texts[0]).not.toMatch(/no frame for (?!over 3000ms\b)\d+ms/);
    expect(texts[0]).not.toContain('attempt 2');
  });

  it('declareUnrecoverable fires exactly once no matter how long the outage runs', async () => {
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, onFrameLoopUnrecoverable, setTargetFPS, getFrameLoopHealth } = await getDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    // Run well past the 12s threshold.
    for (let i = 0; i < 30; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    expect(fired).toBe(1);
    expect(getFrameLoopHealth().unrecoverable).toBe(true);
    const unrecoverableLogs = errSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('UNRECOVERABLE'),
    );
    expect(unrecoverableLogs).toHaveLength(1);
  });

  it('recovery clears the flag; a SECOND outage later in the same session still logs, ' +
     're-arms and fires onFrameLoopUnrecoverable again (defect 2, terminal-flag regression)', async () => {
    // Before this fix, `if (unrecoverable) return;` sat above EVERY detection, reset, log and
    // re-arm, and nothing outside `__resetFrameDriverForTests()` ever cleared it — so a single
    // false positive (or a real but transient outage) silently disabled the watchdog for the
    // rest of the session: a genuine SECOND wedge later produced no log, no re-arm and no
    // listener call. `getFrameLoopHealth().status` returning to `'running'` with `unrecoverable`
    // still stuck `true` was also invisible to `agentEditorOps.ts`'s `frameLoopFields()`, which
    // omits the whole block when `status === 'running' && recovered === 0`.
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { pending = cb as (t: number) => void; return 1; });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, onFrameLoopUnrecoverable, setTargetFPS, getFrameLoopHealth } = await getDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    // OUTAGE 1: the chain never delivers a single frame — escalates to unrecoverable at ~12s.
    for (let i = 0; i < 13; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(getFrameLoopHealth().unrecoverable).toBe(true);
    expect(fired).toBe(1);

    // RECOVERY: the very same (never re-armed, never superseded) pending callback finally,
    // very late, delivers a real frame.
    advanceManual(10);
    const recoveredCb = pending!;
    recoveredCb(0);
    vi.advanceTimersByTime(1000); // the next watchdog tick observes `since < STALL_MS`

    expect(getFrameLoopHealth().unrecoverable, 'a real frame must clear the flag').toBe(false);
    expect(getFrameLoopHealth().status).toBe('running');
    expect(getFrameLoopHealth().recoveryAttempts).toBe(0);

    errSpy.mockClear(); // isolate OUTAGE 2's own log activity from OUTAGE 1's

    // OUTAGE 2: this chain (already re-armed once by `recoveredCb`'s own `requestAnimationFrame`
    // call inside `runFrame`) now ALSO goes permanently silent. If it must still escalate,
    // re-arm along the way, log, and notify — the exact behaviour that used to be permanently
    // switched off after outage 1.
    for (let i = 0; i < 13; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    expect(getFrameLoopHealth().unrecoverable, 'a genuinely new outage must still be detected').toBe(true);
    expect(fired, 'the listener must fire AGAIN, not just once per session').toBe(2);
    expect(getFrameLoopHealth().recovered, 'it must have re-armed at least once during outage 2')
      .toBeGreaterThan(0);
    expect(stallTexts().length, 'outage 2 must log too, not go silent forever after outage 1')
      .toBeGreaterThan(0);
  });

  it('a full stop/start cycle ALSO clears a stuck unrecoverable flag (the other repro in the ' +
     'terminal-flag finding — no real frame is possible when nothing is armed to deliver one)', async () => {
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, stopFrameDriver, setTargetFPS, getFrameLoopHealth } = await getDriver();
    setTargetFPS(0);
    startFrameDriver();

    for (let i = 0; i < 13; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(getFrameLoopHealth().unrecoverable).toBe(true);

    stopFrameDriver(); // refCount -> 0, disarmLoop() -> stopWatchdog()
    expect(getFrameLoopHealth().unrecoverable, 'a full stop is a clean slate').toBe(false);

    startFrameDriver(); // fresh arm
    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(getFrameLoopHealth().recoveryAttempts).toBe(0);
  });

  it('re-arms a chain that ran a frame and then died (does not regress the working recovery path)', async () => {
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    let rafCalls = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      pending = cb as (t: number) => void;
      rafCalls++;
      return rafCalls;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth } = await getDriver();
    setTargetFPS(0);
    startFrameDriver(); // arms — rafCalls === 1

    // The chain delivers ONE frame almost immediately, then dies for good (the pending
    // callback from THIS point on is simply never fired again).
    advanceManual(10);
    const cb = pending!;
    cb(10);
    expect(rafCalls).toBe(2); // runFrame() rescheduled itself

    // Now it goes silent. The watchdog must re-arm at least once, because this chain DID run.
    for (let i = 0; i < 4; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    expect(getFrameLoopHealth().recovered).toBeGreaterThan(0);
    expect(rafCalls).toBeGreaterThan(2); // at least one watchdog-triggered re-arm requested a NEW chain
  });

  it('no user-visible string (stall/unrecoverable logs, FrameLoopHealth.detail) contains "editor"', async () => {
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth } = await getDriver();
    setTargetFPS(0);
    startFrameDriver();

    const seenDetails: string[] = [];
    for (let i = 0; i < 13; i++) {
      advanceManual(1000);
      vi.advanceTimersByTime(1000);
      // Sample `detail` mid-outage too — while STILL RETRYING (not yet unrecoverable) is a
      // SEPARATE branch of the message from the final "gave up" one, and both must be checked.
      seenDetails.push(getFrameLoopHealth().detail ?? '');
    }

    const allStrings = [
      ...errSpy.mock.calls
        .map((args: unknown[]) => args[0])
        .filter((a: unknown): a is string => typeof a === 'string'),
      ...seenDetails,
    ];
    for (const s of allStrings) expect(s.toLowerCase()).not.toContain('editor');
  });

  it('includes the GPU fault reason in the stall report when the GPU device is lost, ' +
     'SURVIVING the real production sequence (defect 3/6)', async () => {
    // The real sequence is `reportRendererLoss` -> `onRendererLost` -> `rendererRecovery`
    // (~250ms delay) -> a viewport's `bringUp()` -> `setActiveRenderer` ->
    // `setActiveRendererHandle`, which UNCONDITIONALLY wipes `gpuFaultState` for the new
    // renderer (`attachUncapturedErrorListener`'s "a new renderer starts with a clean slate",
    // which every viewport bring-up calls — it took that job over in #802). Against
    // the plan doc's own iPhone-8 trace the loss is at +1,136,882 and the stall fires at
    // +1,139,989 — well over a `STALL_MS` later, so by report time the LIVE `getGpuFaultState()`
    // has already been cleared by that rebuild. This test simulates exactly that: a second
    // `setActiveRendererHandle` call for a DIFFERENT renderer, between the loss and the ticks
    // that detect the stall — reading `getGpuFaultState()` live at report time goes red here;
    // only the latched copy survives it.
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    // frameDriver's `onRendererLost` subscription is registered at MODULE LOAD — import it
    // (matching production, where frameDriver loads long before any renderer ever registers)
    // BEFORE the loss fires, so the latch is actually listening.
    const { startFrameDriver, setTargetFPS, getFrameLoopHealth } = await getDriver();
    const { getGpuFaultState } = await import('../../src/runtime/core/activeRenderer');
    const viewport = await attachViewportDetection();
    viewport.loseContext(); // record a WebGL context loss — the CAUSE
    expect(getGpuFaultState()?.deviceLost).toBe(true); // the loss really was recorded

    // The rebuild: a NEW viewport attaches, wiping the live fault state clean for it. Sanity
    // check the premise — if this stops being true, the whole test stops meaning anything.
    await attachViewportDetection();
    expect(getGpuFaultState()).toBeNull();

    setTargetFPS(0);
    startFrameDriver();

    for (let i = 0; i < 3; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    expect(stallTexts()[0]).toContain('GPU fault:');
    expect(getFrameLoopHealth().gpuFault?.deviceLost).toBe(true);
  });

  it('drops a latched GPU fault once a real frame runs after an IN-PLACE recovery, so an ' +
     'UNRELATED later stall does not misattribute a fault that recovered long ago (BLOCKER fix)', async () => {
    // The DESIGNED recovery path: `reportRendererLoss` -> `onRendererLost` (latches) ->
    // `rendererRecovery` rebuilds within ~250ms (a NEW `setActiveRendererHandle`, which
    // unconditionally wipes the LIVE `gpuFaultState` — see the "SURVIVING" test above) -> frames
    // resume. That rebuild happens well under `STALL_MS` (3000), so `checkStall()`'s healthy
    // branch never sees `stalledSince !== null || unrecoverable` and its gated clear never runs.
    // Before the fix this left `latchedGpuFault` — read in PREFERENCE to the (correctly cleared)
    // live state once any LATER stall occurs — permanently shadowing that live `null` with a
    // fault that had already recovered. This rAF mock, unlike the "SURVIVING" test's, DOES
    // deliver real frames, so `lastFrameAt` genuinely advances past the latch.
    vi.resetModules();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);

    let frameCallback: ((t: number) => void) | null = null;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frameCallback = cb as (t: number) => void;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth } = await getDriver();
    const { getGpuFaultState } = await import('../../src/runtime/core/activeRenderer');
    const viewport = await attachViewportDetection();

    setTargetFPS(0);
    startFrameDriver();
    frameCallback!(0); // a real frame, before the loss

    viewport.loseContext(); // GPU context lost at t=0 — latches the fault (the CAUSE)
    // ⚠️ Assert the fault was REALLY recorded. Without this the test passes vacuously: its final
    // assertions are all "no GPU fault is mentioned", which hold trivially if the loss never
    // happened — which is exactly what #802 silently did to it for a while.
    expect(getGpuFaultState()?.deviceLost).toBe(true);

    // The rebuild: a NEW viewport attaches, wiping the LIVE fault state — matching the
    // "SURVIVING" test's premise above.
    await attachViewportDetection();
    expect(getGpuFaultState()).toBeNull();

    // Recovery IN PLACE: a real frame runs again well inside STALL_MS of the loss.
    advanceManual(250);
    vi.advanceTimersByTime(250);
    frameCallback!(250);

    // Keep the loop healthy (one real frame per watchdog tick) out to +20s — a long-lived
    // session with the loss far behind it, matching the brief's repro. Never a stall, so
    // `status` stays `'running'` throughout and `getFrameLoopHealth().gpuFault` (which reads the
    // LATCH only while `stalled`) can't distinguish fixed from broken here — the discriminating
    // read is the LATER stall below.
    for (let i = 0; i < 20; i++) {
      advanceManual(1000);
      vi.advanceTimersByTime(1000);
      frameCallback!(1250 + i * 1000);
    }

    // An UNRELATED stall now: rAF simply stops delivering. No new GPU fault occurs.
    for (let i = 0; i < 3; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    expect(stallTexts().length).toBeGreaterThan(0);
    for (const t of stallTexts()) expect(t).not.toContain('GPU fault:');
    expect(getFrameLoopHealth().gpuFault).toBeUndefined();
  });
});
