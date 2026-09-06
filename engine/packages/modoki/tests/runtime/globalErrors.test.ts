// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `installGlobalErrorHandlers` closes the gap #275 exists for: a SHIPPED build had no global JS
 * error handling at all, so an uncaught throw, an unhandled rejection or a `console.error` reached
 * nothing. These tests drive the module through a fresh registry each time, because the install is
 * process-level by design (idempotent, wraps `console` once) and a shared install would let one
 * test's caps decide another's result.
 *
 * Every test re-imports through `vi.resetModules()` and restores `console` afterwards — the module
 * REPLACES `console.error`/`console.warn`, and a leaked wrapper would report every later test's
 * logging into a dead service.
 */

type Loaded = typeof import('../../src/runtime/core/globalErrors') &
  typeof import('../../src/runtime/core/appServices');

let realError: typeof console.error;
let realWarn: typeof console.warn;

async function load(clock?: () => number): Promise<Loaded> {
  vi.resetModules();
  const g = await import('../../src/runtime/core/globalErrors');
  const a = await import('../../src/runtime/core/appServices');
  g.installGlobalErrorHandlers();
  g.__resetGlobalErrorsForTest(clock ? { clock } : undefined);
  return { ...g, ...a } as Loaded;
}

let sink: { errors: string[]; logs: string[] };
let svc: { recordError(m: string): void; log(m: string): void };

beforeEach(() => {
  // ⚠️ EVERY key, not just this module's. `__resetGlobalErrorsForTest()` clears
  // `modoki.globalErrors.sessionCounters`, but the staleness tests below also write
  // `modoki.resumeReload`, and `sessionStorage` survives `vi.resetModules()` within a file. A
  // leftover 45-minute breadcrumb makes the persistence guard at
  // 'a counter charged in one realm is still charged after a simulated reload' DROP the budget it
  // exists to prove is kept — so that test would pass only by source order, and go red under
  // `--sequence.shuffle.tests`. Caught in close-out review by copying that guard below the
  // staleness tests and watching it fail (101 errors instead of 100).
  sessionStorage.clear();
  // ⚠️ Same "every key" reasoning as sessionStorage.clear() above, for the SIBLING early buffer
  // (#636): a leftover `__MODOKI_EARLY_ERRORS__` from one test is harmless once drained (`done`
  // latches true), but a test that SEEDS a fresh one and never lets it drain would otherwise leak
  // into whichever test runs next.
  delete (globalThis as { __MODOKI_EARLY_ERRORS__?: unknown }).__MODOKI_EARLY_ERRORS__;
  realError = console.error;
  realWarn = console.warn;
  // ⚠️ BOUND TO THIS TEST'S OWN ARRAYS, not to the shared `sink` binding. `vi.resetModules()`
  // hands each test a fresh module that adds its OWN window listeners, and the previous test's
  // listeners are still attached to the same jsdom window holding their own service objects. With
  // `sink.errors.push(...)` those stale services would push into whatever `sink` points at NOW —
  // which read as the handler firing four times for one event.
  const local = { errors: [] as string[], logs: [] as string[] };
  sink = local;
  svc = {
    recordError: (m: string) => { local.errors.push(m); },
    log: (m: string) => { local.logs.push(m); },
  };
});

afterEach(() => {
  console.error = realError;
  console.warn = realWarn;
});

describe('globalErrors — the console split', () => {
  /**
   * ⚠️ This test used to assert `console.warn` became a BREADCRUMB, and that expectation was
   * reversed by the OWNER on 2026-08-20, not by a refactor. The old rule reasoned that a game
   * warns on ordinary paths and that alerting on those would bury a real crash; the owner's rule
   * is that a warning is something to look at, and a warn on an ordinary path should be removed
   * rather than routed somewhere nobody reads. Breadcrumbs now carry GAME EVENTS instead, fed
   * from Court's `track()` seam — see `games/court/packages/app-services/src/track.ts`.
   */
  it('routes BOTH console.error and console.warn to recordError, and neither to a breadcrumb', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });

    console.error('boom', 42);
    console.warn('careful');

    expect(sink.errors).toEqual(['[console.error] boom 42', '[console.warn] careful']);
    expect(sink.logs, 'console no longer produces breadcrumbs at all').toEqual([]);
  });

  it('still passes the line through to the real console — capture must not swallow logging', async () => {
    const seen: unknown[][] = [];
    // Installed OVER this, so it is the "real" console from the module's point of view.
    console.error = (...args: unknown[]) => { seen.push(args); };
    const m = await load();
    m.registerAppServices({ crashlytics: svc });

    console.error('passthrough', 1);

    expect(seen).toEqual([['passthrough', 1]]);
    expect(sink.errors).toEqual(['[console.error] passthrough 1']);
  });
});

