/** 2D group-drag delta + field-write rule (#105 Phase 2).
 *
 *  Extracted from `SceneView.tsx`'s group-drag pointer path into `multiTransform`,
 *  next to the `applyGroupTransform2D` these feed. Both were inline in a 2,311-line
 *  component at 0% coverage. */

import { describe, it, expect } from 'vitest';
import { virtualDragDelta, groupMemberFields, type Transform2D } from '../../src/editor/scene/multiTransform';

const T = (over: Partial<Transform2D> = {}): Transform2D => ({ x: 0, y: 0, rz: 0, sx: 1, sy: 1, ...over });

// The real clamp wraps into (-PI, PI]; a marker is enough to prove it is APPLIED
// and to which field, which is what this rule owns.
const clamp = (a: number) => a + 1000;

describe('virtualDragDelta', () => {
  it('reports translation and rotation as differences', () => {
    const d = virtualDragDelta(T({ x: 5, y: 5, rz: 1 }), T({ x: 8, y: 1, rz: 1.5 }));
    expect(d.dx).toBe(3);
    expect(d.dy).toBe(-4);
    expect(d.dRz).toBeCloseTo(0.5);
  });

  it('reports scale as a RATIO, not a difference', () => {
    // applyGroupTransform2D multiplies by this to spread members from the pivot —
    // a difference here would collapse or explode the group.
    const d = virtualDragDelta(T({ sx: 2, sy: 4 }), T({ sx: 3, sy: 1 }));
    expect(d.dSx).toBe(1.5);
    expect(d.dSy).toBe(0.25);
  });

  it('is identity for a drag that went nowhere', () => {
    expect(virtualDragDelta(T({ x: 3, y: 4, rz: 2, sx: 5, sy: 6 }), T({ x: 3, y: 4, rz: 2, sx: 5, sy: 6 })))
      .toEqual({ dx: 0, dy: 0, dRz: 0, dSx: 1, dSy: 1 });
  });

  describe('a zero start scale must not divide by zero', () => {
    // The guard matters more than it looks: Infinity/NaN here propagates into every
    // member's Transform, and undo cannot recover it because the NaN is what got
    // written to the trait.
    it('treats a zero start scale as 1 rather than producing Infinity', () => {
      const d = virtualDragDelta(T({ sx: 0, sy: 0 }), T({ sx: 2, sy: 3 }));
      expect(d.dSx).toBe(2);
      expect(d.dSy).toBe(3);
      expect(Number.isFinite(d.dSx)).toBe(true);
    });

    it('stays finite when both start and end scale are zero', () => {
      const d = virtualDragDelta(T({ sx: 0, sy: 0 }), T({ sx: 0, sy: 0 }));
      expect(d.dSx).toBe(0);
      expect(Number.isNaN(d.dSx)).toBe(false);
    });

    it('handles a NEGATIVE start scale normally — only zero is special', () => {
      expect(virtualDragDelta(T({ sx: -2 }), T({ sx: -4 })).dSx).toBe(2);
    });
  });
});

describe('groupMemberFields — which fields each mode writes', () => {
  const next = T({ x: 9, y: 8, rz: 7, sx: 6, sy: 5 });

  it('translate writes ONLY position', () => {
    expect(groupMemberFields('translate', next, clamp)).toEqual({ x: 9, y: 8 });
  });

  it('rotate writes position AND rotation — not rotation alone', () => {
    // The rule this module exists for. A rigid group rotation ORBITS members around
    // the shared pivot, so their positions move even though the user is "only
    // rotating". Dropping x/y here spins each member in place instead: almost
    // right, and wrong.
    expect(groupMemberFields('rotate', next, clamp)).toEqual({ x: 9, y: 8, rz: 1007 });
  });

  it('scale writes position AND scale, for the same orbit/spread reason', () => {
    expect(groupMemberFields('scale', next, clamp)).toEqual({ x: 9, y: 8, sx: 6, sy: 5 });
  });

  it('applies the clamp to rotation only', () => {
    const r = groupMemberFields('rotate', next, clamp) as Record<string, number>;
    expect(r.rz).toBe(1007);
    expect(r.x).toBe(9); // untouched by the clamp
  });

  it('never writes a field its mode does not own', () => {
    // A patch that carried rz on a translate would fight the rotate handle.
    expect(groupMemberFields('translate', next, clamp)).not.toHaveProperty('rz');
    expect(groupMemberFields('translate', next, clamp)).not.toHaveProperty('sx');
    expect(groupMemberFields('rotate', next, clamp)).not.toHaveProperty('sx');
    expect(groupMemberFields('scale', next, clamp)).not.toHaveProperty('rz');
  });
});
