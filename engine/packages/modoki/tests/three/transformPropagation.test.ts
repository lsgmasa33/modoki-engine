/** transformPropagationSystem unit tests — world transform computation, deactivation cascading. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { Transform, EntityAttributes } from '../../src/runtime/traits';
import { transformPropagationSystem, worldTransforms, deactivatedEntities } from '../../src/three/systems/transformPropagationSystem';

let testWorld: ReturnType<typeof createWorld>;

beforeEach(() => {
  testWorld = createWorld();
});

afterEach(() => {
  testWorld.destroy();
});

describe('transformPropagationSystem', () => {
  describe('root entity (no parent)', () => {
    it('world transform equals local transform', () => {
      const entity = testWorld.spawn(
        Transform({ x: 3, y: 5, z: -2, rx: 0.1, ry: 0.2, rz: 0.3, sx: 2, sy: 2, sz: 2 }),
        EntityAttributes({ name: 'Root', parentId: 0 }),
      );

      transformPropagationSystem(testWorld);

      const wt = worldTransforms.get(entity.id());
      expect(wt).toBeDefined();
      expect(wt!.x).toBeCloseTo(3);
      expect(wt!.y).toBeCloseTo(5);
      expect(wt!.z).toBeCloseTo(-2);
      expect(wt!.rx).toBeCloseTo(0.1);
      expect(wt!.ry).toBeCloseTo(0.2);
      expect(wt!.rz).toBeCloseTo(0.3);
      expect(wt!.sx).toBeCloseTo(2);
      expect(wt!.sy).toBeCloseTo(2);
      expect(wt!.sz).toBeCloseTo(2);
    });

    it('default transform is identity', () => {
      const entity = testWorld.spawn(
        Transform(),
        EntityAttributes({ name: 'Origin' }),
      );

      transformPropagationSystem(testWorld);

      const wt = worldTransforms.get(entity.id());
      expect(wt).toBeDefined();
      expect(wt!.x).toBeCloseTo(0);
      expect(wt!.y).toBeCloseTo(0);
      expect(wt!.z).toBeCloseTo(0);
      expect(wt!.sx).toBeCloseTo(1);
      expect(wt!.sy).toBeCloseTo(1);
      expect(wt!.sz).toBeCloseTo(1);
    });
  });

  describe('child entity', () => {
    it('world transform = parent world * local', () => {
      const parent = testWorld.spawn(
        Transform({ x: 10, y: 0, z: 0 }),
        EntityAttributes({ name: 'Parent', parentId: 0 }),
      );

      const child = testWorld.spawn(
        Transform({ x: 5, y: 0, z: 0 }),
        EntityAttributes({ name: 'Child', parentId: parent.id() }),
      );

      transformPropagationSystem(testWorld);

      const wt = worldTransforms.get(child.id());
      expect(wt).toBeDefined();
      // Child at local x=5, parent at x=10 → world x=15
      expect(wt!.x).toBeCloseTo(15);
      expect(wt!.y).toBeCloseTo(0);
      expect(wt!.z).toBeCloseTo(0);
    });

    it('grandchild inherits through chain', () => {
      const grandparent = testWorld.spawn(
        Transform({ x: 1, y: 0, z: 0 }),
        EntityAttributes({ name: 'Grandparent', parentId: 0 }),
      );

      const parent = testWorld.spawn(
        Transform({ x: 2, y: 0, z: 0 }),
        EntityAttributes({ name: 'Parent', parentId: grandparent.id() }),
      );

      const child = testWorld.spawn(
        Transform({ x: 3, y: 0, z: 0 }),
        EntityAttributes({ name: 'Child', parentId: parent.id() }),
      );

      transformPropagationSystem(testWorld);

      const wt = worldTransforms.get(child.id());
      expect(wt).toBeDefined();
      // 1 + 2 + 3 = 6
      expect(wt!.x).toBeCloseTo(6);
    });
  });

  describe('scale inheritance', () => {
    it('parent scale 2x doubles child world position', () => {
      const parent = testWorld.spawn(
        Transform({ x: 0, y: 0, z: 0, sx: 2, sy: 2, sz: 2 }),
        EntityAttributes({ name: 'Parent', parentId: 0 }),
      );

      const child = testWorld.spawn(
        Transform({ x: 5, y: 0, z: 0, sx: 1, sy: 1, sz: 1 }),
        EntityAttributes({ name: 'Child', parentId: parent.id() }),
      );

      transformPropagationSystem(testWorld);

      const wt = worldTransforms.get(child.id());
      expect(wt).toBeDefined();
      // Parent at origin with scale 2 → child at local x=5 becomes world x=10
      expect(wt!.x).toBeCloseTo(10);
      expect(wt!.y).toBeCloseTo(0);
      expect(wt!.z).toBeCloseTo(0);
      // Child world scale should be 2*1 = 2
      expect(wt!.sx).toBeCloseTo(2);
      expect(wt!.sy).toBeCloseTo(2);
      expect(wt!.sz).toBeCloseTo(2);
    });
  });

  describe('deactivation', () => {
    it('inactive entity appears in deactivatedEntities', () => {
      const entity = testWorld.spawn(
        Transform(),
        EntityAttributes({ name: 'Inactive', isActive: false, parentId: 0 }),
      );

      transformPropagationSystem(testWorld);

      expect(deactivatedEntities.has(entity.id())).toBe(true);
    });

    it('active entity is not in deactivatedEntities', () => {
      const entity = testWorld.spawn(
        Transform(),
        EntityAttributes({ name: 'Active', isActive: true, parentId: 0 }),
      );

      transformPropagationSystem(testWorld);

      expect(deactivatedEntities.has(entity.id())).toBe(false);
    });

    it('child of inactive parent is also deactivated (cascade)', () => {
      const parent = testWorld.spawn(
        Transform(),
        EntityAttributes({ name: 'InactiveParent', isActive: false, parentId: 0 }),
      );

      const child = testWorld.spawn(
        Transform(),
        EntityAttributes({ name: 'ActiveChild', isActive: true, parentId: parent.id() }),
      );

      transformPropagationSystem(testWorld);

      expect(deactivatedEntities.has(parent.id())).toBe(true);
      expect(deactivatedEntities.has(child.id())).toBe(true);
    });

    it('grandchild of inactive grandparent is deactivated', () => {
      const grandparent = testWorld.spawn(
        Transform(),
        EntityAttributes({ name: 'InactiveGP', isActive: false, parentId: 0 }),
      );

      const parent = testWorld.spawn(
        Transform(),
        EntityAttributes({ name: 'Parent', isActive: true, parentId: grandparent.id() }),
      );

      const child = testWorld.spawn(
        Transform(),
        EntityAttributes({ name: 'Child', isActive: true, parentId: parent.id() }),
      );

      transformPropagationSystem(testWorld);

      expect(deactivatedEntities.has(grandparent.id())).toBe(true);
      expect(deactivatedEntities.has(parent.id())).toBe(true);
      expect(deactivatedEntities.has(child.id())).toBe(true);
    });

    it('re-evaluates activation each frame — a once-active chain that deactivates is not stale-cached (F5 negative memo)', () => {
      const parent = testWorld.spawn(
        Transform(),
        EntityAttributes({ name: 'P', isActive: true, parentId: 0 }),
      );
      const child = testWorld.spawn(
        Transform(),
        EntityAttributes({ name: 'C', isActive: true, parentId: parent.id() }),
      );

      // Frame 1: both active → both populate the per-frame "known active" memo.
      transformPropagationSystem(testWorld);
      expect(deactivatedEntities.has(parent.id())).toBe(false);
      expect(deactivatedEntities.has(child.id())).toBe(false);

      // Deactivate the parent, then re-run. If the negative memo weren't cleared per
      // frame, parent (and thus child) would be wrongly remembered as active.
      parent.set(EntityAttributes, { ...parent.get(EntityAttributes), isActive: false });
      transformPropagationSystem(testWorld);
      expect(deactivatedEntities.has(parent.id())).toBe(true);
      expect(deactivatedEntities.has(child.id())).toBe(true);
    });

    it('entity without Transform but with EntityAttributes can be deactivated', () => {
      // Some entities (e.g., UI-only) may not have Transform
      const entity = testWorld.spawn(
        EntityAttributes({ name: 'NoTransform', isActive: false, parentId: 0 }),
      );

      transformPropagationSystem(testWorld);

      expect(deactivatedEntities.has(entity.id())).toBe(true);
      // Should not appear in worldTransforms (no Transform trait)
      expect(worldTransforms.has(entity.id())).toBe(false);
    });
  });

  describe('rotation inheritance', () => {
    it('parent 90° Y rotation rotates child position', () => {
      const parent = testWorld.spawn(
        Transform({ x: 0, y: 0, z: 0, ry: Math.PI / 2 }),
        EntityAttributes({ name: 'Parent', parentId: 0 }),
      );

      const child = testWorld.spawn(
        Transform({ x: 5, y: 0, z: 0 }),
        EntityAttributes({ name: 'Child', parentId: parent.id() }),
      );

      transformPropagationSystem(testWorld);

      const wt = worldTransforms.get(child.id());
      expect(wt).toBeDefined();
      // 90° Y rotation: (5,0,0) → (0,0,-5)
      expect(wt!.x).toBeCloseTo(0);
      expect(wt!.y).toBeCloseTo(0);
      expect(wt!.z).toBeCloseTo(-5);
    });

    it('parent 90° Z rotation rotates child position in XY plane', () => {
      const parent = testWorld.spawn(
        Transform({ x: 0, y: 0, z: 0, rz: Math.PI / 2 }),
        EntityAttributes({ name: 'Parent', parentId: 0 }),
      );

      const child = testWorld.spawn(
        Transform({ x: 5, y: 0, z: 0 }),
        EntityAttributes({ name: 'Child', parentId: parent.id() }),
      );

      transformPropagationSystem(testWorld);

      const wt = worldTransforms.get(child.id());
      expect(wt).toBeDefined();
      // 90° Z rotation: (5,0,0) → (0,5,0)
      expect(wt!.x).toBeCloseTo(0);
      expect(wt!.y).toBeCloseTo(5);
      expect(wt!.z).toBeCloseTo(0);
    });

    it('child inherits parent rotation', () => {
      const parent = testWorld.spawn(
        Transform({ x: 0, y: 0, z: 0, ry: Math.PI / 4 }),
        EntityAttributes({ name: 'Parent', parentId: 0 }),
      );

      const child = testWorld.spawn(
        Transform({ x: 0, y: 0, z: 0 }),
        EntityAttributes({ name: 'Child', parentId: parent.id() }),
      );

      transformPropagationSystem(testWorld);

      const wt = worldTransforms.get(child.id());
      expect(wt).toBeDefined();
      // Child at origin with no local rotation inherits parent's ry
      expect(wt!.ry).toBeCloseTo(Math.PI / 4);
    });
  });

  describe('combined translation + rotation + scale', () => {
    it('parent translated + rotated + scaled affects child correctly', () => {
      const parent = testWorld.spawn(
        Transform({ x: 10, y: 0, z: 0, ry: Math.PI / 2, sx: 2, sy: 2, sz: 2 }),
        EntityAttributes({ name: 'Parent', parentId: 0 }),
      );

      const child = testWorld.spawn(
        Transform({ x: 1, y: 0, z: 0 }),
        EntityAttributes({ name: 'Child', parentId: parent.id() }),
      );

      transformPropagationSystem(testWorld);

      const wt = worldTransforms.get(child.id());
      expect(wt).toBeDefined();
      // Parent at (10,0,0), scale 2, rotated 90° Y
      // Child local (1,0,0) → scaled (2,0,0) → rotated 90° Y → (0,0,-2) → translated → (10,0,-2)
      expect(wt!.x).toBeCloseTo(10);
      expect(wt!.y).toBeCloseTo(0);
      expect(wt!.z).toBeCloseTo(-2);
      // Child world scale = parent scale * child scale = 2*1 = 2
      expect(wt!.sx).toBeCloseTo(2);
    });

    it('non-uniform parent scale affects child position per axis', () => {
      const parent = testWorld.spawn(
        Transform({ x: 0, y: 0, z: 0, sx: 3, sy: 1, sz: 2 }),
        EntityAttributes({ name: 'Parent', parentId: 0 }),
      );

      const child = testWorld.spawn(
        Transform({ x: 1, y: 1, z: 1 }),
        EntityAttributes({ name: 'Child', parentId: parent.id() }),
      );

      transformPropagationSystem(testWorld);

      const wt = worldTransforms.get(child.id());
      expect(wt).toBeDefined();
      // Non-uniform scale: x*3, y*1, z*2
      expect(wt!.x).toBeCloseTo(3);
      expect(wt!.y).toBeCloseTo(1);
      expect(wt!.z).toBeCloseTo(2);
      expect(wt!.sx).toBeCloseTo(3);
      expect(wt!.sy).toBeCloseTo(1);
      expect(wt!.sz).toBeCloseTo(2);
    });
  });

  describe('empty world', () => {
    it('handles world with no entities', () => {
      transformPropagationSystem(testWorld);

      expect(worldTransforms.size).toBe(0);
      expect(deactivatedEntities.size).toBe(0);
    });
  });

  describe('edge cases (ecs-core P2)', () => {
    it('treats a dangling parentId (no such entity) as a root — world = local', () => {
      const e = testWorld.spawn(
        Transform({ x: 7, y: -3, z: 2, sx: 1, sy: 1, sz: 1 }),
        EntityAttributes({ name: 'Orphan', parentId: 999999 }), // parent never spawned
      );
      transformPropagationSystem(testWorld);
      const wt = worldTransforms.get(e.id())!;
      expect(wt.x).toBeCloseTo(7);
      expect(wt.y).toBeCloseTo(-3);
      expect(wt.z).toBeCloseTo(2);
    });

    it('does not infinite-loop on a parent cycle (A↔B); both get finite transforms', () => {
      const a = testWorld.spawn(Transform({ x: 1 }), EntityAttributes({ name: 'A', parentId: 0 }));
      const b = testWorld.spawn(Transform({ x: 2 }), EntityAttributes({ name: 'B', parentId: a.id() }));
      // Close the cycle: A's parent ← B.
      a.set(EntityAttributes, { ...a.get(EntityAttributes)!, parentId: b.id() });

      expect(() => transformPropagationSystem(testWorld)).not.toThrow();
      const wa = worldTransforms.get(a.id())!;
      const wb = worldTransforms.get(b.id())!;
      expect(Number.isFinite(wa.x)).toBe(true);
      expect(Number.isFinite(wb.x)).toBe(true);
    });

    it('reuses the matrix pool across frames — a small frame after a large one is still correct', () => {
      // Build a deep parented chain (forces many child matrix allocations in the pool).
      let prev = testWorld.spawn(Transform({ x: 1 }), EntityAttributes({ name: 'n0', parentId: 0 }));
      const chain = [prev];
      for (let i = 1; i < 40; i++) {
        const e = testWorld.spawn(Transform({ x: 1 }), EntityAttributes({ name: `n${i}`, parentId: prev.id() }));
        chain.push(e); prev = e;
      }
      transformPropagationSystem(testWorld);
      // Tip of the chain accumulates x=1 per level → world x == depth.
      expect(worldTransforms.get(chain[39].id())!.x).toBeCloseTo(40);

      // Now collapse to a tiny world and re-run — pooled matrices from the big frame
      // must be fully overwritten, not leak stale values.
      for (let i = 1; i < 40; i++) chain[i].destroy();
      const root = chain[0];
      root.set(Transform, { ...root.get(Transform)!, x: 5 });
      transformPropagationSystem(testWorld);
      expect(worldTransforms.size).toBe(1);
      expect(worldTransforms.get(root.id())!.x).toBeCloseTo(5);
    });
  });
});
