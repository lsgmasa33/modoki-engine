/** Scene2D.renderFrame integration harness (missing-tests #1).
 *
 *  The pure 2D modules (routing, scaler, render2DUtils, paintOrder) are well unit
 *  tested; the STATEFUL glue in Scene2D.renderFrame — pool-slot allocation,
 *  primitive-vs-sprite display-object creation, slot replacement on sprite
 *  kind/URL change, paint-order zIndex, dispose-on-removal, texture refcount
 *  balance, and world-swap teardown — had zero coverage. This is the scaffold the
 *  review calls out as "where F2/F3/F4 would have been caught": a real koota world
 *  + the REAL canvas2DPool, driven over a hand-rolled PixiJS mock.
 *
 *  The Pixi mock mirrors the few semantics renderFrame/pool actually rely on:
 *  addChild sets `parent` + pushes to `children`; removeFromParent splices and
 *  nulls `parent`; destroy() marks `destroyed`. That fidelity is what lets this
 *  same harness later assert the F3/F4 fixes (no double-decrement / no destroy of
 *  an already-destroyed object) without rewriting the setup.
 */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// koota's world-id pool (max 16) is global and survives vi.resetModules, so every
// world this harness creates must be destroyed or the suite exhausts the pool.
const createdWorlds: any[] = [];
function trackWorld<T>(w: T): T { createdWorlds.push(w); return w; }

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  for (const w of createdWorlds) { try { w.destroy(); } catch { /* already disposed */ } }
  createdWorlds.length = 0;
});

// ── PixiJS mock ────────────────────────────────────────────────────────────
// Shared by both the module-under-test (Graphics/Sprite/Texture/Assets) and the
// real canvas2DPool it drives (Application/Container). vi.doMock keys match the
// specifier each module imports — both resolve to this one mock instance.
function mockDeps() {
  vi.doMock('pixi.js', () => {
    class Display {
      parent: any = null;
      destroyed = false;
      destroyCount = 0;        // catches double-teardown (F4)
      zIndex = 0;
      rotation = 0;
      _x = 0; _y = 0; _sx = 1; _sy = 1;
      position = { set: (x: number, y: number) => { this._x = x; this._y = y; } };
      scale = { set: (x: number, y: number) => { this._sx = x; this._sy = y; } };
      removeFromParent() {
        if (this.parent) {
          const i = this.parent.children.indexOf(this);
          if (i >= 0) this.parent.children.splice(i, 1);
          this.parent = null;
        }
      }
      destroy() { this.destroyCount++; this.removeFromParent(); this.destroyed = true; }
    }
    class Container extends Display {
      children: any[] = [];
      sortableChildren = false;
      addChild(c: any) {
        if (c.parent) c.removeFromParent();
        c.parent = this;
        this.children.push(c);
        return c;
      }
    }
    class Texture {
      static EMPTY = { width: 0, height: 0 };
      static WHITE = { width: 1, height: 1, source: { style: {} }, textureMatrix: { mapCoord: {} } };
      width = 0; height = 0; source: any; textureMatrix = { mapCoord: {} };
      destroy = vi.fn();
      // Framed wrapper (new Texture({ source, frame })): carry the borrowed source so the
      // material pass's source-ready guard passes; width/height come from the sub-rect.
      constructor(opts?: any) { this.source = opts?.source; if (opts?.frame) { this.width = opts.frame.width ?? 0; this.height = opts.frame.height ?? 0; } }
    }
    class MeshGeometry { destroy = vi.fn(); constructor(public opts?: any) {} }
    class Mesh extends Display {
      kind = 'material';
      geometry: any; texture: any; shader: any; tint = 0xffffff; blendMode = 'normal';
      constructor(opts: any) { super(); this.geometry = opts?.geometry; this.texture = opts?.texture; this.shader = opts?.shader; }
    }
    class Rectangle { x: number; y: number; width: number; height: number; constructor(x = 0, y = 0, w = 0, h = 0) { this.x = x; this.y = y; this.width = w; this.height = h; } }
    class Graphics extends Display {
      kind = 'graphics';
      clear = vi.fn(() => this);
      rect = vi.fn(() => this);
      circle = vi.fn(() => this);
      moveTo = vi.fn(() => this);
      lineTo = vi.fn(() => this);
      closePath = vi.fn(() => this);
      ellipse = vi.fn(() => this);
      fill = vi.fn(() => this);
      stroke = vi.fn(() => this);
    }
    class Sprite extends Display {
      kind = 'sprite';
      texture: any;
      tint = 0xffffff;
      _ax = 0.5; _ay = 0.5;
      anchor = { set: (x: number, y?: number) => { this._ax = x; this._ay = y === undefined ? x : y; } };
      constructor(texture?: any) { super(); this.texture = texture ?? Texture.EMPTY; }
    }
    class Application {
      stage = new Container();
      ticker = { stop: vi.fn() };
      renderer = { render: vi.fn(), resize: vi.fn() };
      init = vi.fn().mockResolvedValue(undefined);
      destroy = vi.fn();
    }
    // Assets-backed texture cache. __seed makes a url resolve synchronously in
    // makeSprite (cache hit → no async load); __unloaded records release-driven
    // Assets.unload calls so refcount tests can assert "unloaded on last release".
    const cacheMap = new Map<string, any>();
    const unloaded: string[] = [];
    const Assets = {
      cache: { has: (url: string) => cacheMap.has(url) },
      get: (url: string) => cacheMap.get(url),
      load: (url: string) => {
        // Loaded textures carry a live `source` (with a `.style`) — the 2D-material path
        // binds `texture.source.style`, so a source-less texture would (correctly) be
        // rejected as not-ready. Mirror a real decoded texture here.
        const t = cacheMap.get(url) ?? { width: 32, height: 32, source: { style: {} } };
        cacheMap.set(url, t);
        return Promise.resolve(t);
      },
      unload: (url: string) => { unloaded.push(url); cacheMap.delete(url); return Promise.resolve(); },
      __seed: (url: string, tex: any) => cacheMap.set(url, tex),
      __unloaded: unloaded,
    };
    // extensions.add(loadKTX2) is called by ensurePixiKtxTranscoder during startScene2D
    // (v8 doesn't auto-register the KTX2 parser); stub both so the transcoder setup is a no-op.
    return { Application, Container, Texture, Rectangle, Graphics, Sprite, Mesh, MeshGeometry, Assets, isWebGPUSupported: () => Promise.resolve(false), setKTXTranscoderPath: () => {}, extensions: { add: () => {} }, loadKTX2: {} };
  });

  vi.doMock('../../src/runtime/rendering/gpuDetect', () => ({
    getWebGPUSupported: () => Promise.resolve(false),
  }));

  // 2D-material seam: a controllable map of GUID → program readiness, and a shader
  // factory that stamps a unique sentinel per entity so tests can assert per-entity
  // Shaders. `__materialReady` toggles a GUID's program on/off (loading vs ready).
  const readyMaterials = new Set<string>();
  // `textureParams` defaults to [] (no extra samplers) so existing material tests are
  // unaffected; the extra-sampler tests mutate __program.textureParams for their case.
  const sharedProgram: { params: any[]; textureParams: [string, any][]; manifest: any } = { params: [], textureParams: [], manifest: {} };
  const clearSpy = vi.fn();
  vi.doMock('../../src/runtime/loaders/spriteMaterialCache', () => ({
    ensureSpriteMaterial: (guid: string) => (readyMaterials.has(guid) ? sharedProgram : undefined),
    getSpriteMaterialProgram: (guid: string) => (readyMaterials.has(guid) ? sharedProgram : undefined),
    clearSpriteMaterialCache: clearSpy,
    __ready: readyMaterials,
    __program: sharedProgram,
    __clearSpy: clearSpy,
  }));
  let shaderSeq = 0;
  vi.doMock('../../src/runtime/rendering/pixiShaderBuilder', () => ({
    // Capture the texture the material pass bound as uTexture, and the extra-sampler map
    // (4th arg), so tests can assert the entity samples its own sprite bitmap AND that each
    // texture param resolved to its bound Texture (vs the Texture.WHITE fallback).
    makePixiShaderInstance: (_program: any, texture: any, _values: any, extraTextures: any) =>
      ({ id: ++shaderSeq, texture, extraTextures, destroyed: false, destroy() { this.destroyed = true; } }),
  }));

  // Stub the asset/texture-resolver surface so the harness needs no manifest.
  //  - A 'http…' / '/…' ref is a passthrough image url (ref === resolved url) — the
  //    balanced-refcount case used by the green tests.
  //  - An 'img:<url>' ref resolves to a DIFFERENT url (mirrors the production
  //    GUID→path divergence) — used to pin the F3 keying bug below.
  // getWorldTransform2D / resolvePrimitiveShape mirror the real (pure) logic.
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({
    isImagePath: (ref: string) =>
      typeof ref === 'string' && (ref.startsWith('sheet:') || ref.startsWith('img:') || ref.startsWith('http') || ref.startsWith('/')),
    resolveImageUrl: (ref: string) => {
      if (typeof ref !== 'string') return undefined;
      if (ref.startsWith('sheet:')) return 'http://t/sheet.png';
      if (ref.startsWith('img:')) return ref.slice(4);
      if (ref.startsWith('http') || ref.startsWith('/')) return ref;
      return undefined;
    },
    resolveSprite: (ref: string) => {
      if (typeof ref !== 'string') return undefined;
      // `sheet:<i>` → a sliced FRAME of one shared sheet (same url, different sub-rect) —
      // the sprite-sheet animation case the in-place frame-swap path targets.
      const m = /^sheet:(\d+)$/.exec(ref);
      if (m) { const i = +m[1]; return { url: 'http://t/sheet.png', frame: { x: i * 10, y: 0, w: 10, h: 10 }, pivot: null, sheetW: 100, sheetH: 10 }; }
      let url: string | undefined;
      if (ref.startsWith('img:')) url = ref.slice(4);
      else if (ref.startsWith('http') || ref.startsWith('/')) url = ref;
      if (!url) return undefined;
      return { url, frame: null, pivot: null, sheetW: null, sheetH: null };
    },
    resolvePrimitiveShape: (s: string) => (s === 'square' ? 'square' : s === 'triangle' ? 'triangle' : 'circle'),
    getWorldTransform2D: (_id: number, tf: any) => ({ x: tf.x, y: tf.y, rz: tf.rz, sx: tf.sx, sy: tf.sy }),
  }));
}

