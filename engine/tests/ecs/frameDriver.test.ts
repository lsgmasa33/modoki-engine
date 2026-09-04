/** FrameDriver unit tests — priority ordering, FPS capping, ref-counted start/stop, stepOneFrame. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function getFrameDriver() {
  return import('@modoki/engine/runtime');
}

function setupRAFMock() {
  const rafCallbacks: ((t: number) => void)[] = [];
  let rafIdCounter = 0;

  // Ensure rAF/cAF exist on globalThis (jsdom 26 doesn't provide them)
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
  if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;

  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    const id = ++rafIdCounter;
    rafCallbacks.push((t: number) => cb(t));
    return id;
  });
  const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

  return { rafCallbacks, cancelSpy };
}

describe('frameDriver', () => {
  describe('registerFrameCallback / unregisterFrameCallback', () => {
    it('registers and executes callbacks in priority order', async () => {
      const { registerFrameCallback, stepOneFrame } = await getFrameDriver();

      const order: string[] = [];
      registerFrameCallback('low', () => order.push('low'), 20);
      registerFrameCallback('high', () => order.push('high'), 0);
      registerFrameCallback('mid', () => order.push('mid'), 10);

      stepOneFrame();

      expect(order).toEqual(['high', 'mid', 'low']);
    });

    it('replaces existing callback with same key', async () => {
      const { registerFrameCallback, stepOneFrame } = await getFrameDriver();

      const order: string[] = [];
      registerFrameCallback('a', () => order.push('old'), 0);
      registerFrameCallback('a', () => order.push('new'), 0);

      stepOneFrame();

      expect(order).toEqual(['new']);
    });

    it('unregisterFrameCallback removes the callback', async () => {
      const { registerFrameCallback, unregisterFrameCallback, stepOneFrame } = await getFrameDriver();

      let called = false;
      registerFrameCallback('test', () => { called = true; }, 0);
      unregisterFrameCallback('test');

      stepOneFrame();

      expect(called).toBe(false);
    });
  });

  describe('startFrameDriver / stopFrameDriver', () => {
    it('starts rAF loop on first start', async () => {
      setupRAFMock();
      const { startFrameDriver } = await getFrameDriver();

      startFrameDriver();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('does not start multiple rAF loops', async () => {
      setupRAFMock();
      const { startFrameDriver } = await getFrameDriver();

      startFrameDriver();
      startFrameDriver();
      startFrameDriver();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('does not stop until all callers have stopped', async () => {
      setupRAFMock();
      const { startFrameDriver, stopFrameDriver } = await getFrameDriver();

      startFrameDriver();
      startFrameDriver();
      stopFrameDriver();

      expect(cancelAnimationFrame).not.toHaveBeenCalled();
    });

    it('stops rAF when ref count reaches zero', async () => {
      setupRAFMock();
      const { startFrameDriver, stopFrameDriver } = await getFrameDriver();

      startFrameDriver();
      startFrameDriver();
      stopFrameDriver();
      stopFrameDriver();

      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('ignores extra stops instead of cancelling a chain it does not own', async () => {
      setupRAFMock();
      const { startFrameDriver, stopFrameDriver, getFrameLoopHealth } = await getFrameDriver();

      startFrameDriver();
      stopFrameDriver();
      stopFrameDriver();
      stopFrameDriver();

      // Only the BALANCED stop may cancel. The old code decremented past zero and called
      // cancelAnimationFrame on every extra stop; combined with a later start that took the
      // "already running" branch, that is how the loop could end up dead while callers still
      // believed it was pumping — the silent frozen-editor wedge.
      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
      expect(getFrameLoopHealth().refCount).toBe(0);
    });

    it('an unbalanced stop cannot kill a chain another caller still holds', async () => {
      setupRAFMock();
      const { startFrameDriver, stopFrameDriver, getFrameLoopHealth } = await getFrameDriver();

      startFrameDriver();      // caller A
      startFrameDriver();      // caller B
      stopFrameDriver();       // A releases → B still holds one ref
      stopFrameDriver();       // B releases → chain legitimately cancelled
      stopFrameDriver();       // stray cleanup with no matching start — must be inert

      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
      expect(getFrameLoopHealth().refCount).toBe(0);
    });

    it('re-arms a dead chain on start even when refCount is still positive', async () => {
      setupRAFMock();
      const { startFrameDriver, getFrameLoopHealth } = await getFrameDriver();

      startFrameDriver();                       // refCount 1, chain armed
      expect(getFrameLoopHealth().armed).toBe(true);
      const armsAfterFirst = (requestAnimationFrame as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

      // A second start while already running must NOT arm a duplicate chain — the generation
      // guard exists precisely so a repair attempt can never double-step every system.
      startFrameDriver();
      expect((requestAnimationFrame as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
        .toBe(armsAfterFirst);
      expect(getFrameLoopHealth().refCount).toBe(2);
    });

    it('re-starts after full stop', async () => {
      setupRAFMock();
      const { startFrameDriver, stopFrameDriver } = await getFrameDriver();

      startFrameDriver();
      stopFrameDriver();
      expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);

      startFrameDriver();
      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    });
  });

  describe('stepOneFrame', () => {
    it('runs all registered callbacks synchronously', async () => {
      const { registerFrameCallback, stepOneFrame } = await getFrameDriver();

      let result = 0;
      registerFrameCallback('a', () => { result += 1; }, 0);
      registerFrameCallback('b', () => { result += 2; }, 0);

      stepOneFrame();

      expect(result).toBe(3);
    });

    it('can be called multiple times', async () => {
      const { registerFrameCallback, stepOneFrame } = await getFrameDriver();

      let count = 0;
      registerFrameCallback('c', () => { count++; }, 0);

      stepOneFrame();
      stepOneFrame();
      stepOneFrame();

      expect(count).toBe(3);
    });
  });

  describe('FPS capping', () => {
    it('targetFPS can be changed', async () => {
      const { setTargetFPS, targetFPS } = await getFrameDriver();

      // targetFPS starts at 60
      expect(targetFPS).toBe(60);

      setTargetFPS(30);
      const { targetFPS: newFps } = await getFrameDriver();
      expect(newFps).toBe(30);
    });

    it('stepOneFrame bypasses FPS cap', async () => {
      const { registerFrameCallback, stepOneFrame, setTargetFPS } = await getFrameDriver();

      setTargetFPS(1); // 1fps = very slow

      let count = 0;
      registerFrameCallback('test', () => { count++; }, 0);

      // stepOneFrame should run regardless of FPS cap
      stepOneFrame();
      stepOneFrame();
      stepOneFrame();

      expect(count).toBe(3);
    });
  });

  describe('priority constants', () => {
    it('exports expected priority values', async () => {
      const { PRIORITY_ECS, PRIORITY_RENDER_3D, PRIORITY_RENDER_2D } = await getFrameDriver();

      expect(PRIORITY_ECS).toBe(0);
      expect(PRIORITY_RENDER_3D).toBe(10);
      expect(PRIORITY_RENDER_2D).toBe(20);
    });
  });
});

/**
 * Stall-watchdog ESCALATION (#590 Phase 1 — docs/plans/ios-rendering-update-wedge.md), exercised
 * again here through the PUBLIC `@modoki/engine/runtime` barrel (the other required test surface)
 * rather than the package's internal module path. See
 * `engine/packages/modoki/tests/runtime/frameDriver.test.ts` for the fuller suite (including the
 * GPU-fault-correlation case, which needs `setActiveRendererHandle` — not barrel-exported).
 *
 * On iOS, a WebGL context loss makes WKWebView permanently stop delivering
 * `requestAnimationFrame` — JS/timers/the native bridge stay alive, paint just never resumes.
 * Re-arming (the old repair) cannot fix that, and used to retry forever while flooding the crash
 * reporter. These tests drive the watchdog's real `setInterval` via fake timers and the
 * injectable clock (`setManualNow`/`advanceManual`, both barrel-exported) so the 3s/12s
 * thresholds are exercised deterministically, with no real wall-clock involved.
 */
