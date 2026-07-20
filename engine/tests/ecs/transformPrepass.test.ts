/** P1 guard — the pre-physics world-transform pass (SYSTEM_PRIORITY.TRANSFORM_PREPASS)
 *  makes `worldTransforms` hold THIS-frame world matrices by the time physics/game-tier
 *  systems read them. Regression against "propagation only runs after physics, so a
 *  parented body seeds from a stale/empty world map". */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, Transform, EntityAttributes } from '@modoki/engine/runtime';
import { SYSTEM_PRIORITY } from '@modoki/engine/runtime';
import { transformPropagationSystem, worldTransforms } from '@modoki/engine/three';

let tw: TestWorld | undefined;
afterEach(() => { tw?.dispose(); tw = undefined; });

describe('pre-physics transform propagation (P1)', () => {
  it('worldTransforms holds the child world pose when a PHYSICS-tier system runs', () => {
    let seenAtPhysics: { x: number; z: number } | undefined;
    let childId = 0;

    tw = createTestWorld({
      systems: [
        // Pre-physics propagation pass (170) — under PHYSICS (175).
        { name: 'prepass', fn: transformPropagationSystem, priority: SYSTEM_PRIORITY.TRANSFORM_PREPASS },
        // Probe at PHYSICS tier: capture what a physics system WOULD read for the child.
        {
          name: 'physicsProbe',
          fn: () => {
            const wt = worldTransforms.get(childId);
            if (wt) seenAtPhysics = { x: wt.x, z: wt.z };
          },
          priority: SYSTEM_PRIORITY.PHYSICS,
        },
      ],
    });

    // Game Field yawed +90° at (100,0,50); a body marker at local (5,0,0) → world (100,0,45).
    const field = tw.spawn(
      Transform({ x: 100, y: 0, z: 50, rx: 0, ry: Math.PI / 2, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ name: 'Game Field', parentId: 0 }),
    );
    const marker = tw.spawn(
      Transform({ x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ name: 'Body', parentId: field.id() }),
    );
    childId = marker.id();

    tw.step(1);

    expect(seenAtPhysics).toBeDefined();
    expect(seenAtPhysics!.x).toBeCloseTo(100);
    expect(seenAtPhysics!.z).toBeCloseTo(45); // +X local → -Z world under the yawed field, + origin
  });
});