async function setup(opts: { start?: boolean } = {}) {
  mockDeps();
  const pixi: any = await import('pixi.js');
  const traits = await import('../../src/runtime/traits');
  const { registerTrait } = await import('../../src/runtime/ecs/traitRegistry');
  const worldReg = await import('../../src/runtime/ecs/worldRegistry');
  const pool = await import('../../src/runtime/rendering/canvas2DPool');
  const scene2d = await import('../../src/runtime/rendering/Scene2D');
  const { createWorld } = await import('koota');

  // cacheTraits() resolves Canvas2D + EntityAttributes by NAME from the registry;
  // the registered `.trait` must be the same objects we spawn entities with.
  registerTrait({ name: 'Canvas2D', trait: traits.Canvas2D, category: 'component', fields: {} });
  registerTrait({ name: 'EntityAttributes', trait: traits.EntityAttributes, category: 'component', fields: {} });

  trackWorld(worldReg.getCurrentWorld());        // materialize + track the lazy default
  const world = trackWorld(createWorld());
  worldReg.setCurrentWorld(world);
  if (opts.start) scene2d.startScene2D();

  const matCache: any = await import('../../src/runtime/loaders/spriteMaterialCache');
  const newWorld = () => trackWorld(createWorld());
  return { pixi, traits, registerTrait, worldReg, pool, scene2d, world, newWorld, matReady: matCache.__ready as Set<string>, matProgram: matCache.__program as { params: any[]; textureParams: [string, any][]; manifest: any }, matClearSpy: matCache.__clearSpy };
}

// Spawn a Canvas2D host entity (root). Returns the koota entity.
function spawnCanvas(world: any, traits: any, sortOrder = 0) {
  return world.spawn(
    traits.Canvas2D({ referenceWidth: 1080, referenceHeight: 1920, scaleMode: 'fitH' }),
    traits.EntityAttributes({ name: 'canvas', parentId: 0, sortOrder, layer: 'ui' }),
  );
}

// Spawn a Renderable2D child parented to a canvas.
function spawnChild(world: any, traits: any, canvasId: number, rend: any = {}, sortOrder = 0) {
  return world.spawn(
    traits.Transform({}),
    traits.Renderable2D({ sprite: 'square', color: 0xffffff, width: 10, height: 10, ...rend }),
    traits.EntityAttributes({ name: 'child', parentId: canvasId, sortOrder, layer: '2d' }),
  );
}

