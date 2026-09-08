import { describe, expect, it } from 'vitest';
import {
  roundedBoxSdf,
  roundedBoxCoverage,
  buildMaskRamp,
} from '../../src/runtime/rendering/maskRamp';

describe('roundedBoxSdf', () => {
  it('centre of a box is -min(hx,hy) when r === 0', () => {
    expect(roundedBoxSdf(0, 0, 10, 6, 0)).toBeCloseTo(-6, 5);
    expect(roundedBoxSdf(0, 0, 6, 10, 0)).toBeCloseTo(-6, 5);
  });

  it('a point exactly on the edge midpoint is ~0', () => {
    expect(roundedBoxSdf(10, 0, 10, 6, 0)).toBeCloseTo(0, 5);
    expect(roundedBoxSdf(0, 6, 10, 6, 0)).toBeCloseTo(0, 5);
  });

  it('a point outside by d on an axis is ~d', () => {
    expect(roundedBoxSdf(15, 0, 10, 6, 0)).toBeCloseTo(5, 5);
    expect(roundedBoxSdf(0, 11, 10, 6, 0)).toBeCloseTo(5, 5);
  });

  it('with r > 0, the diagonal corner distance matches the analytic rounded-corner value', () => {
    const hx = 10, hy = 10, r = 2;
    // The corner of the shrunk box (hx-r, hy-r) plus radius r along the diagonal.
    const cx = hx - r, cy = hy - r;
    const dist = 5; // distance from that inner corner, outward along the diagonal
    const angle = Math.PI / 4;
    const px = cx + Math.cos(angle) * dist;
    const py = cy + Math.sin(angle) * dist;
    expect(roundedBoxSdf(px, py, hx, hy, r)).toBeCloseTo(dist - r, 5);
  });

  it('clamps r when it exceeds min(hx,hy)', () => {
    // r larger than the smaller half-extent must degrade to r = min(hx,hy) (a stadium/circle),
    // matching what an explicit clamp-then-evaluate would give.
    const hx = 10, hy = 6, rBig = 100;
    const rClamped = Math.min(hx, hy);
    expect(roundedBoxSdf(0, 0, hx, hy, rBig)).toBeCloseTo(roundedBoxSdf(0, 0, hx, hy, rClamped), 5);
    expect(roundedBoxSdf(3, 2, hx, hy, rBig)).toBeCloseTo(roundedBoxSdf(3, 2, hx, hy, rClamped), 5);
  });

  it('hx === 0 does not produce NaN', () => {
    expect(Number.isNaN(roundedBoxSdf(0, 0, 0, 10, 0))).toBe(false);
    expect(Number.isNaN(roundedBoxSdf(5, 5, 0, 10, 3))).toBe(false);
  });
});

describe('roundedBoxCoverage', () => {
  it('is 1 deep inside', () => {
    expect(roundedBoxCoverage(0, 0, 10, 10, 0, 2)).toBe(1);
  });

  it('is 0 deep outside', () => {
    expect(roundedBoxCoverage(100, 100, 10, 10, 0, 2)).toBe(0);
  });

  /** The ramp lives ENTIRELY inside the rect: 0 on the authored edge, 1 at `feather` in. The
   *  authored rect is a hard limit nothing crosses — see the module doc for the straddled variant
   *  this replaced and the live measurement that killed it. */
  it('is exactly 0 on the edge for any feather > 0', () => {
    for (const feather of [0.5, 1, 2, 10, 50]) {
      expect(roundedBoxCoverage(10, 0, 10, 6, 0, feather)).toBeCloseTo(0, 6);
      expect(roundedBoxCoverage(0, 6, 10, 6, 0, feather)).toBeCloseTo(0, 6);
    }
  });

  it('reaches full coverage exactly `feather` inside the edge, and half of it halfway', () => {
    const feather = 4;
    expect(roundedBoxCoverage(10 - feather, 0, 10, 6, 0, feather)).toBeCloseTo(1, 6);
    expect(roundedBoxCoverage(10 - feather / 2, 0, 10, 6, 0, feather)).toBeCloseTo(0.5, 6);
  });

  /** The defect the straddle caused, pinned so it cannot come back: every sample OUTSIDE the
   *  authored rect must be fully transparent, or a clip leaks content past its own bounds. */
  it('never paints outside the authored rect, however wide the feather', () => {
    for (const feather of [1, 12, 90]) {
      for (const d of [0.01, 0.5, 5, 50]) {
        expect(roundedBoxCoverage(10 + d, 0, 10, 6, 0, feather)).toBe(0);
        expect(roundedBoxCoverage(0, 6 + d, 10, 6, 0, feather)).toBe(0);
      }
    }
  });

  it('is a hard step when feather === 0', () => {
    expect(roundedBoxCoverage(9.9, 0, 10, 6, 0, 0)).toBe(1);
    expect(roundedBoxCoverage(10.1, 0, 10, 6, 0, 0)).toBe(0);
  });

  it('is monotonically non-increasing as a point moves outward along a ray', () => {
    const hx = 10, hy = 6, r = 2, feather = 4;
    let prev = Infinity;
    for (let i = 0; i < 20; i++) {
      // Ray from the centre out through the corner region, well past the box.
      const t = i / 19; // 0..1
      const px = t * 20;
      const py = t * 12;
      const c = roundedBoxCoverage(px, py, hx, hy, r, feather);
      expect(c).toBeLessThanOrEqual(prev + 1e-9);
      prev = c;
    }
  });
});