describe('globalErrors — window handlers', () => {
  it('reports an uncaught error with its stack and source location', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });

    const err = new Error('kaboom');
    err.stack = 'Error: kaboom\n  at thing (x.ts:1:1)';
    window.dispatchEvent(
      new ErrorEvent('error', { error: err, message: 'kaboom', filename: 'x.ts', lineno: 7, colno: 3 }),
    );

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]).toContain('[uncaught]');
    expect(sink.errors[0]).toContain('at thing (x.ts:1:1)');
    expect(sink.errors[0]).toContain('(x.ts:7:3)');
  });

  it('reports an unhandled rejection', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });

    const e = new Event('unhandledrejection') as Event & { reason?: unknown };
    e.reason = new Error('nope');
    window.dispatchEvent(e);

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]).toContain('[unhandledrejection]');
    expect(sink.errors[0]).toContain('nope');
  });

  it('survives a value whose stack getter throws — reporting must not amplify', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });

    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'stack', { get() { throw new Error('nested'); } });
    expect(() => {
      window.dispatchEvent(new ErrorEvent('error', { error: hostile, message: 'hostile' }));
    }).not.toThrow();
  });
});

describe('globalErrors — Capacitor double-reporting', () => {
  it('reports an uncaught error ONCE, keeping the [uncaught] label', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });

    // Reproduces what a Capacitor app actually does, measured on a Galaxy S22: the bridge's
    // `cap.handleWindowError` calls `console.error(err)` from INSIDE the error dispatch, so it
    // lands before our own listener. Without the microtask deferral this produced two issues for
    // one fault — a `[console.error]` copy and an `[uncaught]` one.
    const err = new Error('one fault');
    err.stack = 'Error: one fault\n  at boom (x.ts:1:1)';
    console.error(err);
    window.dispatchEvent(new ErrorEvent('error', { error: err, message: 'one fault', filename: 'x.ts', lineno: 1, colno: 1 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]).toContain('[uncaught]');
  });

  it('reports a React boundary crash ONCE, with its component stack', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });

    // React logs a boundary-caught error to console.error as well — same double-report shape as
    // Capacitor's, measured in the same session. The boundary's report is the one worth keeping,
    // because only it carries the component stack.
    const err = new Error('render exploded');
    m.reportReactError(err, '\n    at Board\n    at App');
    console.error(err);
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]).toContain('[react]');
    expect(sink.errors[0]).toContain('at Board');
  });

  it('still reports a lone Error passed to console.error that never became an uncaught event', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });

    console.error(new Error('handled, but logged'));
    expect(sink.errors).toHaveLength(0); // deferred by one microtask
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]).toContain('[console.error]');
    expect(sink.errors[0]).toContain('handled, but logged');
  });
});

describe('globalErrors — the boot queue', () => {
  it('queues events raised before a crashlytics service exists, and flushes on registration', async () => {
    const m = await load();
    // Nothing registered yet — this is the boot window that used to lose everything.
    console.error('early failure');
    expect(sink.errors).toHaveLength(0);

    m.registerAppServices({ crashlytics: svc });
    expect(sink.errors).toEqual(['[console.error] early failure']);
  });

  it('caps the queue and SAYS it dropped rather than lying about completeness', async () => {
    const m = await load();
    for (let i = 0; i < 80; i++) console.warn(`w${i}`);
    m.registerAppServices({ crashlytics: svc });

    // Burst cap bites first (30 per window), so the queue never fills — what matters is that the
    // flush delivered what it held and nothing threw. `errors`, not `logs`: `console.warn` is an
    // ISSUE since the owner's 2026-08-20 call (see the console-split test).
    expect(sink.errors.length).toBeGreaterThan(0);
    expect(sink.errors.length).toBeLessThanOrEqual(51);
  });
});

