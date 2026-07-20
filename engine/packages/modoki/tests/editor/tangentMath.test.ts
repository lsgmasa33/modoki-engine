/** CurvesView tangent-handle math (Missing-Tests #3 / F2 regression).
 *  deriveTangentFromHandle ↔ handleDataPt round-trip, and the unified/broken mirroring. */
import { describe, it, expect } from 'vitest';
import { deriveTangentFromHandle, handleDataPt } from '../../src/editor/panels/animation/tangentMath';
import { DEFAULT_TANGENT_WEIGHT, type Keyframe } from '../../src/runtime/animation/types';

const key = (over: Partial<Keyframe> = {}): Keyframe => ({ t: 1, v: 2, ...over });

describe('handleDataPt — forward (slope+weight → data point)', () => {
  it('out handle points forward in time along the slope', () => {
    const k = key({ outTangent: 2, outWeight: 0.5 });
    const segDt = 2; // neighbor 2s away
    const p = handleDataPt(k, 'out', segDt);
    expect(p.t).toBeCloseTo(1 + 0.5 * 2, 6); // t + w*segDt
    expect(p.v).toBeCloseTo(2 + 2 * (0.5 * 2), 6); // v + slope*dt
  });

  it('in handle points backward in time', () => {
    const k = key({ inTangent: 1, inWeight: 0.25 });
    const segDt = 4;
    const p = handleDataPt(k, 'in', segDt);
    expect(p.t).toBeCloseTo(1 - 0.25 * 4, 6);
    expect(p.v).toBeCloseTo(2 - 1 * (0.25 * 4), 6);
  });

  it('defaults the weight when unset and treats a non-finite (stepped) tangent as slope 0', () => {
    const k = key({ outTangent: Infinity }); // stepped → no slope
    const p = handleDataPt(k, 'out', 3);
    expect(p.t).toBeCloseTo(1 + DEFAULT_TANGENT_WEIGHT * 3, 6);
    expect(p.v).toBe(2); // flat
  });
});

describe('deriveTangentFromHandle ↔ handleDataPt round-trip', () => {
  it('out: derive then re-place lands on the same data point', () => {
    const k = key();
    const segDt = 2;
    // Drag the out handle to (dataT, dataV).
    const dataT = 1.8, dataV = 3.0;
    const patch = deriveTangentFromHandle(k, 'out', dataT, dataV, segDt, false);
    const k2 = { ...k, ...patch } as Keyframe;
    const back = handleDataPt(k2, 'out', segDt);
    expect(back.t).toBeCloseTo(dataT, 6);
    expect(back.v).toBeCloseTo(dataV, 6);
  });

  it('in: derive then re-place lands on the same data point', () => {
    const k = key();
    const segDt = 3;
    const dataT = 0.4, dataV = 0.5;
    const patch = deriveTangentFromHandle(k, 'in', dataT, dataV, segDt, false);
    const k2 = { ...k, ...patch } as Keyframe;
    const back = handleDataPt(k2, 'in', segDt);
    expect(back.t).toBeCloseTo(dataT, 6);
    expect(back.v).toBeCloseTo(dataV, 6);
  });
});

describe('deriveTangentFromHandle — unified vs broken', () => {
  it('unified mirrors the opposite tangent slope; broken does not', () => {
    const k = key();
    const unified = deriveTangentFromHandle(k, 'out', 1.5, 3, 2, true);
    expect(unified.inTangent).toBe(unified.outTangent); // mirrored
    const broken = deriveTangentFromHandle(k, 'out', 1.5, 3, 2, false);
    expect(broken.inTangent).toBeUndefined(); // only the dragged side changes
  });

  it('clamps the weight into [0.02, 1]', () => {
    const k = key();
    // Drag far past the neighbor → weight clamps to 1.
    const big = deriveTangentFromHandle(k, 'out', 100, 5, 2, false);
    expect(big.outWeight).toBe(1);
    // Drag on top of the key → weight clamps to floor 0.02.
    const tiny = deriveTangentFromHandle(k, 'out', 1, 5, 2, false);
    expect(tiny.outWeight).toBe(0.02);
  });
});
