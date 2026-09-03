/** Unit tests for the ONE uncaught-error/unhandledrejection capture (#596/#597 Stage 3a) — split
 *  out of `deviceConsoleCapture.ts` (which had its own copy) and `agentBridge.ts` (which had a
 *  SECOND, near-identical copy) so there is exactly one registration, riding
 *  `installConsoleRing.ts`'s superset gate. See `engine/app/debug/uncaughtCapture.ts` and
 *  `deviceConsoleCaptureInstallOrder.test.ts` (the static-import-order guard for the gate itself).
 *
 *  Every positive-case test below must `installConsoleRing()` first — `recordConsoleRingEntry`
 *  writes into the shared ring regardless, but a test wants a FRESH, empty ring to assert against.
 *  `installed` (this module) and the shared ring's own install flag are both MODULE state, and
 *  vitest does not re-import a module between tests in the same file, so each test that needs a
 *  fresh install does `vi.resetModules()` + a dynamic `import()` of both modules in the SAME
 *  post-reset epoch — importing either statically at the top of this file would silently read a
 *  DIFFERENT module instance than the one just reset (the `/@fs` two-instances trap). */

import { describe, it, expect, afterEach, vi } from 'vitest';

// ⚠️ Snapshot the REAL console methods once, at file load — before any test's `installConsoleRing()`
// has wrapped anything. `vi.resetModules()` alone (the only cleanup this file had) resets the MODULE
// REGISTRY so the next `await import(...)` gets a fresh `consoleRing` instance, but it does NOT undo
// that fresh instance's own `installConsoleRing()` call, which wraps the ACTUAL GLOBAL `console.*`
// methods — themselves already the PREVIOUS test's wrapper, since nothing restored them. Left alone,
// every test in this file nests one more nested wrapper onto `console.*` than the last (contained by
// per-file isolation today, so nothing here failed on it, but it's fragile — a future test that
// counts calls into a spied `console.error` would see the whole nested chain, not one layer).
// Mirrors `deviceConsoleCapture.test.ts`'s sibling `afterEach` — same defect, same fix.
const originalConsole = { ...console };

afterEach(() => {
  // `vi.restoreAllMocks()` FIRST — it restores each spy to whatever `console[method]` it captured
  // AT SPY-CREATION TIME, which could itself be a nested wrapper from an earlier test. The direct
  // assignment below is the authoritative one and must run LAST, so it always wins.
  vi.restoreAllMocks();
  (Object.keys(originalConsole) as (keyof typeof console)[]).forEach((k) => {
    (console as unknown as Record<string, unknown>)[k] = originalConsole[k];
  });
  vi.resetModules();
});

describe('installUncaughtCapture', () => {
  it('is idempotent: a second install does not double-register the window listeners', async () => {
    vi.resetModules();
    const { installConsoleRing } = await import('@modoki/engine/runtime/core/consoleRing');
    installConsoleRing();
    const addSpy = vi.spyOn(window, 'addEventListener');
    const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
    installUncaughtCapture();
    installUncaughtCapture(); // second call must be a no-op — no double-registered listener

    const errorRegistrations = addSpy.mock.calls.filter(([type]) => type === 'error').length;
    const rejectionRegistrations = addSpy.mock.calls.filter(([type]) => type === 'unhandledrejection').length;
    expect(errorRegistrations).toBe(1);
    expect(rejectionRegistrations).toBe(1);
    addSpy.mockRestore();
  });

  it('captures an uncaught window error into the shared ring with the [console-capture] marker', async () => {
    vi.resetModules();
    const { installConsoleRing, getConsoleRingEntries } = await import('@modoki/engine/runtime/core/consoleRing');
    installConsoleRing();
    const { installUncaughtCapture, CONSOLE_CAPTURE_MARKER } = await import('../../app/debug/uncaughtCapture');
    installUncaughtCapture();

    const before = getConsoleRingEntries().length;
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));

    const added = getConsoleRingEntries().slice(before);
    expect(added.some((e) =>
      e.level === 'error'
      && e.args.join(' ').includes(CONSOLE_CAPTURE_MARKER)
      && e.args.join(' ').includes('[uncaught]')
      && e.args.join(' ').includes('boom'),
    )).toBe(true);
  });

  it('captures an unhandledrejection into the shared ring with the [console-capture] marker', async () => {
    vi.resetModules();
    const { installConsoleRing, getConsoleRingEntries } = await import('@modoki/engine/runtime/core/consoleRing');
    installConsoleRing();
    const { installUncaughtCapture, CONSOLE_CAPTURE_MARKER } = await import('../../app/debug/uncaughtCapture');
    installUncaughtCapture();

    const before = getConsoleRingEntries().length;
    // jsdom's PromiseRejectionEvent constructor needs a real promise + reason.
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.reject().catch(() => {}),
      reason: new Error('rejected boom'),
    }));

    const added = getConsoleRingEntries().slice(before);
    expect(added.some((e) =>
      e.level === 'error'
      && e.args.join(' ').includes(CONSOLE_CAPTURE_MARKER)
      && e.args.join(' ').includes('[unhandledrejection]')
      && e.args.join(' ').includes('rejected boom'),
    )).toBe(true);
  });

  // ⚠️ The assertion that matters here is the NEGATIVE one — see `recordConsoleRingEntry`'s own doc
  // comment and `deviceConsoleCapture.test.ts`'s sibling test for the full incident: an earlier
  // implementation that routed a synthetic uncaught-error line back through `console.error` would
  // still land the entry in the ring (so a test that only checks that would pass under BOTH
  // implementations) while ALSO handing it to `globalErrors.ts`'s Crashlytics wrapper, filing a
  // second issue for an already-reported fault. Spying on `console.error` BEFORE dispatching means
  // the spy sees any forwarded call — "not called" is the distinguishing observation.
  it('records DIRECTLY into the ring, never via console.error — no second Crashlytics report', async () => {
    vi.resetModules();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { installConsoleRing } = await import('@modoki/engine/runtime/core/consoleRing');
    installConsoleRing();
    const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
    installUncaughtCapture();

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
