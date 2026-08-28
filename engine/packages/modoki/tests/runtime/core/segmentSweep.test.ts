import { describe, expect, it } from 'vitest';
import { sweepSegment } from '../../../src/runtime/core/segmentSweep';

describe('sweepSegment', () => {
  it('from === null returns just the endpoint', () => {
    expect(sweepSegment(null, { x: 10, y: 20 }, { step: 1 })).toEqual([{ x: 10, y: 20 }]);
  });

  it('a hop shorter than the step returns just the endpoint', () => {
    const out = sweepSegment({ x: 0, y: 0 }, { x: 1, y: 0 }, { step: 10 });
    expect(out).toEqual([{ x: 1, y: 0 }]);
  });

  it('a long hop returns evenly spaced points ending exactly at the endpoint', () => {
    const out = sweepSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, { step: 10 });
    expect(out.length).toBe(10);
    expect(out[0]).toEqual({ x: 10, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 100, y: 0 });
    // Evenly spaced.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].x - out[i - 1].x).toBeCloseTo(10, 9);
    }
  });

  it('caps substeps at maxSteps for a huge jump', () => {
    const out = sweepSegment({ x: 0, y: 0 }, { x: 1_000_000, y: 0 }, { step: 1, maxSteps: 5 });
    expect(out.length).toBe(5);
    expect(out[out.length - 1]).toEqual({ x: 1_000_000, y: 0 });
  });

  it('a degenerate (non-positive) step falls back to the endpoint', () => {
    expect(sweepSegment({ x: 0, y: 0 }, { x: 5, y: 5 }, { step: 0 })).toEqual([{ x: 5, y: 5 }]);
    expect(sweepSegment({ x: 0, y: 0 }, { x: 5, y: 5 }, { step: -1 })).toEqual([{ x: 5, y: 5 }]);
  });

  it('a zero-length hop returns just the endpoint', () => {
    expect(sweepSegment({ x: 3, y: 3 }, { x: 3, y: 3 }, { step: 1 })).toEqual([{ x: 3, y: 3 }]);
  });
});
