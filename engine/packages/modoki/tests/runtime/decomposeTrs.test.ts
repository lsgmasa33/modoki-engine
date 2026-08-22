/** decomposeTrs — the singular-matrix decomposition (#258).
 *
 *  The load-bearing assertion here is a ROUND TRIP: `compose(decomposeTrs(M)) === M`. It is the
 *  one check that cannot be satisfied by a plausible-but-wrong implementation — asserting the
 *  scale triple alone would pass for something that recovered the scale and threw the rotation
 *  away, which is half of what this bug actually does. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { decomposeTrs } from '../../src/runtime/core/ecs/decomposeTrs';

const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();

/** Compose a TRS the way the engine does everywhere (euler XYZ). */
function trs(x: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** decomposeTrs `m`, recompose from the result, and return the max elementwise error. */
function roundTripError(m: THREE.Matrix4): number {
  decomposeTrs(m, pos, quat, scl);
  const back = new THREE.Matrix4().compose(pos, quat, scl);
  let worst = 0;
  for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(back.elements[i] - m.elements[i]));
  return worst;
}

describe('decomposeTrs — non-singular matrices are three.js, unchanged', () => {
  it('matches Matrix4.decompose exactly for an ordinary translated/rotated/scaled matrix', () => {
    const m = trs(3, -4, 5, 0.3, -1.1, 0.7, 2, 0.5, 3);
    const tp = new THREE.Vector3(), tq = new THREE.Quaternion(), ts = new THREE.Vector3();
    m.decompose(tp, tq, ts);
    decomposeTrs(m, pos, quat, scl);
    expect([pos.x, pos.y, pos.z]).toEqual([tp.x, tp.y, tp.z]);
    expect([quat.x, quat.y, quat.z, quat.w]).toEqual([tq.x, tq.y, tq.z, tq.w]);
    expect([scl.x, scl.y, scl.z]).toEqual([ts.x, ts.y, ts.z]);
  });

  it('leaves a very small but non-singular scale alone (0.001 must keep composing as it does today)', () => {
    // The workaround #258 forced on games/court keyed 0.001 instead of 0. Whatever this fix does,
    // that value must not change meaning — hence no epsilon anywhere in the implementation.
    const m = trs(0, 0, 0, 0, 0, 0, 0.001, 0.53, 0.53);
    decomposeTrs(m, pos, quat, scl);
    expect(scl.x).toBeCloseTo(0.001, 12);
    expect(scl.y).toBeCloseTo(0.53, 12);
  });

  it('small-but-valid scales stay on the three.js path across every plausible epsilon band', () => {
    // The nearest miss to this fix is triggering on `Math.abs(det) < someEpsilon` instead of
    // `det !== 0`, which swallows perfectly ordinary authored scales. Sweep uniform scales whose
    // determinants land BETWEEN the round thresholds someone would reach for, and run all the way
    // down, so every plausible epsilon has a value strictly inside it. Assert against three's OWN
    // answer so the two paths cannot quietly diverge on a non-degenerate matrix.
    //
    // Two lessons are baked into this list, both from mutations that ESCAPED an earlier version:
    //  - Values ON a boundary prove nothing: `>= 1e-9` accepts a determinant of exactly 1e-9.
    //  - The list must reach BELOW `Number.EPSILON` (2.22e-16). Stopping at det 8e-15 let a
    //    `>= Number.EPSILON` trigger — the single most likely thing a person would reach for —
    //    pass all 92 assertions in this commit while silently dropping the rotation of an
    //    ordinary 6e-6 scale. The point is not that anyone authors 2e-11; it is that the trigger
    //    is EXACT SINGULARITY, and a test suite that only probes the top of the range cannot say
    //    so. det = s³, so these cover 8e-6 · 8e-9 · 8e-12 · 8e-15 · 8e-18 · 8e-24 · 8e-33.
    for (const s of [0.02, 0.002, 0.0002, 0.00002, 2e-6, 2e-8, 2e-11]) {
      const m = trs(0, 0, 0, 0.2, 0, 0, s, s, s);
      const tp = new THREE.Vector3(), tq = new THREE.Quaternion(), ts = new THREE.Vector3();
      m.decompose(tp, tq, ts);
      decomposeTrs(m, pos, quat, scl);
      expect([scl.x, scl.y, scl.z], `scale ${s}`).toEqual([ts.x, ts.y, ts.z]);
      expect([quat.x, quat.y, quat.z, quat.w], `scale ${s}`).toEqual([tq.x, tq.y, tq.z, tq.w]);
    }
  });

  it('an authored NEGATIVE scale (a mirror) stays on the three.js path', () => {
    // det < 0 is not degenerate, it is a reflection. A trigger written `det > 0` — or one that
    // forgets Math.abs — would divert every mirrored entity into the singular branch and strip
    // the sign three deliberately parks on X.
    const m = trs(1, 0, 0, 0.3, 0.2, 0, -2, 3, 4);
    expect(m.determinant()).toBeLessThan(0);
    const tp = new THREE.Vector3(), tq = new THREE.Quaternion(), ts = new THREE.Vector3();
    m.decompose(tp, tq, ts);
    decomposeTrs(m, pos, quat, scl);
    expect([scl.x, scl.y, scl.z]).toEqual([ts.x, ts.y, ts.z]);
    expect(scl.x).toBeLessThan(0);
  });

});

