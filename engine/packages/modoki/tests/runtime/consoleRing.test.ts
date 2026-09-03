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
});

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

  it('an Error NESTED in an object keeps its stack too', () => {
    installConsoleRing();
    const inner = new Error('inner boom');
    console.error('scene load failed', { cause: inner });

    const [entry] = getConsoleRingEntries();
    expect(entry.args[1]).toContain('inner boom');
    expect(entry.args[1]).not.toBe('{"cause":{}}');
    expect(entry.args[1]).toContain('at '); // the nested stack survived the replacer
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
});
