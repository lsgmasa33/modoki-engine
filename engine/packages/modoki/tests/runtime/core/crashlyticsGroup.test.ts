// @vitest-environment jsdom
/**
 * #1063 — each JS report carries a Crashlytics GROUP, so distinct failures become distinct issues.
 *
 * The group is derived from the report TEXT (see `crashlyticsGroup.ts`'s banner for why). That makes
 * the producers' label shapes load-bearing, so the first block drives every REAL producer
 * (`globalErrors.ts`, `gameJournal.ts`) and asserts the group of what it actually sent. A test built
 * on hand-typed strings would stay green after a producer changed its label and silently coarsened
 * its group. The expected groups are literals, never derived from the function under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  crashlyticsGroup, crashlyticsExceptionOptions, MAX_GROUP_CHARS, CRASHLYTICS_GROUP_FILE,
} from '../../../src/runtime/core/crashlyticsGroup';

let realError: typeof console.error;
let realWarn: typeof console.warn;
let sent: string[];

async function load() {
  vi.resetModules();
  const globalErrors = await import('../../../src/runtime/core/globalErrors');
  const appServices = await import('../../../src/runtime/core/appServices');
  const journal = await import('../../../src/runtime/core/journal');
  const gameJournal = await import('../../../src/runtime/core/gameJournal');
  // Reset BEFORE install: install drains the early buffer into the boot queue, and the reset empties
  // that queue, so the other order silently drops the -early reports the last test below seeds.
  globalErrors.__resetGlobalErrorsForTest();
  globalErrors.installGlobalErrorHandlers();
  // Bound to THIS test's array: earlier tests' window listeners stay attached to the same jsdom window
  // (see globalErrors.test.ts's beforeEach for the four-reports-per-event symptom that causes).
  const local: string[] = [];
  sent = local;
  appServices.registerAppServices({
    crashlytics: { recordError: (m) => { local.push(m); }, log: () => {} },
  });
  journal.setJournalEnabled(false);
  return { ...globalErrors, ...gameJournal };
}

/** The deferred lone-Error `console.error` report lands on a microtask. */
const drain = () => new Promise<void>((r) => setTimeout(r, 0));

const groups = () => sent.map(crashlyticsGroup);

beforeEach(() => {
  sessionStorage.clear();
  delete (globalThis as { __MODOKI_EARLY_ERRORS__?: unknown }).__MODOKI_EARLY_ERRORS__;
  realError = console.error;
  realWarn = console.warn;
  // The wrapped console still forwards to these; keep test output quiet.
  console.error = () => {};
  console.warn = () => {};
});

afterEach(() => {
  console.error = realError;
  console.warn = realWarn;
});

describe('every producer reaches its own group', () => {
  it('journalError groups by event NAME, ignoring a payload that varies per occurrence', async () => {
    const m = await load();
    m.journalError('court.iap.durability-unconfirmed', { txn: 'a1' });
    m.journalError('court.iap.durability-unconfirmed', { txn: 'b2' });
    m.journalError('court.save.load-failed', 'levels.json 404');

    expect(sent).toHaveLength(3);
    expect(groups()).toEqual([
      'journalError/court.iap.durability-unconfirmed',
      'journalError/court.iap.durability-unconfirmed',
      'journalError/court.save.load-failed',
    ]);
  });

  it('an uncaught error groups by kind and error type', async () => {
    await load();
    window.dispatchEvent(new ErrorEvent('error', { error: new RangeError('too far'), message: 'too far' }));
    // No error object — only the browser's message text, which carries its own "Uncaught " prefix.
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught TypeError: x is not a function' }));
    // A cross-origin script error has no type at all.
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    // A bare type in the message, with the producer's own `(file:line:col)` suffix after it.
    window.dispatchEvent(new ErrorEvent('error', { message: 'Error', filename: 'x.ts', lineno: 7, colno: 3 }));

    expect(groups()).toEqual(['uncaught/RangeError', 'uncaught/TypeError', 'uncaught', 'uncaught/Error']);
  });

  it('an unhandled rejection groups by the rejected Error type, and by kind alone for a plain object', async () => {
    await load();
    const firebase = new Error('permission denied');
    firebase.name = 'FirebaseError';
    for (const reason of [firebase, { code: 12501, message: 'Sign in cancelled' }]) {
      const e = new Event('unhandledrejection') as Event & { reason?: unknown };
      e.reason = reason;
      window.dispatchEvent(e);
    }

    expect(groups()).toEqual(['unhandledrejection/FirebaseError', 'unhandledrejection']);
  });

  it('console.error groups by its [Tag] when it has one, else by a lone Error type, else by kind', async () => {
    await load();
    console.error(new SyntaxError('bad json'));
    console.error('[Court] save failed', new Error('quota'));
    console.error('something broke', 42);
    await drain();

    expect(groups().sort()).toEqual(['console.error', 'console.error/Court', 'console.error/SyntaxError'].sort());
  });

  it('console.warn groups by its [Tag], and a numeric bracket is data, not a tag', async () => {
    await load();
    console.warn('[MeshCache] Texture load failed:', 'guid-1');
    console.warn('[MeshCache] Texture load failed:', 'guid-2');
    console.warn('[42] retrying');

    expect(groups()).toEqual(['console.warn/MeshCache', 'console.warn/MeshCache', 'console.warn']);
  });

  it('a React boundary report groups by the error type', async () => {
    const m = await load();
    m.reportReactError(new TypeError('cannot read x'), '\n    at Board');

    expect(groups()).toEqual(['react/TypeError']);
  });

  it('an early-buffered fault keeps its own -early label', async () => {
    (globalThis as { __MODOKI_EARLY_ERRORS__?: unknown }).__MODOKI_EARLY_ERRORS__ = {
      entries: [
        { kind: 'error', error: new TypeError('boot'), message: 'boot' },
        { kind: 'unhandledrejection', reason: new Error('chunk') },
      ],
      done: false,
      dropped: 0,
    };
    await load();

    expect(groups()).toEqual(['uncaught-early/TypeError', 'unhandledrejection-early/Error']);
  });
});

