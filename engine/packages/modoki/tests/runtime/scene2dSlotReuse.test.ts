/** Investigation for GitHub issue #77 (court memo-overlay "blank until next rebuild").
 *
 *  Surviving hypothesis under test: `buildOverlay` (games/court/runtime/systems.ts) does a
 *  full teardown/rebuild every interaction — despawn every overlay entity, then respawn all
 *  marks from `session.paint`, all within ONE synchronous call. If koota reuses a destroyed
 *  entity's raw id for a newly spawned entity within that same tick, and Scene2D's per-entity
 *  bookkeeping (`this.slots` / `this.lastRender` in
 *  engine/packages/modoki/src/runtime/rendering/Scene2D.tsx) is keyed ONLY by `entity.id()`,
 *  a destroyed entity's Pixi slot / change-detection snapshot could be silently inherited by
 *  the new entity that reuses its id — with the `!changed` early-out then skipping the draw
 *  that should update it to the new content.
 *
 *  Two things are tested here:
 *   (1) PURE KOOTA — does `world.spawn()` immediately after `entity.destroy()` actually reuse
 *       the destroyed entity's raw id in the same synchronous tick, and does `entity.id()`
 *       (what Scene2D keys on) strip the generation koota tracks internally? This is
 *       observable with no renderer at all.
 *   (2) SCENE2D INTEGRATION — reusing the hand-rolled PixiJS mock harness from
 *       `engine/packages/modoki/tests/runtime/Scene2D.test.ts` (Application/Container/Sprite
 *       mirror just enough Pixi semantics for addChild/removeFromParent/destroy to be
 *       observable), drive the exact despawn-then-respawn-in-one-tick pattern `buildOverlay`
 *       uses and assert on what actually lands in the canvas container after ONE renderFrame().
 *
 *  This file is READ-ONLY with respect to Scene2D.tsx and games/court/** — it does not patch
 *  either; it only observes.
 */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// Part 1 — pure koota: does destroy()-then-spawn() in one tick reuse the id,
