/** CurvesView tangent-handle math (Missing-Tests #3 / F2 regression).
 *  deriveTangentFromHandle ↔ handleDataPt round-trip, and the unified/broken mirroring. */
import { describe, it, expect } from 'vitest';
import { deriveTangentFromHandle, handleDataPt } from '../../src/editor/panels/animation/tangentMath';
import { DEFAULT_TANGENT_WEIGHT, STEPPED, normalizeAnimationClip, type Keyframe } from '../../src/runtime/animation/types';

const key = (over: Partial<Keyframe> = {}): Keyframe => ({ t: 1, v: 2, inTangent: 0, outTangent: 0, ...over });

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

// A hand-drag that does not RECORD its mode is temporary: the key keeps whatever mode it had
// (usually 'auto') and the next neighbour edit re-derives the shape away. That was the bug.
describe('deriveTangentFromHandle — the drag records what it meant', () => {
  it("a unified drag records 'freeSmooth' and stays mirrored", () => {
    const patch = deriveTangentFromHandle(key({ tangentMode: 'auto' }), 'out', 2, 6, 1, true);
    expect(patch.tangentMode).toBe('freeSmooth');
    expect(patch.broken).toBe(false);
    expect(patch.inTangent).toBe(patch.outTangent); // mirrored, which is what 'freeSmooth' means
  });

  it("a broken drag records 'free' and moves only its own side", () => {
    const patch = deriveTangentFromHandle(key({ tangentMode: 'auto', broken: true }), 'out', 2, 6, 1, false);
    expect(patch.tangentMode).toBe('free');
    expect(patch.broken).toBe(true);
    expect(patch.inTangent).toBeUndefined(); // the other handle is left alone
  });

  it('records the mode on the IN side too', () => {
    const patch = deriveTangentFromHandle(key({ tangentMode: 'auto' }), 'in', 0, -2, 1, true);
    expect(patch.tangentMode).toBe('freeSmooth');
    expect(patch.broken).toBe(false);
  });
});

// A stepped key's hold lives on the OUTGOING tangent, and survives a save only because
// tangentMode:'constant' tells the loader to rebuild it (JSON.stringify(Infinity) === "null").
// So a drag that relabels such a key is data loss one reload later, not a cosmetic slip.
describe('deriveTangentFromHandle — a STEPPED key keeps its hold', () => {
  const stepped = (): Keyframe => key({ tangentMode: 'constant', outTangent: STEPPED, inTangent: 4, broken: true });

  it("dragging the IN handle keeps tangentMode 'constant' — the hold is untouched", () => {
    const patch = deriveTangentFromHandle(stepped(), 'in', 0.5, 1, 1, false);
    expect(patch.tangentMode).toBe('constant');
    expect(patch.outTangent).toBeUndefined(); // the outgoing side — the hold — is not written
  });

  it("dragging the OUT handle DOES relabel it, because that replaces the hold with a slope", () => {
    const patch = deriveTangentFromHandle(stepped(), 'out', 2, 6, 1, false);
    expect(patch.tangentMode).toBe('free');
    expect(Number.isFinite(patch.outTangent!)).toBe(true);
  });

  it('the hold survives a real save/load round-trip after an in-handle drag', () => {
    const k = { ...stepped(), ...deriveTangentFromHandle(stepped(), 'in', 0.5, 1, 1, false) };
    // The save side: JSON cannot carry Infinity, so this is what actually reaches disk.
    const onDisk = JSON.parse(JSON.stringify({
      tracks: [{ path: '', trait: 'T', field: 'f', type: 'number', keys: [k, { t: 2, v: 9, inTangent: 0, outTangent: 0 }] }],
    }));
    expect(onDisk.tracks[0].keys[0].outTangent).toBeNull(); // Infinity → null, as expected
    const reloaded = normalizeAnimationClip(onDisk);
    expect(reloaded.tracks[0].keys[0].outTangent).toBe(STEPPED); // …and rebuilt from the mode
  });
});