describe('Scene2D.renderFrame', () => {
  it('allocates a pool slot for a Canvas2D entity and parents its children there', async () => {
    const { traits, pool, scene2d, world } = await setup();
    const canvas = spawnCanvas(world, traits);
    spawnChild(world, traits, canvas.id());

    scene2d.renderFrame();

    expect(pool.getAllocatedEntityIds().has(canvas.id())).toBe(true);
    const slot = pool.getSlot(canvas.id())!;
    expect(slot).not.toBeNull();
    expect(slot.container.children.length).toBe(1);
  });

  it('creates a Graphics for a primitive and draws it with the entity color', async () => {
    const { traits, pool, scene2d, world } = await setup();
    const canvas = spawnCanvas(world, traits);
    spawnChild(world, traits, canvas.id(), { sprite: 'square', color: 0x123456, width: 10, height: 20 });

    scene2d.renderFrame();

    const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(obj.kind).toBe('graphics');
    expect(obj.clear).toHaveBeenCalled();
    expect(obj.rect).toHaveBeenCalled();          // square → rect
    expect(obj.fill).toHaveBeenCalledWith(0x123456);
  });

  it('creates a Sprite for an image ref and binds the cached texture + tint', async () => {
    const { pixi, traits, pool, scene2d, world } = await setup();
    pixi.Assets.__seed('/a.png', { width: 64, height: 64 });
    const canvas = spawnCanvas(world, traits);
    spawnChild(world, traits, canvas.id(), { sprite: 'img:/a.png', color: 0x00ff00 });

    scene2d.renderFrame();

    const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(obj.kind).toBe('sprite');
    expect(obj.texture.width).toBe(64);            // resolved synchronously from cache
    expect(obj.tint).toBe(0x00ff00);
    expect(obj._ax).toBe(0.5);                     // anchor.set(pivotX, pivotY)
  });

  // Phase 0 (2D materials): Renderable2D.blendMode maps onto the Pixi view's blendMode
  // for both the primitive (Graphics) and image (Sprite) paths, defaults to 'normal',
  // and re-applies when edited (change detection includes blend).
  describe('blend mode', () => {
    it('applies blendMode to a primitive (Graphics) and defaults to normal', async () => {
      const { traits, pool, scene2d, world } = await setup();
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'square', blendMode: 'add' });
      spawnChild(world, traits, canvas.id(), { sprite: 'square' }, /* sortOrder */ 1); // no blendMode → normal

      scene2d.renderFrame();

      const kids = pool.getSlot(canvas.id())!.container.children as any[];
      expect(kids[0].blendMode).toBe('add');
      expect(kids[1].blendMode).toBe('normal');
    });

    it('applies blendMode to an image Sprite', async () => {
      const { pixi, traits, pool, scene2d, world } = await setup();
      pixi.Assets.__seed('/a.png', { width: 64, height: 64 });
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'img:/a.png', blendMode: 'screen' });

      scene2d.renderFrame();

      const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(obj.kind).toBe('sprite');
      expect(obj.blendMode).toBe('screen');
    });

    it('re-applies when blendMode is edited (change detection includes blend)', async () => {
      const { traits, pool, scene2d, world } = await setup();
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'square' });

      scene2d.renderFrame();
      const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(obj.blendMode).toBe('normal');

      child.set(traits.Renderable2D, { ...child.get(traits.Renderable2D), blendMode: 'multiply' });
      scene2d.renderFrame();
      expect(obj.blendMode).toBe('multiply');
    });

    it('coerces an unknown blendMode value to normal', async () => {
      const { traits, pool, scene2d, world } = await setup();
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'square', blendMode: 'bogus' as any });

      scene2d.renderFrame();

      const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(obj.blendMode).toBe('normal');
    });
  });

  // Phase 2 (2D materials): an entity with Renderable2D.material whose program is ready
  // renders as a 'material' Mesh via a per-entity Shader (registered in entityShaders);
  // it's skipped by the sprite pass. While the program is loading it falls back to the
  // default sprite/graphics. Kind switches + removal purge the Shader + slot.
  describe('2D material pass', () => {
    it('renders a ready-material entity as a Mesh with tint + blend + a pivot quad', async () => {
      const { traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'square', material: 'matGuid', blendMode: 'add', color: 0x00ff00, width: 10, height: 20 });

      scene2d.renderFrame();

      const kids = pool.getSlot(canvas.id())!.container.children as any[];
      expect(kids).toHaveLength(1);
      expect(kids[0].kind).toBe('material');       // a Mesh, not a Graphics
      expect(kids[0].shader.id).toBeGreaterThan(0);
      expect(kids[0].blendMode).toBe('add');
      expect(kids[0].tint).toBe(0x00ff00);
      // Geometry: a centered (pivot 0.5) quad of full size width*2 × height*2, UVs 0..1.
      const g = kids[0].geometry.opts;
      expect(Array.from(g.positions)).toEqual([-10, -20, 10, -20, 10, 20, -10, 20]);
      expect(Array.from(g.uvs)).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
      expect(Array.from(g.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    });

    it('applies flip (scale sign), paint-order zIndex, and alpha to the material mesh', async () => {
      const { traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'square', material: 'matGuid', opacity: 0.5, flipX: true, flipY: true }, /* sortOrder */ 0);
      spawnChild(world, traits, canvas.id(), { sprite: 'square', material: 'matGuid' }, /* sortOrder */ 5);

      scene2d.renderFrame();

      const kids = pool.getSlot(canvas.id())!.container.children as any[];
      const flipped = kids.find((k) => k.alpha === 0.5)!;
      const plain = kids.find((k) => k.alpha !== 0.5)!;
      expect(flipped._sx).toBeLessThan(0);          // flipX → negative x scale
      expect(flipped._sy).toBeLessThan(0);          // flipY → negative y scale
      expect(flipped.zIndex).toBeLessThan(plain.zIndex); // higher sortOrder paints on top
    });

    it('clears the 2D-material program cache on world swap AND on final stop', async () => {
      const { traits, scene2d, world, worldReg, newWorld, matReady, matClearSpy } = await setup({ start: true });
      matReady.add('matGuid');
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'square', material: 'matGuid' });
      scene2d.renderFrame();

      matClearSpy.mockClear();
      worldReg.setCurrentWorld(newWorld());         // world swap → unconditional cache clear
      expect(matClearSpy).toHaveBeenCalled();

      matClearSpy.mockClear();
      scene2d.stopScene2D();
      expect(matClearSpy).toHaveBeenCalled();
    });

    it('registers + purges the entity Shader in the renderer.entityShaders map', async () => {
      const { traits, scene2d, pool, world, matReady } = await setup();
      matReady.add('matGuid');
      const r = new scene2d.Scene2DRenderer({ pool: new pool.Canvas2DPool(), primary: false });
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'square', material: 'matGuid' });

      r.renderFrame();
      expect(r.entityShaders.has(child.id())).toBe(true);       // driver can reach this entity's shader

      child.destroy();
      r.renderFrame();
      expect(r.entityShaders.has(child.id())).toBe(false);      // purged when the entity leaves
    });

    it('falls back to the default sprite while the material program is still loading', async () => {
      const { traits, pool, scene2d, world, matReady } = await setup();
      // matGuid NOT ready → ensureSpriteMaterial returns undefined → sprite pass renders it.
      void matReady;
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'square', material: 'matGuid' });

      scene2d.renderFrame();

      const kids = pool.getSlot(canvas.id())!.container.children as any[];
      expect(kids).toHaveLength(1);
      expect(kids[0].kind).toBe('graphics');       // default primitive, not a material Mesh
    });

    it('swaps a loading→ready material from the default slot to a material Mesh', async () => {
      const { traits, pool, scene2d, world, matReady } = await setup();
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'square', material: 'matGuid' });

      scene2d.renderFrame();                        // loading → graphics
      expect((pool.getSlot(canvas.id())!.container.children[0] as any).kind).toBe('graphics');

      matReady.add('matGuid');                      // program compiled
      scene2d.markScene2DDirty();
      scene2d.renderFrame();
      const kids = pool.getSlot(canvas.id())!.container.children as any[];
      expect(kids).toHaveLength(1);                 // old graphics disposed, one material Mesh
      expect(kids[0].kind).toBe('material');
    });

    it('gives two entities off one material independent Shaders (one program)', async () => {
      const { traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'square', material: 'matGuid' }, 0);
      spawnChild(world, traits, canvas.id(), { sprite: 'square', material: 'matGuid' }, 1);

      scene2d.renderFrame();

      const kids = pool.getSlot(canvas.id())!.container.children as any[];
      expect(kids).toHaveLength(2);
      expect(kids[0].shader.id).not.toBe(kids[1].shader.id); // distinct per-entity Shaders
    });

    it('disposes the material Mesh + Shader when the entity is removed', async () => {
      const { traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'square', material: 'matGuid' });

      scene2d.renderFrame();
      const mesh = pool.getSlot(canvas.id())!.container.children[0] as any;
      const shader = mesh.shader;

      child.destroy();
      scene2d.renderFrame();

      expect(mesh.destroyed).toBe(true);
      expect(shader.destroyed).toBe(true);          // shader torn down with the slot
      expect(mesh.geometry.destroy).toHaveBeenCalled();
      expect(pool.getSlot(canvas.id())!.container.children.length).toBe(0);
    });

    // Follow-up #1: the material Mesh samples the entity's OWN sprite bitmap as uTexture.
    it("binds the entity's own resident sprite texture as uTexture (not Texture.WHITE)", async () => {
      const { pixi, traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      const hero = { width: 64, height: 64, source: { style: {} } };
      pixi.Assets.__seed('http://t/hero.png', hero);   // resident → bound synchronously
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid' });

      scene2d.renderFrame();

      const mesh = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(mesh.kind).toBe('material');
      expect(mesh.texture).toBe(hero);                 // Mesh.texture = the sprite bitmap (WebGPU group-2 rebind)
      expect(mesh.shader.texture).toBe(hero);          // and the shader's uTexture too
      expect(mesh.texture).not.toBe(pixi.Texture.WHITE);
    });

    it('falls back to Texture.WHITE while the sprite loads, then rebuilds with it once resident', async () => {
      const { pixi, traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      const canvas = spawnCanvas(world, traits);
      // Not seeded → first frame samples WHITE + kicks an async Assets.load.
      spawnChild(world, traits, canvas.id(), { sprite: 'http://t/late.png', material: 'matGuid' });

      scene2d.renderFrame();
      let mesh = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(mesh.texture).toBe(pixi.Texture.WHITE);   // still loading → WHITE

      await Promise.resolve(); await Promise.resolve(); // let the Assets.load promise settle (markDirty)
      scene2d.renderFrame();

      const kids = pool.getSlot(canvas.id())!.container.children as any[];
      expect(kids).toHaveLength(1);                    // old WHITE mesh disposed, one rebuilt
      mesh = kids[0];
      expect(mesh.kind).toBe('material');
      expect(mesh.texture).not.toBe(pixi.Texture.WHITE); // now the loaded bitmap
      expect(mesh.texture.width).toBe(32);             // Assets.load default-loaded texture
    });

    // Review finding (HIGH): the sprite loads before the shader compiles, so a sprite slot
    // holds the texture; when the material takes over, a naive release-then-retain would drop
    // the shared refcount to 0 and Assets.unload the very texture the material re-binds.
    it('does NOT unload the shared texture across the sprite→material handoff (retain-before-release)', async () => {
      const { pixi, traits, pool, scene2d, world, matReady } = await setup();
      const hero = { width: 64, height: 64, source: { style: {} } };
      pixi.Assets.__seed('http://t/hero.png', hero);      // uniquely held by this one entity
      const canvas = spawnCanvas(world, traits);
      // Material NOT ready yet → Step 3 renders it as a sprite (retains the texture).
      spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid' });

      scene2d.renderFrame();
      expect((pool.getSlot(canvas.id())!.container.children[0] as any).kind).toBe('sprite');

      matReady.add('matGuid');                            // shader compiled → material pass takes over
      scene2d.markScene2DDirty();
      scene2d.renderFrame();

      const kids = pool.getSlot(canvas.id())!.container.children as any[];
      expect(kids).toHaveLength(1);
      expect(kids[0].kind).toBe('material');
      expect(kids[0].texture).toBe(hero);                 // material binds the same live texture
      expect(pixi.Assets.__unloaded).not.toContain('http://t/hero.png'); // never dropped to 0 → not destroyed
    });

    // Review edge (b): clearing rend.material at runtime swaps a material slot → a sprite slot.
    // If the sprite reuses the material's own texture url, a naive release-then-retain drops the
    // shared refcount to 0 → Assets.unload + a re-download flicker. Retain-before-release bridges it.
    it('does NOT unload the shared texture on a material→sprite swap (material cleared at runtime)', async () => {
      const { pixi, traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      const hero = { width: 64, height: 64, source: { style: {} } };
      pixi.Assets.__seed('http://t/hero.png', hero);
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid' });

      scene2d.renderFrame();
      expect((pool.getSlot(canvas.id())!.container.children[0] as any).kind).toBe('material');

      // Clear the material → the sprite pass takes over, reusing the SAME sprite url.
      child.set(traits.Renderable2D, { ...child.get(traits.Renderable2D), material: '' });
      scene2d.markScene2DDirty();
      scene2d.renderFrame();

      const kids = pool.getSlot(canvas.id())!.container.children as any[];
      expect(kids).toHaveLength(1);
      expect(kids[0].kind).toBe('sprite');                 // now a plain sprite
      expect(pixi.Assets.__unloaded).not.toContain('http://t/hero.png'); // bridged → never hit 0
    });

    it('does NOT unload the shared texture on a same-url material rebuild (size edit)', async () => {
      const { pixi, traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      const hero = { width: 64, height: 64, source: { style: {} } };
      pixi.Assets.__seed('http://t/hero.png', hero);
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid', width: 10 });

      scene2d.renderFrame();
      child.set(traits.Renderable2D, { ...child.get(traits.Renderable2D), width: 40 }); // matSig changes, texUrl unchanged
      scene2d.markScene2DDirty();
      scene2d.renderFrame();

      const mesh = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(mesh.kind).toBe('material');
      expect(mesh.texture).toBe(hero);                    // rebuilt Mesh still binds the live texture
      expect(pixi.Assets.__unloaded).not.toContain('http://t/hero.png'); // same-url rebuild never hit refcount 0
    });

    // Perf gate (MaterialSnap): the material pass used to force a canvas redraw EVERY running
    // frame. Now it dirties the canvas only on a (re)build, a transform/appearance change, a
    // driver uniform change (sprite2DMaterialBroker flag), or an external dirty — so a static
    // material stops costing a GPU pass per frame. The harness sim defaults to 'playing', so the
    // material pass runs each frame (the idle path is a separate whole-frame skip).
    it('gates the GPU redraw — dirties the canvas on build/transform/uniform change, skips a settled frame', async () => {
      const { pixi, traits, pool, scene2d, world, matReady } = await setup();
      const broker = await import('../../src/runtime/rendering/sprite2DMaterialBroker');
      matReady.add('matGuid');
      pixi.Assets.__seed('http://t/hero.png', { width: 64, height: 64, source: { style: {} } });
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid' });

      // Capture the dirty-canvas Set handed to renderAll each frame (snapshot — it's reused).
      const dirtied: Set<number>[] = [];
      vi.spyOn(pool.Canvas2DPool.prototype, 'renderAll').mockImplementation(function (ids?: Set<number>) { dirtied.push(new Set(ids)); });

      scene2d.renderFrame();                                   // first frame: Mesh built
      expect(dirtied.at(-1)!.has(canvas.id())).toBe(true);

      scene2d.renderFrame();                                   // nothing changed, no driver flag
      expect(dirtied.at(-1)!.has(canvas.id())).toBe(false);    // → GPU redraw skipped

      child.set(traits.Transform, { ...child.get(traits.Transform), x: 42 }); // moved
      scene2d.renderFrame();
      expect(dirtied.at(-1)!.has(canvas.id())).toBe(true);     // transform change re-dirties

      scene2d.renderFrame();                                   // settled again
      expect(dirtied.at(-1)!.has(canvas.id())).toBe(false);

      broker.markEntity2DMaterialDirty(child.id());            // driver wrote a new uniform this frame
      scene2d.renderFrame();
      expect(dirtied.at(-1)!.has(canvas.id())).toBe(true);     // uniform change forces a redraw
      broker.clearEntity2DMaterialDirty();
    });

    // Review finding (HIGH): with the redraw gate, a co-resident static material no longer
    // force-dirties the canvas every frame — so hiding a material entity must itself dirty the
    // canvas, or its Mesh is removed but its last pixels stay frozen (the disposal sweep looks
    // up canvasId only in the sprite/mesh/text snaps, never lastMaterialRender).
    it('dirties the canvas when a material entity is hidden (clears the ghost)', async () => {
      const { pixi, traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      pixi.Assets.__seed('http://t/hero.png', { width: 64, height: 64, source: { style: {} } });
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid' });

      const dirtied: Set<number>[] = [];
      vi.spyOn(pool.Canvas2DPool.prototype, 'renderAll').mockImplementation(function (ids?: Set<number>) { dirtied.push(new Set(ids)); });

      scene2d.renderFrame();                                   // material drawn
      scene2d.renderFrame();                                   // settled → canvas not dirtied
      expect(dirtied.at(-1)!.has(canvas.id())).toBe(false);

      child.set(traits.Renderable2D, { ...child.get(traits.Renderable2D), isVisible: false }); // hide it
      scene2d.renderFrame();
      expect(dirtied.at(-1)!.has(canvas.id())).toBe(true);     // canvas re-rendered → ghost cleared
      expect(pool.getSlot(canvas.id())!.container.children.length).toBe(0); // Mesh disposed
    });

    it('does NOT crash the frame when the sprite is cached but not source-ready (falls back to WHITE)', async () => {
      const { pixi, traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      // Cached but mid-decode / stale-after-unload: source is null. Binding it as uTexture
      // would throw in makePixiShaderInstance (`source.style`) and kill the 2D frame loop.
      pixi.Assets.__seed('http://t/half.png', { width: 64, height: 64, source: null });
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'http://t/half.png', material: 'matGuid' });

      expect(() => scene2d.renderFrame()).not.toThrow();
      const mesh = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(mesh.kind).toBe('material');
      expect(mesh.texture).toBe(pixi.Texture.WHITE);   // fell back to WHITE, not the source-less texture
    });

    // Additional samplers: a shader's `texture` param (value = its manifest default GUID)
    // resolves whole-image through the shared refcount and binds as an extra sampler in the
    // Shader's `extraTextures` map (uTexture stays the entity's own sprite).
    it("binds a texture param's default image as an extra sampler, keeping uTexture the sprite", async () => {
      const { pixi, traits, pool, scene2d, world, matReady, matProgram } = await setup();
      matReady.add('matGuid');
      matProgram.textureParams = [['uNoise', { type: 'texture', default: 'http://t/noise.png' }]];
      const hero = { width: 64, height: 64, source: { style: {} } };
      const noise = { width: 32, height: 32, source: { style: {} } };
      pixi.Assets.__seed('http://t/hero.png', hero);
      pixi.Assets.__seed('http://t/noise.png', noise);
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid' });

      scene2d.renderFrame();

      const mesh = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(mesh.kind).toBe('material');
      expect(mesh.texture).toBe(hero);                       // uTexture = the entity's own sprite
      expect(mesh.shader.extraTextures.uNoise).toBe(noise);  // texture param → its default image
    });

    it('releases the extra-sampler texture (refcount balances) when the material entity is removed', async () => {
      const { pixi, traits, pool, scene2d, world, matReady, matProgram } = await setup();
      matReady.add('matGuid');
      matProgram.textureParams = [['uNoise', { type: 'texture', default: 'http://t/noise.png' }]];
      pixi.Assets.__seed('http://t/hero.png', { width: 64, height: 64, source: { style: {} } });
      pixi.Assets.__seed('http://t/noise.png', { width: 32, height: 32, source: { style: {} } }); // held only by this material
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid' });

      scene2d.renderFrame();
      expect(pixi.Assets.__unloaded).not.toContain('http://t/noise.png'); // held while resident

      child.destroy();
      scene2d.markScene2DDirty();
      scene2d.renderFrame();

      expect(pool.getSlot(canvas.id())!.container.children.length).toBe(0); // Mesh disposed
      expect(pixi.Assets.__unloaded).toContain('http://t/noise.png');      // last release → unloaded
    });

    it('binds WHITE for an unresolved extra sampler, then rebuilds with it once loaded', async () => {
      const { pixi, traits, pool, scene2d, world, matReady, matProgram } = await setup();
      matReady.add('matGuid');
      matProgram.textureParams = [['uNoise', { type: 'texture', default: 'http://t/latenoise.png' }]];
      pixi.Assets.__seed('http://t/hero.png', { width: 64, height: 64, source: { style: {} } });
      // latenoise NOT seeded → first frame binds WHITE + kicks an async load.
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid' });

      scene2d.renderFrame();
      let mesh = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(mesh.shader.extraTextures.uNoise).toBe(pixi.Texture.WHITE); // loading → WHITE placeholder

      await Promise.resolve(); await Promise.resolve();                   // let the load settle (markDirty)
      scene2d.renderFrame();

      const kids = pool.getSlot(canvas.id())!.container.children as any[];
      expect(kids).toHaveLength(1);                                       // old mesh disposed, one rebuilt
      mesh = kids[0];
      expect(mesh.shader.extraTextures.uNoise).not.toBe(pixi.Texture.WHITE); // now the loaded texture
      expect(mesh.shader.extraTextures.uNoise.width).toBe(32);           // Assets.load default texture
    });

    // Per-instance texture overrides: a MaterialInstance kind:'texture' override on a texture
    // param binds THAT ref instead of the shader's manifest default (an extra-sampler swap).
    it("binds a MaterialInstance kind:'texture' override instead of the param's manifest default", async () => {
      const { pixi, traits, pool, scene2d, world, matReady, matProgram } = await setup();
      matReady.add('matGuid');
      matProgram.textureParams = [['uReveal', { type: 'texture', default: 'http://t/default.png' }]];
      const def = { width: 8, height: 8, source: { style: {} } };
      const over = { width: 16, height: 16, source: { style: {} } };
      pixi.Assets.__seed('http://t/hero.png', { width: 64, height: 64, source: { style: {} } });
      pixi.Assets.__seed('http://t/default.png', def);
      pixi.Assets.__seed('http://t/override.png', over);
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid' });
      child.add(traits.MaterialInstance({ overrides: [{ target: 'uReveal', kind: 'texture', ref: 'http://t/override.png' }] }));

      scene2d.renderFrame();

      const mesh = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(mesh.shader.extraTextures.uReveal).toBe(over);   // the override ref, not the default
      expect(mesh.shader.extraTextures.uReveal).not.toBe(def);
      expect(pixi.Assets.__unloaded).not.toContain('http://t/override.png');
    });

    it('rebuilds and rebalances the refcount when a texture override ref changes', async () => {
      const { pixi, traits, pool, scene2d, world, matReady, matProgram } = await setup();
      matReady.add('matGuid');
      matProgram.textureParams = [['uReveal', { type: 'texture', default: 'http://t/default.png' }]];
      const a = { width: 16, height: 16, source: { style: {} } };
      const b = { width: 24, height: 24, source: { style: {} } };
      pixi.Assets.__seed('http://t/hero.png', { width: 64, height: 64, source: { style: {} } });
      pixi.Assets.__seed('http://t/a.png', a);
      pixi.Assets.__seed('http://t/b.png', b);
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid' });
      child.add(traits.MaterialInstance({ overrides: [{ target: 'uReveal', kind: 'texture', ref: 'http://t/a.png' }] }));

      scene2d.renderFrame();
      expect((pool.getSlot(canvas.id())!.container.children[0] as any).shader.extraTextures.uReveal).toBe(a);

      // Swap the override ref → matSig's extraSig changes → rebuild binds b, releases a to 0.
      child.set(traits.MaterialInstance, { overrides: [{ target: 'uReveal', kind: 'texture', ref: 'http://t/b.png' }] });
      scene2d.markScene2DDirty();
      scene2d.renderFrame();

      const mesh = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(mesh.shader.extraTextures.uReveal).toBe(b);          // rebuilt with the new ref
      expect(pixi.Assets.__unloaded).toContain('http://t/a.png'); // old ref released to 0 → unloaded
    });

    it('releases the sampled sprite texture when the material entity is removed', async () => {
      const { pixi, traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      pixi.Assets.__seed('http://t/hero.png', { width: 64, height: 64, source: { style: {} } });
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/hero.png', material: 'matGuid' });

      scene2d.renderFrame();
      child.destroy();
      scene2d.renderFrame();

      // Last user gone → the sprite bitmap is unloaded (refcount balanced through disposeSlot).
      expect(pixi.Assets.__unloaded).toContain('http://t/hero.png');
      expect(pool.getSlot(canvas.id())!.container.children.length).toBe(0);
    });

    // Atlas sub-rect frames: a material on a SLICED sprite binds a per-slot framed WRAPPER whose
    // uv matrix maps into the sub-rect (so it samples the slice, not the whole sheet).
    it('binds a framed WRAPPER for an atlas slice (borrows the sheet source, sized to the slice)', async () => {
      const { pixi, traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      const sheetSource = { style: {} };
      pixi.Assets.__seed('http://t/sheet.png', { width: 100, height: 10, source: sheetSource });
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'sheet:0', material: 'matGuid' }); // sliced ref

      scene2d.renderFrame();

      const mesh = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(mesh.kind).toBe('material');
      expect(mesh.texture).not.toBe(pixi.Texture.WHITE);
      expect(mesh.texture.source).toBe(sheetSource); // borrows the shared sheet source
      expect(mesh.texture.width).toBe(10);           // the 10px slice, not the 100px sheet
    });

    it('destroys the framed wrapper (keeping the shared source) + releases the sheet on removal', async () => {
      const { pixi, traits, pool, scene2d, world, matReady } = await setup();
      matReady.add('matGuid');
      pixi.Assets.__seed('http://t/sheet.png', { width: 100, height: 10, source: { style: {} } });
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'sheet:0', material: 'matGuid' });

      scene2d.renderFrame();
      const wrapper = (pool.getSlot(canvas.id())!.container.children[0] as any).texture;

      child.destroy();
      scene2d.renderFrame();

      expect(wrapper.destroy).toHaveBeenCalledWith(false);            // wrapper dropped, source kept
      expect(pixi.Assets.__unloaded).toContain('http://t/sheet.png'); // base source unloaded at refcount 0
    });
  });

  it('replaces the display object when the sprite KIND changes (primitive → image)', async () => {
    const { pixi, traits, pool, scene2d, world } = await setup();
    pixi.Assets.__seed('/a.png', { width: 64, height: 64 });
    const canvas = spawnCanvas(world, traits);
    const child = spawnChild(world, traits, canvas.id(), { sprite: 'square' });

    scene2d.renderFrame();
    const oldObj = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(oldObj.kind).toBe('graphics');

    child.set(traits.Renderable2D, { ...child.get(traits.Renderable2D), sprite: 'img:/a.png' });
    scene2d.renderFrame();

    expect(oldObj.destroyed).toBe(true);           // old graphics torn down
    const newObj = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(newObj.kind).toBe('sprite');
    expect(pool.getSlot(canvas.id())!.container.children.length).toBe(1);
  });

  it('replaces the sprite and unloads the old texture when the image URL changes', async () => {
    const { pixi, traits, pool, scene2d, world } = await setup();
    pixi.Assets.__seed('http://t/a.png', { width: 64, height: 64 });
    pixi.Assets.__seed('http://t/b.png', { width: 32, height: 32 });
    const canvas = spawnCanvas(world, traits);
    // Passthrough urls (ref === resolved url) → balanced retain/release.
    const child = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/a.png' });

    scene2d.renderFrame();
    child.set(traits.Renderable2D, { ...child.get(traits.Renderable2D), sprite: 'http://t/b.png' });
    scene2d.renderFrame();

    // a.png was the last (only) user → unloaded; b.png now bound, not unloaded.
    expect(pixi.Assets.__unloaded).toContain('http://t/a.png');
    expect(pixi.Assets.__unloaded).not.toContain('http://t/b.png');
    const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(obj.texture.width).toBe(32);
  });

  // Frame-swap (sprite-sheet animation): when the ref changes to a DIFFERENT frame of
  // the SAME base texture, the slot must NOT be disposed/recreated. A rebuild would drop
  // the texture refcount to 0 → Assets.unload races the re-retain → the GPU texture is
  // freed for a frame → visible flash. The frame must swap in place: same Sprite kept on
  // screen, old framed wrapper destroyed, texture never unloaded.
  it('swaps the frame IN PLACE for a same-sheet ref change — no flash, no unload churn', async () => {
    const { pixi, traits, pool, scene2d, world } = await setup();
    pixi.Assets.__seed('http://t/sheet.png', { width: 100, height: 10 });
    const canvas = spawnCanvas(world, traits);
    const child = spawnChild(world, traits, canvas.id(), { sprite: 'sheet:0' });

    scene2d.renderFrame();
    const sprite0 = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(sprite0.kind).toBe('sprite');
    const tex0 = sprite0.texture;

    // Advance to the next frame of the SAME sheet.
    child.set(traits.Renderable2D, { ...child.get(traits.Renderable2D), sprite: 'sheet:1' });
    scene2d.renderFrame();

    const sprite1 = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(sprite1).toBe(sprite0);             // SAME Sprite reused — not disposed/recreated
    expect(sprite0.destroyed).toBeFalsy();     // never torn down → no blank frame
    expect(sprite1.texture).not.toBe(tex0);    // framed sub-texture swapped in place
    expect(tex0.destroy).toHaveBeenCalled();   // old framed wrapper destroyed
    expect(pixi.Assets.__unloaded).not.toContain('http://t/sheet.png'); // texture never unloaded
    expect(pool.getSlot(canvas.id())!.container.children.length).toBe(1);
  });

  // F12 — pins the dispose-on-change invariant the makeSprite `.then` guard relies on:
  // when an entity's sprite url changes while the old url's texture is still loading, the
  // stale resolve must NOT bind onto the (now destroyed) old sprite or onto the new one.
  it('a stale async texture load is dropped after the url changed mid-load (F12)', async () => {
    const { pool, traits, scene2d, world } = await setup();
    // Neither url seeded → makeSprite takes the ASYNC load branch (load left in flight).
    const canvas = spawnCanvas(world, traits);
    const child = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/a.png' });

    scene2d.renderFrame();                       // makeSprite(a): load in flight, texture EMPTY
    const spriteA = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(spriteA.kind).toBe('sprite');
    expect(spriteA.texture.width).toBe(0);       // not yet resolved

    // Change the url BEFORE a's load resolves → slot replacement destroys spriteA, makes spriteB.
    child.set(traits.Renderable2D, { ...child.get(traits.Renderable2D), sprite: 'http://t/b.png' });
    scene2d.renderFrame();
    const spriteB = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(spriteB).not.toBe(spriteA);
    expect(spriteA.destroyed).toBe(true);

    // Flush both pending loads (a's stale resolve, then b's).
    await Promise.resolve();
    await Promise.resolve();

    expect(spriteA.texture.width).toBe(0);       // a's resolve dropped (destroyed guard) — no rebind
    expect(spriteB.texture.width).toBe(32);      // b bound normally
    expect(pool.getSlot(canvas.id())!.container.children.length).toBe(1);
  });

  it('assigns paint-order zIndex so higher sortOrder stacks on top', async () => {
    const { traits, pool, scene2d, world } = await setup();
    const canvas = spawnCanvas(world, traits);
    spawnChild(world, traits, canvas.id(), { sprite: 'square', color: 0xaa0000 }, /* sortOrder */ 0);
    spawnChild(world, traits, canvas.id(), { sprite: 'square', color: 0xbb0000 }, /* sortOrder */ 5);

    scene2d.renderFrame();

    const kids = pool.getSlot(canvas.id())!.container.children as any[];
    const low = kids.find(o => o.fill.mock.calls.some((c: any[]) => c[0] === 0xaa0000))!;
    const high = kids.find(o => o.fill.mock.calls.some((c: any[]) => c[0] === 0xbb0000))!;
    expect(low.zIndex).toBeLessThan(high.zIndex);
  });

  it('disposes a display object and unloads its texture when the entity is removed', async () => {
    const { pixi, traits, pool, scene2d, world } = await setup();
    pixi.Assets.__seed('http://t/a.png', { width: 64, height: 64 });
    const canvas = spawnCanvas(world, traits);
    const child = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/a.png' });

    scene2d.renderFrame();
    const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(obj.kind).toBe('sprite');

    child.destroy();
    scene2d.renderFrame();

    expect(obj.destroyed).toBe(true);
    expect(pool.getSlot(canvas.id())!.container.children.length).toBe(0);
    expect(pixi.Assets.__unloaded).toContain('http://t/a.png');   // last ref released
  });

  // F3 (fixed): makeSprite retains the refcount on the RESOLVED url; disposeSlot
  // now releases on the same resolved url (slot.textureUrl), NOT the raw ref. So
  // even when ref !== url — the normal case, since 2D sprite refs are GUIDs
  // resolved to asset paths — the retain/release balance and the texture unloads.
  // (Before the fix this leaked: the url's count stayed at 1 forever.)
  it('unloads the texture even when the sprite ref differs from its resolved url (F3)', async () => {
    const { pixi, traits, scene2d, world } = await setup();
    pixi.Assets.__seed('/a.png', { width: 64, height: 64 });
    const canvas = spawnCanvas(world, traits);
    const child = spawnChild(world, traits, canvas.id(), { sprite: 'img:/a.png' }); // ref 'img:/a.png' → url '/a.png'

    scene2d.renderFrame();
    child.destroy();
    scene2d.renderFrame();

    expect(pixi.Assets.__unloaded).toContain('/a.png');
  });

  // F4: when a Canvas2D entity is removed while its Renderable2D children still
  // exist, the children are orphaned (no canvas ancestor). pool.release now only
  // DETACHES them; Scene2D's dispose loop is the single owner that destroys them.
  // Before the fix pool.release destroyed them too, so the dispose loop destroyed
  // a second time and decremented the texture refcount twice.
  it("disposes a removed canvas's orphaned children exactly once (F4 — no double teardown)", async () => {
    const { pixi, traits, pool, scene2d, world } = await setup();
    pixi.Assets.__seed('http://t/a.png', { width: 64, height: 64 });
    const canvas = spawnCanvas(world, traits);
    spawnChild(world, traits, canvas.id(), { sprite: 'http://t/a.png' });

    scene2d.renderFrame();
    const obj = pool.getSlot(canvas.id())!.container.children[0] as any;

    canvas.destroy();          // remove the CANVAS but keep its child entity
    scene2d.renderFrame();

    expect(obj.destroyCount).toBe(1);                 // destroyed once, not twice
    expect(obj.destroyed).toBe(true);
    // Texture released exactly once → unloaded exactly once (no double-decrement).
    expect(pixi.Assets.__unloaded.filter((u: string) => u === 'http://t/a.png')).toHaveLength(1);
  });

  it('unloads sprite textures on world swap (F3 clear-on-swap)', async () => {
    const { pixi, traits, scene2d, world, worldReg, newWorld } = await setup({ start: true });
    pixi.Assets.__seed('http://t/a.png', { width: 64, height: 64 });
    const canvas = spawnCanvas(world, traits);
    spawnChild(world, traits, canvas.id(), { sprite: 'http://t/a.png' });

    scene2d.renderFrame();
    worldReg.setCurrentWorld(newWorld());

    expect(pixi.Assets.__unloaded).toContain('http://t/a.png');
    scene2d.stopScene2D();
  });

  it('unloads sprite textures on stopScene2D (F3 clear-on-stop)', async () => {
    const { pixi, traits, scene2d, world } = await setup({ start: true });
    pixi.Assets.__seed('http://t/a.png', { width: 64, height: 64 });
    const canvas = spawnCanvas(world, traits);
    spawnChild(world, traits, canvas.id(), { sprite: 'http://t/a.png' });

    scene2d.renderFrame();
    scene2d.stopScene2D();

    expect(pixi.Assets.__unloaded).toContain('http://t/a.png');
  });

  // missing-test #4 — the single-user retain/release/unload path is covered above;
  // the REASON the refcount exists is shared textures. Two sprites on one resolved url
  // must keep it loaded until the LAST one is gone (no premature unload while a sprite
  // still uses it), and it must unload exactly once (no double-decrement).
  describe('texture refcount balance (#4)', () => {
    it('unloads a shared texture only when the LAST sprite using it is removed', async () => {
      const { pixi, traits, scene2d, world } = await setup();
      pixi.Assets.__seed('http://t/shared.png', { width: 64, height: 64 });
      const canvas = spawnCanvas(world, traits);
      // Two distinct entities, same resolved url (passthrough ref) → refcount 2.
      const a = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/shared.png' });
      const b = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/shared.png' });

      scene2d.renderFrame();

      a.destroy();
      scene2d.renderFrame();
      // b still uses it → must NOT be unloaded yet.
      expect(pixi.Assets.__unloaded).not.toContain('http://t/shared.png');

      b.destroy();
      scene2d.renderFrame();
      // last user gone → unloaded exactly once.
      expect(pixi.Assets.__unloaded.filter((u: string) => u === 'http://t/shared.png')).toHaveLength(1);
    });

    it('does not unload a shared texture again on stop after the last release already unloaded it', async () => {
      const { pixi, traits, scene2d, world } = await setup({ start: true });
      pixi.Assets.__seed('http://t/shared.png', { width: 64, height: 64 });
      const canvas = spawnCanvas(world, traits);
      const a = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/shared.png' });
      const b = spawnChild(world, traits, canvas.id(), { sprite: 'http://t/shared.png' });

      scene2d.renderFrame();
      a.destroy(); b.destroy();
      scene2d.renderFrame();                       // both released → unloaded once, map cleared
      expect(pixi.Assets.__unloaded.filter((u: string) => u === 'http://t/shared.png')).toHaveLength(1);

      scene2d.stopScene2D();                        // unloadAllSpriteTextures over an empty map → no-op
      expect(pixi.Assets.__unloaded.filter((u: string) => u === 'http://t/shared.png')).toHaveLength(1);
    });

    it('keeps a shared texture loaded on swap when re-seeded, balancing the refcount across scenes', async () => {
      const { pixi, traits, scene2d, world, worldReg, newWorld } = await setup({ start: true });
      pixi.Assets.__seed('http://t/shared.png', { width: 64, height: 64 });
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'http://t/shared.png' });
      spawnChild(world, traits, canvas.id(), { sprite: 'http://t/shared.png' });

      scene2d.renderFrame();                        // refcount 2

      // World swap disposes both slots (2 releases → count 0 → 1 unload) then
      // unloadAllSpriteTextures clears the now-empty map. Net: unloaded exactly once,
      // no negative drift, no leaked accounting into the next scene.
      worldReg.setCurrentWorld(newWorld());
      expect(pixi.Assets.__unloaded.filter((u: string) => u === 'http://t/shared.png')).toHaveLength(1);
      scene2d.stopScene2D();
    });
  });

  it('skips a Renderable2D with no Canvas2D ancestor', async () => {
    const { traits, pool, scene2d, world } = await setup();
    const canvas = spawnCanvas(world, traits);
    // Child parented to root (0), not the canvas → no Canvas2D ancestor.
    spawnChild(world, traits, /* parentId */ 0, { sprite: 'square' });

    scene2d.renderFrame();

    expect(pool.getSlot(canvas.id())!.container.children.length).toBe(0);
  });

  it('tears down all slots and releases the pool on world swap', async () => {
    const { traits, pool, scene2d, world, worldReg, newWorld } = await setup({ start: true });
    const canvas = spawnCanvas(world, traits);
    spawnChild(world, traits, canvas.id(), { sprite: 'square' });

    scene2d.renderFrame();
    const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(pool.getAllocatedEntityIds().size).toBe(1);

    // Promote a fresh world → fires the onWorldSwap teardown registered by startScene2D.
    worldReg.setCurrentWorld(newWorld());

    expect(obj.destroyed).toBe(true);                       // display objects disposed
    expect(obj.destroyCount).toBe(1);                       // once — disposeSlot owns it, releaseAll only detaches
    expect(pool.getAllocatedEntityIds().size).toBe(0);      // pool.releaseAll()
    scene2d.stopScene2D();
  });

  // ── Dirty gating (F1) ──
  describe('dirty gating (F1)', () => {
    it('skips the gfx rebuild when an entity is unchanged across frames', async () => {
      const { traits, pool, scene2d, world } = await setup();
      const canvas = spawnCanvas(world, traits);
      spawnChild(world, traits, canvas.id(), { sprite: 'square', color: 0x112233 });

      scene2d.renderFrame();
      const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(obj.clear).toHaveBeenCalledTimes(1);   // drawn on the first frame

      scene2d.renderFrame();                          // nothing changed
      expect(obj.clear).toHaveBeenCalledTimes(1);     // NOT re-tessellated
    });

    it('redraws an entity when a render-relevant trait changes', async () => {
      const { traits, pool, scene2d, world } = await setup();
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'square', color: 0x112233 });

      scene2d.renderFrame();
      const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(obj.clear).toHaveBeenCalledTimes(1);

      child.set(traits.Renderable2D, { ...child.get(traits.Renderable2D), color: 0x445566 });
      scene2d.renderFrame();
      expect(obj.clear).toHaveBeenCalledTimes(2);     // color change → redraw
    });

    it('redraws when the transform moves (an animating sprite)', async () => {
      const { traits, pool, scene2d, world } = await setup();
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'square' });

      scene2d.renderFrame();
      const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(obj.clear).toHaveBeenCalledTimes(1);

      child.set(traits.Transform, { ...child.get(traits.Transform), x: 50 });
      scene2d.renderFrame();
      expect(obj.clear).toHaveBeenCalledTimes(2);
    });

    it('skips the whole frame while the sim is stopped and nothing is externally dirty', async () => {
      const { traits, pool, scene2d, world } = await setup();
      const { setPlayState } = await import('../../src/runtime/systems/playState');
      const canvas = spawnCanvas(world, traits);
      const child = spawnChild(world, traits, canvas.id(), { sprite: 'square', color: 0x111111 });

      scene2d.renderFrame();                          // first frame draws (starts dirty)
      const obj = pool.getSlot(canvas.id())!.container.children[0] as any;
      expect(obj.clear).toHaveBeenCalledTimes(1);

      setPlayState('stopped');
      // Mutate WITHOUT a dirty signal (the addDirtyListener wiring lives in
      // startScene2D, not used here) → the idle gate must skip the frame entirely.
      child.set(traits.Renderable2D, { ...child.get(traits.Renderable2D), color: 0x999999 });
      scene2d.renderFrame();
      expect(obj.clear).toHaveBeenCalledTimes(1);     // frame skipped → change not drawn

      scene2d.markScene2DDirty();                     // explicit dirty wakes it
      scene2d.renderFrame();
      expect(obj.clear).toHaveBeenCalledTimes(2);     // now redrawn
    });
  });
});

