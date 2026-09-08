/** #682 — `computeDiagnostics()`'s `frameLoop` block (healthy-means-silent, mirroring the editor's
 *  `frameLoopFields()` convention) and the `perf.currentFps` fix for the stale-perf problem:
 *  `perf.frame.fps` is a median over a sample ring that stops filling the moment frames stop, so
 *  it reports the last healthy value FOREVER with nothing saying so. `getCurrentFPS()` self-zeroes
 *  past the stall threshold; this pins that it is actually wired through.
 *
 *  A FRESH dynamic import + `vi.resetModules()` per test (frameDriver.test.ts's own pattern),
 *  because frame-loop status is GLOBAL module state and these tests deliberately arm/stall the
 *  frame driver — sharing one module instance with `diagnose.test.ts`'s other, unrelated describes
 *  would leak that state across files/tests. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

async function loadRuntime() {
  return import('@modoki/engine/runtime');
}
async function loadDiagnose() {
  return import('../../app/debug/diagnose');
}
async function loadRegisterTraits() {
  return import('../../app/ecs/registerTraits');
}

function mockRaf(deliver: ((cb: (t: number) => void) => void) | null) {
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as unknown as typeof requestAnimationFrame;
  if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    if (deliver) deliver(cb as unknown as (t: number) => void);
    return 1;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
}

describe('computeDiagnostics: frameLoop block (#682)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('is PRESENT (idle) when nothing has ever pumped a frame — the default headless state', async () => {
    const { createTestWorld, Transform, Camera, EntityAttributes } = await loadRuntime();
    const { registerAllTraits } = await loadRegisterTraits();
    const { computeDiagnostics } = await loadDiagnose();
    registerAllTraits();
    const game = createTestWorld({});
    game.spawn(Transform({}), Camera({}), EntityAttributes({ name: 'Camera' }));

    const d = computeDiagnostics() as { frameLoop?: { status: string } };
    expect(d.frameLoop?.status).toBe('idle');

    game.dispose();
  });

  it('is OMITTED once the loop is running with nothing recovered — healthy means silent', async () => {
    const { createTestWorld, Transform, Camera, EntityAttributes, startFrameDriver, stopFrameDriver } = await loadRuntime();
    const { registerAllTraits } = await loadRegisterTraits();
    const { computeDiagnostics } = await loadDiagnose();
    registerAllTraits();
    const game = createTestWorld({});
    game.spawn(Transform({}), Camera({}), EntityAttributes({ name: 'Camera' }));

    let pending: ((t: number) => void) | null = null;
    mockRaf((cb) => { pending = cb; });
    startFrameDriver();
    pending!(16); // one real frame -> status 'running'

    const d = computeDiagnostics() as Record<string, unknown>;
    expect(d).not.toHaveProperty('frameLoop');

    stopFrameDriver();
    game.dispose();
  });

  it('is PRESENT (stalled) once the watchdog detects a dead rAF chain, with a specific detail', async () => {
    vi.useFakeTimers();
    const {
      createTestWorld, Transform, Camera, EntityAttributes,
      startFrameDriver, setTargetFPS, setManualNow, advanceManual, stopFrameDriver, restoreRealClock,
    } = await loadRuntime();
    const { registerAllTraits } = await loadRegisterTraits();
    const { computeDiagnostics } = await loadDiagnose();
    registerAllTraits();
    const game = createTestWorld({});
    game.spawn(Transform({}), Camera({}), EntityAttributes({ name: 'Camera' }));

    setManualNow(0);
    mockRaf(null); // never delivers
    setTargetFPS(0);
    startFrameDriver();
    for (let i = 0; i < 3; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    const d = computeDiagnostics() as { frameLoop?: { status: string; detail?: string } };
    expect(d.frameLoop?.status).toBe('stalled');
    expect(d.frameLoop?.detail).toMatch(/not ticked/);

    stopFrameDriver();
    restoreRealClock();
    vi.useRealTimers();
    game.dispose();
  });

  // #682 close-out (LOW 6): `ok` used to be computed with no reference to `frameLoop` at all, so a
  // dead rAF chain reported `ok:true, summary:'No issues detected.'` directly above a
  // `frameLoop.status:'stalled'` block — every OTHER field in the same report (perf, refs,
  // transforms, offScreen) is frame-fed and therefore just as unreliable, and nothing said so.
  it('a STALLED loop fails `ok` and names itself first in the summary', async () => {
    vi.useFakeTimers();
    const {
      createTestWorld, Transform, Camera, EntityAttributes,
      startFrameDriver, setTargetFPS, setManualNow, advanceManual, stopFrameDriver, restoreRealClock,
    } = await loadRuntime();
    const { registerAllTraits } = await loadRegisterTraits();
    const { computeDiagnostics } = await loadDiagnose();
    registerAllTraits();
    const game = createTestWorld({});
    game.spawn(Transform({}), Camera({}), EntityAttributes({ name: 'Camera' }));

    setManualNow(0);
    mockRaf(null); // never delivers
    setTargetFPS(0);
    startFrameDriver();
    for (let i = 0; i < 3; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    const d = computeDiagnostics() as { ok: boolean; summary: string; frameLoop?: { status: string } };
    expect(d.frameLoop?.status).toBe('stalled');
    expect(d.ok, 'ok:true directly above frameLoop.status:"stalled" is the contradiction this closes').toBe(false);
    expect(d.summary).toContain('frame loop stalled');

    stopFrameDriver();
    restoreRealClock();
    vi.useRealTimers();
    game.dispose();
  });

  it('an UNRECOVERABLE loop fails `ok` too, and the summary says so', async () => {
    vi.useFakeTimers();
    const {
      createTestWorld, Transform, Camera, EntityAttributes,
      startFrameDriver, setTargetFPS, setManualNow, advanceManual, stopFrameDriver, restoreRealClock,
    } = await loadRuntime();
    const { registerAllTraits } = await loadRegisterTraits();
    const { computeDiagnostics } = await loadDiagnose();
    registerAllTraits();
    const game = createTestWorld({});
    game.spawn(Transform({}), Camera({}), EntityAttributes({ name: 'Camera' }));

    setManualNow(0);
    mockRaf(null); // never delivers
    setTargetFPS(0);
    startFrameDriver();
    // Past UNRECOVERABLE_AFTER_ATTEMPTS (~12s post-detection) — matches the other #682 test
    // files' timeline for a declared-dead chain, not merely a transient stall.
    for (let i = 0; i < 12; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    const d = computeDiagnostics() as { ok: boolean; summary: string; frameLoop?: { status: string; unrecoverable: boolean } };
    expect(d.frameLoop?.unrecoverable).toBe(true);
    expect(d.ok).toBe(false);
    expect(d.summary).toContain('unrecoverable');

    stopFrameDriver();
    restoreRealClock();
    vi.useRealTimers();
    game.dispose();
  });

  it('accept side: a HEALTHY loop does not fail `ok` on its own account', async () => {
    const { createTestWorld, Transform, Camera, EntityAttributes, startFrameDriver, stopFrameDriver } = await loadRuntime();
    const { registerAllTraits } = await loadRegisterTraits();
    const { computeDiagnostics } = await loadDiagnose();
    registerAllTraits();
    const game = createTestWorld({});
    game.spawn(Transform({}), Camera({}), EntityAttributes({ name: 'Camera' }));

    let pending: ((t: number) => void) | null = null;
    mockRaf((cb) => { pending = cb; });
    startFrameDriver();
    pending!(16); // one real frame -> status 'running'

    const d = computeDiagnostics() as { ok: boolean; summary: string };
    expect(d.ok).toBe(true);
    expect(d.summary).toBe('No issues detected.');

    stopFrameDriver();
    game.dispose();
  });
});

describe('computeDiagnostics: perf.currentFps self-zeroes on a stall, unlike perf.frame.fps (#682)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('currentFps reads 0 once stalled while frame.fps still reports the last real measurement', async () => {
    vi.useFakeTimers();
    const {
      createTestWorld, Transform, Camera, EntityAttributes,
      startFrameDriver, setTargetFPS, setManualNow, advanceManual, stopFrameDriver, restoreRealClock,
    } = await loadRuntime();
    const { registerAllTraits } = await loadRegisterTraits();
    const { computeDiagnostics } = await loadDiagnose();
    registerAllTraits();
    const game = createTestWorld({});
    game.spawn(Transform({}), Camera({}), EntityAttributes({ name: 'Camera' }));

    setManualNow(0);
    let pending: ((t: number) => void) | null = null;
    mockRaf((cb) => { pending = cb; });
    setTargetFPS(0);
    startFrameDriver();

    // Two real, ~16ms-apart frames so `getFrameProfile().fps` has a genuine non-zero median before
    // the chain dies (a single frame's `frameMs` is 0 — "no previous" — and tells us nothing).
    // `pending` is re-armed (reassigned) synchronously INSIDE each invocation (`runFrame`'s own
    // `requestAnimationFrame(self)` re-arm) — never null it out by hand between calls.
    advanceManual(16);
    pending!(16);
    advanceManual(16);
    pending!(32);

    const before = computeDiagnostics() as { perf: { frame: { fps: number }; currentFps: number } };
    expect(before.perf.frame.fps).toBeGreaterThan(0);

    // Now let the chain die — no further delivery, past STALL_MS (3000ms).
    for (let i = 0; i < 3; i++) { advanceManual(1000); vi.advanceTimersByTime(1000); }

    const after = computeDiagnostics() as { perf: { frame: { fps: number }; currentFps: number } };
    expect(after.perf.currentFps).toBe(0);
    // The bug: the median ring never learns the loop died, so it keeps the SAME pre-stall value.
    expect(after.perf.frame.fps).toBe(before.perf.frame.fps);
    expect(after.perf.frame.fps).toBeGreaterThan(0);

    stopFrameDriver();
    restoreRealClock();
    vi.useRealTimers();
    game.dispose();
  });
});
