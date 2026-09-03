/** consoleRing unit tests — the one shared console ring (Stage 1 of #596/#597). */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  unpatchedLog,
  installConsoleRing,
  getConsoleRingEntries,
  getConsoleRingVersion,
  getConsoleRingDropped,
  getConsoleRingBootPrefixCount,
  subscribeConsoleRing,
  isConsoleRingInstalled,
  __resetConsoleRingForTest,
} from '../../src/runtime/core/consoleRing';

afterEach(() => {
  __resetConsoleRingForTest();
  delete (globalThis as { __MODOKI_EARLY_CONSOLE__?: unknown }).__MODOKI_EARLY_CONSOLE__;
});

/** Shape published by the inline early-capture shim in engine/index.html (#633). Duplicated here
 *  rather than imported — it is not exported, deliberately: nothing outside consoleRing.ts should
 *  build one of these except the shim itself. */
interface EarlyConsoleState {
  entries: [string, unknown[], number?][];
  done: boolean;
  dropped: number;
}

function seedEarlyConsole(state: Partial<EarlyConsoleState> = {}): EarlyConsoleState {
  const full: EarlyConsoleState = { entries: [], done: false, dropped: 0, ...state };
  (globalThis as { __MODOKI_EARLY_CONSOLE__?: EarlyConsoleState }).__MODOKI_EARLY_CONSOLE__ = full;
  return full;
}

