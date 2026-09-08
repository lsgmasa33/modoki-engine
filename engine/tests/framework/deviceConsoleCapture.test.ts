/** Unit tests for the device console-capture SEAM (#591; rebuilt on the shared ring in #596/#597
 *  Stage 2) — split out of `bridge.ts` so it can be installed before `App.tsx`'s module graph. See
 *  `engine/app/debug/deviceConsoleCapture.ts` and `deviceConsoleCaptureInstallOrder.test.ts` (the
 *  static-import-order guard).
 *
 *  ⚠️ SINCE STAGE 2 this module no longer patches `console.*` itself — the ONE shared engine ring
 *  (`@modoki/engine/runtime/core/consoleRing`) does, and `consoleRing`/`readConsoleSource` here are
 *  a PROJECTION of it. Every positive-case test below must therefore `installConsoleRing()` first;
 *  a test that skips it is testing a build where the device seam is registered but nothing is
 *  actually wrapping `console.*` — see the "does not patch on its own" test for exactly that case,
 *  asserted deliberately rather than by omission.
 *
 *  ⚠️ SINCE STAGE 3a this module also no longer registers the `window` `error`/`unhandledrejection`
 *  listeners itself — they moved to `./uncaughtCapture.ts` (own unit tests in
 *  `uncaughtCapture.test.ts`), registered from `installConsoleRing.ts`'s gate instead of this
 *  module's narrower one, because `agentBridge.ts` had grown a SECOND, near-identical pair and once
 *  Stage 2 made both feed the one shared ring, every uncaught error produced two entries. The two
 *  positive-case tests below that dispatch a `window` error/rejection now install BOTH this module
 *  (for the `setConsoleSource` projection) AND `installUncaughtCapture()` (for the listener itself)
 *  — exactly the pairing `main.tsx` installs for real, and what proves an entry written by the new
 *  owner is still visible through this module's own projection.
 *
 *  `installed` (this module) and the shared ring's own install flag are both MODULE state, and
 *  vitest does not re-import a module between tests in the same file, so each test that needs a
 *  FRESH install does `vi.resetModules()` + a dynamic `import()` of the shared ring, this module,
 *  and `consoleSource.ts` in the SAME post-reset epoch — importing any of them statically at the top
 *  of this file would silently read a DIFFERENT module instance than the one the others just
 *  published into (the `/@fs` two-instances trap). */

import { describe, it, expect, afterEach, vi } from 'vitest';

const originalConsole = { ...console };

afterEach(() => {
  (Object.keys(originalConsole) as (keyof typeof console)[]).forEach((k) => {
    (console as unknown as Record<string, unknown>)[k] = originalConsole[k];
  });
  vi.resetModules();
});

