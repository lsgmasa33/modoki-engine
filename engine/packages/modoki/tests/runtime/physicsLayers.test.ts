/** Physics collision layers — the named-layer + matrix system on top of Rapier's raw
 *  bitmasks. Unit-tests the resolver, then proves filtering physically: a body on a
 *  layer that collides with the floor lands on it; a body on a "Ghost" layer that
 *  collides with nothing falls straight through. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/systems/physics2DSystem';
import { initRapier2D } from '../../src/runtime/systems/rapierLoader';
import {
  setPhysicsLayers, resetPhysicsLayers, resolveColliderBits, layersCollide, getPhysicsLayerNames,
} from '../../src/runtime/systems/physicsLayers';

beforeAll(async () => { await initRapier2D(); });
let tw: TestWorld | undefined;
afterEach(() => { resetPhysicsLayers(); if (tw) { disposePhysics2D(tw.world); tw.dispose(); tw = undefined; } });

describe('physicsLayers — resolver', () => {
  it('default is a single all-colliding layer', () => {
    resetPhysicsLayers();
    expect(getPhysicsLayerNames()).toEqual(['Default']);
    const bits = resolveColliderBits('Default', 0, 0);
    expect(bits.groups).toBe(0x0001);   // membership = bit 0
    expect(bits.mask).toBe(0xffff);     // collides with everything
  });

  it('resolves membership from layer index and filter from the matrix', () => {
    // Default(0) collides with Default only; Ghost(1) collides with nothing.
    setPhysicsLayers({ layers: ['Default', 'Ghost'], collisionMatrix: [0b01, 0b00] });
    expect(resolveColliderBits('Default', 0, 0)).toEqual({ groups: 0b01, mask: 0b01 });
    expect(resolveColliderBits('Ghost', 0, 0)).toEqual({ groups: 0b10, mask: 0b00 });
    expect(layersCollide(0, 0)).toBe(true);
    expect(layersCollide(0, 1)).toBe(false);
    expect(layersCollide(1, 1)).toBe(false);
  });

  it('falls back to raw bitmasks for an empty or unknown layer', () => {
    setPhysicsLayers({ layers: ['Default', 'Ghost'] });
    expect(resolveColliderBits('', 0x00f0, 0x000f)).toEqual({ groups: 0x00f0, mask: 0x000f });
    expect(resolveColliderBits('Nope', 0x0002, 0x0004)).toEqual({ groups: 0x0002, mask: 0x0004 });
  });

  it('caps at 16 layers', () => {
    setPhysicsLayers({ layers: Array.from({ length: 20 }, (_, i) => `L${i}`) });
    expect(getPhysicsLayerNames().length).toBe(16);
  });

  it('symmetrizes an asymmetric matrix (Rapier group test is bidirectional)', () => {
    // Author only one direction: A(0) says it collides with B(1), but B doesn't say so.
    setPhysicsLayers({ layers: ['A', 'B'], collisionMatrix: [0b11, 0b01] });
    expect(layersCollide(0, 1)).toBe(true);
    expect(layersCollide(1, 0)).toBe(true);   // healed to symmetric
  });

  it('keeps entries by index — a blank middle name does not shift later layers', () => {
    // Blank the middle name; 'Ghost' must still resolve to index 2 (bit 2), not 1.
    setPhysicsLayers({ layers: ['Default', '', 'Ghost'], collisionMatrix: [0b001, 0b010, 0b100] });
    expect(getPhysicsLayerNames()).toEqual(['Default', '', 'Ghost']);
    expect(resolveColliderBits('Ghost', 0, 0).groups).toBe(0b100);
  });
});

describe('physicsLayers — physical filtering', () => {
  function drop(layer: string): number {
    tw = createTestWorld({ systems: [{ name: 'p', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    // Floor on 'Default'; the dropped ball on `layer`.
    tw.spawn(Transform({ x: 0, y: 400 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20, physicsLayer: 'Default' }));
    const ball = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 30, physicsLayer: layer }));
    tw.step(400);
    return tw.trait<{ y: number }>(Transform, ball).y;
  }

  it('a body on a colliding layer lands on the floor; a Ghost falls through', () => {
    // Default collides with Default (floor); Ghost collides with nothing.
    setPhysicsLayers({ layers: ['Default', 'Ghost'], collisionMatrix: [0b01, 0b00] });
    const landed = drop('Default');
    resetPhysicsLayers();
    setPhysicsLayers({ layers: ['Default', 'Ghost'], collisionMatrix: [0b01, 0b00] });
    const ghost = drop('Ghost');
    expect(landed).toBeLessThan(400);      // rests above the floor (top ~380)
    expect(ghost).toBeGreaterThan(500);    // sailed straight through
  });
});

describe('physicsLayers — live collision-matrix edit (T4)', () => {
  it('re-applies to already-built colliders when the matrix changes mid-sim', () => {
    // A and B collide with everything → a B ball lands on the A floor.
    setPhysicsLayers({ layers: ['A', 'B'], collisionMatrix: [0b11, 0b11] });
    tw = createTestWorld({ systems: [{ name: 'p', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: 300 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20, physicsLayer: 'A' }));
    const ball = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 15, physicsLayer: 'B' }));
    tw.step(120);
    const yLanded = tw.trait<{ y: number }>(Transform, ball).y;
    expect(yLanded).toBeLessThan(300);                  // landed on the floor (A↔B collide)

    // Now make A and B NOT collide — existing colliders must update (in-place setCollisionGroups).
    setPhysicsLayers({ layers: ['A', 'B'], collisionMatrix: [0b01, 0b10] });
    tw.step(180);
    expect(tw.trait<{ y: number }>(Transform, ball).y).toBeGreaterThan(yLanded + 50); // now falls through
  });
});