// and does entity.id() strip the generation that would otherwise disambiguate it?
// ─────────────────────────────────────────────────────────────────────────
describe('koota entity id recycling (pure ECS, no renderer)', () => {
  it('reuses a destroyed entity raw id for a new spawn in the SAME synchronous tick', async () => {
    const { createWorld, trait } = await import('koota');
    const Marker = trait({ n: 0 });
    const world = createWorld();
    try {
      // Mirror despawnOverlayOnly's pattern: spawn N, destroy them all, spawn N new ones —
      // no render/query/yield between destroy and the following spawn.
      const olds = [1, 2, 3, 4, 5].map((n) => world.spawn(Marker({ n })));
      const oldIds = olds.map((e) => e.id());

      for (const e of olds) e.destroy();

      const news = [10, 20, 30, 40, 50].map((n) => world.spawn(Marker({ n })));
      const newIds = news.map((e) => e.id());

      // The core claim: at least one freshly spawned entity's raw id collides with one of
      // the ids just freed — i.e. koota's free-list handed out a recycled id, not a fresh one.
      const collided = newIds.filter((id) => oldIds.includes(id));
      expect(collided.length).toBeGreaterThan(0);
    } finally {
      world.destroy();
    }
  });

  it('entity.id() strips the generation that disambiguates a recycled id (isAlive() does not)', async () => {
    const { createWorld, trait } = await import('koota');
    const Marker = trait({ n: 0 });
    const world = createWorld();
    try {
      const oldEntity = world.spawn(Marker({ n: 1 }));
      const oldFullHandle = oldEntity; // the packed (world|generation|id) number koota hands back
      const oldRawId = oldEntity.id();

      oldEntity.destroy();
      const newEntity = world.spawn(Marker({ n: 2 }));

      if (newEntity.id() !== oldRawId) {
        // This machine's free-list didn't happen to recycle THIS id on the first try —
        // the collision test above already proves recycling happens; this one only adds
        // the generation-stripping detail when we get a same-id hit to inspect.
        return;
      }

      // Raw id collides — Scene2D's Map<number, Slot> keyed by entity.id() cannot tell
      // old and new apart.
      expect(newEntity.id()).toBe(oldRawId);
      // But koota's OWN internal handle is NOT the same number — it carries a bumped
      // generation, and the OLD packed handle is provably stale via isAlive().
      expect(newEntity).not.toBe(oldFullHandle);
      // koota augments Number.prototype, so the handle is a number at runtime but carries
      // methods TS's `number` does not declare — cast to the shape we actually call.
      expect((oldFullHandle as unknown as { isAlive(): boolean }).isAlive()).toBe(false);
      expect((newEntity as unknown as { isAlive(): boolean }).isAlive()).toBe(true);
    } finally {
      world.destroy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Part 2 — Scene2D integration: same despawn-then-respawn-in-one-tick shape, but through
// the real renderFrame() + real per-id bookkeeping, over a hand-rolled Pixi mock (borrowed
// from engine/packages/modoki/tests/runtime/Scene2D.test.ts's harness).
// ─────────────────────────────────────────────────────────────────────────

const createdWorlds: any[] = [];
function trackWorld<T>(w: T): T { createdWorlds.push(w); return w; }

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  for (const w of createdWorlds) { try { w.destroy(); } catch { /* already disposed */ } }
  createdWorlds.length = 0;
});

function mockDeps() {
  vi.doMock('pixi.js', () => {
    class Display {
      parent: any = null;
      destroyed = false;
      destroyCount = 0;
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
    const cacheMap = new Map<string, any>();
    const unloaded: string[] = [];
    const Assets = {
      cache: { has: (url: string) => cacheMap.has(url) },
      get: (url: string) => cacheMap.get(url),
      load: (url: string) => {
        const t = cacheMap.get(url) ?? { width: 32, height: 32, source: { style: {} } };
        cacheMap.set(url, t);
        return Promise.resolve(t);
      },
      unload: (url: string) => { unloaded.push(url); cacheMap.delete(url); return Promise.resolve(); },
      __seed: (url: string, tex: any) => cacheMap.set(url, tex),
      __unloaded: unloaded,
    };
    return { Application, Container, Texture, Rectangle, Graphics, Sprite, Mesh, MeshGeometry, Assets, isWebGPUSupported: () => Promise.resolve(false), setKTXTranscoderPath: () => {}, extensions: { add: () => {} }, loadKTX2: {} };
  });

  vi.doMock('../../src/runtime/rendering/gpuDetect', () => ({
    getWebGPUSupported: () => Promise.resolve(false),
  }));

  const readyMaterials = new Set<string>();
  const sharedProgram: { params: any[]; textureParams: [string, any][]; manifest: any } = { params: [], textureParams: [], manifest: {} };
  vi.doMock('../../src/runtime/loaders/spriteMaterialCache', () => ({
    ensureSpriteMaterial: (guid: string) => (readyMaterials.has(guid) ? sharedProgram : undefined),
    getSpriteMaterialProgram: (guid: string) => (readyMaterials.has(guid) ? sharedProgram : undefined),
    clearSpriteMaterialCache: vi.fn(),
    __ready: readyMaterials,
    __program: sharedProgram,
  }));
  let shaderSeq = 0;
  vi.doMock('../../src/runtime/rendering/pixiShaderBuilder', () => ({
    makePixiShaderInstance: (_program: any, texture: any, _values: any, extraTextures: any) =>
      ({ id: ++shaderSeq, texture, extraTextures, destroyed: false, destroy() { this.destroyed = true; } }),
  }));

  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({
    // A 'vid:' ref stands in for a video-asset GUID: a Sprite slot that skips the
    // still-image pipeline entirely (no resolve, no Assets.load, no url retain).
    isVideoRef: (ref: string) => typeof ref === 'string' && ref.startsWith('vid:'),
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

async function setup() {
  mockDeps();
  const pixi: any = await import('pixi.js');
  const traits = await import('../../src/runtime/traits');
  const { registerTrait } = await import('../../src/runtime/core/ecs/traitRegistry');
  const worldReg = await import('../../src/runtime/core/ecs/worldRegistry');
  const pool = await import('../../src/runtime/rendering/canvas2DPool');
  const scene2d = await import('../../src/runtime/rendering/Scene2D');
  const { createWorld } = await import('koota');

  registerTrait({ name: 'Canvas2D', trait: traits.Canvas2D, category: 'component', fields: {} });
  registerTrait({ name: 'EntityAttributes', trait: traits.EntityAttributes, category: 'component', fields: {} });

  trackWorld(worldReg.getCurrentWorld());
  const world = trackWorld(createWorld());
  worldReg.setCurrentWorld(world);

  return { pixi, traits, world, pool, scene2d };
}

function spawnCanvas(world: any, traits: any, sortOrder = 0) {
  return world.spawn(
    traits.Canvas2D({ referenceWidth: 1080, referenceHeight: 1920, scaleMode: 'fitH' }),
    traits.EntityAttributes({ name: 'canvas', parentId: 0, sortOrder, layer: 'ui' }),
  );
}

function spawnMark(world: any, traits: any, canvasId: number, rend: any, sortOrder = 0) {
  return world.spawn(
    traits.Transform({ x: rend.x ?? 0, y: rend.y ?? 0 }),
    traits.Renderable2D({ sprite: 'square', color: 0xffffff, width: 5, height: 5, ...rend }),
    traits.EntityAttributes({ name: 'mark', parentId: canvasId, sortOrder, layer: '2d' }),
  );
}

describe('Scene2D integration — despawn-all + respawn-all in one tick (buildOverlay shape)', () => {
  it('destroy(N)+spawn(N) in ONE synchronous block before renderFrame() recycles at least one id', async () => {
    const { traits, world } = await setup();
    const canvas = spawnCanvas(world, traits);
    const olds = [0, 1, 2, 3, 4].map((i) => spawnMark(world, traits, canvas.id(), { color: 0x111111 + i, x: i * 10 }, i));
    const oldIds = olds.map((e) => e.id());

    // despawnOverlayOnly() equivalent — destroy every old mark, no render in between.
    for (const e of olds) e.destroy();
    // buildOverlay's respawn — brand-new content (different color/position) at each slot,
    // exactly mirroring "rebuild wholesale from session.paint" with genuinely changed marks.
    const news = [0, 1, 2, 3, 4].map((i) => spawnMark(world, traits, canvas.id(), { color: 0x999900 + i, x: i * 10 + 500 }, i));
    const newIds = news.map((e) => e.id());

    expect(newIds.some((id) => oldIds.includes(id))).toBe(true); // recycling actually happened

    const { scene2d, pool } = { scene2d: (await import('../../src/runtime/rendering/Scene2D')), pool: (await import('../../src/runtime/rendering/canvas2DPool')) };
    scene2d.renderFrame(); // first frame ever → forced dirty, sees ONLY the 5 new marks

    const container = pool.getSlot(canvas.id())!.container;
    // No stale leftovers, no duplicates: exactly 5 live children for the 5 currently-alive marks.
    expect(container.children.length).toBe(5);

    // Each child actually reflects the NEW entity's data (position), not a stale slot inherited
    // from the destroyed old entity that happened to share its raw id.
    const xs = container.children.map((c: any) => c._x).sort((a: number, b: number) => a - b);
    expect(xs).toEqual([500, 510, 520, 530, 540]);
  });

  it('a recycled id whose new content is IDENTICAL to the old (same signature) leaves the slot correctly drawn, not blank', async () => {
    const { pixi, traits, world } = await setup();
    // Image-mode sprite (like court's PIECE_SPRITE(glyph) marks) so `.tint` is meaningful —
    // a 'square' primitive renders via Graphics.fill(), not a `.tint` field.
    pixi.Assets.__seed('/glyph.png', { width: 32, height: 32 });
    const canvas = spawnCanvas(world, traits);
    const old = spawnMark(world, traits, canvas.id(), { sprite: 'img:/glyph.png', color: 0xabcdef, x: 42 }, 0);

    const { scene2d, pool } = { scene2d: (await import('../../src/runtime/rendering/Scene2D')), pool: (await import('../../src/runtime/rendering/canvas2DPool')) };
    scene2d.renderFrame();
    const before = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(before.tint).toBe(0xabcdef);
    expect(before._x).toBe(42);

    old.destroy();
    // Respawn with the EXACT same signature (a cell whose memo mark didn't change across the
    // rebuild) — this is the coincidental-match case where Scene2D's `changed` comparison would
    // read false against the stale snapshot.
    const fresh = spawnMark(world, traits, canvas.id(), { sprite: 'img:/glyph.png', color: 0xabcdef, x: 42 }, 0);
    expect(fresh.id()).toBe(old.id()); // must actually be the recycled-id case to be testing anything

    scene2d.renderFrame();
    const after = pool.getSlot(canvas.id())!.container.children[0] as any;
    expect(after.destroyed).toBe(false);
    expect(after.parent).toBe(pool.getSlot(canvas.id())!.container); // still on stage — not orphaned
    expect(after.tint).toBe(0xabcdef);
    expect(after._x).toBe(42);
  });
});