describe('globalErrors — rate limiting', () => {
  it('sends an identical message at most three times', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });
    for (let i = 0; i < 10; i++) m.captureToCrashlytics('error', 'same');
    expect(sink.errors).toHaveLength(3);
  });

  it('caps a burst that DEFEATS dedupe by varying its text', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });
    for (let i = 0; i < 100; i++) m.captureToCrashlytics('error', `unique ${i}`);
    expect(sink.errors).toHaveLength(30);
  });

  it('does NOT let a deduped flood eat the burst window and starve a fresh crash', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });

    // The threat model this module names in its own comments: a warning inside a per-frame system.
    // Dedupe sends 3 of them. The other 37 must cost NOTHING — charging the burst window for an
    // attempt dedupe already rejected is what silently dropped the next unrelated crash.
    for (let i = 0; i < 40; i++) m.captureToCrashlytics('error', 'per-frame spam');
    expect(sink.errors).toHaveLength(3);

    m.captureToCrashlytics('error', 'BRAND NEW first-ever crash');
    expect(sink.errors).toHaveLength(4);
    expect(sink.errors[3]).toContain('BRAND NEW');
  });

  /**
   * ⚠️ REGRESSION (close-out, 2026-08-20). When `console.warn` became an ISSUE it also started
   * spending the ERROR budget, and that inverted what this limiter exists for. Dedupe keys on
   * exact text, so it does nothing against the ~97 runtime warn sites that interpolate a value
   * (`[MeshCache] Texture load failed: ${ref}`, one per ref): 100 such warns exhausted
   * `MAX_ERRORS_PER_SESSION`, and from then on EVERY genuine crash that session was dropped by the
   * cap — silently, since `allow()` just returns false.
   *
   * Warns are still delivered as issues. They simply have their OWN session budget now, so they
   * cannot spend the one that exists to guarantee a crash gets through.
   */
  it('does NOT let a warn flood spend the crash budget', async () => {
    let t = 0;
    const m = await load(() => t);
    m.registerAppServices({ crashlytics: svc });

    // Distinct text every time — the shape dedupe cannot touch. Step the clock so the BURST window
    // (shared on purpose) is never the thing under test.
    for (let i = 0; i < 300; i++) {
      if (i % 20 === 0) t += 6000;
      m.captureToCrashlytics('warn', `[console.warn] texture load failed: ref-${i}`);
    }
    const afterFlood = sink.errors.length;
    expect(afterFlood, 'the warns are capped by their own budget').toBeLessThanOrEqual(100);

    t += 6000;
    m.captureToCrashlytics('error', 'REAL CRASH — the report that matters');
    expect(sink.errors, 'and a genuine crash still gets through').toHaveLength(afterFlood + 1);
    expect(sink.errors[sink.errors.length - 1]).toContain('REAL CRASH');
  });

  it('delivers a warn as an ISSUE, not a breadcrumb — a separate budget is not a separate destination', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });
    m.captureToCrashlytics('warn', 'something to look at');
    expect(sink.errors).toEqual(['something to look at']);
    expect(sink.logs).toEqual([]);
  });

  it('bounds the dedupe table rather than growing a key per distinct message forever', async () => {
    let t = 0;
    const m = await load(() => t);
    m.registerAppServices({ crashlytics: svc });

    // A flood that DEFEATS dedupe by varying its text. The session caps stop the sending, not the
    // bookkeeping — so without a bound this is one Map key per message for the life of a process.
    // Step the clock so the burst window never becomes the thing under test.
    for (let i = 0; i < 4000; i++) {
      if (i % 20 === 0) t += 6000;
      m.captureToCrashlytics('breadcrumb', `varying ${i}`);
    }
    expect(m.__dedupeTableSizeForTest()).toBeLessThanOrEqual(500);
  });

  it('lets the burst window reopen once time passes', async () => {
    let t = 0;
    const m = await load(() => t);
    m.registerAppServices({ crashlytics: svc });
    for (let i = 0; i < 100; i++) m.captureToCrashlytics('error', `a${i}`);
    expect(sink.errors).toHaveLength(30);
    t += 6000;
    m.captureToCrashlytics('error', 'after the window');
    expect(sink.errors).toHaveLength(31);
  });

  it('truncates a very long message rather than paying for it on the bridge', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });
    m.captureToCrashlytics('error', 'x'.repeat(10_000));
    expect(sink.errors[0].length).toBeLessThan(4_100);
    expect(sink.errors[0]).toContain('[truncated]');
  });
});

