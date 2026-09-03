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

// F4 (#626/#633 adversarial review): track every listener a test adds to the shared jsdom
// `window` so `afterEach` below can remove them all. Every test in this file calls
// `installUncaughtCapture()` fresh (after its own `vi.resetModules()`), which registers three NEW
// `window` listeners bound to that test's own module instances — and nothing here ever removed
// them, so `window` accumulated one stale listener per earlier test, forever. Harmless for every
// OTHER test (a stale listener just re-records into its own now-orphaned ring), but the
// ResizeObserver-suppression test below needs a REAL `window.dispatchEvent(...)` to actually
// exercise `stopImmediatePropagation()`, and a stale listener from an earlier test could win that
// race — or land its own `recordConsoleRingEntry` call in an orphaned ring — before this test's own
// listener ever runs. Patched once, at file load, so a test's own `vi.spyOn(window,
// 'addEventListener')` wraps (and `vi.restoreAllMocks()` below unwraps back to) THIS forwarding
// function, never the pristine jsdom original — tracking stays intact across the whole file.
type AddListenerArgs = Parameters<typeof window.addEventListener>;
const realAddEventListener = window.addEventListener.bind(window);
const realRemoveEventListener = window.removeEventListener.bind(window);
let addedListeners: AddListenerArgs[] = [];
window.addEventListener = ((...args: AddListenerArgs) => {
  addedListeners.push(args);
  return realAddEventListener(...args);
}) as typeof window.addEventListener;

