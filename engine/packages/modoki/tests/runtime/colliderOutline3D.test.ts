import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { colliderWireframeGeometry, colliderOutlineSig3D } from '../../src/runtime/rendering/colliderOutline3D';

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