describe('Scene2D collider overlay (editor)', () => {
  it('draws an outline Graphics per canvas for Collider2D entities only when enabled', async () => {
    const { traits, pool, scene2d, world } = await setup();
    const canvas = spawnCanvas(world, traits);
    // A collider-only entity (no Renderable2D) parented to the canvas.
    world.spawn(
      traits.Transform({ x: 100, y: 100 }),
      traits.Collider2D({ shape: 'box', halfW: 50, halfH: 50 }),
      traits.EntityAttributes({ name: 'wall', parentId: canvas.id(), layer: '2d' }),
    );

    // Off by default → no overlay drawn.
    scene2d.renderFrame();
    const slot = pool.getSlot(canvas.id())!;
    expect(slot.container.children.some((c: any) => c.kind === 'graphics' && c.stroke.mock.calls.length > 0)).toBe(false);

    // Enabled → one overlay Graphics with a stroked box outline.
    scene2d.setShowColliders2D(true);
    scene2d.renderFrame();
    const overlays = slot.container.children.filter((c: any) => c.kind === 'graphics' && c.stroke.mock.calls.length > 0);
    expect(overlays.length).toBe(1);
    const g = overlays[0];
    expect(g.moveTo.mock.calls.length + g.lineTo.mock.calls.length).toBeGreaterThan(0); // box perimeter drawn

    // Disabled again → the overlay is cleared on the next frame.
    g.clear.mockClear();
    scene2d.setShowColliders2D(false);
    scene2d.renderFrame();
    expect(g.clear).toHaveBeenCalled();
  });
});