describe('consoleRing', () => {
  it('records all four levels and always forwards to the original console method', () => {
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    const spies = {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    console.log = spies.log;
    console.info = spies.info;
    console.warn = spies.warn;
    console.error = spies.error;
    try {
      installConsoleRing();
      console.log('a');
      console.info('b');
      console.warn('c');
      console.error('d');

      expect(spies.log).toHaveBeenCalledWith('a');
      expect(spies.info).toHaveBeenCalledWith('b');
      expect(spies.warn).toHaveBeenCalledWith('c');
      expect(spies.error).toHaveBeenCalledWith('d');

      const entries = getConsoleRingEntries();
      expect(entries.map((e) => [e.level, e.args])).toEqual([
        ['log', ['a']],
        ['info', ['b']],
        ['warn', ['c']],
        ['error', ['d']],
      ]);
    } finally {
      // Restore the ring's bookkeeping FIRST (it currently thinks the spies above are "the
      // original"), then reinstate the real console methods — reversed, the global afterEach's
      // own `__resetConsoleRingForTest()` call would restore console.log back to a dead spy.
      __resetConsoleRingForTest();
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  it('is idempotent — a second install records once, not twice', () => {
    installConsoleRing();
    installConsoleRing();
    expect(isConsoleRingInstalled()).toBe(true);
    console.log('only-once');
    const entries = getConsoleRingEntries();
    expect(entries.filter((e) => e.args[0] === 'only-once')).toHaveLength(1);
  });

  it('unpatchedLog does NOT get recorded into the ring (the #591 regression, pinned)', () => {
    installConsoleRing();
    const before = getConsoleRingEntries().length;
    unpatchedLog('via-unpatched-log');
    const after = getConsoleRingEntries();
    expect(after).toHaveLength(before);
    expect(after.some((e) => e.args.includes('via-unpatched-log'))).toBe(false);
  });

  it('the pinned boot prefix survives heavy later logging', () => {
    installConsoleRing({ capacity: 20, bootPrefix: 5 });
    for (let i = 1; i <= 200; i++) console.log(`line-${i}`);

    const entries = getConsoleRingEntries();
    expect(entries).toHaveLength(20);
    expect(entries.slice(0, 5).map((e) => e.args[0])).toEqual([
      'line-1',
      'line-2',
      'line-3',
      'line-4',
      'line-5',
    ]);
    expect(getConsoleRingDropped()).toBe(180);
  });

  // Finding A (#596/#597 close-out review): `getConsoleRingBootPrefixCount()` is the boundary a
  // reader needs to draw a gap marker where `getConsoleRingDropped()` says the ring is
  // discontiguous — a `seq` is in the pinned prefix iff it is `<=` this value.
  it('getConsoleRingBootPrefixCount climbs to bootPrefix during boot, then holds', () => {
    installConsoleRing({ capacity: 20, bootPrefix: 5 });
    expect(getConsoleRingBootPrefixCount()).toBe(0);
    console.log('boot-1');
    console.log('boot-2');
    expect(getConsoleRingBootPrefixCount()).toBe(2);
    for (let i = 0; i < 200; i++) console.log(`line-${i}`);
    expect(getConsoleRingBootPrefixCount()).toBe(5); // caps at bootPrefix and never evicts

    // `pinned` is always the ring's very first N records, contiguous by construction: the boundary
    // IS the seq value.
    const entries = getConsoleRingEntries();
    const bootCount = getConsoleRingBootPrefixCount();
    expect(entries[bootCount - 1].seq).toBe(bootCount);
    expect(entries[bootCount].seq).toBeGreaterThan(bootCount);
  });

  it('getConsoleRingEntries(sinceSeq) filters correctly', () => {
    installConsoleRing();
    console.log('one');
    console.log('two');
    console.log('three');
    const all = getConsoleRingEntries();
    expect(all).toHaveLength(3);
    const sinceFirst = getConsoleRingEntries(all[0].seq);
    expect(sinceFirst.map((e) => e.args[0])).toEqual(['two', 'three']);
  });

  it('version bumps synchronously; subscriber fires on a microtask, not synchronously', async () => {
    installConsoleRing();
    const seen: string[] = [];
    subscribeConsoleRing(() => seen.push('notified'));
    const before = getConsoleRingVersion();

    console.log('probe');

    expect(getConsoleRingVersion()).toBeGreaterThan(before);
    expect(seen).toEqual([]); // not yet — still the same task

    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual(['notified']);
  });

  it('a throwing subscriber neither escapes nor prevents a second subscriber from running', async () => {
    installConsoleRing();
    const reached: string[] = [];
    const unsubA = subscribeConsoleRing(() => {
      throw new Error('subscriber exploded');
    });
    const unsubB = subscribeConsoleRing(() => reached.push('b'));

    expect(() => console.log('probe')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(reached).toEqual(['b']);
    unsubA();
    unsubB();
  });

  it('a circular object does not throw', () => {
    installConsoleRing();
    const circular: Record<string, unknown> = { name: 'circular' };
    circular.self = circular;

    expect(() => console.log(circular)).not.toThrow();
    const entries = getConsoleRingEntries();
    expect(typeof entries[entries.length - 1].args[0]).toBe('string');
  });

  // Adversarial review of the F1 per-entry catch: `record()` used to do `seq: ++seq` as the FIRST
  // property of the entry literal, with `args: args.map(stringifyArg)` evaluated after — so a
  // stringify failure (a hostile getter, thrown mid-construction) still burned the seq before the
  // throw unwound the object literal and left nothing pushed to `pinned`/`tail`. That breaks the
  // contiguity invariant `getConsoleRingBootPrefixCount()`'s own doc comment asserts (an entry's
  // `seq` is in the pinned prefix iff `seq <= getConsoleRingBootPrefixCount()`), which both the
  // editor's and the in-game debug menu's gap-disclosure markers rely on to find the seam — a lost
  // seq shifts it one row early.
  it('a swallowed record (a hostile arg that throws while stringifying) does not consume a seq', () => {
    installConsoleRing();
    console.log('before');
    expect(getConsoleRingEntries().map((e) => e.seq)).toEqual([1]);

    // `isThenable`'s `.then` read sits OUTSIDE `stringifyArg`'s own try/catch (only the
    // `JSON.stringify` call is guarded) — a `.then` getter that itself throws escapes stringifyArg
    // entirely, and this file's console wrapper (`installConsoleRing`'s `try { record(...) } catch
    // {}`) is the only thing standing between that and an aborted console call.
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'then', {
      get() { throw new Error('then getter exploded'); },
    });
    expect(() => console.error(hostile)).not.toThrow();

    console.log('after');
    const entries = getConsoleRingEntries();
    // The hostile call recorded nothing at all — and, the point of this test, did not burn a seq:
    // 'after' is seq 2, immediately following 'before's seq 1, with no gap for the swallowed entry.
    expect(entries.map((e) => e.args[0])).toEqual(['before', 'after']);
    expect(entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  // Four consumers now project from this ONE buffer, so a live internal reference escaping to any
  // of them would let a stray mutation there corrupt what all the others (and /api/console-logs)
  // see. The no-argument branch used to return `pinned` itself whenever the tail was still empty.
  it('never hands out the live internal array — a caller mutating the result cannot corrupt the ring', () => {
    installConsoleRing();
    console.log('one');
    console.log('two');

    const first = getConsoleRingEntries();
    expect(first).toHaveLength(2);

    first.reverse();
    first.push({ seq: 999, mono: 0, level: 'log', args: ['injected'] });
    first.length = 0;

    const second = getConsoleRingEntries();
    expect(second).toHaveLength(2);
    expect(second.map((e) => e.args[0])).toEqual(['one', 'two']);
    expect(second).not.toBe(first);
  });

  // JSON.stringify returns undefined (NOT a string) for a function or a symbol, so this used to put
  // a non-string into args despite its string[] type — and the first consumer to call .slice() on
  // it would throw from inside a console wrapper.
  it('stringifies a function and a symbol to actual strings, not undefined', () => {
    installConsoleRing();
    console.log(function namedFn() {}, Symbol('tag'));

    const [entry] = getConsoleRingEntries();
    expect(entry.args).toHaveLength(2);
    for (const arg of entry.args) {
      expect(typeof arg).toBe('string');
      expect(arg).not.toBe('undefined');
      expect(() => arg.slice(0, 4)).not.toThrow();
    }
  });

  // ⚠️ These four are the gap that let a real regression through close-out review. The first draft
  // of `stringifyArg` returned `${name}: ${message}` for an Error — visible but useless, because the
  // stack is what says WHERE — and every test here covered strings, circulars, functions and
  // symbols, never an Error. All three captures this ring replaced returned `stack || message`;
  // `diagnose` reading `mesh load failed {}` off a device is the measured symptom (#157).
  it('an Error keeps its STACK, not just name and message', () => {
    installConsoleRing();
    const err = new Error('boom');
    console.error(err);

    const [entry] = getConsoleRingEntries();
    expect(entry.args[0]).toContain('boom');
    expect(entry.args[0]).toBe(err.stack || err.message);
    expect(entry.args[0].split('\n').length).toBeGreaterThan(1); // a stack, not a one-liner
  });

  // F3 (#626/#633 adversarial review): the editor's own `formatError` used to add this, but
  // nothing called it any more — `getEditorLogs()` (and every other projection) reads THIS
  // module's `stringifyArg`, which is `stack || message` alone and drops `cause` entirely. Moved
  // here so every consumer (editor, in-game debug menu, agent bridge, device bridge) gains it.
  it('an Error keeps its STACK *and* its cause chain', () => {
    installConsoleRing();
    const err = new Error('outer', { cause: new RangeError('inner') });
    console.error(err);

    const [entry] = getConsoleRingEntries();
    expect(entry.args[0]).toContain(err.stack || err.message); // the head is still the full stack
    expect(entry.args[0]).toContain('caused by: RangeError: inner');
  });

  it('the cause chain is depth-capped so a cyclic/pathological `cause` cannot grow an entry without bound', () => {
    installConsoleRing();
    // A chain far past the cap — each link is a real Error, distinct so a leak past the cap is
    // visible in the assertion rather than accidentally matching a shorter one.
    let err = new Error('link-0');
    for (let i = 1; i <= 10; i++) err = new Error(`link-${i}`, { cause: err });
    console.error(err);

    const [entry] = getConsoleRingEntries();
    const causedByCount = entry.args[0].split('caused by:').length - 1;
    expect(causedByCount).toBe(4); // the cap, exactly — not "however deep the chain goes"
    // The deepest links must not have leaked past the cap.
    expect(entry.args[0]).not.toContain('link-0');
    expect(entry.args[0]).not.toContain('link-5');
  });

  it('an Error NESTED in an object keeps its stack too', () => {
    installConsoleRing();
    const inner = new Error('inner boom');
    console.error('scene load failed', { cause: inner });

    const [entry] = getConsoleRingEntries();
    expect(entry.args[1]).toContain('inner boom');
    expect(entry.args[1]).not.toBe('{"cause":{}}');
    expect(entry.args[1]).toContain('at '); // the nested stack survived the replacer
  });

  // F8 (adversarial review of the F3 fix): F3 only extended the TOP-LEVEL `v instanceof Error`
  // branch above — the module's own doc comment claims both shapes are "handled at BOTH depths",
  // but the nested replacer still returned `stack || message` alone, so an Error NESTED in an
  // object or array (`console.error('ctx', { err })`, `console.error([err])` — exactly how a
  // rejection value arrives) lost its cause chain while the top-level shape kept it. Pins both
  // named shapes.
  it('an Error NESTED in an object or array keeps its OWN cause chain too', () => {
    installConsoleRing();
    const err = new Error('outer', { cause: new RangeError('inner') });
    console.error('ctx', { err });
    console.error([err]);

    const entries = getConsoleRingEntries();
    expect(entries[0].args[1]).toContain('caused by: RangeError: inner');
    expect(entries[1].args[0]).toContain('caused by: RangeError: inner');
  });

  it('a pending promise is marked, not serialised to {}', () => {
    installConsoleRing();
    console.log('result', Promise.resolve(1));

    const [entry] = getConsoleRingEntries();
    expect(entry.args[1]).toBe('[unresolved Promise — did you forget `await`?]');
  });

  // `pinned` fills to `bootPrefix` regardless of `capacity`, so a bootPrefix larger than capacity
  // used to let the ring grow without bound — 50 logs retained under {capacity:10}.
  it('a bootPrefix larger than capacity cannot make the ring exceed capacity', () => {
    installConsoleRing({ capacity: 10, bootPrefix: 128 });
    for (let i = 0; i < 50; i++) console.log(`line ${i}`);

    expect(getConsoleRingEntries().length).toBeLessThanOrEqual(10);
  });

  it('__resetConsoleRingForTest restores the real console methods', () => {
    const originalLog = console.log;
    installConsoleRing();
    expect(console.log).not.toBe(originalLog);
    __resetConsoleRingForTest();
    expect(console.log).toBe(originalLog);
    expect(isConsoleRingInstalled()).toBe(false);
  });

  // #626: opt-in call-site capture, folding the editor Console panel's own capture into this ring.
  describe('retainCallSite (#626)', () => {
    it('defaults OFF: a warn entry has no stack', () => {
      installConsoleRing();
      console.warn('careful');

      const [entry] = getConsoleRingEntries();
      expect(entry.stack).toBeUndefined();
    });

    it('with retainCallSite: true, warn and error entries expose a non-empty stack; log and info do not', () => {
      installConsoleRing({ retainCallSite: true });
      console.log('plain');
      console.info('fyi');
      console.warn('careful');
      console.error('boom');

      const [logE, infoE, warnE, errE] = getConsoleRingEntries();
      expect(logE.stack).toBeUndefined();
      expect(infoE.stack).toBeUndefined();
      expect(warnE.stack).toBeTruthy();
      expect(errE.stack).toBeTruthy();
      // The captured call site, not the "Error" header — slice(3) must have dropped the internal
      // frames (record, the console wrapper).
      expect(warnE.stack).not.toMatch(/^Error/);
    });

    it('the stack getter is LAZY and MEMOIZED: reading it twice returns the identical string', () => {
      installConsoleRing({ retainCallSite: true });
      console.error('boom');

      const [entry] = getConsoleRingEntries();
      const descriptor = Object.getOwnPropertyDescriptor(entry, 'stack');
      expect(descriptor?.get, 'stack must be backed by a getter, not a plain value, to stay lazy').toBeTypeOf('function');

      const first = entry.stack;
      const second = entry.stack;
      expect(first).toBeTruthy();
      expect(second).toBe(first); // memoized — same string instance, not recomputed
    });

    it('a REPLAYED entry (the #633 shim drain) gets NO stack, even with retainCallSite: true', () => {
      // A real mono timestamp, as the actual shim always supplies (engine/index.html's inline
      // capture calls `now()` unconditionally).
      seedEarlyConsole({ entries: [['warn', ['early-warn'], 11], ['error', ['early-error'], 22]] });
      installConsoleRing({ retainCallSite: true });

      const entries = getConsoleRingEntries();
      const warnE = entries.find((e) => e.args[0] === 'early-warn')!;
      const errE = entries.find((e) => e.args[0] === 'early-error')!;
      expect(warnE.stack).toBeUndefined();
      expect(errE.stack).toBeUndefined();

      // A LIVE warn/error recorded after the drain still gets one — the skip is specific to
      // replayed entries, not a side effect of the drain disabling capture altogether.
      console.warn('live-warn');
      const liveE = getConsoleRingEntries().find((e) => e.args[0] === 'live-warn')!;
      expect(liveE.stack).toBeTruthy();
    });

    it('a replayed entry with NO usable timestamp is still recognised as a replay (no stack)', () => {
      // Regression pin. Replay used to be inferred from "a timestamp was passed", but the drain
      // deliberately passes none when the shim's payload is missing or non-finite (it is untrusted
      // plain JS from HTML). Under that inference exactly those entries — the defensive path — got a
      // call-site stack pointing at the drain loop rather than at any real caller. `record()` now
      // keys on the replay marker being PASSED, not on its contents.
      seedEarlyConsole({ entries: [['warn', ['no-ts-warn']], ['error', ['bad-ts-error'], Number.NaN]] });
      installConsoleRing({ retainCallSite: true });

      const entries = getConsoleRingEntries();
      expect(entries.find((e) => e.args[0] === 'no-ts-warn')!.stack).toBeUndefined();
      expect(entries.find((e) => e.args[0] === 'bad-ts-error')!.stack).toBeUndefined();
    });

    it('__resetConsoleRingForTest clears retainCallSite back to false', () => {
      installConsoleRing({ retainCallSite: true });
      console.warn('careful');
      expect(getConsoleRingEntries()[0].stack).toBeTruthy();

      __resetConsoleRingForTest();
      installConsoleRing(); // no options — retainCallSite must be back to its default
      console.warn('careful again');
      expect(getConsoleRingEntries()[0].stack).toBeUndefined();
    });
  });

  // #633: the inline early-capture shim in engine/index.html buffers console calls made before
  // this module can patch console.* in a bundled build. installConsoleRing() must drain it.
  describe('early-console shim drain (#633)', () => {

  it('a hostile buffered arg cannot throw out of installConsoleRing() — that would abort boot', () => {
    // `args` are LIVE references the shim captured from arbitrary pre-install code, and
    // `stringifyArg` has throwing paths. `installConsoleRing()` is reached from main.tsx through a
    // STATIC side-effect import, so an escaping throw does not lose a line — it aborts the entry
    // module and React never mounts. Measured: a null-prototype self-referencing object threw
    // `TypeError: Cannot convert object to primitive value` before the per-entry guard.
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.self = hostile;
    seedEarlyConsole({
      entries: [
        ['log', ['before', hostile], 1],
        ['warn', ['after-the-hostile-one'], 2],
      ],
    });

    expect(() => installConsoleRing()).not.toThrow();
    // and the guard is PER ENTRY, so the good line after it still lands
    const entries = getConsoleRingEntries();
    expect(entries.some(e => e.args.includes('after-the-hostile-one'))).toBe(true);
  });

  it('preserves each drained line\'s ORIGINAL timestamp, not the drain moment', () => {
    // The shim stamps `performance.now()` at CALL time and hands it over. Without that, every
    // buffered boot line would carry the drain instant and the boot-timing table this ring exists
    // to produce (#591's nav+ms figures) would be uniformly wrong while looking plausible.
    seedEarlyConsole({
      entries: [
        ['info', ['early-a'], 11],
        ['warn', ['early-b'], 22],
      ],
    });
    installConsoleRing();
    const entries = getConsoleRingEntries();
    expect(entries.map(e => e.mono)).toEqual([11, 22]);
  });

  it('falls back to the ring clock when the shim supplied no (or a non-finite) timestamp', () => {
    seedEarlyConsole({
      entries: [
        ['info', ['no-ts']],
        ['warn', ['bad-ts'], Number.NaN],
      ],
    });
    installConsoleRing();
    const entries = getConsoleRingEntries();
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(Number.isFinite(e.mono)).toBe(true);
    expect(entries.every(e => !Number.isNaN(e.mono))).toBe(true);
  });
    it('drains a pre-seeded early buffer into the ring, preserving order and level', () => {
      seedEarlyConsole({ entries: [['log', ['boot-1']], ['warn', ['boot-2']], ['error', ['boot-3']]] });
      installConsoleRing();

      const entries = getConsoleRingEntries();
      expect(entries.map((e) => [e.level, e.args])).toEqual([
        ['log', ['boot-1']],
        ['warn', ['boot-2']],
        ['error', ['boot-3']],
      ]);
    });

    it('drained entries have a LOWER seq than a console.log made after install', () => {
      seedEarlyConsole({ entries: [['log', ['before-install']]] });
      installConsoleRing();
      console.log('after-install');

      const entries = getConsoleRingEntries();
      const drained = entries.find((e) => e.args[0] === 'before-install')!;
      const after = entries.find((e) => e.args[0] === 'after-install')!;
      expect(drained.seq).toBeLessThan(after.seq);
    });

    it('sets done = true and empties entries', () => {
      const early = seedEarlyConsole({ entries: [['log', ['x']]] });
      installConsoleRing();

      expect(early.done).toBe(true);
      expect(early.entries).toEqual([]);
    });

    it('does NOT reassign console.log/info/warn/error — the nesting-safety pin', () => {
      seedEarlyConsole({ entries: [['log', ['before']]] });
      // A sentinel wrapper installed AFTER the shim seeds state but BEFORE installConsoleRing() —
      // modelling installGlobalErrorHandlers wrapping AROUND the shim, which is already in place
      // by drain time in the real boot sequence. If drainEarlyConsole ever "unwrapped" the shim by
      // reassigning console.warn back to some captured original, this sentinel would be dropped
      // from the chain and never run again.
      const originalWarn = console.warn;
      let sentinelRan = false;
      const sentinel = (...args: unknown[]) => {
        sentinelRan = true;
        originalWarn.apply(console, args);
      };
      console.warn = sentinel;

      try {
        installConsoleRing();
        // installConsoleRing wraps ITS OWN patch around whatever console.warn currently is — so
        // the live console.warn is neither the pristine original nor the bare sentinel, but a call
        // through it must still reach the sentinel underneath.
        expect(console.warn).not.toBe(originalWarn);
        expect(console.warn).not.toBe(sentinel);
        console.warn('probe');
        expect(sentinelRan).toBe(true); // still in the chain, not clobbered
      } finally {
        __resetConsoleRingForTest();
        console.warn = originalWarn;
      }
    });

    it('a dropped > 0 count surfaces one warn entry', () => {
      seedEarlyConsole({ entries: [['log', ['x']]], dropped: 3 });
      installConsoleRing();

      const warnEntries = getConsoleRingEntries().filter((e) => e.level === 'warn');
      expect(warnEntries).toHaveLength(1);
      expect(warnEntries[0].args[0]).toContain('3');
      expect(warnEntries[0].args[0]).toContain('[console-ring]');
    });

    it('a second installConsoleRing() does not double-drain', () => {
      seedEarlyConsole({ entries: [['log', ['once']]] });
      installConsoleRing();
      installConsoleRing();

      const matches = getConsoleRingEntries().filter((e) => e.args[0] === 'once');
      expect(matches).toHaveLength(1);
    });

    it('an unknown level in the early buffer folds to "log" rather than throwing', () => {
      seedEarlyConsole({ entries: [['trace', ['mystery']]] });
      expect(() => installConsoleRing()).not.toThrow();

      const entry = getConsoleRingEntries().find((e) => e.args[0] === 'mystery');
      expect(entry?.level).toBe('log');
    });
  });
});
