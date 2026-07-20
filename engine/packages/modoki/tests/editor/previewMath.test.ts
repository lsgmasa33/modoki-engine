/** ParticleEditor preview elapsed readout (F5).
 *  The preview's `elapsedRef` grows unbounded; the displayed scrub value must wrap against
 *  the loop period for a looping effect and clamp for a one-shot. */
import { describe, it, expect } from 'vitest';
import { displayElapsed } from '../../src/editor/panels/particle/previewMath';

describe('displayElapsed — F5 looping preview readout', () => {
  it('clamps at duration for a one-shot effect', () => {
    expect(displayElapsed(0, 2, false)).toBe(0);
    expect(displayElapsed(1.5, 2, false)).toBe(1.5);
    expect(displayElapsed(2, 2, false)).toBe(2);
    expect(displayElapsed(4.2, 2, false)).toBe(2); // past the end → pinned at duration
  });

  it('wraps into [0, duration) for a looping effect', () => {
    expect(displayElapsed(0, 2, true)).toBe(0);
    expect(displayElapsed(1.5, 2, true)).toBe(1.5);
    expect(displayElapsed(2, 2, true)).toBe(0);       // exactly one loop → phase 0
    expect(displayElapsed(4.2, 2, true)).toBeCloseTo(0.2, 6); // 2 loops + 0.2
    expect(displayElapsed(5, 2, true)).toBe(1);       // 2.5 loops → phase 1
  });

  it('returns 0 for a non-positive duration (guard against div-by-zero)', () => {
    expect(displayElapsed(3, 0, true)).toBe(0);
    expect(displayElapsed(3, 0, false)).toBe(0);
    expect(displayElapsed(3, -1, false)).toBe(0);
  });
});