// ── SceneView-Pixi migration: two coexisting renderers (Phase 0b/1) ──
// The editor SceneView runs a SECOND Scene2DRenderer on its own Canvas2DPool so it renders the
// same world as GameView through a separate Pixi surface. These lock the two properties the
// migration depends on: separate object trees per viewport, and a SHARED texture refcount so one
// viewport dropping a texture (or closing) doesn't unload it out from under the other.
describe('Scene2DRenderer instancing', () => {
  it('two renderers on separate pools render the SAME entity into separate object trees', async () => {
    const { traits, scene2d, pool, world } = await setup();
    const editorPool = new pool.Canvas2DPool();
    const editorRenderer = new scene2d.Scene2DRenderer({ pool: editorPool, primary: false });

    const canvas = spawnCanvas(world, traits);
    spawnChild(world, traits, canvas.id(), { sprite: 'square', color: 0x123456 });

    scene2d.renderFrame();          // default (primary) → defaultPool
    editorRenderer.renderFrame();   // editor (non-primary) → editorPool

    const defSlot = pool.getSlot(canvas.id())!;
    const edSlot = editorPool.getSlot(canvas.id())!;
    expect(defSlot).not.toBeNull();
    expect(edSlot).not.toBeNull();
    // Distinct pools → distinct containers → distinct display objects (a Pixi object has one parent).
    expect(edSlot.container).not.toBe(defSlot.container);
    expect(defSlot.container.children.length).toBe(1);
    expect(edSlot.container.children.length).toBe(1);
    expect(edSlot.container.children[0]).not.toBe(defSlot.container.children[0]);
  });

  it('a non-primary renderer stopping while the primary is live does NOT unload a shared texture', async () => {
    // Models: GameView (primary) + SceneView (non-primary) both show sprite X, then GameView closes.
    // The adversarial-review HIGH finding: a blanket unloadAllSpriteTextures on the primary stop
    // destroyed X while the editor still displayed it. Gating the nuke on the live-renderer counter
    // (last-one-out) fixes it — the primary stop must NOT unload a texture the editor still holds.
    const { pixi, traits, scene2d, pool, world } = await setup({ start: true }); // default.start() → live=1
    pixi.Assets.__seed('/a.png', { width: 64, height: 64 });
    const editorPool = new pool.Canvas2DPool();
    const editorRenderer = new scene2d.Scene2DRenderer({ pool: editorPool, primary: false });
    editorRenderer.start(); // live=2

    const canvas = spawnCanvas(world, traits);
    spawnChild(world, traits, canvas.id(), { sprite: 'img:/a.png' });

    scene2d.renderFrame();        // primary retains /a.png (shared count 1)
    editorRenderer.renderFrame(); // editor retains /a.png (shared count 2)
    expect(pixi.Assets.__unloaded).not.toContain('/a.png');

    // GameView (primary) closes while the editor is still live → per-slot release drops the count
    // 2→1 but NOT the last renderer, so the blanket nuke must be skipped: /a.png survives.
    scene2d.stopScene2D(); // live=1
    expect(pixi.Assets.__unloaded).not.toContain('/a.png');

    // Editor closes last → count 1→0 (last-one-out) → /a.png finally unloads.
    editorRenderer.stop(); // live=0
    expect(pixi.Assets.__unloaded).toContain('/a.png');
  });
});

