import { describe, it, expect } from 'vitest';
import { applyGizmoDrag2D, worldToLocal2D, rotateInverse2D, snapDragResult, DEFAULT_GIZMO_SNAP, type GizmoDragStart, type Transform2D } from '../../src/editor/panels/Gizmo2D';
import { clampAngle } from '../../src/runtime/traits/Transform';

/** Compose a local transform under a parent into world space (inverse of worldToLocal2D). */
function localToWorld2D(local: Transform2D, parent: Transform2D | null): Transform2D {
  if (!parent) return { ...local };
  const sx = local.x * parent.sx, sy = local.y * parent.sy;
  const c = Math.cos(parent.rz), s = Math.sin(parent.rz);
  return {
    x: parent.x + (sx * c - sy * s),
    y: parent.y + (sx * s + sy * c),
    rz: parent.rz + local.rz,
    sx: parent.sx * local.sx,
    sy: parent.sy * local.sy,
  };
}

const start: GizmoDragStart = { x: 10, y: 20, rz: 0, sx: 1, sy: 1 };
const center = { x: 10, y: 20 };

describe('applyGizmoDrag2D', () => {
  describe('free move', () => {
    it('translates by the pointer delta on both axes', () => {
      const r = applyGizmoDrag2D('free', 105, 70, 100, 50, start, center, 'world');
      expect(r).toEqual({ x: 10 + 5, y: 20 + 20 });
    });
  });

  describe('axis-constrained move (world space)', () => {
    it('x-axis moves only x', () => {
      const r = applyGizmoDrag2D('x-axis', 117, 999, 100, 50, start, center, 'world');
      expect(r).toEqual({ x: 10 + 17 });
      expect(r.y).toBeUndefined();
    });
    it('y-axis moves only y', () => {
      const r = applyGizmoDrag2D('y-axis', 999, 53, 100, 50, start, center, 'world');
      expect(r).toEqual({ y: 20 + 3 });
      expect(r.x).toBeUndefined();
    });
  });

  describe('axis-constrained move (local space)', () => {
    it('at rz=0 local x-axis equals world x (y projects to start.y)', () => {
      const r = applyGizmoDrag2D('x-axis', 110, 80, 100, 50, start, center, 'local');
      expect(r.x).toBeCloseTo(10 + 10);
      expect(r.y).toBeCloseTo(20); // no movement along the local x reaches y at rz=0
    });
    it('at rz=90° the local x-axis runs along world +y', () => {
      const s90: GizmoDragStart = { ...start, rz: Math.PI / 2 };
      // local x-axis points along world +y, so a +y drag moves y and a +x drag is ignored.
      const alongAxis = applyGizmoDrag2D('x-axis', 100, 58, 100, 50, s90, center, 'local');
      expect(alongAxis.x).toBeCloseTo(10, 5); // x stays
      expect(alongAxis.y).toBeCloseTo(20 + 8, 5);
      const offAxis = applyGizmoDrag2D('x-axis', 108, 50, 100, 50, s90, center, 'local');
      expect(offAxis.x).toBeCloseTo(10, 5); // +x drag has zero projection onto the local x-axis
      expect(offAxis.y).toBeCloseTo(20, 5);
    });
  });

  describe('rotate', () => {
    it('returns the clamped angle delta about the center', () => {
      // Start pointer at +x of center (angle 0); move to +y (angle +90°).
      const r = applyGizmoDrag2D('rotate', center.x, center.y + 5, center.x + 5, center.y, start, center, 'world');
      expect(r.rz).toBeCloseTo(clampAngle(Math.PI / 2), 5);
    });

    // gizmos F2: the contract is the engine-wide clampAngle range [-2π, 2π] (±360°),
    // NOT a single-turn [-π, π] wrap. Starting half a turn in and dragging ~+179° must
    // accumulate to ~+359° (still > π), not collapse to a small equivalent angle.
    it('does not single-turn wrap — accumulates up to ±360° (clampAngle contract)', () => {
      const s: GizmoDragStart = { ...start, rz: Math.PI }; // already +180°
      const theta = (179 * Math.PI) / 180;                 // ~+179° pointer delta
      const px = center.x + 5 * Math.cos(theta);
      const py = center.y + 5 * Math.sin(theta);
      const r = applyGizmoDrag2D('rotate', px, py, center.x + 5, center.y, s, center, 'world');

      expect(r.rz).toBeCloseTo(clampAngle(Math.PI + theta), 5);
      expect(r.rz!).toBeGreaterThan(Math.PI);                       // not wrapped into [-π, π]
      expect(Math.abs(r.rz!)).toBeLessThanOrEqual(2 * Math.PI + 1e-9); // but bounded at ±360°
    });
  });

  describe('scale-uniform', () => {
    it('scales both axes by the distance ratio', () => {
      // start pointer 10 units right of center; current 20 units → ratio 2.
      const r = applyGizmoDrag2D('scale-uniform', center.x + 20, center.y, center.x + 10, center.y, start, center, 'world');
      expect(r.sx).toBeCloseTo(2);
      expect(r.sy).toBeCloseTo(2);
    });
    it('ignores a degenerate start distance (<= 1px)', () => {
      const r = applyGizmoDrag2D('scale-uniform', center.x + 50, center.y, center.x, center.y, start, center, 'world');
      expect(r).toEqual({});
    });
  });

  describe('corner scale', () => {
    it('scales each axis independently in local space', () => {
      // start 10 right + 4 up; double x distance, keep y → sx≈2, sy≈1.
      const r = applyGizmoDrag2D('scale-br', center.x + 20, center.y + 4, center.x + 10, center.y + 4, start, center, 'world');
      expect(r.sx).toBeCloseTo(2);
      expect(r.sy).toBeCloseTo(1);
    });

    // F9: dragging a corner ACROSS the pivot must NOT flip the scale negative
    // (an accidental mirror) — the ratio clamps at 0.
    it('clamps at 0 when the pointer crosses the pivot (no negative/mirror)', () => {
      // start 10 right of center; drag to 5 LEFT of center → raw ratioX = -0.5.
      const r = applyGizmoDrag2D('scale-br', center.x - 5, center.y + 10, center.x + 10, center.y + 10, start, center, 'world');
      expect(r.sx).toBe(0);          // clamped, not negative
      expect(r.sx).toBeGreaterThanOrEqual(0);
    });

    // F9: a near-pivot start (below the min radius) is a no-op on that axis rather
    // than dividing by a ~1px denominator and shooting to a huge ratio.
    it('ignores a tiny start radius on an axis (ratio stays 1)', () => {
      // start 2px right (< SCALE_MIN_START_DIST=4) but 10px up; x stays, y scales.
      const r = applyGizmoDrag2D('scale-br', center.x + 50, center.y + 20, center.x + 2, center.y + 10, start, center, 'world');
      expect(r.sx).toBeCloseTo(1);   // x ignored (denominator too small)
      expect(r.sy).toBeCloseTo(2);   // y: 20/10
    });
  });
});

