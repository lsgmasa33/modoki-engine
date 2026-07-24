import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { colliderWireframeGeometry, colliderOutlineSig3D, colliderWorldScale3D } from '../../src/runtime/rendering/colliderOutline3D';

const base = { radius: 0.5, halfW: 0.5, halfH: 0.5, halfD: 0.5, halfHeight: 0.5 };

describe('colliderOutline3D', () => {
  it('builds a box wireframe sized to half-extents', () => {
    const geo = colliderWireframeGeometry({ ...base, shape: 'box', halfW: 1, halfH: 2, halfD: 3 });
    expect(geo).not.toBeNull();
    geo!.computeBoundingBox();
    const bb = geo!.boundingBox!;
    expect(bb.max.x).toBeCloseTo(1, 5);   // halfW
    expect(bb.max.y).toBeCloseTo(2, 5);
    expect(bb.max.z).toBeCloseTo(3, 5);
  });

  it('builds a wireframe for every primitive shape', () => {
    for (const shape of ['box', 'sphere', 'capsule', 'cylinder', 'cone']) {
      const geo = colliderWireframeGeometry({ ...base, shape });
      expect(geo, shape).not.toBeNull();
      expect(geo!.getAttribute('position').count, shape).toBeGreaterThan(0);
    }
  });

  it('sphere wireframe radius matches the collider radius', () => {
    const geo = colliderWireframeGeometry({ ...base, shape: 'sphere', radius: 1.5 });
    geo!.computeBoundingSphere();
    expect(geo!.boundingSphere!.radius).toBeCloseTo(1.5, 2);
  });

  it('mesh shapes need geometry — null without it, edges with it', () => {
    expect(colliderWireframeGeometry({ ...base, shape: 'convex' })).toBeNull();
    expect(colliderWireframeGeometry({ ...base, shape: 'trimesh' })).toBeNull();
    const mesh = new THREE.BoxGeometry(2, 2, 2);
    const geo = colliderWireframeGeometry({ ...base, shape: 'convex' }, mesh);
    expect(geo).not.toBeNull();
    expect(geo!.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('unknown shape returns null; sig changes with dims', () => {
    expect(colliderWireframeGeometry({ ...base, shape: 'nope' })).toBeNull();
    const a = colliderOutlineSig3D({ ...base, shape: 'box' });
    const b = colliderOutlineSig3D({ ...base, shape: 'box', halfW: 2 });
    expect(a).not.toBe(b);
  });
});

describe('colliderWorldScale3D (wireframe scale must match makeColliderDesc\'s live Rapier collider)', () => {
  it('box scales per-axis — a 24x0.5x24 floor wireframe must match the visual floor, not stay at 1x1x1', () => {
    expect(colliderWorldScale3D('box', 24, 0.5, 24)).toEqual([24, 0.5, 24]);
  });

  it('sphere approximates a non-uniform scale with the mean of all three axes', () => {
    const [x, y, z] = colliderWorldScale3D('sphere', 1, 2, 3);
    expect(x).toBeCloseTo(2, 6); expect(y).toBeCloseTo(2, 6); expect(z).toBeCloseTo(2, 6);
  });

  it.each(['capsule', 'cylinder', 'cone'])('%s approximates radius by the mean of X/Z, height by Y', (shape) => {
    const [x, y, z] = colliderWorldScale3D(shape, 2, 5, 4);
    expect(x).toBeCloseTo(3, 6); // (2+4)/2
    expect(y).toBeCloseTo(5, 6); // height follows Y directly
    expect(z).toBeCloseTo(3, 6);
  });

  it('uniform scale reduces every shape to a uniform result', () => {
    for (const shape of ['box', 'sphere', 'capsule', 'cylinder', 'cone']) {
      expect(colliderWorldScale3D(shape, 2, 2, 2)).toEqual([2, 2, 2]);
    }
  });

  it('mesh shapes (convex/trimesh) and unknown shapes stay at scale 1 — the geometry is already scaled', () => {
    expect(colliderWorldScale3D('convex', 5, 5, 5)).toEqual([1, 1, 1]);
    expect(colliderWorldScale3D('trimesh', 5, 5, 5)).toEqual([1, 1, 1]);
    expect(colliderWorldScale3D('nope', 5, 5, 5)).toEqual([1, 1, 1]);
  });

  it('negative scale (mirrored transform) uses absolute value', () => {
    expect(colliderWorldScale3D('box', -3, 2, -4)).toEqual([3, 2, 4]);
  });
});
