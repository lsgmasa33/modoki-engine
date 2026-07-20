/** Transform propagation system — extended tests for parent-child hierarchies,
 *  deactivation inheritance, and cycle detection. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { transformPropagationSystem, worldTransforms, deactivatedEntities } from '@modoki/engine/three';
import { Transform, EntityAttributes } from '@modoki/engine/runtime';

let w: ReturnType<typeof createWorld>;

afterEach(() => {
  w?.destroy();
});

describe('transformPropagationSystem — parent-child', () => {
  it('child inherits parent translation', () => {
    w = createWorld();
    const parent = w.spawn(
      Transform({ x: 10, y: 20, z: 30, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: 0 }),
    );
    const child = w.spawn(
      Transform({ x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: parent.id() }),
    );

    transformPropagationSystem(w);

    const parentWT = worldTransforms.get(parent.id())!;
    const childWT = worldTransforms.get(child.id())!;
    expect(parentWT.x).toBeCloseTo(10);
    expect(parentWT.y).toBeCloseTo(20);
    // Child world position = parent(10,20,30) + child(5,0,0) = (15,20,30)
    expect(childWT.x).toBeCloseTo(15);
    expect(childWT.y).toBeCloseTo(20);
    expect(childWT.z).toBeCloseTo(30);
  });

  it('child inherits parent scale', () => {
    w = createWorld();
    const parent = w.spawn(
      Transform({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 2, sy: 3, sz: 1 }),
      EntityAttributes({ parentId: 0 }),
    );
    const child = w.spawn(
      Transform({ x: 1, y: 1, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: parent.id() }),
    );

    transformPropagationSystem(w);

    const childWT = worldTransforms.get(child.id())!;
    // Scaled by parent: world pos = (1*2, 1*3, 0) = (2, 3, 0)
    expect(childWT.x).toBeCloseTo(2);
    expect(childWT.y).toBeCloseTo(3);
    // World scale = parent * child = (2, 3, 1)
    expect(childWT.sx).toBeCloseTo(2);
    expect(childWT.sy).toBeCloseTo(3);
  });

  it('3-level deep hierarchy propagates correctly', () => {
    w = createWorld();
    const grandparent = w.spawn(
      Transform({ x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: 0 }),
    );
    const parent = w.spawn(
      Transform({ x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: grandparent.id() }),
    );
    const child = w.spawn(
      Transform({ x: 3, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: parent.id() }),
    );

    transformPropagationSystem(w);

    expect(worldTransforms.get(grandparent.id())!.x).toBeCloseTo(10);
    expect(worldTransforms.get(parent.id())!.x).toBeCloseTo(15);
    expect(worldTransforms.get(child.id())!.x).toBeCloseTo(18);
  });

  it('siblings with same parent get correct world transforms', () => {
    w = createWorld();
    const parent = w.spawn(
      Transform({ x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: 0 }),
    );
    const childA = w.spawn(
      Transform({ x: 1, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: parent.id() }),
    );
    const childB = w.spawn(
      Transform({ x: -1, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: parent.id() }),
    );

    transformPropagationSystem(w);

    expect(worldTransforms.get(childA.id())!.x).toBeCloseTo(11);
    expect(worldTransforms.get(childB.id())!.x).toBeCloseTo(9);
  });

  it('root entities with parentId=0 have world=local', () => {
    w = createWorld();
    const e = w.spawn(
      Transform({ x: 7, y: 8, z: 9, rx: 0.1, ry: 0.2, rz: 0.3, sx: 2, sy: 2, sz: 2 }),
      EntityAttributes({ parentId: 0 }),
    );

    transformPropagationSystem(w);

    const wt = worldTransforms.get(e.id())!;
    expect(wt.x).toBe(7);
    expect(wt.y).toBe(8);
    expect(wt.z).toBe(9);
    expect(wt.rx).toBe(0.1);
    expect(wt.ry).toBe(0.2);
    expect(wt.rz).toBe(0.3);
    expect(wt.sx).toBe(2);
    expect(wt.sy).toBe(2);
    expect(wt.sz).toBe(2);
  });

  it('child with missing parent treated as root', () => {
    w = createWorld();
    // parentId=999 doesn't exist — should be treated as root
    const orphan = w.spawn(
      Transform({ x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: 999 }),
    );

    transformPropagationSystem(w);

    const wt = worldTransforms.get(orphan.id())!;
    expect(wt.x).toBeCloseTo(5);
  });
});

describe('transformPropagationSystem — deactivation', () => {
  it('inactive entity is in deactivatedEntities set', () => {
    w = createWorld();
    const active = w.spawn(
      Transform({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ isActive: true, parentId: 0 }),
    );
    const inactive = w.spawn(
      Transform({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ isActive: false, parentId: 0 }),
    );

    transformPropagationSystem(w);

    expect(deactivatedEntities.has(active.id())).toBe(false);
    expect(deactivatedEntities.has(inactive.id())).toBe(true);
  });

  it('children of inactive parent are deactivated', () => {
    w = createWorld();
    const parent = w.spawn(
      Transform({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ isActive: false, parentId: 0 }),
    );
    const child = w.spawn(
      Transform({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ isActive: true, parentId: parent.id() }),
    );

    transformPropagationSystem(w);

    expect(deactivatedEntities.has(parent.id())).toBe(true);
    expect(deactivatedEntities.has(child.id())).toBe(true);
  });

  it('grandchild inherits deactivation from grandparent', () => {
    w = createWorld();
    const grandparent = w.spawn(
      EntityAttributes({ isActive: false, parentId: 0 }),
    );
    const parent = w.spawn(
      EntityAttributes({ isActive: true, parentId: grandparent.id() }),
    );
    const child = w.spawn(
      EntityAttributes({ isActive: true, parentId: parent.id() }),
    );

    transformPropagationSystem(w);

    expect(deactivatedEntities.has(grandparent.id())).toBe(true);
    expect(deactivatedEntities.has(parent.id())).toBe(true);
    expect(deactivatedEntities.has(child.id())).toBe(true);
  });

  it('active sibling is not affected by inactive sibling', () => {
    w = createWorld();
    const parent = w.spawn(
      EntityAttributes({ isActive: true, parentId: 0 }),
    );
    const activeSibling = w.spawn(
      EntityAttributes({ isActive: true, parentId: parent.id() }),
    );
    const inactiveSibling = w.spawn(
      EntityAttributes({ isActive: false, parentId: parent.id() }),
    );

    transformPropagationSystem(w);

    expect(deactivatedEntities.has(parent.id())).toBe(false);
    expect(deactivatedEntities.has(activeSibling.id())).toBe(false);
    expect(deactivatedEntities.has(inactiveSibling.id())).toBe(true);
  });
});

describe('transformPropagationSystem — cycle detection', () => {
  it('handles self-referencing parentId without infinite loop', () => {
    w = createWorld();
    // Entity references itself as parent — cycle
    const e = w.spawn(
      Transform({ x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
    );
    // Set parentId to self after spawning
    w.query(EntityAttributes).updateEach(([ea], entity) => {
      if (entity.id() === e.id()) ea.parentId = e.id();
    });

    // Should not hang — cycle detection returns identity matrix
    transformPropagationSystem(w);

    const wt = worldTransforms.get(e.id());
    expect(wt).toBeDefined();
  });
});

describe('transformPropagationSystem — clears between frames', () => {
  it('removed entities disappear from worldTransforms on next frame', () => {
    w = createWorld();
    const e1 = w.spawn(
      Transform({ x: 1, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: 0 }),
    );
    const e2 = w.spawn(
      Transform({ x: 2, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }),
      EntityAttributes({ parentId: 0 }),
    );

    transformPropagationSystem(w);
    expect(worldTransforms.has(e1.id())).toBe(true);
    expect(worldTransforms.has(e2.id())).toBe(true);

    // Destroy one entity
    e1.destroy();
    transformPropagationSystem(w);

    expect(worldTransforms.has(e1.id())).toBe(false);
    expect(worldTransforms.has(e2.id())).toBe(true);
  });
});
