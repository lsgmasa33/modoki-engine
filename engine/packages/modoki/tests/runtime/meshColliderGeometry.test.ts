import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import {
  colliderPositions, colliderIndices, geometryBoxHalfExtents, geometryBoundingRadius,
  buildMeshColliderDescs,
} from '../../src/runtime/systems/meshColliderGeometry';
import { initRapier3D, getRapier3D } from '../../src/runtime/systems/rapier3DLoader';

describe('meshColliderGeometry — pure extraction', () => {
  it('colliderPositions extracts + scales vertices (robust to indexed/interleaved)', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1); // corners at ±0.5, indexed (Uint16)
    const p = colliderPositions(geo, 1, 1, 1);
    expect(p).toBeInstanceOf(Float32Array);
    expect(p.length).toBe(geo.getAttribute('position').count * 3);
    // every coord is ±0.5
    for (const v of p) expect(Math.abs(v)).toBeCloseTo(0.5, 6);
    // scaled by (2,3,4) → coords become ±1, ±1.5, ±2
    const s = colliderPositions(geo, 2, 3, 4);
    expect(Math.abs(s[0])).toBeCloseTo(1, 6);
    expect(Math.abs(s[1])).toBeCloseTo(1.5, 6);
    expect(Math.abs(s[2])).toBeCloseTo(2, 6);
  });

  it('colliderIndices widens Uint16→Uint32 for indexed geometry', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const idx = colliderIndices(geo);
    expect(idx).toBeInstanceOf(Uint32Array);
    expect(idx.length).toBe(36); // 12 triangles × 3
    expect(Math.max(...idx)).toBeLessThan(geo.getAttribute('position').count);
  });

  it('colliderIndices synthesizes an identity index for non-indexed geometry', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    expect(geo.index).toBeNull();
    const idx = colliderIndices(geo);
    const n = geo.getAttribute('position').count;
    expect(idx.length).toBe(n);
    expect(idx[0]).toBe(0);
    expect(idx[n - 1]).toBe(n - 1);
  });

  it('geometryBoxHalfExtents + boundingRadius from bounds (scaled)', () => {
    const geo = new THREE.BoxGeometry(2, 4, 6); // full extents 2,4,6
    const he = geometryBoxHalfExtents(geo, 1, 1, 1);
    expect(he.x).toBeCloseTo(1, 6);
    expect(he.y).toBeCloseTo(2, 6);
    expect(he.z).toBeCloseTo(3, 6);
    const he2 = geometryBoxHalfExtents(geo, 2, 2, 2);
    expect(he2.y).toBeCloseTo(4, 6);
    const r = geometryBoundingRadius(new THREE.SphereGeometry(2.5, 16, 12), 1, 1, 1);
    expect(r).toBeCloseTo(2.5, 4);
  });
});

describe('meshColliderGeometry — convex + trimesh in a real Rapier sim', () => {
  beforeAll(async () => { await initRapier3D(); });

  it('a convex-hull box falls and rests on a trimesh floor', () => {
    const R = getRapier3D();
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = 1 / 60;

    // Static trimesh floor: a wide flat slab (top surface at y=0.5).
    const floorBody = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
    const floorDescs = buildMeshColliderDescs(R, new THREE.BoxGeometry(40, 1, 40), 'trimesh') as import('@dimforge/rapier3d-compat').ColliderDesc[];
    expect(floorDescs).not.toBeNull();
    world.createCollider(floorDescs[0], floorBody);

    // Dynamic convex-hull box (half-extent 0.5) dropped from y=5.
    const boxBody = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
    const boxDescs = buildMeshColliderDescs(R, new THREE.BoxGeometry(1, 1, 1), 'convex') as import('@dimforge/rapier3d-compat').ColliderDesc[];
    expect(boxDescs).not.toBeNull();
    world.createCollider(boxDescs[0].setDensity(1), boxBody);

    for (let i = 0; i < 300; i++) world.step();

    const y = boxBody.translation().y;
    expect(y).toBeGreaterThan(0.9);   // floor top 0.5 + box half-extent 0.5 ≈ 1.0
    expect(y).toBeLessThan(1.2);
    world.free();
  });
});
