/** billboardBonePose — the coordinate math for posing a 2.5D billboard Bone2D with the
 *  3D gizmo. Locks the reflection sign convention `(x,y,rz) → (x,-y,-rz)` (an involution
 *  matching buildBillboardGeometry's (px,-py) mesh layout) and the parent-relative
 *  round-trip, so a gizmo drag maps back to the exact bone-local Transform. */
import { describe, it, expect } from 'vitest';
import { boneRelToProxyLocal, proxyLocalToBoneRel, proxyLocalToBoneLocal } from '../../src/editor/scene/billboardBonePose';

describe('boneRelToProxyLocal — reflection into the billboard flip frame', () => {
  it('flips Y and rotation, keeps X/scale, and pins Z=0', () => {
    const p = boneRelToProxyLocal({ x: 10, y: 20, rz: 0.5, sx: 2, sy: 3 });
    expect(p).toEqual({ x: 10, y: -20, z: 0, rz: -0.5, sx: 2, sy: 3 });
  });

  it('is an involution — proxyLocalToBoneRel undoes it exactly', () => {
    const rel = { x: 72.39, y: 204.32, rz: -0.9197, sx: 1, sy: 1 };
    const back = proxyLocalToBoneRel(boneRelToProxyLocal(rel));
    expect(back.x).toBeCloseTo(rel.x, 9);
    expect(back.y).toBeCloseTo(rel.y, 9);
    expect(back.rz).toBeCloseTo(rel.rz, 9);
    expect(back.sx).toBeCloseTo(rel.sx, 9);
    expect(back.sy).toBeCloseTo(rel.sy, 9);
  });
});

describe('proxyLocalToBoneLocal — gizmo drag → bone-local Transform', () => {
  it('with no parent, the bone-local IS the reflected proxy transform', () => {
    // Bone whose parent is the sprite/rig root (parentRel = null): the proxy local,
    // un-reflected, is already the bone-local transform.
    const proxy = { x: 5, y: -8, rz: -0.3, sx: 1, sy: 1 };
    const local = proxyLocalToBoneLocal(proxy, null);
    expect(local.x).toBeCloseTo(5, 9);
    expect(local.y).toBeCloseTo(8, 9);   // un-flip Y
    expect(local.rz).toBeCloseTo(0.3, 9); // un-flip rotation
  });

  it('subtracts an unrotated parent translation (pure offset)', () => {
    // Bone world-rel = (30, -10); parent world-rel = (20, -10) → bone-local = (10, 0).
    // Proxy for a bone at rig-2D (30,10): reflect → (30,-10).
    const proxy = { x: 30, y: -10, rz: 0, sx: 1, sy: 1 };
    const parentRel = { x: 20, y: 10, rz: 0, sx: 1, sy: 1 }; // rig-2D, y-down
    const local = proxyLocalToBoneLocal(proxy, parentRel);
    expect(local.x).toBeCloseTo(10, 9);
    expect(local.y).toBeCloseTo(0, 9);
    expect(local.rz).toBeCloseTo(0, 9);
  });

  it('round-trips a full bone-local through the proxy and back (with a rotated parent)', () => {
    // Given a parent (rig-2D) and a bone-local, compose to bone world-rel, reflect to a
    // proxy, then proxyLocalToBoneLocal must recover the original bone-local.
    const parentRel = { x: 40, y: 25, rz: 0.4, sx: 1, sy: 1 };
    const boneLocal = { x: 12, y: -7, rz: 0.25, sx: 1, sy: 1 };
    // Compose parent ∘ boneLocal → bone world-rel (2D, y-down):
    const c = Math.cos(parentRel.rz), s = Math.sin(parentRel.rz);
    const boneWorldRel = {
      x: parentRel.x + (boneLocal.x * c - boneLocal.y * s),
      y: parentRel.y + (boneLocal.x * s + boneLocal.y * c),
      rz: parentRel.rz + boneLocal.rz, sx: 1, sy: 1,
    };
    // Reflect bone world-rel into the proxy's flip-local frame (what the gizmo would hold):
    const proxy = { x: boneWorldRel.x, y: -boneWorldRel.y, rz: -boneWorldRel.rz, sx: 1, sy: 1 };
    const recovered = proxyLocalToBoneLocal(proxy, parentRel);
    expect(recovered.x).toBeCloseTo(boneLocal.x, 6);
    expect(recovered.y).toBeCloseTo(boneLocal.y, 6);
    expect(recovered.rz).toBeCloseTo(boneLocal.rz, 6);
  });
});