describe('rotateInverse2D (F6 shared helper)', () => {
  it('is identity at zero rotation', () => {
    expect(rotateInverse2D(3, 4, 0)).toEqual({ x: 3, y: 4 });
  });
  it('rotates a delta by -rz into entity-local space (+90° entity → world +x maps to local -y... wait, undo)', () => {
    // Entity rotated +90° (rz=π/2). A world +x delta (1,0) un-rotated by -90° → (0,-1).
    const r = rotateInverse2D(1, 0, Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo(-1, 6);
  });
  it('round-trips with the forward rotation (inverse∘forward = identity)', () => {
    const rz = 0.7;
    const fwdC = Math.cos(rz), fwdS = Math.sin(rz);
    const dx = 2, dy = -3;
    // forward-rotate, then inverse-rotate → back to the original delta.
    const fx = dx * fwdC - dy * fwdS;
    const fy = dx * fwdS + dy * fwdC;
    const back = rotateInverse2D(fx, fy, rz);
    expect(back.x).toBeCloseTo(dx, 6);
    expect(back.y).toBeCloseTo(dy, 6);
  });
});

// gizmos F1: a parented 2D entity is dragged in WORLD space, then mapped back to
// local. worldToLocal2D is the inverse of the parent→child composition.
describe('worldToLocal2D', () => {
  const expectClose = (a: Transform2D, b: Transform2D) => {
    expect(a.x).toBeCloseTo(b.x, 5); expect(a.y).toBeCloseTo(b.y, 5);
    expect(a.rz).toBeCloseTo(b.rz, 5);
    expect(a.sx).toBeCloseTo(b.sx, 5); expect(a.sy).toBeCloseTo(b.sy, 5);
  };

  it('no parent → world IS local (copy)', () => {
    const w: Transform2D = { x: 3, y: -4, rz: 0.5, sx: 2, sy: 1.5 };
    expectClose(worldToLocal2D(w, null), w);
  });

  it('parent translation only → subtract parent position', () => {
    const parent: Transform2D = { x: 100, y: 50, rz: 0, sx: 1, sy: 1 };
    const w: Transform2D = { x: 105, y: 53, rz: 0, sx: 1, sy: 1 };
    expectClose(worldToLocal2D(w, parent), { x: 5, y: 3, rz: 0, sx: 1, sy: 1 });
  });

  it('parent scale → divide world position and scale by parent scale', () => {
    const parent: Transform2D = { x: 0, y: 0, rz: 0, sx: 2, sy: 4 };
    const w: Transform2D = { x: 20, y: 40, rz: 0, sx: 6, sy: 8 };
    expectClose(worldToLocal2D(w, parent), { x: 10, y: 10, rz: 0, sx: 3, sy: 2 });
  });

  it('parent rotation → world delta maps onto the rotated local axes', () => {
    // Parent rotated +90°: a child local +x sits along world +y.
    const parent: Transform2D = { x: 0, y: 0, rz: Math.PI / 2, sx: 1, sy: 1 };
    const w: Transform2D = { x: 0, y: 7, rz: Math.PI / 2, sx: 1, sy: 1 };
    expectClose(worldToLocal2D(w, parent), { x: 7, y: 0, rz: 0, sx: 1, sy: 1 });
  });

  it('round-trips an arbitrary local under a translated+rotated+scaled parent', () => {
    const parent: Transform2D = { x: 12, y: -3, rz: 0.7, sx: 2, sy: 1.5 };
    const local: Transform2D = { x: 4, y: -2, rz: -0.3, sx: 1.25, sy: 0.5 };
    const world = localToWorld2D(local, parent);
    expectClose(worldToLocal2D(world, parent), local);
  });

  it('a dragged parented entity recovers the right LOCAL move (the F1 regression)', () => {
    // Parent at (100,50) rotated 90°, scale 2. Entity local (0,0). The user drags
    // the entity +10 in WORLD x. Old code added the world delta straight to local x
    // (→ local x = 10, wrong); the fix maps it through the parent inverse.
    const parent: Transform2D = { x: 100, y: 50, rz: Math.PI / 2, sx: 2, sy: 2 };
    const startLocal: Transform2D = { x: 0, y: 0, rz: 0, sx: 1, sy: 1 };
    const startWorld = localToWorld2D(startLocal, parent);
    const draggedWorld: Transform2D = { ...startWorld, x: startWorld.x + 10 };
    const local = worldToLocal2D(draggedWorld, parent);
    // World +x under a 90°/scale-2 parent → local (0, -5): rotate world delta by
    // -90° (→ -y) then /scale 2.
    expect(local.x).toBeCloseTo(0, 5);
    expect(local.y).toBeCloseTo(-5, 5);
    expect(local.x).not.toBeCloseTo(10, 1); // the bug would have produced ~10
  });
});

describe('snapDragResult (F7 Shift-snap)', () => {
  it('snaps translate to the grid increment (absolute, not delta)', () => {
    const out = snapDragResult({ x: 1.23, y: -0.4 }, DEFAULT_GIZMO_SNAP); // 0.5 grid
    expect(out.x).toBeCloseTo(1.0, 6);   // 1.23 → nearest 0.5 = 1.0
    expect(out.y).toBeCloseTo(-0.5, 6);  // -0.4 → -0.5
  });

  it('snaps rotation to 15° (π/12) multiples', () => {
    const deg20 = (20 * Math.PI) / 180;
    const out = snapDragResult({ rz: deg20 }, DEFAULT_GIZMO_SNAP);
    expect(out.rz).toBeCloseTo((15 * Math.PI) / 180, 6); // 20° → 15°
  });

  it('snaps scale to 0.1 steps', () => {
    const out = snapDragResult({ sx: 1.17, sy: 0.94 }, DEFAULT_GIZMO_SNAP);
    expect(out.sx).toBeCloseTo(1.2, 6);
    expect(out.sy).toBeCloseTo(0.9, 6);
  });

  it('only touches present fields; a zero/undefined increment disables that axis', () => {
    expect(snapDragResult({ x: 1.23 }, DEFAULT_GIZMO_SNAP)).toEqual({ x: 1.0 });
    // rotate-only result: x/y absent → stay absent
    const r = snapDragResult({ rz: 0.01 }, DEFAULT_GIZMO_SNAP);
    expect('x' in r).toBe(false);
    // a snap with translate disabled leaves x untouched
    expect(snapDragResult({ x: 1.23 }, { translate: 0 }).x).toBe(1.23);
  });

  it('is a no-op shape match — un-snapped vs snapped only differ by rounding', () => {
    const raw = { x: 2.0, y: 1.5, sx: 1.0 }; // already on grid
    expect(snapDragResult(raw, DEFAULT_GIZMO_SNAP)).toEqual(raw);
  });
});
