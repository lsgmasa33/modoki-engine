import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyListeners } from '../../../src/runtime/core/notifyListeners';

afterEach(() => { vi.restoreAllMocks(); });

describe('notifyListeners', () => {
  it('fires every listener with the args — the positive case, so the rest are not vacuous', () => {
    // Without this, a helper that silently fired NOTHING would satisfy every assertion below
    // about a throwing listener not stopping the others.
    const seen: Array<[number, string]> = [];
    const listeners = new Set([
      (n: number, s: string) => { seen.push([n, s]); },
      (n: number, s: string) => { seen.push([n * 2, s]); },
    ]);
    notifyListeners(listeners, 'test', [7, 'x']);
    expect(seen).toEqual([[7, 'x'], [14, 'x']]);
  });

  it('a throwing listener does not starve the listeners AFTER it', () => {
    // This is the whole mechanism (#888): the loop is not resumable and nothing retries it, so a
    // listener that escapes takes out every subscriber behind it in Set iteration order.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const order: string[] = [];
    const listeners = new Set<() => void>([
      () => { order.push('before'); },
      () => { order.push('thrower'); throw new Error('boom'); },
      () => { order.push('after'); },
    ]);
    notifyListeners(listeners, 'test', []);
    expect(order).toEqual(['before', 'thrower', 'after']);
  });

  it('does not propagate the throw to the publisher — its tail still runs', () => {
    // The consequence that made #888 dangerous was not the missed notification but the aborted
    // CALLER: `setCurrentWorld`'s throw skipped `SceneManager`'s ownership latches.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let tailRan = false;
    const publish = (): void => {
      notifyListeners(new Set([() => { throw new Error('boom'); }]), 'test', []);
      tailRan = true;
    };
    expect(() => publish()).not.toThrow();
    expect(tailRan).toBe(true);
  });

  it('reports each throw through console.error, naming the publisher', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('boom');
    notifyListeners(new Set([() => { throw err; }]), 'worldRegistry', []);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('[worldRegistry]');
    expect(spy.mock.calls[0]?.[1]).toBe(err);
  });

  it('reports EVERY throw, not just the first — two bad listeners are two defects', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notifyListeners(new Set([
      () => { throw new Error('a'); },
      () => { throw new Error('b'); },
    ]), 'test', []);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('uses a caller-supplied report INSTEAD of console.error', () => {
    // `consoleRing`/`consoleCapture` fire from inside the console patch, so reaching `console.error`
    // there re-enters the flush and spends a Crashlytics issue on internal bookkeeping.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reported: Array<[string, unknown]> = [];
    const err = new Error('boom');
    notifyListeners(
      new Set([() => { throw err; }]),
      'consoleRing',
      [],
      (label, e) => { reported.push([label, e]); },
    );
    expect(reported).toEqual([['consoleRing', err]]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('hands the report the listener that THREW as its third argument, not a neighbour (#953)', () => {
    // `lateUpdate` names the failing system by mapping this back to its registry key. Threaded
    // between two healthy listeners so an off-by-one (the previous or next listener) cannot pass.
    const err = new Error('boom');
    const good = (): void => {};
    const bad = (): void => { throw err; };
    const reported: unknown[][] = [];
    notifyListeners([good, bad, good], 'pub', [], (...a) => { reported.push(a); });
    expect(reported).toEqual([['pub', err, bad]]);
  });

  it('a report that itself throws does not reintroduce the defect', () => {
    // `report` is caller-supplied, so it is exactly as untrusted as the listeners are.
    const order: string[] = [];
    const listeners = new Set<() => void>([
      () => { throw new Error('boom'); },
      () => { order.push('after'); },
    ]);
    expect(() => notifyListeners(listeners, 'test', [], () => { throw new Error('reporter'); }))
      .not.toThrow();
    expect(order).toEqual(['after']);
  });

  it('an empty set is a no-op and reports nothing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => notifyListeners(new Set<() => void>(), 'test', [])).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
