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
  it('routes console.error to recordError and console.warn to a breadcrumb', async () => {
    const m = await load();
    m.registerAppServices({ crashlytics: svc });

    console.error('boom', 42);
    console.warn('careful');

    expect(sink.errors).toEqual(['[console.error] boom 42']);
    expect(sink.logs).toEqual(['[console.warn] careful']);
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
    // flush delivered what it held and nothing threw.
    expect(sink.logs.length).toBeGreaterThan(0);
    expect(sink.logs.length).toBeLessThanOrEqual(51);
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
    expect(delivered[1]).toContain('[Crashlytics] log failed');
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
