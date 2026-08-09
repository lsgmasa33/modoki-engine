/** Re-entrancy guard for the boot ramp probe (#188).
 *
 *  These tests exist because of a real crash: the probe builds a renderer, renderer construction
 *  resolves the quality tier, and tier resolution is what launches the probe. Unbounded recursion,
 *  one renderer per level, tab killed in ~80 ms on an iPhone 13 mini.
 *
 *  ⚠️ The reason it survived review AND every automated check: a DESKTOP resolves `'desktop'` and
 *  never reaches the probe branch, so the Mac, the editor and headless Chromium all ran it
 *  hundreds of times without recursing. The bug is reachable only on `formFactor: 'mobile'`. So
 *  the last test below models the recursive call structure directly rather than trusting an
 *  environment to expose it — a test that only fails on a phone is not a test.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  isProbeInFlight, withProbeInFlight, resetProbeInFlightForTest,
} from '../../src/runtime/rendering/probeReentrancy';

afterEach(() => resetProbeInFlightForTest());

describe('probe re-entrancy guard', () => {
  it('is off until a probe runs', () => {
    expect(isProbeInFlight()).toBe(false);
  });

  it('is on for the duration of the probe, and off after', async () => {
    let sawInside = false;
    await withProbeInFlight(async () => { sawInside = isProbeInFlight(); });
    expect(sawInside).toBe(true);
    expect(isProbeInFlight()).toBe(false);
  });

  it('clears the flag when the probe THROWS', async () => {
    // A failed probe must never block rendering, so throwing is an expected path. A flag left
    // stuck `true` would permanently disable probing for the process — a silent, once-per-install
    // failure nothing would report.
    await expect(withProbeInFlight(async () => { throw new Error('probe blew up'); }))
      .rejects.toThrow('probe blew up');
    expect(isProbeInFlight()).toBe(false);
  });

  it('returns the probe\'s value untouched', async () => {
    await expect(withProbeInFlight(async () => 42)).resolves.toBe(42);
  });

  it('STOPS THE RECURSION THAT KILLED A PHONE', async () => {
    // Models the real call structure: creating a renderer resolves the tier, and resolving the
    // tier runs the probe, which creates a renderer. Without the guard this recurses without
    // bound; with it, the nested resolution returns immediately and exactly one probe runs.
    let renderersCreated = 0;
    let probesStarted = 0;

    async function makeRenderer(): Promise<void> {
      renderersCreated++;
      if (renderersCreated > 20) throw new Error('runaway recursion');
      await resolveTier();
    }
    async function resolveTier(): Promise<void> {
      if (isProbeInFlight()) return; // the guard under test
      probesStarted++;
      await withProbeInFlight(async () => { await makeRenderer(); });
    }

    await resolveTier();
    expect(probesStarted).toBe(1);
    expect(renderersCreated).toBe(1);
  });

  it('the same structure WITHOUT the guard runs away — proving the test has teeth', async () => {
    // Mutation check, inline: drop the one line and the recursion returns. Without this, the test
    // above would keep passing if the guard were deleted from the call site.
    let renderersCreated = 0;
    async function makeRenderer(): Promise<void> {
      renderersCreated++;
      if (renderersCreated > 20) throw new Error('runaway recursion');
      await resolveTierUnguarded();
    }
    async function resolveTierUnguarded(): Promise<void> {
      await withProbeInFlight(async () => { await makeRenderer(); });
    }
    await expect(resolveTierUnguarded()).rejects.toThrow('runaway recursion');
  });
});