describe('buildMaskRamp', () => {
  it('buffer length is w*h*4, RGB channels all 255', () => {
    const ramp = buildMaskRamp(10, 6, 1, 2, 32);
    expect(ramp.data.length).toBe(ramp.width * ramp.height * 4);
    for (let i = 0; i < ramp.data.length; i += 4) {
      expect(ramp.data[i]).toBe(255);
      expect(ramp.data[i + 1]).toBe(255);
      expect(ramp.data[i + 2]).toBe(255);
    }
  });

  it('alpha at centre pixel is 255 and at a corner pixel is 0 for a reasonable feather', () => {
    // feather must be small relative to the box: the corner SAMPLE (nearest to the geometric
    // corner, but still inside the [-hx,hx] sampling square) sits only slightly outside the
    // rounded corner cut, so a feather comparable to hx/hy would still shade it non-zero.
    const ramp = buildMaskRamp(10, 10, 1, 0.2, 64);
    const centreRow = Math.floor(ramp.height / 2);
    const centreCol = Math.floor(ramp.width / 2);
    const centreIdx = (centreRow * ramp.width + centreCol) * 4;
    expect(ramp.data[centreIdx + 3]).toBe(255);

    const cornerIdx = (0 * ramp.width + 0) * 4;
    expect(ramp.data[cornerIdx + 3]).toBe(0);
  });

  it('preserves aspect ratio within one pixel', () => {
    const hx = 20, hy = 5;
    const ramp = buildMaskRamp(hx, hy, 0, 1, 64);
    const expectedRatio = hx / hy;
    const actualRatio = ramp.width / ramp.height;
    // Allow for rounding of one pixel on either axis.
    expect(Math.abs(actualRatio - expectedRatio)).toBeLessThan(expectedRatio * (1 / Math.min(ramp.width, ramp.height)) + 0.2);
  });

  it('respects maxRes', () => {
    const ramp = buildMaskRamp(10, 10, 0, 1, 16);
    expect(ramp.width).toBeLessThanOrEqual(16);
    expect(ramp.height).toBeLessThanOrEqual(16);
    expect(Math.max(ramp.width, ramp.height)).toBe(16);
  });

  it('degenerate hx = 0 returns a valid buffer and does not throw', () => {
    expect(() => buildMaskRamp(0, 10, 0, 1)).not.toThrow();
    const ramp = buildMaskRamp(0, 10, 0, 1);
    expect(ramp.width).toBe(2);
    expect(ramp.height).toBe(2);
    expect(ramp.data.length).toBe(2 * 2 * 4);
    for (let i = 0; i < ramp.data.length; i += 4) {
      expect(ramp.data[i + 3]).toBe(0);
    }
  });

  it('degenerate hy = 0 returns a valid buffer and does not throw', () => {
    expect(() => buildMaskRamp(10, 0, 0, 1)).not.toThrow();
  });

  it('is symmetric about both axes (catches an off-by-one in pixel-centre mapping)', () => {
    const ramp = buildMaskRamp(10, 6, 2, 3, 32);
    const { width, height, data } = ramp;
    const alphaAt = (col: number, row: number) => data[(row * width + col) * 4 + 3];

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const mirroredCol = width - 1 - col;
        const mirroredRow = height - 1 - row;
        expect(alphaAt(col, row)).toBe(alphaAt(mirroredCol, row));
        expect(alphaAt(col, row)).toBe(alphaAt(col, mirroredRow));
      }
    }
  });
});
