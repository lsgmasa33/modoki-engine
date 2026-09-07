/** `installUnrecoverableFrameLoopAlert` unit tests (modoki package) — Phase 2 of
 *  docs/ios-gpu-memory.md. Drives a real outage through `frameDriver`'s own
 *  watchdog (never-delivering rAF + the manual clock, same machinery `frameDriver.test.ts`'s
 *  "stall watchdog escalation" describe block uses) rather than inventing a fake trigger, so
 *  these tests exercise the actual `onFrameLoopUnrecoverable` wiring end to end. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const COPY = { title: 'Graphics Error', message: 'Please restart.', buttonTitle: 'OK' };

/** Run `n` watchdog ticks (1s each) on both the manual clock and vitest's fake timers — the
 *  exact cadence `frameDriver.test.ts` uses to walk the watchdog through its checks. 13 ticks
 *  carries a never-delivering chain past `UNRECOVERABLE_AFTER_ATTEMPTS` (4) * `STALL_MS` (3000). */
async function tick(advanceManual: (ms: number) => void, n: number) {
  for (let i = 0; i < n; i++) {
    advanceManual(1000);
    vi.advanceTimersByTime(1000);
  }
}

/** Fresh module graph (frameDriver + appServices + the module under test), a never-delivering
 *  rAF, and the manual clock reset to 0 — mirrors `frameDriver.test.ts`'s per-test setup. */
async function freshDriver() {
  vi.resetModules();
  // Ensure rAF/cAF exist (jsdom may not provide them) — matches frameDriver.test.ts's own guard.
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
  if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
  const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
  setManualNow(0);
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1); // never delivers
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

  const frameDriver = await import('../../src/runtime/rendering/frameDriver');
  const appServices = await import('../../src/runtime/core/appServices');
  const alertModule = await import('../../src/runtime/rendering/unrecoverableFrameLoopAlert');
  frameDriver.setTargetFPS(0);
  return { ...frameDriver, ...appServices, ...alertModule, advanceManual };
}

describe('installUnrecoverableFrameLoopAlert (#590 Phase 2)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
    const { restoreRealClock } = await import('../../src/runtime/core/clock');
    restoreRealClock();
  });

  it('fires the dialog once, with the exact copy passed, when the loop goes unrecoverable', async () => {
    const { registerAppServices, installUnrecoverableFrameLoopAlert, startFrameDriver,
      getFrameLoopHealth, advanceManual } = await freshDriver();
    const alert = vi.fn().mockResolvedValue(undefined);
    registerAppServices({ dialog: { alert } });
    installUnrecoverableFrameLoopAlert(COPY);
    startFrameDriver();

    await tick(advanceManual, 13);

    expect(getFrameLoopHealth().unrecoverable).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(COPY);
  });

  it('does not throw and does not call anything when no dialog service is registered', async () => {
    const { installUnrecoverableFrameLoopAlert, startFrameDriver, getFrameLoopHealth,
      advanceManual } = await freshDriver();
    installUnrecoverableFrameLoopAlert(COPY);
    startFrameDriver();

    // If this module threw or produced an unhandled rejection when no `dialog` is registered,
    // this `await` (or the test's own unhandled-rejection detection) would fail the test.
    await tick(advanceManual, 13);

    expect(getFrameLoopHealth().unrecoverable).toBe(true); // the outage itself is real
    // No dialog was ever registered, so there is nothing to assert a call happened ON —
    // the point is only that nothing in this module throws or logs an unhandled rejection.
  });

  it('fires (once) when a dialog service registers LATE, after the outage already fired', async () => {
    const { registerAppServices, installUnrecoverableFrameLoopAlert, startFrameDriver,
      getFrameLoopHealth, advanceManual } = await freshDriver();
    installUnrecoverableFrameLoopAlert(COPY);
    startFrameDriver();

    await tick(advanceManual, 13);
    expect(getFrameLoopHealth().unrecoverable).toBe(true);

    const alert = vi.fn().mockResolvedValue(undefined);
    registerAppServices({ dialog: { alert } }); // arrives well after boot, same as a real game

    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(COPY);

    // A SECOND registration must not re-fire — the module's own dedupe is independent of
    // `onFrameLoopUnrecoverable`'s "at most once" contract.
    const alert2 = vi.fn().mockResolvedValue(undefined);
    registerAppServices({ dialog: { alert: alert2 } });
    expect(alert2).not.toHaveBeenCalled();
  });

  it('a rejecting alert() is swallowed — no throw, no unhandled rejection, a warning is logged', async () => {
    const { registerAppServices, installUnrecoverableFrameLoopAlert, startFrameDriver,
      advanceManual } = await freshDriver();
    const alert = vi.fn().mockRejectedValue(new Error('native bridge unavailable'));
    registerAppServices({ dialog: { alert } });
    installUnrecoverableFrameLoopAlert(COPY);
    startFrameDriver();

    await tick(advanceManual, 13);
    // Let the rejected promise's `.catch` handler run.
    await Promise.resolve();
    await Promise.resolve();

    expect(alert).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('uninstall stops further alerts — the listener is removed before the outage escalates', async () => {
    const { registerAppServices, installUnrecoverableFrameLoopAlert, startFrameDriver,
      getFrameLoopHealth, advanceManual } = await freshDriver();
    const alert = vi.fn().mockResolvedValue(undefined);
    registerAppServices({ dialog: { alert } });
    const uninstall = installUnrecoverableFrameLoopAlert(COPY);
    startFrameDriver();

    await tick(advanceManual, 6); // short of the ~13-tick threshold
    uninstall();
    await tick(advanceManual, 10); // now well past it

    expect(getFrameLoopHealth().unrecoverable, 'frameDriver itself still escalates').toBe(true);
    expect(alert, 'but nothing is subscribed to hear it anymore').not.toHaveBeenCalled();
  });

  it('installing twice without uninstalling REPLACES the first install with the new copy', async () => {
    // Both real call sites (games/wordweave, games/court) discard the returned uninstaller, so a
    // game swap that reinstalls has nowhere to call the old one from — replace-on-reinstall is
    // what makes that safe. See the function's own doc comment.
    const { registerAppServices, installUnrecoverableFrameLoopAlert, startFrameDriver,
      advanceManual } = await freshDriver();
    const alert = vi.fn().mockResolvedValue(undefined);
    registerAppServices({ dialog: { alert } });

    const OTHER_COPY = { title: 'other', message: 'other' };
    const first = installUnrecoverableFrameLoopAlert(COPY);
    const second = installUnrecoverableFrameLoopAlert(OTHER_COPY);
    expect(second).not.toBe(first); // a fresh subscription, not the old one handed back
    expect(warnSpy).toHaveBeenCalled(); // still worth flagging — usually means a caller forgot

    startFrameDriver();
    await tick(advanceManual, 13);

    // The SECOND install's copy fires — the first was torn down, not left running alongside it.
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(OTHER_COPY);
  });
});