describe('crashlyticsGroup — the grammar', () => {
  it('keeps a replay marker in front, so a previous boot\'s fault is its own issue', () => {
    expect(crashlyticsGroup('[prev-boot] [journalError] a.b {"n":1}')).toBe('prev-boot/journalError/a.b');
    expect(crashlyticsGroup('[prev-boot] [uncaught] TypeError: x')).toBe('prev-boot/uncaught/TypeError');
  });

  it('plain text that merely STARTS with "Error" is not a type — only errorText\'s "Name:" / "Name\\n" shape is', () => {
    expect(crashlyticsGroup('[console.error] Error loading scene')).toBe('console.error');
    expect(crashlyticsGroup('[uncaught] Error while booting')).toBe('uncaught');
    expect(crashlyticsGroup('[uncaught] Error')).toBe('uncaught/Error');
  });

  it('a bare type followed by a producer\'s " (" suffix, or by CRLF, is still a type', () => {
    expect(crashlyticsGroup('[uncaught] Error (x.ts:7:3)')).toBe('uncaught/Error');
    expect(crashlyticsGroup('[uncaught-early] TypeError (t=12ms)')).toBe('uncaught-early/TypeError');
    expect(crashlyticsGroup('[unhandledrejection] IOException\r\n  at x')).toBe('unhandledrejection/IOException');
  });

  it('only a whole identifier ending in Error/Exception is a type', () => {
    expect(crashlyticsGroup('[uncaught] Errorless: x')).toBe('uncaught');
    expect(crashlyticsGroup('[unhandledrejection] Note: x')).toBe('unhandledrejection');
    expect(crashlyticsGroup('[unhandledrejection] DOMException: aborted')).toBe('unhandledrejection/DOMException');
    expect(crashlyticsGroup('[react] Error\n    at x')).toBe('react/Error');
  });

  it('a message with no label is grouped as unlabelled, not dropped', () => {
    expect(crashlyticsGroup('plain text')).toBe('unlabelled');
  });

  it('is clipped to MAX_GROUP_CHARS', () => {
    expect(crashlyticsGroup(`[journalError] ${'x'.repeat(500)}`).length).toBeLessThanOrEqual(MAX_GROUP_CHARS);
  });
});

describe('crashlyticsExceptionOptions — one shape per platform', () => {
  const msg = '[journalError] court.iap.durability-unconfirmed {"txn":"a1"}';

  it('iOS: the group is the NSError domain, and NO stacktrace (which would make the plugin drop domain)', () => {
    expect(crashlyticsExceptionOptions(msg, 'ios')).toEqual({
      message: msg,
      domain: 'journalError/court.iap.durability-unconfirmed',
      code: 0,
    });
  });

  it('Android: the group is the one frame\'s function name, and no domain', () => {
    expect(crashlyticsExceptionOptions(msg, 'android')).toEqual({
      message: msg,
      stacktrace: [{ functionName: 'journalError/court.iap.durability-unconfirmed', fileName: CRASHLYTICS_GROUP_FILE, lineNumber: 0 }],
    });
  });

  it('two different failures produce two different grouping inputs on both platforms', () => {
    const other = '[journalError] court.save.load-failed';
    expect(crashlyticsExceptionOptions(msg, 'ios').domain).not.toBe(crashlyticsExceptionOptions(other, 'ios').domain);
    expect(crashlyticsExceptionOptions(msg, 'android').stacktrace?.[0].functionName)
      .not.toBe(crashlyticsExceptionOptions(other, 'android').stacktrace?.[0].functionName);
  });
});