describe('frameDriver — stall watchdog escalation (#590)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    vi.useRealTimers();
    const { restoreRealClock } = await getFrameDriver();
    restoreRealClock();
  });

  function stallTexts(): string[] {
    return errSpy.mock.calls
      .map((args: unknown[]) => args[0])
      .filter((a: unknown): a is string => typeof a === 'string' && a.includes('FRAME LOOP STALLED'));
  }

  it('a sustained slow-but-alive rAF (~4900ms per delivery, well past the 3s stall threshold) ' +
     'RECOVERS and never escalates — the defect-5 regression guard', async () => {
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);

    const DELIVER_MS = 4900;
    let current = 0;
    const state: { pending: ((t: number) => void) | null } = { pending: null };
    let scheduledAt = 0;
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      state.pending = cb as (t: number) => void;
      scheduledAt = current;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getFrameDriver();
    setTargetFPS(0);
    let unrecoverableFired = 0;
    onFrameLoopUnrecoverable(() => { unrecoverableFired++; });

    startFrameDriver();

    let deliveries = 0;
    for (let step = 0; step < 30; step++) {
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

    expect(unrecoverableFired).toBe(0);
    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    // Not just "never declared unrecoverable" — the device must actually keep PAINTING. A
    // supersession-starved chain (defect 5) could otherwise mask as "healthy" without ever
    // delivering a single frame again.
    expect(deliveries).toBeGreaterThanOrEqual(4);
  });

  it('recoveryAttempts no longer resets mid-outage — logging goes quiet past MAX_REPORTED_ATTEMPTS (defect 2)', async () => {
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth } = await getFrameDriver();
    setTargetFPS(0);
    startFrameDriver();

    for (let i = 0; i < 9; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(stallTexts()).toHaveLength(3);
    expect(getFrameLoopHealth().recoveryAttempts).toBe(3);

    for (let i = 0; i < 3; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(stallTexts()).toHaveLength(3); // the 4th crossing is UNRECOVERABLE, a separate message
    expect(getFrameLoopHealth().unrecoverable).toBe(true);
  });

  it('a re-arm\'s grace period does not mask an ONGOING outage (defect 2, precise timing)', async () => {
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { pending = cb as (t: number) => void; return 1; });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth } = await getFrameDriver();
    setTargetFPS(0);
    startFrameDriver();

    advanceManual(10);
    const cb = pending!;
    cb(10); // one real frame, then this chain never fires again

    // t=4000: first detection (attempt 1) — also re-arms (the chain DID run once), refreshing
    // `armedAt`. t=7000: a SECOND STALL_MS has elapsed since the real frame at t=10 —
    // recoveryAttempts must reach 2. Judged on the arm-grace clock instead of the real-frame
    // clock, `since` at t=7000 would read only ~3000ms since the t=4000 re-arm — still attempt 1.
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
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    let rafCalls = 0;
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      pending = cb as (t: number) => void;
      rafCalls++;
      return rafCalls;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getFrameDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    for (let i = 0; i < 2; i++) {
      advanceManual(1000);
      const cb = pending!; pending = null;
      cb(0);
      vi.advanceTimersByTime(1000);
    }
    expect(getFrameLoopHealth().status).toBe('running');

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    for (let i = 0; i < 20; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    advanceManual(1000);
    vi.advanceTimersByTime(1000);

    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(fired).toBe(0);
    expect(getFrameLoopHealth().recovered).toBeGreaterThan(0); // it DID re-arm, not surrender

    const cb = pending!;
    expect(cb).toBeDefined();
    advanceManual(10);
    cb(0);
    vi.advanceTimersByTime(1000);
    const health = getFrameLoopHealth();
    expect(health.status).toBe('running');
    expect(health.recoveryAttempts).toBe(0);
  });

  it('a long main-thread block does not escalate on the first tick (frameSinceArm true)', async () => {
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    let rafCalls = 0;
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      pending = cb as (t: number) => void;
      rafCalls++;
      return rafCalls;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getFrameDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    advanceManual(10);
    const cb = pending!;
    cb(10); // one real frame establishes frameSinceArm=true and a recent lastFrameAt

    // The main thread blocks for 20s in one go — the watchdog's setInterval only fires ONCE
    // catching up (advance fake-timer time by exactly one WATCHDOG_INTERVAL_MS).
    advanceManual(20000);
    vi.advanceTimersByTime(1000);

    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(fired).toBe(0);
    expect(getFrameLoopHealth().recovered).toBeGreaterThan(0);
  });

  it('a chain already dead BEFORE a hidden gap does not skip straight to unrecoverable ' +
     '(isolates outageDetectedAt re-baselining from the frameSinceArm gate)', async () => {
    // `frameSinceArm` is false throughout this scenario (the chain never delivers a single
    // frame), so the `!frameSinceArm` escalation gate does NOT protect it — whatever protection
    // exists here comes from `outageDetectedAt` re-baselining alone.
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getFrameDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    for (let i = 0; i < 4; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); } // attempt 1 by t=3000

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    for (let i = 0; i < 20; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    advanceManual(1000);
    vi.advanceTimersByTime(1000); // first post-hidden tick — `since` is huge in one shot

    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(fired).toBe(0);
  });

  it('a real frame just before a SECOND long block does not skip straight to unrecoverable ' +
     '(isolates the frameSinceArm gate from outageDetectedAt re-baselining)', async () => {
    // Three prior detections (all with `frameSinceArm` false, none re-arming or healthy-resetting)
    // bring `recoveryAttempts` to 3 WITHOUT ever clearing `outageDetectedAt` — still pinned to the
    // very first detection. Then ONE real frame delivers (`frameSinceArm` becomes true), but no
    // watchdog tick observes it before a second long block hits, so `outageDetectedAt` is STILL
    // not reset. The next detection measures from that stale `outageDetectedAt` and jumps
    // `recoveryAttempts` way past `UNRECOVERABLE_AFTER_ATTEMPTS` in one shot — re-baselining alone
    // cannot prevent this, because nothing here ever re-baselined. Only the `!frameSinceArm` gate
    // stops it.
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { pending = cb as (t: number) => void; return 1; });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getFrameDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    for (let i = 0; i < 9; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(getFrameLoopHealth().recoveryAttempts).toBe(3);

    advanceManual(500);
    const cb = pending!;
    cb(9500);
    expect(getFrameLoopHealth().recovered).toBe(0); // a natural delivery, not a re-arm

    advanceManual(20000);
    vi.advanceTimersByTime(1000);

    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(fired).toBe(0);
  });

  it('escalation after a 20s hidden gap takes ~9s from DETECTION, not 4s from resume ' +
     '(regression: the clamp described in review as a no-op)', async () => {
    // Measured on the reviewed build: hidden 8s/20s/60s all declared unrecoverable 4 REAL
    // seconds after resume — a `Math.min(attempt, recoveryAttempts + 1)` "clamp" that always
    // equals `recoveryAttempts + 1` is just `recoveryAttempts++` once per 1000ms watchdog tick
    // once `since` is already several `STALL_MS` units stale. This walks the FULL interval.
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // never delivers again
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getFrameDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    for (let i = 0; i < 20; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    advanceManual(1000);
    vi.advanceTimersByTime(1000);
    expect(getFrameLoopHealth().unrecoverable, 'must not fire on the very first post-gap tick').toBe(false);

    for (let i = 0; i < 4; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(getFrameLoopHealth().unrecoverable, 'still false at 4s past resume').toBe(false);

    for (let i = 0; i < 4; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(getFrameLoopHealth().unrecoverable, 'still false at 8s past resume').toBe(false);
    expect(fired).toBe(0);

    advanceManual(1000);
    vi.advanceTimersByTime(1000);
    expect(getFrameLoopHealth().unrecoverable, '~9s after detection, the outage is genuinely dead').toBe(true);
    expect(fired).toBe(1);
  });

  it('a chain delivering every 4900ms across a hidden-gap resume never escalates at all ' +
     '(defect-5 regression, now exercised across a discontinuity)', async () => {
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    const DELIVER_MS = 4900;
    let current = 0;
    const state: { pending: ((t: number) => void) | null } = { pending: null };
    let scheduledAt = 0;
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      state.pending = cb as (t: number) => void;
      scheduledAt = current;
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth, onFrameLoopUnrecoverable } = await getFrameDriver();
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

    for (let i = 0; i < 10; i++) step();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    for (let i = 0; i < 20; i++) { current += 1000; advanceManual(1000); vi.advanceTimersByTime(1000); }
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    for (let i = 0; i < 20; i++) step();

    expect(unrecoverableFired).toBe(0);
    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(deliveries).toBeGreaterThan(2);
  });

  it('the stall message text is byte-identical across repeated emissions (defect 1)', async () => {
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS } = await getFrameDriver();
    setTargetFPS(0);
    startFrameDriver();

    for (let i = 0; i < 6; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    const texts = stallTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toEqual(texts[1]); // byte-identical — NOT a substring check
    expect(texts[0]).not.toContain('attempt 2');
  });

  it('declareUnrecoverable fires exactly once no matter how long the outage runs', async () => {
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, onFrameLoopUnrecoverable, setTargetFPS, getFrameLoopHealth } = await getFrameDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

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
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { pending = cb as (t: number) => void; return 1; });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, onFrameLoopUnrecoverable, setTargetFPS, getFrameLoopHealth } = await getFrameDriver();
    setTargetFPS(0);
    let fired = 0;
    onFrameLoopUnrecoverable(() => { fired++; });
    startFrameDriver();

    for (let i = 0; i < 13; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(getFrameLoopHealth().unrecoverable).toBe(true);
    expect(fired).toBe(1);

    advanceManual(10);
    const recoveredCb = pending!;
    recoveredCb(0);
    vi.advanceTimersByTime(1000);

    expect(getFrameLoopHealth().unrecoverable, 'a real frame must clear the flag').toBe(false);
    expect(getFrameLoopHealth().status).toBe('running');
    expect(getFrameLoopHealth().recoveryAttempts).toBe(0);

    errSpy.mockClear();

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
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, stopFrameDriver, setTargetFPS, getFrameLoopHealth } = await getFrameDriver();
    setTargetFPS(0);
    startFrameDriver();

    for (let i = 0; i < 13; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }
    expect(getFrameLoopHealth().unrecoverable).toBe(true);

    stopFrameDriver();
    expect(getFrameLoopHealth().unrecoverable, 'a full stop is a clean slate').toBe(false);

    startFrameDriver();
    expect(getFrameLoopHealth().unrecoverable).toBe(false);
    expect(getFrameLoopHealth().recoveryAttempts).toBe(0);
  });

  it('re-arms a chain that ran a frame and then died (does not regress the working recovery path)', async () => {
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    let rafCalls = 0;
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      pending = cb as (t: number) => void;
      rafCalls++;
      return rafCalls;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth } = await getFrameDriver();
    setTargetFPS(0);
    startFrameDriver();
    expect(rafCalls).toBe(1);

    advanceManual(10);
    const cb = pending!;
    cb(10);
    expect(rafCalls).toBe(2);

    for (let i = 0; i < 4; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    expect(getFrameLoopHealth().recovered).toBeGreaterThan(0);
    expect(rafCalls).toBeGreaterThan(2);
  });

  it('no user-visible string (stall/unrecoverable logs, FrameLoopHealth.detail) contains "editor"', async () => {
    const { setManualNow, advanceManual } = await getFrameDriver();
    setManualNow(0);
    if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
    if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // NEVER delivers
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

    const { startFrameDriver, setTargetFPS, getFrameLoopHealth } = await getFrameDriver();
    setTargetFPS(0);
    startFrameDriver();

    const seenDetails: string[] = [];
    for (let i = 0; i < 13; i++) {
      advanceManual(1000);
      vi.advanceTimersByTime(1000);
      // Sample `detail` mid-outage too — "still retrying" (not yet unrecoverable) is a SEPARATE
      // branch of the message from the final "gave up" one, and both must be checked.
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
});
