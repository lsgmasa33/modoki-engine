/** getWorldTransform3D — on-demand world-transform composition by walking parentId. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { createWorld } from 'koota';
import { Transform, EntityAttributes } from '../../src/runtime/traits';
import { registerEntity } from '../../src/runtime/core/ecs/world';
import { setCurrentWorld } from '../../src/runtime/core/ecs/worldRegistry';
import { getWorldTransform3D, worldToLocal3D } from '../../src/runtime/core/ecs/worldTransform';

let w: ReturnType<typeof createWorld>;
beforeEach(() => { w = createWorld(); setCurrentWorld(w); });
afterEach(() => { w.destroy(); });

function spawn(name: string, parentId: number, tf: Partial<Record<'x'|'y'|'z'|'rx'|'ry'|'rz'|'sx'|'sy'|'sz', number>>) {
  const e = w.spawn(
    Transform({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, ...tf }),
    EntityAttributes({ name, parentId }),
  );
  registerEntity(e, w);
  return e;
}

describe('getWorldTransform3D', () => {
  it('a root entity: world == local', () => {
    const e = spawn('Root', 0, { x: 3, y: 5, z: -2, ry: 0.4, sx: 2 });
    const wt = getWorldTransform3D(e.id(), w);
    expect(wt.x).toBeCloseTo(3); expect(wt.y).toBeCloseTo(5); expect(wt.z).toBeCloseTo(-2);
    expect(wt.ry).toBeCloseTo(0.4); expect(wt.sx).toBeCloseTo(2);
  });

  it('a child adds the parent translation', () => {
    const p = spawn('Parent', 0, { x: 10, z: 5 });
    const c = spawn('Child', p.id(), { x: 1, z: 0 });
    const wt = getWorldTransform3D(c.id(), w);
    expect(wt.x).toBeCloseTo(11); expect(wt.z).toBeCloseTo(5);
  });

  it("a parent's Y-rotation rotates the child offset into world space", () => {
    // Parent yawed +90° (about Y). Child local +X → world -Z (right-handed, +Y up).
    const p = spawn('Parent', 0, { x: 0, y: 0, z: 0, ry: Math.PI / 2 });
    const c = spawn('Child', p.id(), { x: 2, z: 0 });
    const wt = getWorldTransform3D(c.id(), w);
    expect(wt.x).toBeCloseTo(0);
    expect(wt.z).toBeCloseTo(-2);
  });

  it('composes translation + rotation of a moved parent (the Game Field case)', () => {
    // Game Field translated to (100,0,50) and yawed 90°; a marker at local (5,0,0)
    // ends up at world (100,0,45): +X local → -Z world, then + the field origin.
    const field = spawn('Game Field', 0, { x: 100, y: 0, z: 50, ry: Math.PI / 2 });
    const marker = spawn('Marker', field.id(), { x: 5, z: 0 });
    const wt = getWorldTransform3D(marker.id(), w);
    expect(wt.x).toBeCloseTo(100);
    expect(wt.z).toBeCloseTo(45);
  });

  it('walks a 3-deep chain (grandparent · parent · child)', () => {
    const gp = spawn('GP', 0, { x: 10 });
    const p = spawn('P', gp.id(), { x: 1 });
    const c = spawn('C', p.id(), { x: 0.5 });
    const wt = getWorldTransform3D(c.id(), w);
    expect(wt.x).toBeCloseTo(11.5);
  });

  it('is headless-safe: works when the entity index is NOT populated (no registerEntity)', () => {
    // Test worlds (createTestWorld) spawn directly and skip registerEntity, so the
    // entity index is empty. A query-based walk must still compose correctly — this is
    // the regression that left enemies/puck at the origin (sling.test.ts). Spawn WITHOUT
    // registerEntity.
    const field = w.spawn(
      Transform({ x: 0, y: 0, z: 0, rx: 0, ry: Math.PI / 2, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ name: 'Game Field', parentId: 0 }),
    );
    const marker = w.spawn(
      Transform({ x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ name: 'Marker', parentId: field.id() }),
    );
    const wt = getWorldTransform3D(marker.id(), w);
    expect(wt.x).toBeCloseTo(0);
    expect(wt.z).toBeCloseTo(-5); // +X local → -Z world under the yawed field
  });

  it('worldToLocal3D inverts the parent: round-trips a world pose to local', () => {
    const field = spawn('Game Field', 0, { x: 100, y: 0, z: 50, ry: Math.PI / 2 });
    const marker = spawn('Marker', field.id(), { x: 5, z: 0 });
    // Marker world pose is (100,0,45) — feed it back through worldToLocal3D and expect
    // the original local (5,0,0).
    const q = new THREE.Quaternion(); // identity world rotation for the marker itself
    const local = worldToLocal3D(marker.id(), { x: 100, y: 0, z: 45 }, q, w);
    expect(local.x).toBeCloseTo(5);
    expect(local.y).toBeCloseTo(0);
    expect(local.z).toBeCloseTo(0);
  });
});

describe('getWorldTransform3D — a zero scale axis (#258)', () => {
  // The ON-DEMAND half of the world-transform contract had the identical identity fallback as
  // the cached half, so physics/audio/game systems that read this API saw the same lie. Both
  // halves need their own regression: fixing one says nothing about the other.

  it('keeps the parent chain scale instead of falling back to identity', () => {
    const root = spawn('Flag', 0, { sx: 0.53, sy: 0.53, sz: 0.53 });
    const cloth = spawn('Cloth', root.id(), { sx: 0 });
    const wt = getWorldTransform3D(cloth.id(), w);
    expect(wt.sx).toBe(0);          // was 1
    expect(wt.sy).toBeCloseTo(0.53, 9); // was 1 — the parent's scale vanished too
    expect(wt.sz).toBeCloseTo(0.53, 9);
  });

  it('keeps the ROTATION of an entity flattened on one axis', () => {
    const root = spawn('Group', 0, { sx: 2, sy: 2, sz: 2 });
    const flat = spawn('Flat', root.id(), { ry: Math.PI / 2, sy: 0 });
    const wt = getWorldTransform3D(flat.id(), w);
    expect(wt.ry).toBeCloseTo(Math.PI / 2, 9); // was 0
    expect(wt.sy).toBe(0);
    expect(wt.sx).toBeCloseTo(2, 9);
  });
});
