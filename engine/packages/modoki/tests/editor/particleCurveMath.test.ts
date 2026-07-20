/** Particle CurveEditor math (Missing-Tests #1).
 *  toLocal/curveX/curveY round-trip; endpoint t-lock (index 0 → t=0, last → t=1);
 *  interior clamp between neighbours. Scale preservation (F1) is enforced by the parent
 *  ParticleEditor spreading the prior curve — these test the editor's coordinate + edit math. */
import { describe, it, expect } from 'vitest';
import { curveX, curveY, editPoint, PAD, toLocal, withCurvePoints, withCurveScale } from '../../src/editor/panels/particle/curveMath';

const RECT = { left: 0, top: 0, width: 100, height: 100 };

describe('curveMath — toLocal/X/Y mapping', () => {
  it('toLocal maps client px → t,v with PAD inset, clamped to [0,1]', () => {
    // inner area is [PAD, width-PAD] = [8, 92], span 84.
    const mid = toLocal(PAD + 42, PAD + 42, RECT);
    expect(mid.t).toBeCloseTo(0.5, 6);
    expect(mid.v).toBeCloseTo(0.5, 6); // v inverted: y at center → v 0.5
    // left/top corner → t=0, v=1 (y inverted)
    const tl = toLocal(PAD, PAD, RECT);
    expect(tl.t).toBeCloseTo(0, 6);
    expect(tl.v).toBeCloseTo(1, 6);
    // out-of-bounds clamps
    expect(toLocal(-50, -50, RECT).t).toBe(0);
    expect(toLocal(-50, -50, RECT).v).toBe(1);
    expect(toLocal(500, 500, RECT).t).toBe(1);
    expect(toLocal(500, 500, RECT).v).toBe(0);
  });

  it('curveX / curveY are the inverse of toLocal (round-trip)', () => {
    const W = 240, H = 96;
    for (const t of [0, 0.25, 0.5, 1]) {
      const px = curveX(t, W);
      // curveX inverse: t = (px - PAD) / (W - 2PAD)
      expect((px - PAD) / (W - 2 * PAD)).toBeCloseTo(t, 6);
    }
    for (const v of [0, 0.5, 1]) {
      const py = curveY(v, H);
      expect(1 - (py - PAD) / (H - 2 * PAD)).toBeCloseTo(v, 6);
    }
  });
});

describe('curveMath — editPoint t-lock + interior clamp', () => {
  const pts = [{ t: 0, v: 1 }, { t: 0.5, v: 0.5 }, { t: 1, v: 0 }];

  it('locks endpoint t (index 0 → t=0, last → t=1) but moves v', () => {
    expect(editPoint(pts, 0, 0.9, 0.3)).toEqual([{ t: 0, v: 0.3 }, { t: 0.5, v: 0.5 }, { t: 1, v: 0 }]);
    expect(editPoint(pts, 2, 0.1, 0.8)).toEqual([{ t: 0, v: 1 }, { t: 0.5, v: 0.5 }, { t: 1, v: 0.8 }]);
  });

  it('clamps an interior point strictly between its neighbours', () => {
    // dragging the middle point past the right neighbour clamps to hi - 0.001
    const out = editPoint(pts, 1, 5, 0.2);
    expect(out[1].t).toBeCloseTo(1 - 0.001, 6);
    expect(out[1].v).toBe(0.2);
    // and past the left neighbour clamps to lo + 0.001
    const out2 = editPoint(pts, 1, -5, 0.9);
    expect(out2[1].t).toBeCloseTo(0 + 0.001, 6);
  });

  it('does not mutate the input array', () => {
    const snapshot = JSON.parse(JSON.stringify(pts));
    editPoint(pts, 1, 0.7, 0.4);
    expect(pts).toEqual(snapshot);
  });
});

describe('curveMath — withCurvePoints / withCurveScale (F1 scale round-trip)', () => {
  it('withCurvePoints preserves an authored scale across a points edit', () => {
    const prev = { points: [{ t: 0, v: 1 }, { t: 1, v: 0 }], scale: 3 };
    const next = withCurvePoints(prev, [{ t: 0, v: 0 }, { t: 1, v: 1 }]);
    expect(next.scale).toBe(3); // the bug F1 fixed: scale must NOT be wiped
    expect(next.points).toEqual([{ t: 0, v: 0 }, { t: 1, v: 1 }]);
  });

  it('withCurvePoints leaves scale undefined when the prior curve had none', () => {
    const next = withCurvePoints(undefined, [{ t: 0, v: 1 }, { t: 1, v: 1 }]);
    expect(next.scale).toBeUndefined();
    expect(next.points).toHaveLength(2);
  });

  it('withCurveScale preserves the prior points and sets the new scale', () => {
    const prev = { points: [{ t: 0, v: 0.2 }, { t: 0.5, v: 1 }, { t: 1, v: 0 }] };
    const next = withCurveScale(prev, 2.5);
    expect(next.scale).toBe(2.5);
    expect(next.points).toBe(prev.points); // shape untouched
  });

  it('withCurveScale falls back to a flat default when the def had no curve yet', () => {
    const next = withCurveScale(undefined, 4);
    expect(next.scale).toBe(4);
    expect(next.points).toEqual([{ t: 0, v: 1 }, { t: 1, v: 1 }]);
  });
});
