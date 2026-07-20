/** canvas2DPool unit tests — allocate, release, getSlot, resize, releaseAll, destroyPool. */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();   // don't let one test's console spy leak its calls into the next
});

function mockDeps() {
  vi.doMock('pixi.js', () => {
    class MockContainer {
      children: any[] = [];
      position = { set: vi.fn() };
      scale = { set: vi.fn() };
      rotation = 0;
      destroy = vi.fn();
      addChild = vi.fn((c: any) => { this.children.push(c); });
    }
    class MockApplication {
      stage = new MockContainer();
      ticker = { stop: vi.fn() };
      renderer = { render: vi.fn(), resize: vi.fn() };
      init = vi.fn().mockResolvedValue(undefined);
      destroy = vi.fn();
    }
    return {
      Application: MockApplication,
      Container: MockContainer,
      isWebGPUSupported: () => Promise.resolve(false),
    };
  });
  vi.doMock('../../src/runtime/rendering/gpuDetect', () => ({
    getWebGPUSupported: () => Promise.resolve(false),
  }));
}

async function getModule() {
  mockDeps();
  return import('../../src/runtime/rendering/canvas2DPool');
}

describe('canvas2DPool', () => {
  describe('allocate + getSlot', () => {
    it('allocates a slot for an entity', async () => {
      const pool = await getModule();
      const slot = pool.allocate(100);

      expect(slot).not.toBeNull();
      expect(slot!.entityId).toBe(100);
      expect(slot!.canvas).toBeInstanceOf(HTMLCanvasElement);
    });

    it('returns same slot for same entity', async () => {
      const pool = await getModule();
      const slot1 = pool.allocate(200);
      const slot2 = pool.allocate(200);

      expect(slot1).toBe(slot2);
    });

    it('getSlot returns allocated slot', async () => {
      const pool = await getModule();
      pool.allocate(300);

      const slot = pool.getSlot(300);
      expect(slot).not.toBeNull();
      expect(slot!.entityId).toBe(300);
    });

    it('getSlot returns null for unallocated entity', async () => {
      const pool = await getModule();
      expect(pool.getSlot(999)).toBeNull();
    });

    it('returns null when max slots reached', async () => {
      const pool = await getModule();
      // Allocate 6 slots (MAX_SLOTS)
      for (let i = 0; i < 6; i++) {
        expect(pool.allocate(i)).not.toBeNull();
      }
      // 7th should fail
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(pool.allocate(99)).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('release', () => {
    it('releases a slot back to the pool', async () => {
      const pool = await getModule();
      pool.allocate(400);
      pool.release(400);

      expect(pool.getSlot(400)).toBeNull();
    });

    it('released slot can be reused by another entity', async () => {
      const pool = await getModule();
      const slot1 = pool.allocate(500);
      pool.release(500);

      const slot2 = pool.allocate(600);
      // Should reuse the freed slot
      expect(slot2).toBe(slot1);
      expect(slot2!.entityId).toBe(600);
    });

    it('release is safe to call for non-allocated entity', async () => {
      const pool = await getModule();
      expect(() => pool.release(9999)).not.toThrow();
    });
  });

  describe('getAllocatedEntityIds', () => {
    it('returns set of allocated IDs', async () => {
      const pool = await getModule();
      pool.allocate(10);
      pool.allocate(20);
      pool.allocate(30);

      const ids = pool.getAllocatedEntityIds();
      expect(ids).toEqual(new Set([10, 20, 30]));
    });

    it('reflects releases', async () => {
      const pool = await getModule();
      pool.allocate(10);
      pool.allocate(20);
      pool.release(10);

      const ids = pool.getAllocatedEntityIds();
      expect(ids).toEqual(new Set([20]));
    });
  });

  describe('resize', () => {
    it('sets canvas dimensions for uninitialized slot', async () => {
      const pool = await getModule();
      const slot = pool.allocate(700)!;

      pool.resize(700, 320, 480);
      expect(slot.canvas.width).toBe(320);
      expect(slot.canvas.height).toBe(480);
    });

    it('is safe to call for non-allocated entity', async () => {
      const pool = await getModule();
      expect(() => pool.resize(9999, 100, 100)).not.toThrow();
    });
  });

  describe('releaseAll', () => {
    it('releases all allocated slots', async () => {
      const pool = await getModule();
      pool.allocate(1);
      pool.allocate(2);
      pool.allocate(3);

      pool.releaseAll();

      expect(pool.getAllocatedEntityIds().size).toBe(0);
      expect(pool.getSlot(1)).toBeNull();
      expect(pool.getSlot(2)).toBeNull();
      expect(pool.getSlot(3)).toBeNull();
    });
  });

  describe('destroyPool', () => {
    it('destroys all slots and resets state', async () => {
      const pool = await getModule();
      pool.allocate(1);
      pool.allocate(2);

      pool.destroyPool();

      expect(pool.getAllocatedEntityIds().size).toBe(0);
      expect(pool.getApp()).toBeNull();
    });
  });

  describe('getApp', () => {
    it('returns null when no slots are initialized', async () => {
      const pool = await getModule();
      expect(pool.getApp()).toBeNull();
    });

    it('returns an app after a slot is initialized', async () => {
      const pool = await getModule();
      const slot = pool.allocate(800)!;
      // Wait for init to complete
      await slot.ready;

      expect(pool.getApp()).not.toBeNull();
    });
  });

  // Phase 5: the global GPU-context counter tracks live Applications across pools (a leak/heavy-scene
  // canary). It rises on a slot's Application init and falls on destroy.
  describe('live GPU-context count', () => {
    it('increments on init and drops to zero on destroyPool', async () => {
      const pool = await getModule();
      expect(pool.liveCanvas2DContextCount()).toBe(0);
      const s1 = pool.allocate(1)!;
      const s2 = pool.allocate(2)!;
      await Promise.all([s1.ready, s2.ready]);
      expect(pool.liveCanvas2DContextCount()).toBe(2);
      pool.destroyPool();
      expect(pool.liveCanvas2DContextCount()).toBe(0);
    });
  });

  // Two-claim ownership: a slot has a sim claim (Scene2D allocate/release) and a
  // mount claim (Canvas2DMount mount/unmount); it's reclaimed only when BOTH drop.
  describe('mount/unmount ownership (F5/F6)', () => {
    it('mount → unmount reclaims the slot, and a new entity reuses it', async () => {
      const pool = await getModule();
      const a = pool.mount(1)!;
      pool.unmount(1);                       // canvas left DOM, sim never claimed → reclaimed
      expect(pool.getSlot(1)).toBeNull();
      const b = pool.mount(2)!;              // distinct entity reuses the freed slot
      expect(b).toBe(a);
    });

    it('mount/unmount churn of distinct entities never exhausts the pool (F5)', async () => {
      const pool = await getModule();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (let i = 0; i < 20; i++) {
        expect(pool.mount(i)).not.toBeNull(); // would go null after 6 without unmount-reclaim
        pool.unmount(i);
      }
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('keeps a sim-released slot alive while its canvas is still mounted, reclaims on unmount (F6)', async () => {
      const pool = await getModule();
      const slot = pool.mount(1)!;           // Canvas2DMount claim
      pool.allocate(1);                      // Scene2D claim (same slot)
      pool.release(1);                       // entity left the world — canvas still mounted
      expect(pool.getSlot(1)).toBe(slot);    // survives: mount claim still held
      pool.unmount(1);                       // canvas left DOM — now fully unclaimed
      expect(pool.getSlot(1)).toBeNull();
    });

    it('releaseAll keeps a mounted slot but drops the sim claim', async () => {
      const pool = await getModule();
      const slot = pool.mount(1)!;
      pool.allocate(1);
      pool.releaseAll();                     // world swap drops sim claims
      expect(pool.getSlot(1)).toBe(slot);    // mounted → survives
      expect(pool.getAllocatedEntityIds().has(1)).toBe(true);
      pool.unmount(1);
      expect(pool.getSlot(1)).toBeNull();
    });

    it('renderAll renders only the canvases in the dirty set (F1)', async () => {
      const pool = await getModule();
      const s1 = pool.allocate(1)!;
      const s2 = pool.allocate(2)!;
      // Size both so the <=1 "not yet sized" guard doesn't skip them.
      s1.canvas.width = 320; s1.canvas.height = 480;
      s2.canvas.width = 320; s2.canvas.height = 480;
      await Promise.all([s1.ready, s2.ready]);

      pool.renderAll(new Set([1]));                          // only canvas 1 dirty
      expect(s1.app.renderer.render).toHaveBeenCalledTimes(1);
      expect(s2.app.renderer.render).not.toHaveBeenCalled();

      pool.renderAll();                                      // no set → render all (back-compat)
      expect(s1.app.renderer.render).toHaveBeenCalledTimes(2);
      expect(s2.app.renderer.render).toHaveBeenCalledTimes(1);

      pool.renderAll(new Set());                             // empty set → render nothing
      expect(s1.app.renderer.render).toHaveBeenCalledTimes(2);
      expect(s2.app.renderer.render).toHaveBeenCalledTimes(1);
    });

    it('silently isolates a one-frame teardown throw (world swap) — no throw, no warn', async () => {
      const pool = await getModule();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s1 = pool.allocate(1)!;
      const s2 = pool.allocate(2)!;
      s1.canvas.width = 320; s1.canvas.height = 480;
      s2.canvas.width = 320; s2.canvas.height = 480;
      await Promise.all([s1.ready, s2.ready]);
      // s1's renderer is mid-teardown: render() throws (PixiJS batcher null). renderAll
      // must swallow it (no throw out of the frame callback), still render the healthy
      // s2, and NOT warn — a one-frame blip is expected during a swap.
      (s1.app.renderer.render as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new TypeError("Cannot read properties of null (reading 'clear')"); });
      expect(() => pool.renderAll()).not.toThrow();
      expect(s2.app.renderer.render).toHaveBeenCalledTimes(1); // healthy slot still rendered
      expect(warn).not.toHaveBeenCalled();                     // transient ⇒ silent
    });

    it('warns ONCE when a renderer is stuck (throws many consecutive frames)', async () => {
      const pool = await getModule();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s1 = pool.allocate(1)!;
      s1.canvas.width = 320; s1.canvas.height = 480;
      await s1.ready;
      (s1.app.renderer.render as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new TypeError('stuck'); });
      for (let i = 0; i < 50; i++) pool.renderAll(); // sustained failure
      const stuck = warn.mock.calls.filter((c) => String(c[0]).includes('stuck renderer'));
      expect(stuck).toHaveLength(1); // surfaced exactly once, not every frame
    });

    it('a successful render resets the fail streak (transient blip never escalates)', async () => {
      const pool = await getModule();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s1 = pool.allocate(1)!;
      s1.canvas.width = 320; s1.canvas.height = 480;
      await s1.ready;
      const render = s1.app.renderer.render as ReturnType<typeof vi.fn>;
      // Alternate throw/success for many frames — never 30 consecutive ⇒ never warns.
      for (let i = 0; i < 100; i++) {
        render.mockImplementationOnce(i % 2 === 0 ? () => { throw new Error('blip'); } : () => {});
        pool.renderAll();
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('skips a slot whose renderer was torn down to null (no throw)', async () => {
      const pool = await getModule();
      const s1 = pool.allocate(1)!;
      s1.canvas.width = 320; s1.canvas.height = 480;
      await s1.ready;
      (s1.app as { renderer: unknown }).renderer = null; // app destroyed out from under the slot
      expect(() => pool.renderAll()).not.toThrow();
    });

    it('shrink spares an unclaimed slot whose canvas is still in the DOM (F6 guard)', async () => {
      const pool = await getModule();
      const s1 = pool.allocate(1)!;
      const s2 = pool.allocate(2)!;
      await Promise.all([s1.ready, s2.ready]);
      // Simulate a decoupled mount: canvas in the DOM but the slot gets sim-released
      // without a paired mount claim. The DOM guard must still protect it.
      document.body.appendChild(s1.canvas);
      pool.release(1);                       // unclaimed (entityId null), canvas IN dom
      pool.release(2);                       // unclaimed, canvas NOT in dom
      pool.renderAll();                      // shrink keeps ≥1 spare
      expect(s1.app.destroy).not.toHaveBeenCalled();  // spared — canvas on screen
      expect(s2.app.destroy).toHaveBeenCalled();       // safe spare beyond 1 destroyed
      document.body.removeChild(s1.canvas);
    });
  });
});

// resolvePixiBackend is the SINGLE source of truth for "which Canvas2D backend". It honors an
// explicit `pixi.backend` render-setting WITHOUT probing hardware, and only falls back to
// getWebGPUSupported() detection for 'auto'. Detection is mocked with a spy so the not-called
// cases are asserted directly.
describe('resolvePixiBackend', () => {
  async function setup(webgpu: boolean) {
    const getWebGPUSupported = vi.fn().mockResolvedValue(webgpu);
    vi.doMock('pixi.js', () => ({ Application: class {}, Container: class {}, isWebGPUSupported: () => Promise.resolve(webgpu) }));
    vi.doMock('../../src/runtime/rendering/gpuDetect', () => ({ getWebGPUSupported }));
    const pool = await import('../../src/runtime/rendering/canvas2DPool');
    const rs = await import('../../src/runtime/rendering/renderSettings');
    return { pool, rs, getWebGPUSupported };
  }

  it("honors an explicit 'webgpu' setting without consulting detection", async () => {
    const { pool, rs, getWebGPUSupported } = await setup(false); // detection would say webgl — must be ignored
    rs.setRenderSettings({ pixi: { backend: 'webgpu', antialias: true, resolution: 0 } });
    await expect(pool.resolvePixiBackend()).resolves.toBe('webgpu');
    expect(getWebGPUSupported).not.toHaveBeenCalled();
  });

  it("honors an explicit 'webgl' setting without consulting detection", async () => {
    const { pool, rs, getWebGPUSupported } = await setup(true); // detection would say webgpu — must be ignored
    rs.setRenderSettings({ pixi: { backend: 'webgl', antialias: true, resolution: 0 } });
    await expect(pool.resolvePixiBackend()).resolves.toBe('webgl');
    expect(getWebGPUSupported).not.toHaveBeenCalled();
  });

  it("falls back to detection for 'auto' → webgpu when supported", async () => {
    const { pool, rs, getWebGPUSupported } = await setup(true);
    rs.setRenderSettings({ pixi: { backend: 'auto', antialias: true, resolution: 0 } });
    await expect(pool.resolvePixiBackend()).resolves.toBe('webgpu');
    expect(getWebGPUSupported).toHaveBeenCalled();
  });

  it("falls back to detection for 'auto' → webgl when unsupported", async () => {
    const { pool, rs, getWebGPUSupported } = await setup(false);
    rs.setRenderSettings({ pixi: { backend: 'auto', antialias: true, resolution: 0 } });
    await expect(pool.resolvePixiBackend()).resolves.toBe('webgl');
    expect(getWebGPUSupported).toHaveBeenCalled();
  });
});