afterEach(() => {
  // `vi.restoreAllMocks()` FIRST — it restores each spy to whatever `console[method]` it captured
  // AT SPY-CREATION TIME, which could itself be a nested wrapper from an earlier test. The direct
  // assignment below is the authoritative one and must run LAST, so it always wins.
  vi.restoreAllMocks();
  (Object.keys(originalConsole) as (keyof typeof console)[]).forEach((k) => {
    (console as unknown as Record<string, unknown>)[k] = originalConsole[k];
  });
  vi.resetModules();
  // Remove everything THIS test added to `window`, via the REAL (never mocked) removeEventListener
  // — see the tracking setup above.
  for (const args of addedListeners) realRemoveEventListener(...args);
  addedListeners = [];
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
    // TWO 'error' listeners per install (#626): a capture-phase one (resource-load errors + the
    // ResizeObserver-loop swallow) registered FIRST, plus the plain one below it — see
    // uncaughtCapture.ts's own doc comment for why both the phase and the order are load-bearing.
    // "Idempotent" means a SECOND installUncaughtCapture() call adds neither again, not that there
    // is only ever one 'error' listener.
    expect(errorRegistrations).toBe(2);
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

  // #626: folding the editor Console panel's own capture-phase listener in — see
  // uncaughtCapture.ts's module doc comment.
  describe('the capture-phase listener (#626)', () => {
    it('a resource-load error (non-ErrorEvent, target carries src) records exactly ONE ring entry', async () => {
      vi.resetModules();
      const { installConsoleRing, getConsoleRingEntries } = await import('@modoki/engine/runtime/core/consoleRing');
      installConsoleRing();
      const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
      installUncaughtCapture();

      const before = getConsoleRingEntries().length;
      const img = document.createElement('img');
      document.body.appendChild(img);
      img.src = 'http://localhost/missing.png';
      // Resource errors don't bubble — only a listener registered in the CAPTURE phase on an
      // ancestor (window) ever sees them, which is the whole reason this listener exists.
      img.dispatchEvent(new Event('error'));
      document.body.removeChild(img);

      const added = getConsoleRingEntries().slice(before);
      expect(added).toHaveLength(1);
      expect(added[0].args.join(' ')).toContain('Resource load error');
      expect(added[0].args.join(' ')).toContain('<img>');
      expect(added[0].args.join(' ')).toContain('missing.png');
    });

    // ⚠️ THE regression this whole capture-phase addition risks reintroducing: for an event whose
    // target IS window (every genuine ErrorEvent), BOTH the capture-phase and the plain listener
    // registered on window fire — so without the capture-phase listener's own `instanceof
    // ErrorEvent` guard, a real uncaught error would be recorded TWICE. #596/#597 Stage 3a already
    // fixed exactly this class of bug once (agentBridge.ts + deviceConsoleCapture.ts each recording
    // their own copy); this test is what stops it coming back through the new listener.
    it('a real ErrorEvent records exactly ONE entry, not two, with both listeners registered', async () => {
      vi.resetModules();
      const { installConsoleRing, getConsoleRingEntries } = await import('@modoki/engine/runtime/core/consoleRing');
      installConsoleRing();
      const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
      installUncaughtCapture();

      const before = getConsoleRingEntries().length;
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));

      const added = getConsoleRingEntries().slice(before);
      expect(added).toHaveLength(1);
    });

    // F4 (#626/#633 adversarial review): the swallow must never be a SILENT drop — the first
    // occurrence surfaces a one-shot warn notice instead of recording nothing at all, and a later
    // occurrence in the same session increments the count without spamming a second notice.
    //
    // Dispatches a REAL `window.dispatchEvent(...)`, not a direct call into the capture-phase
    // listener — invoking the listener function directly never runs the PLAIN listener registered
    // below it, so it cannot distinguish "swallowed by `stopImmediatePropagation()`" from "the
    // plain listener was never going to see this anyway": deleting the `stopImmediatePropagation()`
    // call left this test green under a direct-invocation version of itself. A real dispatch is
    // only safe now that the file-level `afterEach` above removes every listener a test adds to
    // the shared jsdom `window` — see its comment for why a stale listener from an EARLIER test
    // would otherwise be the FIRST to see this event and could win the `stopImmediatePropagation()`
    // race before this test's own listener runs.
    it('a ResizeObserver loop message is suppressed but surfaced ONCE as a warn notice, not silently dropped', async () => {
      vi.resetModules();
      const { installConsoleRing, getConsoleRingEntries } = await import('@modoki/engine/runtime/core/consoleRing');
      installConsoleRing();
      const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
      installUncaughtCapture();

      const before = getConsoleRingEntries().length;
      const dispatch = () => window.dispatchEvent(new ErrorEvent('error', {
        message: 'ResizeObserver loop completed with undelivered notifications.',
      }));
      dispatch();

      const added = getConsoleRingEntries().slice(before);
      // Not recorded as a real fault...
      expect(added.some((e) => e.args.join(' ').includes('[uncaught]'))).toBe(false);
      // ...but not silent either.
      expect(added).toHaveLength(1);
      expect(added[0].level).toBe('warn');
      expect(added[0].args.join(' ')).toContain('ResizeObserver loop');

      // A second occurrence in the same session is still suppressed, but does not spam a second
      // notice.
      dispatch();
      expect(getConsoleRingEntries().slice(before)).toHaveLength(1);
    });

    // F4: the discriminator is `!event.error` + a message STARTING WITH the prefix, never a
    // substring match — a game's own thrown error merely mentioning the same words in its message
    // must still reach the ring as a real uncaught error.
    it('a game-authored error whose message merely CONTAINS "ResizeObserver loop" is NOT swallowed', async () => {
      vi.resetModules();
      const { installConsoleRing, getConsoleRingEntries } = await import('@modoki/engine/runtime/core/consoleRing');
      installConsoleRing();
      const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
      installUncaughtCapture();

      const before = getConsoleRingEntries().length;
      window.dispatchEvent(new ErrorEvent('error', {
        error: new Error('ResizeObserver loop guard tripped in my game'),
        message: 'Uncaught Error: ResizeObserver loop guard tripped in my game',
      }));

      const added = getConsoleRingEntries().slice(before);
      expect(added.some((e) =>
        e.args.join(' ').includes('[uncaught]')
        && e.args.join(' ').includes('ResizeObserver loop guard tripped in my game'),
      )).toBe(true);
    });

    // F4, the OTHER half of the discriminator: a message that DOES start with the exact prefix but
    // carries a real `.error` must still reach the ring as a real uncaught error. The test above
    // alone cannot prove `!event.error` matters — its message doesn't start with the literal
    // prefix, so `.startsWith` alone already excludes it regardless of `.error`. This one isolates
    // the `!event.error` half by using a message that WOULD match `.startsWith`.
    it('an error whose message STARTS WITH the ResizeObserver prefix but carries a real .error is NOT swallowed', async () => {
      vi.resetModules();
      const { installConsoleRing, getConsoleRingEntries } = await import('@modoki/engine/runtime/core/consoleRing');
      installConsoleRing();
      const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
      installUncaughtCapture();

      const before = getConsoleRingEntries().length;
      window.dispatchEvent(new ErrorEvent('error', {
        error: new Error('ResizeObserver loop triggered by a real game exception'),
        message: 'ResizeObserver loop triggered by a real game exception',
      }));

      const added = getConsoleRingEntries().slice(before);
      expect(added.some((e) =>
        e.args.join(' ').includes('[uncaught]')
        && e.args.join(' ').includes('ResizeObserver loop triggered by a real game exception'),
      )).toBe(true);
    });

    // F5 (#626/#633 adversarial review): `instanceof ErrorEvent` is realm-scoped, so a plain
    // `Event('error')` (or a cross-realm ErrorEvent) used to fall into the resource-load branch
    // AND still reach the plain listener below — two fabricated ring entries for one non-event.
    it('a plain Event("error") (not an ErrorEvent) records exactly ONE entry, not two', async () => {
      vi.resetModules();
      const { installConsoleRing, getConsoleRingEntries } = await import('@modoki/engine/runtime/core/consoleRing');
      installConsoleRing();
      const { installUncaughtCapture } = await import('../../app/debug/uncaughtCapture');
      installUncaughtCapture();

      const before = getConsoleRingEntries().length;
      window.dispatchEvent(new Event('error'));

      const added = getConsoleRingEntries().slice(before);
      expect(added).toHaveLength(1);
      expect(added.some((e) => e.args.join(' ').includes('Resource load error'))).toBe(false);
    });
  });
});