// Phase 4 (2D particle preview): the editor passes a per-frame particleDt PROVIDER. While it returns a
// number the renderer must keep drawing every frame even with the sim STOPPED (so particles animate and
// direct-write edits show live); while it returns undefined the frame is skipped as before. Runtime (no
// provider) is unaffected. We observe the gate via a direct Transform write (which does NOT set the
// external-dirty flag): it only lands when the frame actually runs.
describe('Scene2DRenderer 2D-particle-preview render gate (Phase 4)', () => {
  it('a preview provider keeps renderFrame alive while stopped; undefined skips as before', async () => {
    const { traits, scene2d, pool, world } = await setup();
    const { setPlayState } = await import('../../src/runtime/systems/playState');
    setPlayState('stopped'); // the editor opens scenes stopped; the harness defaults to 'playing'
    const editorPool = new pool.Canvas2DPool();
    let previewDt: number | undefined;
    const provider = vi.fn(() => previewDt);
    const r = new scene2d.Scene2DRenderer({ pool: editorPool, primary: false, particleDt: provider });

    const canvas = spawnCanvas(world, traits);
    const child = spawnChild(world, traits, canvas.id(), { sprite: 'square' });
    r.renderFrame(); // first frame is _externalDirty → renders + clears the flag
    const obj = editorPool.getSlot(canvas.id())!.container.children[0] as { _x: number };
    expect(obj._x).toBe(0);

    // Direct koota write — bypasses the dirty listeners, so the gate alone decides if it renders.
    child.set(traits.Transform, { ...child.get(traits.Transform), x: 42 });

    previewDt = undefined;           // preview OFF → stopped + clean + not previewing ⇒ skip
    r.renderFrame();
    expect(provider).toHaveBeenCalled();
    expect(obj._x).toBe(0);          // frame skipped → stale position retained

    previewDt = 0.016;               // preview ON → previewing keeps the frame alive
    r.renderFrame();
    expect(obj._x).toBe(42);         // move rendered
  });

  it('the default (runtime) renderer has no provider and still skips a direct write while stopped', async () => {
    const { traits, scene2d, pool, world } = await setup();
    const { setPlayState } = await import('../../src/runtime/systems/playState');
    setPlayState('stopped');
    const canvas = spawnCanvas(world, traits);
    const child = spawnChild(world, traits, canvas.id(), { sprite: 'square' });
    scene2d.renderFrame();
    const obj = pool.getSlot(canvas.id())!.container.children[0] as { _x: number };
    child.set(traits.Transform, { ...child.get(traits.Transform), x: 99 });
    scene2d.renderFrame();           // no provider, stopped, clean ⇒ skip (unchanged behavior)
    expect(obj._x).toBe(0);
  });
});