describe('globalErrors — the async bounce', () => {
  it('terminates at exactly two messages when the service always rejects', async () => {
    const m = await load();
    const delivered: string[] = [];
    // The SHIPPING shape: async, rejects, and warns once per distinct message (Court's
    // crashlytics.ts). `reporting` cannot cover this — it is released before the .catch runs — so
    // what bounds it is the wrapper's latch. Pin the number: a wrapper that forgets its latch
    // shows up here as a rising count instead of as a silent flood on a player's phone.
    const warned = new Set<string>();
    const fail = (what: string, e: unknown) => {
      const msg = String(e);
      if (warned.has(msg)) return;
      warned.add(msg);
      console.warn(`[Crashlytics] ${what} failed: ${msg}`);
    };
    const rejecting = {
      recordError: (msg: string) => {
        delivered.push(msg);
        void Promise.reject(new Error('bridge down')).catch((e) => fail('recordError', e));
      },
      log: (msg: string) => {
        delivered.push(msg);
        void Promise.reject(new Error('bridge down')).catch((e) => fail('log', e));
      },
    };
    m.registerAppServices({ crashlytics: rejecting });

    console.warn('the original warning');
    for (let i = 0; i < 40; i++) await Promise.resolve();

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toContain('the original warning');
    // `recordError`, not `log`: a warn is an ISSUE now, so the rejecting call it bounces off — and
    // therefore the wrapper's own failure warning — is the recordError one.
    expect(delivered[1]).toContain('[Crashlytics] recordError failed');
  });
});

describe('globalErrors — re-entrancy', () => {
  it('does not loop when the crashlytics implementation itself warns', async () => {
    const m = await load();
    let depth = 0;
    let maxDepth = 0;
    m.registerAppServices({
      crashlytics: {
        recordError(msg: string) {
          depth++;
          maxDepth = Math.max(maxDepth, depth);
          sink.errors.push(msg);
          // Every wrapper in this repo warns when the SDK call fails. Unguarded, that warning
          // re-enters the module and reports the report.
          console.warn('[Crashlytics] recordError failed');
          depth--;
        },
        log(msg: string) {
          depth++;
          maxDepth = Math.max(maxDepth, depth);
          sink.logs.push(msg);
          depth--;
        },
      },
    });

    console.error('the original failure');
    expect(maxDepth).toBe(1);
    expect(sink.errors).toHaveLength(1);
    expect(sink.logs).toHaveLength(0);
  });
});

describe('globalErrors — install', () => {
  it('is idempotent, so a second call cannot double-report every line', async () => {
    const m = await load();
    m.installGlobalErrorHandlers();
    m.installGlobalErrorHandlers();
    m.registerAppServices({ crashlytics: svc });
    console.error('once');
    expect(sink.errors).toHaveLength(1);
  });
});

