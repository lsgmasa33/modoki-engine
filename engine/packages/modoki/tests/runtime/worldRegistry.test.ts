/** worldRegistry unit tests — world lifecycle, swap listeners, entity index. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function getModule() {
  return import('../../../src/runtime/ecs/worldRegistry');
}

describe('worldRegistry', () => {
  describe('getCurrentWorld', () => {
    it('returns a world on first call (lazy creation)', async () => {
      const { getCurrentWorld } = await getModule();
      const world = getCurrentWorld();
      expect(world).toBeDefined();
      expect(typeof world.spawn).toBe('function');
    });

    it('returns the same world on repeated calls', async () => {
      const { getCurrentWorld } = await getModule();
      const w1 = getCurrentWorld();
      const w2 = getCurrentWorld();
      expect(w1).toBe(w2);
    });
  });

  describe('setCurrentWorld', () => {
    it('changes the current world', async () => {
      const { getCurrentWorld, setCurrentWorld } = await getModule();
      const { createWorld } = await import('koota');
      const old = getCurrentWorld();
      const next = createWorld();
      setCurrentWorld(next);
      expect(getCurrentWorld()).toBe(next);
      expect(getCurrentWorld()).not.toBe(old);
    });

    it('fires swap listeners with (new, old)', async () => {
      const { getCurrentWorld, setCurrentWorld, onWorldSwap } = await getModule();
      const { createWorld } = await import('koota');
      const old = getCurrentWorld();
      const next = createWorld();

      const listener = vi.fn();
      onWorldSwap(listener);
      setCurrentWorld(next);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(next, old);
    });

    it('is a no-op when setting the same world', async () => {
      const { getCurrentWorld, setCurrentWorld, onWorldSwap } = await getModule();
      const world = getCurrentWorld();
      const listener = vi.fn();
      onWorldSwap(listener);
      setCurrentWorld(world);
      expect(listener).not.toHaveBeenCalled();
    });

    it('fires multiple listeners', async () => {
      const { getCurrentWorld, setCurrentWorld, onWorldSwap } = await getModule();
      const { createWorld } = await import('koota');
      getCurrentWorld();
      const next = createWorld();

      const l1 = vi.fn();
      const l2 = vi.fn();
      onWorldSwap(l1);
      onWorldSwap(l2);
      setCurrentWorld(next);

      expect(l1).toHaveBeenCalledOnce();
      expect(l2).toHaveBeenCalledOnce();
    });
  });

  describe('onWorldSwap', () => {
    it('returns an unsubscribe function', async () => {
      const { getCurrentWorld, setCurrentWorld, onWorldSwap } = await getModule();
      const { createWorld } = await import('koota');
      getCurrentWorld();

      const listener = vi.fn();
      const unsub = onWorldSwap(listener);

      unsub();
      setCurrentWorld(createWorld());
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('getEntityIndex', () => {
    it('returns a Map for the current world', async () => {
      const { getCurrentWorld, getEntityIndex } = await getModule();
      const world = getCurrentWorld();
      const idx = getEntityIndex(world);
      expect(idx).toBeInstanceOf(Map);
    });

    it('returns the same Map for the same world on repeated calls', async () => {
      const { getCurrentWorld, getEntityIndex } = await getModule();
      const world = getCurrentWorld();
      const idx1 = getEntityIndex(world);
      const idx2 = getEntityIndex(world);
      expect(idx1).toBe(idx2);
    });

    it('creates a new Map for a new world', async () => {
      const { getCurrentWorld, getEntityIndex } = await getModule();
      const { createWorld } = await import('koota');
      const world1 = getCurrentWorld();
      const world2 = createWorld();
      const idx1 = getEntityIndex(world1);
      const idx2 = getEntityIndex(world2);
      expect(idx1).not.toBe(idx2);
    });

    it('persists entries between calls', async () => {
      const { getCurrentWorld, getEntityIndex } = await getModule();
      const world = getCurrentWorld();
      const idx = getEntityIndex(world);
      idx.set(42, { id: 42 });
      expect(getEntityIndex(world).get(42)).toEqual({ id: 42 });
    });
  });
});
