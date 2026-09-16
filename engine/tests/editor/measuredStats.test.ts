/** #1305 — the Inspector must not render a measurement it does not have.
 *
 *  Both the texture and model panels used to total their per-variant/per-LOD sizes with
 *  `(xs ?? []).reduce((a, b) => a + (b ?? 0), 0)`. Those sizes are peeled into the gitignored
 *  `.meta.local.json`, so on a machine that has never re-derived them the reduce ran over nothing
 *  and the row asserted **0 B** — across 216 of this repo's 282 committed texture blocks. */

import { describe, it, expect } from 'vitest';
import { sumMeasured } from '../../packages/modoki/src/editor/panels/assetViews/measuredStats';

describe('sumMeasured', () => {
  it('totals the values that are present', () => {
    expect(sumMeasured([1, 2, 3])).toBe(6);
  });

  /** The defect itself: nothing measured must not read as zero. */
  it('returns undefined when no value was measured', () => {
    expect(sumMeasured([])).toBeUndefined();
    expect(sumMeasured([undefined, undefined])).toBeUndefined();
    expect(sumMeasured(undefined)).toBeUndefined();
  });

  /** ⚠️ The distinction the whole module exists for, and the one a "simplification" would
   *  destroy. A measured zero is an ANSWER — an empty variant that really is 0 bytes — while an
   *  absent value is the lack of one. Any `|| undefined` on the result collapses them and puts
   *  #1305 straight back, silently, with every other test here still green. */
  it('distinguishes a measured zero from an absent value', () => {
    expect(sumMeasured([0])).toBe(0);
    expect(sumMeasured([undefined])).toBeUndefined();
    expect(sumMeasured([0, undefined])).toBe(0);
  });

  /** Partial data still totals what it knows — the per-row rendering is what shows which
   *  individual entries are unknown, so an all-or-nothing total would hide more than it protects. */
  it('sums the known entries when only some are missing', () => {
    expect(sumMeasured([10, undefined, 5])).toBe(15);
  });
});