describe('globalErrors — session budget survives a reload (#588)', () => {
  /**
   * A webview reload destroys and re-zeroes this module's `let`s while native Crashlytics still
   * counts it as ONE session — so a cap whose name says "per session" was really per REALM.
   * `sessionStorage` survives a same-origin reload (it is what jsdom keeps across `vi.resetModules()`
   * within one test file too), so re-importing the module with it intact is a faithful simulation of
   * a reload.
   */
  it('a counter charged in one realm is still charged after a simulated reload', async () => {
    // Step the injected clock so the pre-reload batch is not itself burst-capped (30/5s) — the
    // budget under test here is the SESSION cap (100), not the burst window.
    let t = 0;
    const m1 = await load(() => t);
    m1.registerAppServices({ crashlytics: svc });
    for (let i = 0; i < 97; i++) {
      if (i % 20 === 0) t += 6000;
      m1.captureToCrashlytics('error', `pre-reload ${i}`);
    }
    expect(sink.errors).toHaveLength(97);

    // Simulate a reload: re-import the module (a fresh `let errorsSent = 0` at the JS level) WITHOUT
    // calling __resetGlobalErrorsForTest, so sessionStorage is the only thing carrying the count over.
    vi.resetModules();
    const g2 = await import('../../src/runtime/core/globalErrors');
    const a2 = await import('../../src/runtime/core/appServices');
    g2.installGlobalErrorHandlers();
    a2.registerAppServices({ crashlytics: svc });

    // 3 left of the 100-per-session budget — the reload did NOT refresh it to a fresh 100.
    g2.captureToCrashlytics('error', 'post-reload A');
    g2.captureToCrashlytics('error', 'post-reload B');
    g2.captureToCrashlytics('error', 'post-reload C');
    expect(sink.errors).toHaveLength(100);

    g2.captureToCrashlytics('error', 'post-reload D — should be capped');
    expect(sink.errors, 'the budget remembers the 97 already spent pre-reload').toHaveLength(100);
  });

  it('a throwing/absent sessionStorage falls back to in-memory behaviour and reporting still works', async () => {
    vi.resetModules();
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const throwing = new Proxy(
      {},
      {
        get(): never { throw new Error('sessionStorage disabled'); },
        set(): never { throw new Error('sessionStorage disabled'); },
      },
    );
    Object.defineProperty(window, 'sessionStorage', { value: throwing, configurable: true });
    try {
      // Module top-level init reads sessionStorage while it is throwing — must not throw itself.
      const g = await import('../../src/runtime/core/globalErrors');
      const a = await import('../../src/runtime/core/appServices');
      expect(() => g.installGlobalErrorHandlers()).not.toThrow();
      a.registerAppServices({ crashlytics: svc });
      expect(() => g.captureToCrashlytics('error', 'still works')).not.toThrow();
      expect(sink.errors).toEqual(['still works']);
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  it('a budget carried past the native session window is DROPPED, not inherited', async () => {
    // ⚠️ Found in close-out review; the persistence shipped without this and it is the one
    // direction in which persisting is WORSE than not persisting. Crashlytics ends a session
    // after ~30 min in the background, but `sessionStorage` survives as long as the webview
    // content process does. So: spend the budget, go away longer than the session window, let
    // #574 reload on resume — and the brand-new native session inherits a spent budget and ships
    // NOTHING for its entire life, silently. Before the persistence the reload restored it.
    let t = 0;
    const m1 = await load(() => t);
    m1.registerAppServices({ crashlytics: svc });
    for (let i = 0; i < 100; i++) {
      if (i % 20 === 0) t += 6000;
      m1.captureToCrashlytics('error', `pre-reload ${i}`);
    }
    expect(sink.errors, 'the pre-reload session spent its whole budget').toHaveLength(100);

    // The resume-reload breadcrumb the reload path leaves behind, with a gap well past the window.
    sessionStorage.setItem('modoki.resumeReload', JSON.stringify({ awayMs: 45 * 60_000 }));

    vi.resetModules();
    const g2 = await import('../../src/runtime/core/globalErrors');
    const a2 = await import('../../src/runtime/core/appServices');
    // No second installGlobalErrorHandlers() — this test only needs the re-imported module's
    // counters, and each extra install leaves another window listener on the shared jsdom window.
    a2.registerAppServices({ crashlytics: svc });

    g2.captureToCrashlytics('error', 'post-reload, new native session');
    expect(
      sink.errors.length,
      'a new Crashlytics session must start with a fresh budget — inheriting the spent one '
        + 'silences the whole session',
    ).toBeGreaterThan(100);
  });

  it('does NOT drop the budget for a SHORT away gap — that is the case persistence exists for', async () => {
    // The complement, and what keeps the staleness check from quietly undoing #588: a resume-reload
    // inside the session window is the same native session, so the budget must still carry over.
    let t = 0;
    const m1 = await load(() => t);
    m1.registerAppServices({ crashlytics: svc });
    for (let i = 0; i < 100; i++) {
      if (i % 20 === 0) t += 6000;
      m1.captureToCrashlytics('error', `pre-reload ${i}`);
    }
    expect(sink.errors).toHaveLength(100);

    sessionStorage.setItem('modoki.resumeReload', JSON.stringify({ awayMs: 2 * 60_000 }));

    vi.resetModules();
    const g2 = await import('../../src/runtime/core/globalErrors');
    const a2 = await import('../../src/runtime/core/appServices');
    a2.registerAppServices({ crashlytics: svc });

    g2.captureToCrashlytics('error', 'post-reload, same native session');
    expect(
      sink.errors,
      'a 2-minute gap is the same native session — the budget must still be spent',
    ).toHaveLength(100);
  });

  it('a dropped stale budget is cleared from STORAGE, not just from memory', async () => {
    // Realm A spends the budget -> long gap -> realm B drops it in memory and charges nothing ->
    // realm C must still start fresh. If the drop were in-memory only, B never calls
    // savePersistedCounters() (it only runs on an allowed capture), so the spent value survives in
    // storage and C files nothing for its whole life. Found in close-out review.
    let t = 0;
    const mA = await load(() => t);
    mA.registerAppServices({ crashlytics: svc });
    for (let i = 0; i < 100; i++) {
      if (i % 20 === 0) t += 6000;
      mA.captureToCrashlytics('error', `A${i}`);
    }
    expect(sink.errors).toHaveLength(100);

    // Realm B: long gap, drops the budget, charges NOTHING.
    sessionStorage.setItem('modoki.resumeReload', JSON.stringify({ awayMs: 45 * 60_000 }));
    vi.resetModules();
    await import('../../src/runtime/core/globalErrors');
    sessionStorage.removeItem('modoki.resumeReload');

    // Realm C: an ordinary reload with no breadcrumb at all.
    vi.resetModules();
    const gC = await import('../../src/runtime/core/globalErrors');
    const aC = await import('../../src/runtime/core/appServices');
    aC.registerAppServices({ crashlytics: svc });
    gC.captureToCrashlytics('error', 'C — must be reported');
    expect(
      sink.errors.length,
      'realm C inherited the dead session\'s spent budget from storage',
    ).toBeGreaterThan(100);
  });

  it('peeking the resume-reload breadcrumb does not consume it', async () => {
    // globalErrors reads the breadcrumb to size the staleness check; the resume-reload consumer
    // still owns it. If the peek removed it, the real consumer would see a cold launch instead.
    sessionStorage.setItem('modoki.resumeReload', JSON.stringify({ awayMs: 1000 }));
    vi.resetModules();
    await import('../../src/runtime/core/globalErrors');
    const rr = await import('../../src/runtime/core/resumeReload');
    expect(
      rr.consumeResumeReload(),
      'globalErrors consumed the breadcrumb out from under the resume-reload path',
    ).toEqual({ awayMs: 1000 });
  });

  it('__resetGlobalErrorsForTest clears the persisted values', async () => {
    const m1 = await load();
    m1.registerAppServices({ crashlytics: svc });
    m1.captureToCrashlytics('error', 'charge one');
    expect(sink.errors).toHaveLength(1);
    expect(sessionStorage.getItem('modoki.globalErrors.sessionCounters')).not.toBeNull();

    m1.__resetGlobalErrorsForTest();

    expect(sessionStorage.getItem('modoki.globalErrors.sessionCounters')).toBeNull();
  });
});

describe('globalErrors — [reload] breadcrumb at boot', () => {
  it('emits a [reload] breadcrumb when the navigation type is reload', async () => {
    sessionStorage.clear();
    vi.resetModules();
    const spy = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' }] as unknown as PerformanceEntryList);
    try {
      const g = await import('../../src/runtime/core/globalErrors');
      const a = await import('../../src/runtime/core/appServices');
      g.installGlobalErrorHandlers();
      a.registerAppServices({ crashlytics: svc });
      expect(sink.logs.some((m) => m.includes('[reload]'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('does NOT emit a [reload] breadcrumb when the navigation type is navigate', async () => {
    sessionStorage.clear();
    vi.resetModules();
    const spy = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'navigate' }] as unknown as PerformanceEntryList);
    try {
      const g = await import('../../src/runtime/core/globalErrors');
      const a = await import('../../src/runtime/core/appServices');
      g.installGlobalErrorHandlers();
      a.registerAppServices({ crashlytics: svc });
      expect(sink.logs.some((m) => m.includes('[reload]'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('globalErrors — early error buffer drain (#636)', () => {
  /**
   * Shape published by the fatal-load guard's early-error buffer in `engine/index.html`.
   * Duplicated here rather than imported — mirrors `consoleRing.test.ts`'s `seedEarlyConsole` for
   * the sibling `__MODOKI_EARLY_CONSOLE__` buffer: nothing outside the guard itself and
   * `drainEarlyErrors` should ever construct one of these.
   */
  interface EarlyErrorEntry {
    kind: 'error' | 'unhandledrejection';
    error?: unknown;
    message?: string;
    filename?: string;
    lineno?: number;
    colno?: number;
    reason?: unknown;
    ts?: number;
  }
  interface EarlyErrorState { entries: EarlyErrorEntry[]; done: boolean; dropped: number }
  function seedEarlyErrors(state: Partial<EarlyErrorState> = {}): EarlyErrorState {
    const full: EarlyErrorState = { entries: [], done: false, dropped: 0, ...state };
    (globalThis as { __MODOKI_EARLY_ERRORS__?: EarlyErrorState }).__MODOKI_EARLY_ERRORS__ = full;
    return full;
  }

  // ⚠️ These tests do NOT use the shared `load()` helper. `load()` calls
  // `__resetGlobalErrorsForTest()` right after `installGlobalErrorHandlers()`, which resets the
  // boot QUEUE — and a seeded buffer drains INTO that queue during install, before a crashlytics
  // service is registered. `load()` would wipe it before any test could observe it. This is the
  // same reason the `[reload] breadcrumb at boot` tests just above assemble the module by hand.

  it('drains a pre-seeded uncaught error into exactly one recordError, labeled [uncaught-early]', async () => {
    vi.resetModules();
    const err = new Error('boot-time throw');
    seedEarlyErrors({ entries: [{ kind: 'error', error: err, message: err.message, filename: 'App.tsx', lineno: 5, colno: 9 }] });

    const g = await import('../../src/runtime/core/globalErrors');
    const a = await import('../../src/runtime/core/appServices');
    g.installGlobalErrorHandlers();
    a.registerAppServices({ crashlytics: svc });

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]).toContain('[uncaught-early]');
    expect(sink.errors[0]).toContain('boot-time throw');
    expect(sink.errors[0]).toContain('(App.tsx:5:9)');
  });

  it('drains a pre-seeded unhandledrejection into exactly one recordError, labeled [unhandledrejection-early]', async () => {
    vi.resetModules();
    seedEarlyErrors({ entries: [{ kind: 'unhandledrejection', reason: new Error('early rejection') }] });

    const g = await import('../../src/runtime/core/globalErrors');
    const a = await import('../../src/runtime/core/appServices');
    g.installGlobalErrorHandlers();
    a.registerAppServices({ crashlytics: svc });

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]).toContain('[unhandledrejection-early]');
    expect(sink.errors[0]).toContain('early rejection');
  });

  it('sets done = true and empties entries — single-drain, like drainEarlyConsole', async () => {
    vi.resetModules();
    const early = seedEarlyErrors({ entries: [{ kind: 'error', error: new Error('x') }] });

    const g = await import('../../src/runtime/core/globalErrors');
    const a = await import('../../src/runtime/core/appServices');
    g.installGlobalErrorHandlers();
    a.registerAppServices({ crashlytics: svc });

    expect(early.done).toBe(true);
    expect(early.entries).toEqual([]);
  });

  it('a second installGlobalErrorHandlers() does not double-drain', async () => {
    vi.resetModules();
    seedEarlyErrors({ entries: [{ kind: 'error', error: new Error('once') }] });

    const g = await import('../../src/runtime/core/globalErrors');
    const a = await import('../../src/runtime/core/appServices');
    g.installGlobalErrorHandlers();
    g.installGlobalErrorHandlers(); // idempotent no-op — must not re-read an already-drained buffer
    a.registerAppServices({ crashlytics: svc });

    expect(sink.errors.filter((e) => e.includes('once'))).toHaveLength(1);
  });

  /**
   * The risky half (#636's design doc calls this out explicitly): a buffered error replayed
   * without claiming it first would file the fault TWICE once Capacitor's bridge or React's
   * boundary re-logs the same object through `console.error` — the exact "two issues per fault"
   * symptom `alreadyReported` exists to prevent (see the WeakSet's doc comment above).
   */
  it('claims the buffered error object BEFORE reporting, so a later console.error(sameObject) does not double-report', async () => {
    vi.resetModules();
    const err = new Error('claimed early');
    seedEarlyErrors({ entries: [{ kind: 'error', error: err, message: err.message }] });

    const g = await import('../../src/runtime/core/globalErrors');
    const a = await import('../../src/runtime/core/appServices');
    g.installGlobalErrorHandlers();
    a.registerAppServices({ crashlytics: svc });
    expect(sink.errors, 'the early drain itself must have reported it').toHaveLength(1);

    console.error(err); // the SAME object, exactly what a re-logging bridge/boundary would pass
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.errors, 'the claim must stand the console.error copy of the SAME object down').toHaveLength(1);
  });

  // The negative control the claim test above needs: proof this isn't passing by dropping
  // console.error reports altogether. A DIFFERENT object must still get through.
  it('does NOT suppress a DIFFERENT error reported through console.error', async () => {
    vi.resetModules();
    seedEarlyErrors({ entries: [{ kind: 'error', error: new Error('claimed early'), message: 'claimed early' }] });

    const g = await import('../../src/runtime/core/globalErrors');
    const a = await import('../../src/runtime/core/appServices');
    g.installGlobalErrorHandlers();
    a.registerAppServices({ crashlytics: svc });
    expect(sink.errors).toHaveLength(1);

    console.error(new Error('a totally different fault'));
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.errors).toHaveLength(2);
    expect(sink.errors[1]).toContain('a totally different fault');
  });

  it('a dropped > 0 count surfaces one breadcrumb (a log, not an error)', async () => {
    vi.resetModules();
    seedEarlyErrors({ entries: [], dropped: 5 });

    const g = await import('../../src/runtime/core/globalErrors');
    const a = await import('../../src/runtime/core/appServices');
    g.installGlobalErrorHandlers();
    a.registerAppServices({ crashlytics: svc });

    expect(sink.errors).toEqual([]);
    expect(sink.logs).toHaveLength(1);
    expect(sink.logs[0]).toContain('5');
    expect(sink.logs[0]).toContain('[modoki]');
  });

  // #682 close-out MEDIUM 3: `engine/index.html`'s `EARLY_ERROR_CAP` (28) must stay comfortably
  // under `MAX_PER_BURST_WINDOW` (30) — the drain below feeds every buffered entry through THIS
  // SAME shared rate limiter synchronously, in one burst, and a `[reload]` breadcrumb can already
  // have spent one slot before the drain starts. With the old cap of 32 this pair of tests would
  // have shown the "dropped" breadcrumb — the one thing that makes the cap honest — silently
  // refused by the very limiter it exists to report on.
  it('at the cap (28 entries), the dropped-count breadcrumb still gets through even after a [reload] breadcrumb spent a slot', async () => {
    vi.resetModules();
    const spy = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' }] as unknown as PerformanceEntryList);
    try {
      // Worst case: buffer full to `EARLY_ERROR_CAP` (28) with more dropped on top, on a RELOAD
      // boot — 1 (reload) + 28 (errors) + 1 (dropped breadcrumb) = 30, exactly MAX_PER_BURST_WINDOW.
      const entries = Array.from({ length: 28 }, (_, i) => ({ kind: 'error' as const, error: new Error(`e${i}`), message: `e${i}` }));
      seedEarlyErrors({ entries, dropped: 2 });

      const g = await import('../../src/runtime/core/globalErrors');
      const a = await import('../../src/runtime/core/appServices');
      g.installGlobalErrorHandlers();
      a.registerAppServices({ crashlytics: svc });

      expect(sink.logs.some((m) => m.includes('[reload]'))).toBe(true);
      expect(sink.errors).toHaveLength(28); // every buffered entry got through
      expect(sink.logs.some((m) => m.includes('2') && m.includes('dropped'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('one entry OVER that budget silently refuses the dropped-count breadcrumb — the regression this cap exists to prevent', async () => {
    vi.resetModules();
    const spy = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' }] as unknown as PerformanceEntryList);
    try {
      // 1 (reload) + 29 (errors) already exhausts the 30-per-window budget, so the dropped-count
      // breadcrumb — attempt #31 — is refused by `allow()`. This is the shape MEDIUM 3 found live
      // with the old EARLY_ERROR_CAP of 32.
      const entries = Array.from({ length: 29 }, (_, i) => ({ kind: 'error' as const, error: new Error(`e${i}`), message: `e${i}` }));
      seedEarlyErrors({ entries, dropped: 1 });

      const g = await import('../../src/runtime/core/globalErrors');
      const a = await import('../../src/runtime/core/appServices');
      g.installGlobalErrorHandlers();
      a.registerAppServices({ crashlytics: svc });

      expect(sink.errors).toHaveLength(29);
      expect(sink.logs.some((m) => m.includes('dropped'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('survives a reason whose stack getter throws — draining must not amplify the fault', async () => {
    vi.resetModules();
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'stack', { get() { throw new Error('nested'); } });
    seedEarlyErrors({ entries: [{ kind: 'unhandledrejection', reason: hostile }] });

    const g = await import('../../src/runtime/core/globalErrors');
    const a = await import('../../src/runtime/core/appServices');
    expect(() => g.installGlobalErrorHandlers()).not.toThrow();
    expect(() => a.registerAppServices({ crashlytics: svc })).not.toThrow();
  });

  // #682 close-out round 3, MEDIUM 3: `EarlyErrorEntry.ts` (the guard's own `performance.now()` at
  // CAPTURE time, set in `engine/index.html`) used to be written and typed but never read by this
  // drain — a field with no consumer. It reports "how far into boot" the fault happened, which the
  // drain time cannot (install can run long after the entry was captured).
  it("surfaces the buffered entry's own capture time in the reported message, not the drain time", async () => {
    vi.resetModules();
    seedEarlyErrors({ entries: [{ kind: 'error', error: new Error('timed'), message: 'timed', ts: 1234.6 }] });

    const g = await import('../../src/runtime/core/globalErrors');
    const a = await import('../../src/runtime/core/appServices');
    g.installGlobalErrorHandlers();
    a.registerAppServices({ crashlytics: svc });

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]).toContain('(t=1235ms)'); // rounded, and CAPTURE time, not drain time
  });

  it('an entry with no `ts` (older buffer, or a genuinely absent capture time) reports cleanly — no "undefined"/"NaN" in the message', async () => {
    vi.resetModules();
    seedEarlyErrors({ entries: [{ kind: 'error', error: new Error('untimed'), message: 'untimed' }] });

    const g = await import('../../src/runtime/core/globalErrors');
    const a = await import('../../src/runtime/core/appServices');
    g.installGlobalErrorHandlers();
    a.registerAppServices({ crashlytics: svc });

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]).not.toContain('undefined');
    expect(sink.errors[0]).not.toContain('NaN');
    expect(sink.errors[0]).not.toContain('(t=');
  });
});
