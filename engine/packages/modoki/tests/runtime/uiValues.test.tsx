/** uiValues — the game-bindable UI store (setUIValues / setUIValue / clearUIValues + its
 *  useSyncExternalStore hook). Verifies merge, single-set, clear, reactivity (subscribers
 *  re-render), and the no-op-on-unchanged fast path (stable snapshot ref → no re-render). */
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { setUIValues, setUIValue, clearUIValues, useGameUIValues } from '../../src/runtime/ui/uiValues';
import { getStoreHooks } from '../../src/runtime/ui/storeHooks';

afterEach(() => { cleanup(); clearUIValues(); });   // reset the module singleton between tests

describe('uiValues', () => {
  it('registers its hook with the UIRenderer store-hook registry (binding seam)', () => {
    // If this import side-effect were tree-shaken/removed, every game text/visibility binding would
    // silently stop resolving game values — assert the registration happened.
    expect(getStoreHooks()).toContain(useGameUIValues);
  });

  it('starts empty and merges published values, re-rendering subscribers', () => {
    const { result } = renderHook(() => useGameUIValues());
    expect(result.current).toEqual({});

    act(() => setUIValues({ hearts: 3, gameOver: false }));
    expect(result.current).toEqual({ hearts: 3, gameOver: false });

    act(() => setUIValues({ enemies: 2 }));                  // MERGE, not replace
    expect(result.current).toEqual({ hearts: 3, gameOver: false, enemies: 2 });
  });

  it('setUIValue sets a single key; clearUIValues resets to empty', () => {
    const { result } = renderHook(() => useGameUIValues());
    act(() => setUIValue('resultText', 'You Win!'));
    expect(result.current.resultText).toBe('You Win!');
    act(() => clearUIValues());
    expect(result.current).toEqual({});
  });

  it('no-op when nothing changed — same snapshot object (no re-render)', () => {
    const { result } = renderHook(() => useGameUIValues());
    act(() => setUIValues({ hearts: 3 }));
    const ref1 = result.current;
    act(() => setUIValues({ hearts: 3 }));                   // identical → early-out
    expect(result.current).toBe(ref1);                       // same reference, no new object
    act(() => setUIValue('hearts', 3));                      // identical single set → early-out
    expect(result.current).toBe(ref1);
  });

  it('a changed value produces a NEW snapshot object (triggers re-render)', () => {
    const { result } = renderHook(() => useGameUIValues());
    act(() => setUIValues({ hearts: 3 }));
    const ref1 = result.current;
    act(() => setUIValues({ hearts: 2 }));                   // changed
    expect(result.current).not.toBe(ref1);
    expect(result.current.hearts).toBe(2);
  });

  it('clearUIValues on an already-empty store is a no-op (stable ref)', () => {
    const { result } = renderHook(() => useGameUIValues());
    const empty = result.current;
    act(() => clearUIValues());
    expect(result.current).toBe(empty);
  });
});