describe('decomposeTrs — a zero scale axis', () => {
  it('recovers the parent-chain scale instead of falling back to identity (the #258 repro)', () => {
    // games/court's guard flag: root at 0.53, child animated to sx = 0.
    const world = trs(0, 0, 0, 0, 0, 0, 0.53, 0.53, 0.53)
      .multiply(trs(0, 0, 0, 0, 0, 0, 0, 1, 1));
    decomposeTrs(world, pos, quat, scl);
    expect(scl.x).toBe(0);
    expect(scl.y).toBeCloseTo(0.53, 12);
    expect(scl.z).toBeCloseTo(0.53, 12);
  });

  it('keeps the authored ROTATION when one axis is flattened (a flat mesh is still visible)', () => {
    const m = trs(1, 2, 3, 0, 0, Math.PI / 2, 2, 0, 3);
    expect(roundTripError(m)).toBeLessThan(1e-12);
    // …and the rotation really is the authored one, not a coincidence of the round trip.
    const e = new THREE.Euler().setFromQuaternion(quat);
    expect(e.z).toBeCloseTo(Math.PI / 2, 12);
    expect(scl.x).toBeCloseTo(2, 12);
    expect(scl.y).toBe(0);
    expect(scl.z).toBeCloseTo(3, 12);
  });

  it('round-trips for a zero on EVERY axis, under an arbitrary rotation', () => {
    for (const [sx, sy, sz] of [[0, 2, 3], [2, 0, 3], [2, 3, 0]] as const) {
      const m = trs(-1, 4, 0.5, 0.4, 1.2, -0.8, sx, sy, sz);
      expect(roundTripError(m), `scale ${sx},${sy},${sz}`).toBeLessThan(1e-12);
      expect([scl.x, scl.y, scl.z].map((v) => +v.toFixed(9))).toEqual([sx, sy, sz]);
    }
  });

  it('round-trips with TWO axes zero, and yields a valid (non-NaN) unit quaternion', () => {
    for (const [sx, sy, sz] of [[4, 0, 0], [0, 4, 0], [0, 0, 4]] as const) {
      const m = trs(2, 0, -3, 0.9, 0.2, 1.4, sx, sy, sz);
      expect(roundTripError(m), `scale ${sx},${sy},${sz}`).toBeLessThan(1e-12);
      expect(quat.length()).toBeCloseTo(1, 9); // not NaN, not un-normalized
      expect([scl.x, scl.y, scl.z].map((v) => +v.toFixed(9))).toEqual([sx, sy, sz]);
    }
  });

  it('…including when the surviving axis lies exactly ON a world axis (the tie-break case)', () => {
    // `perpendicularTo` crosses the survivor with whichever world axis it is LEAST aligned to,
    // precisely so the cross is never degenerate. The rotated case above can never exercise that
    // — its survivor is off-axis, so ANY choice works and a tie-break that always picked (1,0,0)
    // passed every assertion in this file. An UNROTATED collapse ("flatten to a spike along X")
    // is the ordinary authoring shape that catches it, and it yields a non-unit quaternion of
    // length 0.707 when the tie-break is wrong.
    for (const [sx, sy, sz] of [[4, 0, 0], [0, 4, 0], [0, 0, 4]] as const) {
      const m = trs(0, 0, 0, 0, 0, 0, sx, sy, sz);
      decomposeTrs(m, pos, quat, scl);
      expect(quat.length(), `scale ${sx},${sy},${sz} — unit quaternion`).toBeCloseTo(1, 9);
      expect(roundTripError(m), `scale ${sx},${sy},${sz}`).toBeLessThan(1e-12);
    }
  });

  it('returns all-zero scale and identity rotation when every axis is zero', () => {
    const m = trs(7, 8, 9, 0.5, 0.5, 0.5, 0, 0, 0);
    decomposeTrs(m, pos, quat, scl);
    expect([scl.x, scl.y, scl.z]).toEqual([0, 0, 0]);
    expect([quat.x, quat.y, quat.z, quat.w]).toEqual([0, 0, 0, 1]);
    expect([pos.x, pos.y, pos.z]).toEqual([7, 8, 9]); // position survives regardless
  });

  it('recovers a scale so small the DETERMINANT underflows to zero', () => {
    // s^3 < ~5e-324 underflows to exactly 0, so three reports (1,1,1) — a full-size render for
    // something authored to be vanishingly small. Same bug, no zero anywhere in the data.
    const s = 1e-120;
    const m = trs(0, 0, 0, 0, 0, 0, s, s, s);
    expect(m.determinant()).toBe(0); // the precondition this test exists for
    decomposeTrs(m, pos, quat, scl);
    expect(scl.x).toBeCloseTo(s, 130);
    expect(scl.y).toBeCloseTo(s, 130);
    expect(scl.z).toBeCloseTo(s, 130);
  });

  it('recovers scale but not rotation for a singular matrix with NO zero column (shear)', () => {
    // Two parallel columns: det === 0, yet every column has length. No orthonormal basis
    // represents this, so rotation falls back to identity — scale is still better than (1,1,1).
    const m = new THREE.Matrix4().set(
      2, 2, 0, 0,
      0, 0, 0, 0,
      0, 0, 3, 0,
      0, 0, 0, 1,
    );
    expect(m.determinant()).toBe(0);
    decomposeTrs(m, pos, quat, scl);
    expect(scl.x).toBeCloseTo(2, 12);
    expect(scl.y).toBeCloseTo(2, 12);
    expect(scl.z).toBeCloseTo(3, 12);
    expect([quat.x, quat.y, quat.z, quat.w]).toEqual([0, 0, 0, 1]);
  });
});

describe('three.js contract this fix is built on', () => {
  it('CANARY: Matrix4.decompose returns identity scale+rotation for a singular matrix', () => {
    // If a three upgrade changes this (back to NaN, or to a real degenerate decomposition),
    // decomposeTrs's singular branch may be redundant or newly wrong — find out HERE, loudly,
    // rather than in a scene where something invisible starts rendering at full size again.
    const m = trs(1, 2, 3, 0.5, 0.5, 0.5, 0, 2, 3);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    expect([s.x, s.y, s.z]).toEqual([1, 1, 1]);
    expect([q.x, q.y, q.z, q.w]).toEqual([0, 0, 0, 1]);
    expect([p.x, p.y, p.z]).toEqual([1, 2, 3]); // position is read before the early-out
  });
});
