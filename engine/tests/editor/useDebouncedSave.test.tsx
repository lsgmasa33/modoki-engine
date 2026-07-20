/** useDebouncedSave — the timing-sensitive auto-save logic extracted from the Particle
 *  Editor (jsdom + @testing-library renderHook + fake timers). Locks down the contract:
 *  trailing debounce, coalescing rapid edits to the latest value, no rewrite-on-open
 *  (markSaved), success marks saved, and unmount cancels a pending write. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDebouncedSave } from '@modoki/engine/editor';

const DELAY = 400;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Render the hook over a changeable value. `write` defaults to a success stub. */
function setup<T>(write: (v: T) => Promise<boolean> = async () => true) {
  const fn = vi.fn(write);
  const view = renderHook(({ v }: { v: T | null }) => useDebouncedSave(v, fn, DELAY), {
    initialProps: { v: null as T | null },
  });
  return { fn, ...view };
}

describe('useDebouncedSave', () => {
  it('writes the value once, only after the debounce delay elapses', () => {
    const { fn, rerender } = setup<{ id: string }>();
    const a = { id: 'a' };
    rerender({ v: a });

    vi.advanceTimersByTime(DELAY - 1);
    expect(fn).not.toHaveBeenCalled(); // still within the debounce window
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(a);
  });

  it('coalesces a burst of rapid edits into a single write of the latest value', () => {
    const { fn, rerender } = setup<{ id: string }>();
    rerender({ v: { id: 'a' } });
    vi.advanceTimersByTime(100);
    rerender({ v: { id: 'b' } });
    vi.advanceTimersByTime(100);
    const c = { id: 'c' };
    rerender({ v: c }); // each edit resets the timer

    vi.advanceTimersByTime(DELAY);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(c);
  });

  it('does not write a value that was marked saved (no rewrite-on-open)', () => {
    const { fn, result, rerender } = setup<{ id: string }>();
    const loaded = { id: 'loaded' };
    // Seed the just-loaded reference as in-sync *before* it becomes the value.
    result.current.markSaved(loaded);
    rerender({ v: loaded });

    vi.advanceTimersByTime(DELAY);
    expect(fn).not.toHaveBeenCalled();
  });

  it('writes again once the value diverges from the marked-saved reference', () => {
    const { fn, result, rerender } = setup<{ id: string }>();
    const loaded = { id: 'loaded' };
    result.current.markSaved(loaded);
    rerender({ v: loaded });
    vi.advanceTimersByTime(DELAY);
    expect(fn).not.toHaveBeenCalled();

    const edited = { id: 'edited' }; // a real edit → new reference
    rerender({ v: edited });
    vi.advanceTimersByTime(DELAY);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(edited);
  });

  it('marks the value saved on a successful write so it is not re-written', async () => {
    const { fn, rerender } = setup<{ id: string }>();
    const a = { id: 'a' };
    rerender({ v: a });
    await vi.advanceTimersByTimeAsync(DELAY); // fire timer AND flush the write promise
    expect(fn).toHaveBeenCalledTimes(1);

    // Re-rendering with the same (now-saved) reference must not write again.
    rerender({ v: a });
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending write when unmounted before the delay', () => {
    const { fn, rerender, unmount } = setup<{ id: string }>();
    rerender({ v: { id: 'a' } });
    vi.advanceTimersByTime(DELAY - 50);
    unmount();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it('never schedules a write for a null value', () => {
    const { fn } = setup<{ id: string }>();
    vi.advanceTimersByTime(DELAY * 2);
    expect(fn).not.toHaveBeenCalled();
  });
});
