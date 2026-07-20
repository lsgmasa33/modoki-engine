import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { pick2D, pick3D, type Pick2DCandidate, type Pick3DEntry } from '../../src/editor/panels/picking';

// ── pick2D ──

function candidate(partial: Partial<Pick2DCandidate> & { id: number }): Pick2DCandidate {
  return {
    wx: 0, wy: 0, wsx: 1, wsy: 1,
    width: 10, height: 10,
    pivotX: 0.5, pivotY: 0.5,
    ...partial,
  };
}

describe('pick2D', () => {
  it('returns null when no candidates', () => {
    expect(pick2D(0, 0, [])).toBeNull();
  });

  it('hits a centered box at its center', () => {
    const c = candidate({ id: 7 }); // box spans [-10,10] in x and y (hw=10)
    expect(pick2D(0, 0, [c])).toBe(7);
  });

  it('hits inside the box and misses outside', () => {
    const c = candidate({ id: 1 }); // hw = width(10) * |scale(1)| = 10
    expect(pick2D(9, -9, [c])).toBe(1);
    expect(pick2D(11, 0, [c])).toBeNull();
    expect(pick2D(0, -11, [c])).toBeNull();
  });

  it('breaks ties by closest box center', () => {
    // Two overlapping boxes both containing (1,0); B is centered nearer.
    const a = candidate({ id: 100, wx: -5 }); // center shifted to x=-5
    const b = candidate({ id: 200, wx: 0 });  // center at x=0, nearer to (1,0)
    expect(pick2D(1, 0, [a, b])).toBe(200);
    // Order-independent: nearest center still wins regardless of list order.
    expect(pick2D(1, 0, [b, a])).toBe(200);
  });

  it('prefers the topmost (highest paint order) hit over a nearer center', () => {
    // Both boxes contain (0,0). The back one (order 0) is dead-centered; the
    // front one (order 5) is offset so its center is farther — it still wins.
    const back = candidate({ id: 1, wx: 0, order: 0 });
    const front = candidate({ id: 2, wx: 4, order: 5 });
    expect(pick2D(0, 0, [back, front])).toBe(2);
    expect(pick2D(0, 0, [front, back])).toBe(2); // order-independent
  });

  it('falls back to closest center when paint orders tie', () => {
    const a = candidate({ id: 100, wx: -5, order: 3 });
    const b = candidate({ id: 200, wx: 0, order: 3 });
    expect(pick2D(1, 0, [a, b])).toBe(200);
  });

  it('accounts for scale in the box extents', () => {
    const c = candidate({ id: 5, wsx: 2, wsy: 2 }); // hw = 10 * 2 = 20
    expect(pick2D(18, 0, [c])).toBe(5);
    expect(pick2D(22, 0, [c])).toBeNull();
  });

  it('shifts the AABB center by pivot', () => {
    // pivotX=0 → center at +hw (x=10); box spans [0,20].
    const c = candidate({ id: 9, pivotX: 0 });
    expect(pick2D(0.5, 0, [c])).toBe(9);   // just inside left edge
    expect(pick2D(-1, 0, [c])).toBeNull(); // left of box
    expect(pick2D(19, 0, [c])).toBe(9);    // near right edge
  });
});

// ── pick3D ──

/** Camera at +Z looking toward origin; NDC (0,0) is the center ray down -Z. */
function frontCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

function box(): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
}

describe('pick3D', () => {
  it('returns null when the ray hits nothing', () => {
    const cam = frontCamera();
    const mesh = box();
    mesh.position.set(50, 50, 0); // far off to the side
    mesh.updateMatrixWorld(true);
    const entries: Pick3DEntry[] = [{ id: 1, object: mesh }];
    expect(pick3D(0, 0, cam, entries)).toBeNull();
  });

  it('picks the mesh under the center ray', () => {
    const cam = frontCamera();
    const mesh = box();
    mesh.updateMatrixWorld(true);
    const entries: Pick3DEntry[] = [{ id: 42, object: mesh }];
    expect(pick3D(0, 0, cam, entries)).toBe(42);
  });

  it('picks the nearer of two meshes along the ray', () => {
    const cam = frontCamera(); // at z=10 looking toward -z
    const near = box();
    near.position.set(0, 0, 3);
    near.updateMatrixWorld(true);
    const far = box();
    far.position.set(0, 0, -3);
    far.updateMatrixWorld(true);
    const entries: Pick3DEntry[] = [
      { id: 1, object: far },
      { id: 2, object: near },
    ];
    expect(pick3D(0, 0, cam, entries)).toBe(2);
  });

  it('walks up from a nested child to the tracked parent (GLB group case)', () => {
    const cam = frontCamera();
    const group = new THREE.Group(); // the tracked object — has no geometry itself
    const child = box();             // raycast actually hits this nested mesh
    group.add(child);
    group.updateMatrixWorld(true);
    const entries: Pick3DEntry[] = [{ id: 77, object: group }];
    expect(pick3D(0, 0, cam, entries)).toBe(77);
  });

  it('returns the deepest tracked entry along the ancestor chain', () => {
    // Both the child mesh and its parent group are tracked entities. The walk
    // starts at the actual hit object (the child) and climbs, so the deepest
    // match wins — the child, not its ancestor.
    const cam = frontCamera();
    const child = box();
    const parent = new THREE.Group();
    parent.add(child);
    parent.updateMatrixWorld(true);
    const entries: Pick3DEntry[] = [
      { id: 10, object: parent },
      { id: 20, object: child },
    ];
    expect(pick3D(0, 0, cam, entries)).toBe(20);
  });
});
