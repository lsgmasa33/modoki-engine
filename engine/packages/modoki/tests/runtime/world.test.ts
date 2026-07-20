/** world.ts unit tests — findEntityById, registerEntity, unregisterEntity. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function getModule() {
  return import('../../src/runtime/ecs/world');
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
});