describe('installDeviceConsoleCapture — positive case (shared ring installed)', () => {
  it('captures a console.info into the ring at level "info", folded to "log" through readConsoleSource', async () => {
    vi.resetModules();
    const { installConsoleRing } = await import('@modoki/engine/runtime/core/consoleRing');
    installConsoleRing();
    const { installDeviceConsoleCapture, consoleRing } = await import('../../app/debug/deviceConsoleCapture');
    const { readConsoleSource } = await import('../../app/debug/consoleSource');
    installDeviceConsoleCapture();

    console.info('hello from boot');

    expect(consoleRing.entries.some((e) => e.level === 'info' && e.args.join(' ').includes('hello from boot'))).toBe(true);
    const viaReader = readConsoleSource();
    expect(viaReader).not.toBeNull();
    expect(viaReader!.some((e) => e.level === 'log' && e.text.includes('hello from boot'))).toBe(true);
  });

  it('unpatchedLog BYPASSES the ring, so the bridge\'s own chatter cannot evict what the ring is for', async () => {
    vi.resetModules();
    const { installConsoleRing } = await import('@modoki/engine/runtime/core/consoleRing');
    installConsoleRing();
    const { installDeviceConsoleCapture, consoleRing, unpatchedLog } = await import('../../app/debug/deviceConsoleCapture');
    installDeviceConsoleCapture();

    const before = consoleRing.entries.length;
    unpatchedLog('[debug-bridge] TAP → chatter');
    const afterChatter = consoleRing.entries.length;

    // The CONTROL, and it is what stops this passing vacuously: a normal console.log MUST still
    // land, so "nothing was added" cannot be satisfied by a ring that records nothing at all.
    console.log('a real app line');
    const afterRealLine = consoleRing.entries.length;

    // Regression pin for the defect #591's own fix introduced, still true post-Stage-2: `bridge.ts`
    // gets a pristine `console.log` via a re-export of the shared ring's OWN `unpatchedLog`, bound
    // at that module's evaluation time — before `installConsoleRing()` can run. Every
    // `device_tap`/`drag`/`pointer`/`press_key`/`type_text` logs one line through it, so ~200 input
    // ops must not be able to evict the boot log the ring exists to preserve.
    expect(afterChatter, 'unpatchedLog must not push into consoleRing').toBe(before);
    expect(afterRealLine, 'console.log must still be captured').toBe(before + 1);
  });

  // ⚠️ The assertion that matters here is the NEGATIVE one, and it is the whole point of the test:
  // an earlier draft implemented `push` as `console[level](...args)` and pinned it with a test that
  // only checked the entry landed in the ring — which is true under BOTH implementations, so it
  // proved nothing and would have defended the bug. `globalErrors.ts:490` wraps `console.error` and
  // reports to Crashlytics; its dedup (`:385-389`) only recognises a call whose sole argument is an
  // `Error` OBJECT, so a synthetic STRING slips past it and files a SECOND issue for an uncaught
  // error already reported — the measured "two issues per fault" regression at
  // `globalErrors.ts:366-377`. Spying on `console.warn` BEFORE the ring wraps it means the spy sees
  // any forwarded call, so "spy not called" distinguishes the two implementations.
  it('consoleRing.push() records DIRECTLY, never via console[level] — no second Crashlytics report', async () => {
    vi.resetModules();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { installConsoleRing } = await import('@modoki/engine/runtime/core/consoleRing');
    installConsoleRing();
    const { installDeviceConsoleCapture, consoleRing } = await import('../../app/debug/deviceConsoleCapture');
    installDeviceConsoleCapture();

    const before = consoleRing.entries.length;
    consoleRing.push('warn', ['synthetic line']);

    const added = consoleRing.entries.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ level: 'warn', args: ['synthetic line'] });
    // The distinguishing observation: nothing was forwarded to the underlying console.warn.
    expect(warnSpy).not.toHaveBeenCalled();
    // ...and the control: a REAL console.warn still forwards, so the spy is wired up correctly and
    // "not called" above means the path was bypassed, not that the spy was inert.
    console.warn('a real call');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('captures an uncaught window error with the [console-capture] marker (installUncaughtCapture is the listener, this module is the reader)', async () => {
    vi.resetModules();
    const { installConsoleRing } = await import('@modoki/engine/runtime/core/consoleRing');
    installConsoleRing();
    const { installDeviceConsoleCapture, consoleRing, CONSOLE_CAPTURE_MARKER } = await import('../../app/debug/deviceConsoleCapture');
    const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
    // Both, exactly as `main.tsx` installs them for real: `installDeviceConsoleCapture()` no longer
    // registers the listener itself (#596/#597 Stage 3a) — `installUncaughtCapture()` does.
    installDeviceConsoleCapture();
    installUncaughtCapture();

    const before = consoleRing.entries.length;
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));

    const added = consoleRing.entries.slice(before);
    expect(added.some((e) =>
      e.level === 'error'
      && e.args.join(' ').includes(CONSOLE_CAPTURE_MARKER)
      && e.args.join(' ').includes('[uncaught]'),
    )).toBe(true);
  });

  it('captures an unhandledrejection with the [console-capture] marker (installUncaughtCapture is the listener, this module is the reader)', async () => {
    vi.resetModules();
    const { installConsoleRing } = await import('@modoki/engine/runtime/core/consoleRing');
    installConsoleRing();
    const { installDeviceConsoleCapture, consoleRing, CONSOLE_CAPTURE_MARKER } = await import('../../app/debug/deviceConsoleCapture');
    const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
    installDeviceConsoleCapture();
    installUncaughtCapture();

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

describe('installDeviceConsoleCapture — does not patch on its own (#596/#597 Stage 2)', () => {
  it('without the shared ring installed, console still works but nothing is captured', async () => {
    vi.resetModules();
    const { installDeviceConsoleCapture, consoleRing } = await import('../../app/debug/deviceConsoleCapture');
    installDeviceConsoleCapture(); // deliberately WITHOUT installing the shared ring first

    const spy = vi.spyOn(console, 'log');
    console.log('never captured');

    // console.log itself is untouched by this module now — the shared ring owns that patch, and it
    // was never installed here.
    expect(spy).toHaveBeenCalledWith('never captured');
    expect(consoleRing.entries.some((e) => e.args.includes('never captured'))).toBe(false);
  });
});

/** THE REGRESSION GUARD FOR TASK A OF #596/#597 STAGE 3a.
 *
 *  BEFORE this stage, `deviceConsoleCapture.ts` and `agentBridge.ts` EACH registered their own
 *  `window` 'error'/'unhandledrejection' listener — invisible duplication while each fed a separate
 *  private buffer, but once Stage 2 made both feed the ONE shared ring, every uncaught error in the
 *  editor produced TWO ring entries. This installs every former call site — exactly what `main.tsx`
 *  boots for real (`installConsoleRing.ts`'s eager import, `installDeviceConsoleCapture.ts`'s eager
 *  import, and `agentBridge.ts`'s `initAgentBridge()` calling its own `installConsoleCapture()`) —
 *  and dispatches ONE uncaught error. Before the fix this produced 2 matching entries (one from
 *  `deviceConsoleCapture.ts`'s own listener, one from `agentBridge.ts`'s); now `installUncaughtCapture()`
 *  is the only registration anywhere, so it produces exactly 1. */
describe('dedup: an uncaught error is captured ONCE, not twice (#596/#597 Stage 3a)', () => {
  it('installing every former call site together still yields exactly ONE ring entry per uncaught error', async () => {
    vi.resetModules();
    const { installConsoleRing, getConsoleRingEntries } = await import('@modoki/engine/runtime/core/consoleRing');
    installConsoleRing();
    const { installDeviceConsoleCapture, CONSOLE_CAPTURE_MARKER } = await import('../../app/debug/deviceConsoleCapture');
    const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
    const agentBridge = await import('../../app/debug/agentBridge');
    installDeviceConsoleCapture();
    installUncaughtCapture();
    agentBridge.installConsoleCapture();

    const before = getConsoleRingEntries().length;
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));

    const matching = getConsoleRingEntries().slice(before).filter((e) =>
      e.level === 'error'
      && e.args.join(' ').includes(CONSOLE_CAPTURE_MARKER)
      && e.args.join(' ').includes('[uncaught]'));
    expect(matching).toHaveLength(1);
  });

  it('…and the same for an unhandledrejection', async () => {
    vi.resetModules();
    const { installConsoleRing, getConsoleRingEntries } = await import('@modoki/engine/runtime/core/consoleRing');
    installConsoleRing();
    const { installDeviceConsoleCapture, CONSOLE_CAPTURE_MARKER } = await import('../../app/debug/deviceConsoleCapture');
    const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
    const agentBridge = await import('../../app/debug/agentBridge');
    installDeviceConsoleCapture();
    installUncaughtCapture();
    agentBridge.installConsoleCapture();

    const before = getConsoleRingEntries().length;
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.reject().catch(() => {}),
      reason: new Error('rejected boom'),
    }));

    const matching = getConsoleRingEntries().slice(before).filter((e) =>
      e.level === 'error'
      && e.args.join(' ').includes(CONSOLE_CAPTURE_MARKER)
      && e.args.join(' ').includes('[unhandledrejection]'));
    expect(matching).toHaveLength(1);
  });
});
