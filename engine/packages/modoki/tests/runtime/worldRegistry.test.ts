/** worldRegistry unit tests — world lifecycle, swap listeners, entity index. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { World } from 'koota';

beforeEach(() => {
  vi.resetModules();
});

async function getModule() {
  return import('../../src/runtime/core/ecs/worldRegistry');
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

    describe('a listener that throws (#888)', () => {
      // koota caps the process at 16 live worlds and `releaseWorldId` reclaims LIFO, so a suite
      // that only ever creates worlds runs the pool dry — this block was what tipped this file
      // over. Destroy in reverse creation order so the ids actually come back.
      const spawned: World[] = [];
      afterEach(() => {
        for (let i = spawned.length - 1; i >= 0; i--) {
          try { spawned[i]!.destroy(); } catch { /* already gone */ }
        }
        spawned.length = 0;
        // Required, not hygiene: `vi.spyOn` hands back the EXISTING mock when the property is
        // already spied, so without this the console.error spy is one object shared by every test
        // in this block and its call count is the running total (measured: 4, not 1).
        vi.restoreAllMocks();
      });

      it('does not starve the listeners registered after it', async () => {
        // `Set` iteration order is registration order, so before the fix everything behind the
        // thrower never fired for that swap — permanently, since the loop is not resumable and
        // nothing retries it. ~50 subscribers register `onWorldSwap` across the engine.
        const { getCurrentWorld, setCurrentWorld, onWorldSwap } = await getModule();
        const { createWorld } = await import('koota');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        spawned.push(getCurrentWorld());
        const next = createWorld();
        spawned.push(next);

        const before = vi.fn();
        const after = vi.fn();
        onWorldSwap(before);
        onWorldSwap(() => { throw new Error('listener boom'); });
        onWorldSwap(after);

        setCurrentWorld(next);

        expect(before).toHaveBeenCalledOnce();
        expect(after).toHaveBeenCalledOnce();
      });

      it('does not propagate out of setCurrentWorld — the promoter\'s tail must still run', async () => {
        // This is the consequence that made #888 dangerous rather than merely lossy: the throw
        // unwound into `SceneManager.loadScene`'s tail, skipping `nextWorld = null` and
        // `swapped = true`, so its `catch` released the live scene's resources and destroyed the
        // world it had just promoted.
        const { getCurrentWorld, setCurrentWorld, onWorldSwap } = await getModule();
        const { createWorld } = await import('koota');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        spawned.push(getCurrentWorld());
        const next = createWorld();
        spawned.push(next);
        onWorldSwap(() => { throw new Error('listener boom'); });

        expect(() => setCurrentWorld(next)).not.toThrow();
      });

      it('still promotes the world — the swap is committed, not rolled back', async () => {
        const { getCurrentWorld, setCurrentWorld, onWorldSwap } = await getModule();
        const { createWorld } = await import('koota');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        spawned.push(getCurrentWorld());
        const next = createWorld();
        spawned.push(next);
        onWorldSwap(() => { throw new Error('listener boom'); });

        setCurrentWorld(next);

        expect(getCurrentWorld()).toBe(next);
      });

      it('reports the throw rather than swallowing it silently', async () => {
        // A contained error that says nothing is how a dead listener stays dead for months.
        const { getCurrentWorld, setCurrentWorld, onWorldSwap } = await getModule();
        const { createWorld } = await import('koota');
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        spawned.push(getCurrentWorld());
        const next = createWorld();
        spawned.push(next);
        onWorldSwap(() => { throw new Error('listener boom'); });

        setCurrentWorld(next);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0]?.[0])).toContain('[worldRegistry]');
      });
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
