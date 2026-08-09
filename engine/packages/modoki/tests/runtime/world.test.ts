/** world.ts unit tests — findEntityById, registerEntity, unregisterEntity. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function getModule() {
  return import('../../src/runtime/core/ecs/world');
}

describe('world entity index', () => {
  describe('registerEntity + findEntityById', () => {
    it('registers and retrieves entity by ID', async () => {
      const { getCurrentWorld, registerEntity, findEntityById } = await getModule();
      const world = getCurrentWorld();
      const mockEntity = { id: () => 42 };
      registerEntity(mockEntity, world);

      expect(findEntityById(42, world)).toBe(mockEntity);
    });

    it('returns undefined for unregistered ID', async () => {
      const { getCurrentWorld, findEntityById } = await getModule();
      const world = getCurrentWorld();
      expect(findEntityById(99999, world)).toBeUndefined();
    });

    it('uses current world by default', async () => {
      const { registerEntity, findEntityById } = await getModule();
      const mockEntity = { id: () => 7 };
      registerEntity(mockEntity);

      expect(findEntityById(7)).toBe(mockEntity);
    });
  });

  describe('unregisterEntity', () => {
    it('removes entity from index', async () => {
      const { registerEntity, unregisterEntity, findEntityById } = await getModule();
      const mockEntity = { id: () => 55 };
      registerEntity(mockEntity);
      expect(findEntityById(55)).toBe(mockEntity);

      unregisterEntity(mockEntity);
      expect(findEntityById(55)).toBeUndefined();
    });

    it('is a no-op for non-existent entity', async () => {
      const { unregisterEntity } = await getModule();
      expect(() => unregisterEntity({ id: () => 99999 })).not.toThrow();
    });
  });

  describe('multiple registrations', () => {
    it('handles many entities', async () => {
      const { registerEntity, findEntityById } = await getModule();
      const entities = Array.from({ length: 100 }, (_, i) => ({ id: () => i + 1 }));
      for (const e of entities) registerEntity(e);

      expect(findEntityById(1)).toBe(entities[0]);
      expect(findEntityById(50)).toBe(entities[49]);
      expect(findEntityById(100)).toBe(entities[99]);
    });

    it('overwrites registration with same ID', async () => {
      const { registerEntity, findEntityById } = await getModule();
      const entity1 = { id: () => 42, label: 'old' };
      const entity2 = { id: () => 42, label: 'new' };
      registerEntity(entity1);
      registerEntity(entity2);

      expect(findEntityById(42)).toBe(entity2);
    });
  });

  // The helper pair exists because `world.spawn()` is koota's API, so registering could never be
  // automatic — it was a second call you had to remember, and three sites in games/ forgot the
  // destroy half. These assert the pairing itself, against the REAL module (this file mocks
  // nothing), which is what makes them meaningful: entityUtils.test.ts mocks core/ecs/world, so
  // its "index" is a stand-in Map that cannot observe a real stale entry.
  describe('spawnEntity / destroyEntity (the index pairing)', () => {
    /** Minimal koota-shaped world: spawn hands back an entity with an id and a destroy spy. */
    function fakeWorld() {
      let next = 1;
      const destroyed: number[] = [];
      const world = {
        spawn: (..._traits: unknown[]) => {
          const id = next++;
          return { id: () => id, destroy: () => { destroyed.push(id); } };
        },
      };
      return { world: world as never, destroyed };
    }

    it('spawnEntity puts the entity in the index — a bare world.spawn does not', async () => {
      const { spawnEntity, findEntityById } = await getModule();
      const { world } = fakeWorld();

      const viaHelper = spawnEntity(world, {} as never);
      expect(findEntityById(viaHelper.id(), world)).toBe(viaHelper);

      // The contrast is the whole point of the helper: the raw call is invisible to the index.
      const raw = (world as unknown as { spawn: () => { id: () => number } }).spawn();
      expect(findEntityById(raw.id(), world)).toBeUndefined();
    });

    it('destroyEntity removes the index entry AND destroys the entity', async () => {
      const { spawnEntity, destroyEntity, findEntityById } = await getModule();
      const { world, destroyed } = fakeWorld();

      const e = spawnEntity(world, {} as never);
      destroyEntity(e, world);

      expect(destroyed).toEqual([e.id()]);
      expect(findEntityById(e.id(), world)).toBeUndefined();
    });

    it('never leaves a live index entry pointing at a destroyed entity (the games/agy bug)', async () => {
      // The regression this pair exists for. Destroying WITHOUT unregistering is worse than
      // failing to register: an unregistered spawn still resolves via the O(n) fallback and warns,
      // whereas a stale entry is a silent index HIT — findEntityById hands back a corpse and the
      // caller reads traits off it. games/agy did this per-frame on gem pickup; games/codex once.
      // (Both scaffolds have since been deleted — those names are the bug's, not live paths.)
      const { spawnEntity, destroyEntity, findEntityById } = await getModule();
      const { world } = fakeWorld();

      const keep = spawnEntity(world, {} as never);
      const gone = spawnEntity(world, {} as never);
      destroyEntity(gone, world);

      expect(findEntityById(gone.id(), world)).toBeUndefined(); // no corpse
      expect(findEntityById(keep.id(), world)).toBe(keep);      // and its sibling is untouched
    });

    it('defaults to the current world, like every other function here', async () => {
      const { spawnEntity, destroyEntity, findEntityById, getCurrentWorld } = await getModule();
      const world = getCurrentWorld();
      // koota's real world is fine here — we only need spawn() + destroy() to exist.
      const e = spawnEntity(world);
      expect(findEntityById(e.id())).toBe(e);

      destroyEntity(e);
      expect(findEntityById(e.id())).toBeUndefined();
    });
  });
});
