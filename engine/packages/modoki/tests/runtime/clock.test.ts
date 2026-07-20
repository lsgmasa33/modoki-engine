/** clock.ts — the injectable wall-clock seam for the verification harness
 *  (determinism-harness Missing Test #4). Production reads performance.now();
 *  a manual clock pins/advances time so a headless run is reproducible. */

import { describe, it, expect, afterEach } from 'vitest';
import { rawNow, setManualNow, advanceManual, isManualClock, restoreRealClock } from '../../src/runtime/systems/clock';

afterEach(() => restoreRealClock());

describe('clock', () => {
  it('rawNow returns the real clock by default (no manual installed)', () => {
    expect(isManualClock()).toBe(false);
    const a = rawNow();
    expect(typeof a).toBe('number');
    expect(a).toBeGreaterThanOrEqual(0);
  });

  it('setManualNow pins rawNow to an exact value', () => {
    setManualNow(1234);
    expect(isManualClock()).toBe(true);
    expect(rawNow()).toBe(1234);
    expect(rawNow()).toBe(1234); // stable across calls (no real-clock drift)
  });

  it('advanceManual steps the manual clock by an exact delta', () => {
    setManualNow(100);
    advanceManual(16);
    expect(rawNow()).toBe(116);
    advanceManual(16);
    expect(rawNow()).toBe(132);
  });

  it('advanceManual installs the manual clock at 0 first when none is active', () => {
    expect(isManualClock()).toBe(false);
    advanceManual(50);
    expect(isManualClock()).toBe(true);
    expect(rawNow()).toBe(50); // 0 + 50
  });

  it('restoreRealClock clears the manual clock and isManualClock transitions back', () => {
    setManualNow(999);
    expect(isManualClock()).toBe(true);
    restoreRealClock();
    expect(isManualClock()).toBe(false);
    expect(rawNow()).not.toBe(999); // back on the real clock
  });

  it('manual now of 0 is still a manual clock (null vs 0 distinction)', () => {
    setManualNow(0);
    expect(isManualClock()).toBe(true); // 0 ≠ null — pinned at the origin
    expect(rawNow()).toBe(0);
  });
});
