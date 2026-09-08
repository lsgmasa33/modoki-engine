/** clock.ts — the injectable wall-clock seam for the verification harness
 *  (determinism-harness Missing Test #4). Production reads performance.now();
 *  a manual clock pins/advances time so a headless run is reproducible. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  rawNow, setManualNow, advanceManual, isManualClock, restoreRealClock,
  rawEpochNow, setManualEpoch, isManualEpoch, restoreRealEpoch,
} from '../../src/runtime/core/clock';

// Both overrides, every time — `restoreRealClock()` and `restoreRealEpoch()` are separate
// teardowns for separate clocks; a test file leaving either pinned would leak into a LATER test in
// this same file (module state, not per-test).
afterEach(() => { restoreRealClock(); restoreRealEpoch(); });

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

describe('rawEpochNow', () => {
  it('returns a plausible real epoch by default (no manual epoch installed)', () => {
    const a = rawEpochNow();
    expect(typeof a).toBe('number');
    expect(a).toBeGreaterThan(1_700_000_000_000); // 2023-11-14 — well before "now", any real clock
  });

  it('setManualEpoch pins rawEpochNow to an exact value', () => {
    setManualEpoch(1_800_000_000_000);
    expect(rawEpochNow()).toBe(1_800_000_000_000);
    expect(rawEpochNow()).toBe(1_800_000_000_000); // stable across calls
  });

  // The unit-conflation bug this design guards against: `_manualNow` (monotonic ms since load) and
  // `_manualEpoch` (wall-clock epoch) are different units with different origins, and reusing one
  // for the other would make an epoch stamp read as ~56 years old the moment a test pins the other
  // clock at 0. Each override must leave the OTHER reading untouched.
  it('setManualNow and setManualEpoch are isolated from each other', () => {
    setManualNow(0);
    expect(rawEpochNow()).toBeGreaterThan(1_700_000_000_000); // untouched by the monotonic pin

    restoreRealClock();
    setManualEpoch(0);
    expect(rawNow()).not.toBe(0); // untouched by the epoch pin — still the real performance.now()
  });

  // The epoch/monotonic split: `restoreRealClock()` used to clear BOTH overrides, which meant
  // `stepSimulation`'s (and `createTestWorld.dispose()`'s) unconditional call to it silently wiped
  // out a manually-pinned epoch nobody asked either of them to touch. Each override now has its
  // OWN teardown.
  it('restoreRealClock clears only the manual now, leaving a pinned manual epoch untouched', () => {
    setManualNow(999);
    setManualEpoch(1_800_000_000_000);
    restoreRealClock();
    expect(isManualClock()).toBe(false);
    expect(rawNow()).not.toBe(999);
    expect(rawEpochNow()).toBe(1_800_000_000_000); // untouched — restoreRealEpoch() is its own call
    restoreRealEpoch();
    expect(rawEpochNow()).not.toBe(1_800_000_000_000);
  });

  it('restoreRealEpoch clears only the manual epoch, leaving a pinned manual now untouched', () => {
    setManualNow(999);
    setManualEpoch(1_800_000_000_000);
    restoreRealEpoch();
    expect(isManualEpoch()).toBe(false);
    expect(rawEpochNow()).not.toBe(1_800_000_000_000);
    expect(isManualClock()).toBe(true);
    expect(rawNow()).toBe(999); // untouched — restoreRealClock() is its own call
  });

  it('isManualEpoch mirrors isManualClock for the epoch override, independently of it', () => {
    expect(isManualEpoch()).toBe(false);
    setManualEpoch(1_800_000_000_000);
    expect(isManualEpoch()).toBe(true);
    expect(isManualClock()).toBe(false); // the monotonic override is untouched
    restoreRealEpoch();
    expect(isManualEpoch()).toBe(false);
  });
});
