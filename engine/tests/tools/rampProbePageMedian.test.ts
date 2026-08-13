/** `engine/tools/ramp-probe-page/main.ts` — the standalone measurement page's headline (#205
 *  R5.4). Covers only `medianMeasurement`, the one piece of logic in that file; everything else
 *  is DOM wiring for a human tapping a phone screen.
 *
 *  Lives under `engine/tests/tools/` rather than the `packages/modoki` suite: `main.ts` sits
 *  outside `packages/modoki`'s `rootDir`, so importing it from a test under that package's own
 *  tsconfig fails `npm run typecheck` (TS6059) even though vitest itself resolves it fine — the
 *  root suite's tsconfig has no such boundary.
 *
 *  This file is NOT part of any built app — it is imported directly, which means running its
 *  module-level DOM lookups (`$('device')`, etc.) for real, so the test stands up the handful of
 *  elements `index.html` provides before importing it. `__BUILD_ID__` is a build-time literal
 *  (`declare const`) with no runtime binding outside the built page, so it is stubbed the same
 *  way. Nothing in this file is called — `autoLabel` requires a `?auto=` query param that the
 *  test env's default location does not have, so the page never starts a probe run on import. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProbeMeasurement } from '../../packages/modoki/src/runtime/rendering/rampProbe';

const IDS = ['device', 'run', 'status', 'headline', 'out', 'buildid', 'reload'];

beforeEach(() => {
  document.body.innerHTML = IDS.map((id) => {
    const tag = id === 'device' ? 'select' : id === 'run' || id === 'reload' ? 'button' : 'div';
    return `<${tag} id="${id}"></${tag}>`;
  }).join('');
  vi.stubGlobal('__BUILD_ID__', 'test-build');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Minimal but shape-complete — only `totalMs` is exercised by `medianMeasurement`; the rest
 *  exists so the value type-checks as a real `ProbeMeasurement`. */
function measurement(totalMs: number): ProbeMeasurement {
  const reading = { kind: 'fill' as const, status: 'escaped' as const, unitsPerMs: 1, bound: 'measured' as const, peakLoad: 8, steps: [] };
  return {
    intervalMs: 16.7, clockKind: 'webgpu', axes: '3d', fill: reading, draw: reading,
    totalMs, rendererMs: 10, compileMs: 10, shadeCompileMs: 0,
    bufferPixels: 1_000_000, shadeRegionPixels: 0,
  };
}

describe('medianMeasurement (#205 R5.4 — the harness headline was order-middle, not sorted-middle)', () => {
  it('picks the sorted-middle run when order and sorted order already agree', async () => {
    const { medianMeasurement } = await import('../../tools/ramp-probe-page/main');
    const runs = [measurement(100), measurement(200), measurement(300)];
    expect(medianMeasurement(runs).totalMs).toBe(200);
  });

  it('picks the SORTED middle, not the order-middle, when a cold first run is an outlier', async () => {
    // THE CASE THAT DISTINGUISHES THE FIX FROM THE BUG. Position 1 (order-middle, what the old
    // `measurements[Math.floor(len/2)]` returned) is the 900 ms outlier — a cold first pass, per
    // this file's own header. The true median by value is 150.
    const runs = [measurement(900), measurement(100), measurement(150)];
    const { medianMeasurement } = await import('../../tools/ramp-probe-page/main');
    const med = medianMeasurement(runs);

    expect(med.totalMs).toBe(150); // sorted-middle: [100, 150, 900][1]
    expect(med.totalMs).not.toBe(runs[Math.floor(runs.length / 2)].totalMs); // order-middle was 100...
  });

  it('is stable on ties: equal totalMs keeps original relative order', async () => {
    const a = measurement(100);
    const b = measurement(100);
    const c = measurement(200);
    const { medianMeasurement } = await import('../../tools/ramp-probe-page/main');
    expect(medianMeasurement([a, b, c])).toBe(b);
  });
});
