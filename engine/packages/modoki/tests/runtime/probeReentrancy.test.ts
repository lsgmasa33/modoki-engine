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
  isProbeInFlight, withProbeInFlight, resetProbeInFlightForTest, shareTierResolution,
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

describe('concurrent first calls share ONE resolution', () => {
  it('runs the work once when two surfaces ask in the same tick', async () => {
    // The real scenario: two 3D surfaces creating a renderer on a cold start. Both clear every
    // early-out (no tier yet, `probing` still false) because the probe is awaited, so without
    // coalescing both would run a launch-blocking probe — and, since the verdict now refines
    // across launches, both would read the same prior samples and the second write would discard
    // the first's reading. Two probes paid, one sample banked.
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const work = () => { runs += 1; return gate; };

    const a = shareTierResolution(work);
    const b = shareTierResolution(work);
    expect(runs).toBe(1);
    expect(b).toBe(a);          // the SAME promise, so the second caller waits rather than re-runs
    release();
    await Promise.all([a, b]);
  });

  it('lets a LATER call run again once the first has settled', async () => {
    // Not a cache: it coalesces what is in flight. A second launch (or a retry after a failure)
    // must be able to probe again, or a device could never refine its verdict at all.
    let runs = 0;
    const work = () => { runs += 1; return Promise.resolve(); };
    await shareTierResolution(work);
    await shareTierResolution(work);
    expect(runs).toBe(2);
  });

  it('does not wedge on a rejected resolution', async () => {
    // A settled-rejected promise left in the slot would make every later surface await a failure
    // forever — the same class as a stuck `probing` flag, and just as silent.
    const boom = () => Promise.reject(new Error('probe blew up'));
    await expect(shareTierResolution(boom)).rejects.toThrow('probe blew up');
    let ran = false;
    await shareTierResolution(() => { ran = true; return Promise.resolve(); });
    expect(ran).toBe(true);
  });
});

describe('the in-flight guard survives overlapping probes', () => {
  it('stays raised until the LAST overlapping probe finishes', async () => {
    // It was a bare boolean, so the first probe to finish cleared it while a second was still
    // running — reopening the unbounded-recursion window mid-probe, with a renderer already under
    // construction inside it. `shareTierResolution` makes overlap unreachable through the one
    // caller today; this guard must not depend on the caller staying correct, because depending on
    // that is what killed an iPhone 13 mini's tab the first time.
    let releaseA!: () => void;
    let releaseB!: () => void;
    const a = withProbeInFlight(() => new Promise<void>((r) => { releaseA = r; }));
    const b = withProbeInFlight(() => new Promise<void>((r) => { releaseB = r; }));
    expect(isProbeInFlight()).toBe(true);
    releaseA();
    await a;
    expect(isProbeInFlight()).toBe(true);   // B is still probing
    releaseB();
    await b;
    expect(isProbeInFlight()).toBe(false);
  });

  it('a throwing probe still decrements — one failure must not disable probing forever', async () => {
    await expect(withProbeInFlight(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(isProbeInFlight()).toBe(false);
  });
});

describe('resetProbeInFlightForTest scopes to a generation', () => {
  it('a probe parked across the reset does not decrement the NEXT session\'s count', async () => {
    // The bug: resetProbeInFlightForTest() sets probing = 0, but a probe from before the reset is
    // still awaiting. When it resumes, its `finally` fires — and an ungenerationed guard would
    // decrement the counter belonging to a probe that started AFTER the reset, dropping it to 0
    // (or, unguarded, to -1) while that later probe is still running.
    let releaseFirst!: () => void;
    const first = withProbeInFlight(() => new Promise<void>((r) => { releaseFirst = r; }));
    expect(isProbeInFlight()).toBe(true);

    resetProbeInFlightForTest();

    let releaseSecond!: () => void;
    const second = withProbeInFlight(() => new Promise<void>((r) => { releaseSecond = r; }));
    expect(isProbeInFlight()).toBe(true);

    // Resolve the FIRST (pre-reset) probe and let its stale `finally` run.
    releaseFirst();
    await first;
    // The whole point: the second session's in-flight probe must not have been touched.
    expect(isProbeInFlight()).toBe(true);

    releaseSecond();
    await second;
    expect(isProbeInFlight()).toBe(false);
  });

  it('does not leave the counter negative — a reset while parked, then a fresh probe still reports in-flight', async () => {
    let releaseFirst!: () => void;
    const first = withProbeInFlight(() => new Promise<void>((r) => { releaseFirst = r; }));
    resetProbeInFlightForTest();
    releaseFirst();
    await first;

    let sawInside = false;
    await withProbeInFlight(async () => { sawInside = isProbeInFlight(); });
    expect(sawInside).toBe(true);
    expect(isProbeInFlight()).toBe(false);
  });
});
