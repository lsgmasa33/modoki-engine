/** Unit tests for the eager device console capture (#591) — split out of `bridge.ts` so it can be
 *  installed before `App.tsx`'s module graph. See `engine/app/debug/deviceConsoleCapture.ts` and
 *  `deviceConsoleCaptureInstallOrder.test.ts` (the static-import-order guard).
 *
 *  `installed` is MODULE state, and vitest does not re-import a module between tests in the same
 *  file, so each test that needs a FRESH install does `vi.resetModules()` + a dynamic `import()`.
 *  That reset also mints a fresh `consoleSource.ts` instance (it's in the same dependency graph),
 *  so `consoleSource`'s own exports are dynamically re-imported alongside `deviceConsoleCapture`'s in
 *  the SAME post-reset epoch — importing it statically at the top of this file would silently read a
 *  DIFFERENT module instance than the one `installDeviceConsoleCapture()` just published into (the
 *  `/@fs` two-instances trap). */

import { describe, it, expect, afterEach, vi } from 'vitest';

const originalConsole = { ...console };

afterEach(() => {
  (Object.keys(originalConsole) as (keyof typeof console)[]).forEach((k) => {
    (console as unknown as Record<string, unknown>)[k] = originalConsole[k];
  });
  vi.resetModules();
});

describe('installDeviceConsoleCapture — positive case (#591)', () => {
  it('captures a console.info into the ring at level "info", folded to "log" through readConsoleSource', async () => {
    vi.resetModules();
    const { installDeviceConsoleCapture, consoleRing } = await import('../../app/debug/deviceConsoleCapture');
    const { readConsoleSource } = await import('../../app/debug/consoleSource');
    installDeviceConsoleCapture();

    console.info('hello from boot');

    expect(consoleRing.entries.some((e) => e.level === 'info' && e.args.join(' ').includes('hello from boot'))).toBe(true);
    const viaReader = readConsoleSource();
    expect(viaReader).not.toBeNull();
    expect(viaReader!.some((e) => e.level === 'log' && e.text.includes('hello from boot'))).toBe(true);
  });

  it('does not swallow output — the original console function still runs', async () => {
    vi.resetModules();
    const spy = vi.spyOn(console, 'log');
    const { installDeviceConsoleCapture } = await import('../../app/debug/deviceConsoleCapture');
    installDeviceConsoleCapture();

    console.log('still visible');

    // installDeviceConsoleCapture wraps console.log AFTER the spy is installed, so the spy's own
    // implementation (the real console.log) is what the wrapper calls — this asserts the call
    // reached it at all, i.e. capture did not replace it with something that drops the call.
    expect(spy).toHaveBeenCalledWith('still visible');
  });

  it('is idempotent: calling it twice records each subsequent line ONCE', async () => {
    vi.resetModules();
    const { installDeviceConsoleCapture, consoleRing } = await import('../../app/debug/deviceConsoleCapture');
    installDeviceConsoleCapture();
    installDeviceConsoleCapture(); // second call must be a no-op — no double-wrap

    const before = consoleRing.entries.length;
    console.warn('single line');
    const added = consoleRing.entries.length - before;

    // Mutate-check performed by hand while implementing #591: with the `installed` early-return
    // removed, the second `installDeviceConsoleCapture()` call wraps `console.warn` a second time, so
    // one call chains through both wrappers and pushes TWO entries — this assertion is what turns
    // red in that case.
    expect(added).toBe(1);
  });

  it('unpatchedLog BYPASSES the ring, so the bridge\'s own chatter cannot evict what the ring is for', async () => {
    vi.resetModules();
    const { installDeviceConsoleCapture, consoleRing, unpatchedLog } = await import('../../app/debug/deviceConsoleCapture');
    installDeviceConsoleCapture();

    const before = consoleRing.entries.length;
    unpatchedLog('[debug-bridge] TAP → chatter');
    const afterChatter = consoleRing.entries.length;

    // The CONTROL, and it is what stops this passing vacuously: a normal console.log MUST still
    // land, so "nothing was added" cannot be satisfied by a ring that records nothing at all.
    console.log('a real app line');
    const afterRealLine = consoleRing.entries.length;

    // Regression pin for the defect #591's own fix introduced: `bridge.ts` used to get a pristine
    // `console.log` for free from a module-scope `.bind()`, because the capture was installed later.
    // Installing eagerly inverted that, so its ~25 chatter call sites started filling the 200-entry
    // ring — one line per device_tap/drag/pointer/press_key/type_text, i.e. ~200 input ops evict the
    // boot log the ring exists to preserve.
    expect(afterChatter, 'unpatchedLog must not push into consoleRing').toBe(before);
    expect(afterRealLine, 'console.log must still be captured').toBe(before + 1);
  });

  it('captures an uncaught window error with the [console-capture] marker', async () => {
    vi.resetModules();
    const { installDeviceConsoleCapture, consoleRing, CONSOLE_CAPTURE_MARKER } = await import('../../app/debug/deviceConsoleCapture');
    installDeviceConsoleCapture();

    const before = consoleRing.entries.length;
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));

    const added = consoleRing.entries.slice(before);
    expect(added.some((e) =>
      e.level === 'error'
      && e.args.join(' ').includes(CONSOLE_CAPTURE_MARKER)
      && e.args.join(' ').includes('[uncaught]'),
    )).toBe(true);
  });

  it('captures an unhandledrejection with the [console-capture] marker', async () => {
    vi.resetModules();
    const { installDeviceConsoleCapture, consoleRing, CONSOLE_CAPTURE_MARKER } = await import('../../app/debug/deviceConsoleCapture');
    installDeviceConsoleCapture();

    const before = consoleRing.entries.length;
    // jsdom's PromiseRejectionEvent constructor needs a real promise + reason.
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.reject().catch(() => {}),
      reason: new Error('rejected boom'),
    }));

    const added = consoleRing.entries.slice(before);
    expect(added.some((e) =>
      e.level === 'error'
      && e.args.join(' ').includes(CONSOLE_CAPTURE_MARKER)
      && e.args.join(' ').includes('[unhandledrejection]'),
    )).toBe(true);
  });
});
