// @vitest-environment jsdom
/** #752 — the MTSDF `uScreenPxRange` AA uniform used to be derived from the AUTHORED
 *  `Text2D.fontSize` alone (`mtsdfPixiShader.ts`), ignoring both the entity's Transform
 *  scale and the host Canvas2D's own uniform scale. Dead on every device that has
 *  `fwidth` (the WGSL/GLSL-ES3 path recomputes screenPxRange from derivatives every
 *  fragment) but the ONLY value used on the no-derivatives GLSL ES1 fallback (WebGL1
 *  without `OES_standard_derivatives` — the iPhone 8), where the stale value produced
 *  wrong-sharpness antialiasing on any scaled text (wordweave's flight animation, and
 *  its pinch-zoomed static crossword glyphs).
 *
 *  This asserts the UNIFORM VALUE (never pixels) through the real `Scene2D.renderFrame`
 *  pipeline — the harness is the same shape as the "Text2D shader reclaim (#690/#696)"
 *  block in `Scene2D.test.ts` (font/texture loading + `mtsdfPixiShader` mocked with a
 *  fontSize-tracking uniform, real `layoutText`/reclaim/Scene2D logic), with ONE
 *  deliberate difference: `renderUtils` is left UNMOCKED here so `getWorldTransform2D`
 *  runs for real, backed by the real `transformPropagationSystem` — needed to prove the
 *  fix reads the WORLD transform (through a parent chain), not the local one. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// koota's world-id pool (max 16) is global and survives vi.resetModules, so every world
// this harness creates must be destroyed or the suite exhausts the pool.
const createdWorlds: any[] = [];
function trackWorld<T>(w: T): T { createdWorlds.push(w); return w; }

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  for (const w of createdWorlds) { try { w.destroy(); } catch { /* already disposed */ } }
  createdWorlds.length = 0;
});

// ── Mocks — same shapes as Scene2D.test.ts's mockDeps()/mockTextDeps(), minus the
// `renderUtils` mock (see the file doc comment above for why). ──────────────────────
function mockDeps() {
  vi.doMock('pixi.js', () => {
    class Display {
      parent: any = null;
      destroyed = false;
      zIndex = 0;
      rotation = 0;
      position = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } };
      scale = { x: 1, y: 1, set(x: number, y: number) { this.x = x; this.y = y; } };
      pivot = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } };
      alpha = 1;
      get _x() { return this.position.x; }
      get _y() { return this.position.y; }
      get _sx() { return this.scale.x; }
      get _sy() { return this.scale.y; }
      removeFromParent() {
        if (this.parent) {
          const i = this.parent.children.indexOf(this);
          if (i >= 0) this.parent.children.splice(i, 1);
          this.parent = null;
        }
      }
      destroy() { this.removeFromParent(); this.destroyed = true; }
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
      constructor(opts?: any) { this.source = opts?.source; }
    }
    class MeshGeometry {
      buffers: unknown[] | null = [];
      positions: Float32Array;
      private _posBuffer = { update: vi.fn() };
      getBuffer = (name: string) => {
        if (name !== 'aPosition') throw new TypeError(`[mock] no attribute '${name}' on this geometry`);
        return this._posBuffer;
      };
      unload = vi.fn();
      destroy = vi.fn(() => { this.buffers = null; });
      addAttribute = vi.fn();
      constructor(public opts?: any) { this.positions = opts?.positions ?? new Float32Array(8); }
    }
    class Buffer {
      data: any; label?: string; usage?: number;
      constructor(opts?: any) { this.data = opts?.data; this.label = opts?.label; this.usage = opts?.usage; }
      update = vi.fn();
    }
    const BufferUsage = { VERTEX: 1, COPY_DST: 2 };
    class Mesh extends Display {
      kind = 'material';
      geometry: any; texture: any; shader: any; tint = 0xffffff; blendMode = 'normal';
      constructor(opts: any) { super(); this.geometry = opts?.geometry; this.texture = opts?.texture; this.shader = opts?.shader; }
    }
    class Rectangle { x: number; y: number; width: number; height: number; constructor(x = 0, y = 0, w = 0, h = 0) { this.x = x; this.y = y; this.width = w; this.height = h; } }
    class Graphics extends Display { kind = 'graphics'; }
    class Sprite extends Display {
      kind = 'sprite';
      texture: any;
      anchor = { set: () => {} };
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
    const Assets = {
      cache: { has: (url: string) => cacheMap.has(url), remove: (url: string) => cacheMap.delete(url) },
      get: (url: string) => cacheMap.get(url),
      load: (url: string) => {
        const t = cacheMap.get(url) ?? { width: 32, height: 32, source: { style: {} } };
        cacheMap.set(url, t);
        return Promise.resolve(t);
      },
      unload: (url: string) => { cacheMap.delete(url); return Promise.resolve(); },
      __seed: (url: string, tex: any) => cacheMap.set(url, tex),
    };
    return { Application, Container, Texture, Rectangle, Graphics, Sprite, Mesh, MeshGeometry, Buffer, BufferUsage, Assets, isWebGPUSupported: () => Promise.resolve(false), setKTXTranscoderPath: () => {}, extensions: { add: () => {} }, loadKTX2: {} };
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
    makePixiShaderInstance: (_program: any, texture: any, _values: any, extraTextures: any) => ({
      id: ++shaderSeq, texture, extraTextures, destroyed: false,
      destroy() { this.destroyed = true; },
      resources: { textureUniforms: { uniforms: { uTextureMatrix: texture?.textureMatrix?.mapCoord ?? {} } } },
    }),
  }));

  // ⚠️ DELIBERATELY NOT MOCKED: `../../src/runtime/rendering/renderUtils`. This test needs the
  // REAL `getWorldTransform2D` (backed by the real `transformPropagationSystem`) so it can prove
  // the #752 fix reads the entity's WORLD transform, including through a parent chain — the
  // standard Scene2D.test.ts mock collapses "world" to "local" and would make that unprovable.
  // The other renderUtils exports (resolveSprite/isImagePath/…) are real too, but never invoked:
  // this harness only spawns Canvas2D/Transform/Text2D/EntityAttributes entities.
}

const fontTextures = new Map<string, any>();
let currentProvider: any;
let shaderSeq2 = 0;

function mockTextDeps() {
  mockDeps();
  fontTextures.clear();
  currentProvider = undefined;
  shaderSeq2 = 0;

  vi.doMock('../../src/runtime/rendering/text/fontTexturePixi', () => ({
    getFontTexturePixi: (provider: any, page = 0) => {
      const key = `${provider.id}:${page}`;
      if (!fontTextures.has(key)) fontTextures.set(key, { destroyed: false, source: { style: {} } });
      return fontTextures.get(key);
    },
  }));

  vi.doMock('../../src/runtime/loaders/fontAtlasLoader', () => ({
    ensureFontLoaded: () => {},
    getLoadedFont: (_guid: string) => currentProvider,
    __setProvider: (p: any) => { currentProvider = p; },
  }));

  // Lightweight fake Shader whose `uScreenPxRange` uniform mirrors the real shader's
  // fontSize-derived one (mtsdfPixiShader.ts) — i.e. it is set to whatever `fontSize` argument
  // it's given, verbatim. That is exactly the mechanism under test: it proves WHICH size Scene2D
  // computed and passed in, without re-deriving the atlas-based sharpness formula itself (that
  // formula is covered in isolation by mtsdfPixiShaderReuse.test.ts).
  vi.doMock('../../src/runtime/rendering/text/mtsdfPixiShader', () => ({
    makeMtsdfPixiShader: (texture: any, atlas: any, style: any, fontSize: any) => ({
      id: ++shaderSeq2,
      resources: { uTexture: texture.source, uSampler: texture.source?.style, mtsdfUniforms: { uniforms: { uScreenPxRange: fontSize } } },
      _mtsdfAtlas: { ...atlas },
      _style: { ...style },
      destroyed: false,
      destroy: vi.fn(function (this: any) { this.destroyed = true; }),
    }),
    canReuseMtsdfPixiShader: (shader: any, texture: any, atlas: any) => {
      if (shader.resources.uTexture !== texture.source) return false;
      const p = shader._mtsdfAtlas;
      return !!p && p.width === atlas.width && p.height === atlas.height
        && p.distanceRange === atlas.distanceRange && p.size === atlas.size && p.type === atlas.type;
    },
    updateMtsdfPixiMetrics: (shader: any, atlas: any, fontSize: any) => {
      shader._mtsdfAtlas = { ...atlas };
      shader.resources.mtsdfUniforms.uniforms.uScreenPxRange = fontSize;
    },
    updateMtsdfPixiStyle: (shader: any, style: any) => { shader._style = { ...style }; },
  }));
}

async function setupText() {
  mockTextDeps();
  const traits = await import('../../src/runtime/traits');
  const { registerTrait } = await import('../../src/runtime/core/ecs/traitRegistry');
  const worldReg = await import('../../src/runtime/core/ecs/worldRegistry');
  const pool = await import('../../src/runtime/rendering/canvas2DPool');
  const scene2d = await import('../../src/runtime/rendering/Scene2D');
  const fontLoader: any = await import('../../src/runtime/loaders/fontAtlasLoader');
  const { transformPropagationSystem } = await import('../../src/runtime/core/ecs/transformPropagationSystem');
  const { createWorld } = await import('koota');

  registerTrait({ name: 'Canvas2D', trait: traits.Canvas2D, category: 'component', fields: {} });
  registerTrait({ name: 'EntityAttributes', trait: traits.EntityAttributes, category: 'component', fields: {} });

  trackWorld(worldReg.getCurrentWorld());
  const world = trackWorld(createWorld());
  worldReg.setCurrentWorld(world);

  const renderer = (scene2d as unknown as { defaultRenderer: any }).defaultRenderer;
  // Every test drives the two systems together — transformPropagationSystem before
  // renderFrame, exactly like the real per-frame pipeline — so a parent-scale test needs no
  // special-casing versus a flat one.
  const step = () => { transformPropagationSystem(world); scene2d.renderFrame(); };
  return { traits, world, pool, scene2d, fontLoader, renderer, step };
}

// A 1-page font: everything lives on page 0 — these tests only ever render 'A'.
function makeFontProvider(id = 'font1') {
  const metrics = { emSize: 1, lineHeight: 1.2, ascender: -0.8, descender: 0.2 };
  const atlas = { type: 'mtsdf', distanceRange: 4, width: 256, height: 256, size: 32, yOrigin: 'top' as const };
  const glyphs = new Map<number, any>([
    [65, { unicode: 65, advance: 0.6, plane: { left: 0, top: -0.7, right: 0.6, bottom: 0.05 }, atlas: { left: 0, top: 0, right: 32, bottom: 32 }, page: 0 }], // 'A'
  ]);
  return {
    id, atlasVersion: 0, pageCount: 1, metrics, atlas,
    getGlyph: (cp: number) => glyphs.get(cp),
    kerning: () => 0,
    ensureGlyphs: () => {},
    addDisposable: () => {},
    dispose: () => {},
  };
}

function spawnCanvas(world: any, traits: any) {
  return world.spawn(
    traits.Canvas2D({ referenceWidth: 1080, referenceHeight: 1920, scaleMode: 'fitH' }),
    traits.EntityAttributes({ name: 'canvas', parentId: 0, sortOrder: 0, layer: 'ui' }),
  );
}

function spawnText(world: any, traits: any, parentId: number, text2d: any = {}, transform: any = {}) {
  return world.spawn(
    traits.Transform({ ...transform }),
    traits.Text2D({ text: 'A', font: 'font1', fontSize: 32, ...text2d }),
    traits.EntityAttributes({ name: 'text', parentId, sortOrder: 0, layer: '2d' }),
  );
}

function uScreenPxRange(renderer: any, textId: number): number {
  const slot = renderer.slots.get(textId);
  return slot.textShaders[0].resources.mtsdfUniforms.uniforms.uScreenPxRange;
}

// Set the canvas's BACKING size (what computeCanvasScale reads as actualW/actualH for
// scaleMode 'fitH': `scale = actualH / referenceHeight`, uniform on both axes so
// `compensateX === compensateY === 1` always — the "hole" test 6 exists to cover
// specifically exploits that: comp never moves, only the shared `scale` does). Requires the
// canvas's pool slot to already exist (a prior renderFrame()/pool.allocate() call).
function setCanvasHeight(pool: any, canvasId: number, height: number) {
  const slot = pool.getSlot(canvasId)!;
  slot.canvas.height = height;
}

/** A canvas with an explicit scaleMode — `fill` is the ONLY mode that makes `comp` differ from
 *  1 on either axis, so it is the only one that can tell the correct `effScale` apart from one
 *  that double-counts `comp`. Every other mode sets scaleX === scaleY, hence comp === (1,1). */
function spawnCanvasMode(world: any, traits: any, scaleMode: string) {
  return world.spawn(
    traits.Canvas2D({ referenceWidth: 1080, referenceHeight: 1920, scaleMode }),
    traits.EntityAttributes({ name: 'canvas', parentId: 0, sortOrder: 0, layer: 'ui' }),
  );
}

function setCanvasSize(pool: any, canvasId: number, width: number, height: number) {
  const slot = pool.getSlot(canvasId)!;
  slot.canvas.width = width;
  slot.canvas.height = height;
}

describe('Text2D uScreenPxRange tracks the on-screen size, not just authored fontSize (#752)', () => {
  const BASE = 32;

  it("1) Transform.sx on the entity itself: uScreenPxRange equals the value for base*k, not for base", async () => {
    const { traits, world, pool, step, fontLoader, renderer } = await setupText();
    fontLoader.__setProvider(makeFontProvider());
    const canvas = spawnCanvas(world, traits);
    step(); // allocates the canvas pool slot
    setCanvasHeight(pool, canvas.id(), 1920); // canvas scale = 1920/1920 = 1 (baseline)

    const K = 2;
    const text = spawnText(world, traits, canvas.id(), { fontSize: BASE }, { sx: K, sy: 1 });
    step();

    expect(uScreenPxRange(renderer, text.id())).toBe(BASE * K);
    expect(uScreenPxRange(renderer, text.id())).not.toBe(BASE); // the pre-#752 defect's answer
  });

  it('2) a static entity whose PARENT carries the scale: same result via the WORLD transform, not the local one', async () => {
    const { traits, world, pool, step, fontLoader, renderer } = await setupText();
    fontLoader.__setProvider(makeFontProvider());
    const canvas = spawnCanvas(world, traits);
    step();
    setCanvasHeight(pool, canvas.id(), 1920); // canvas scale = 1

    const K = 3;
    const parent = world.spawn(
      traits.Transform({ sx: K, sy: K }),
      traits.EntityAttributes({ name: 'group', parentId: canvas.id(), sortOrder: 0, layer: '2d' }),
    );
    // The text's OWN local Transform is untouched (sx=sy=1 default) — only its ANCESTOR scales.
    const text = spawnText(world, traits, parent.id(), { fontSize: BASE });
    step();

    expect(uScreenPxRange(renderer, text.id())).toBe(BASE * K);
  });

  it('3) a Canvas2D whose scaleMode yields scale != 1: the uniform tracks canvasScale * wt.s', async () => {
    const { traits, world, pool, step, fontLoader, renderer } = await setupText();
    fontLoader.__setProvider(makeFontProvider());
    const canvas = spawnCanvas(world, traits);
    step();
    setCanvasHeight(pool, canvas.id(), 960); // 'fitH': scale = 960/1920 = 0.5

    const text = spawnText(world, traits, canvas.id(), { fontSize: BASE });
    step();

    expect(uScreenPxRange(renderer, text.id())).toBe(BASE * 0.5);
  });

  it('4) NO REBUILD: changing only Transform.sx refreshes the uniform while leaving slot.meshFrameKey untouched (#677 regression guard)', async () => {
    const { traits, world, pool, step, fontLoader, renderer } = await setupText();
    fontLoader.__setProvider(makeFontProvider());
    const canvas = spawnCanvas(world, traits);
    step();
    setCanvasHeight(pool, canvas.id(), 1920); // canvas scale = 1

    const text = spawnText(world, traits, canvas.id(), { fontSize: BASE }, { sx: 1, sy: 1 });
    step();
    const slot1 = renderer.slots.get(text.id());
    const mfkBefore = slot1.meshFrameKey;
    const shaderBefore = slot1.textShaders[0];
    expect(uScreenPxRange(renderer, text.id())).toBe(BASE);

    const K = 2;
    text.set(traits.Transform, { ...text.get(traits.Transform), sx: K });
    step();

    const slot2 = renderer.slots.get(text.id());
    expect(slot2.meshFrameKey).toBe(mfkBefore);       // no relayout/rebuild
    expect(slot2.textShaders[0]).toBe(shaderBefore);  // same Shader instance, not rebuilt
    expect(uScreenPxRange(renderer, text.id())).toBe(BASE * K); // but the uniform DID refresh
  });

  it('5) non-uniform sx != sy resolves by the documented max(|sx|,|sy|) rule, including a flipped axis', async () => {
    const { traits, world, pool, step, fontLoader, renderer } = await setupText();
    fontLoader.__setProvider(makeFontProvider());
    const canvas = spawnCanvas(world, traits);
    step();
    setCanvasHeight(pool, canvas.id(), 1920); // canvas scale = 1

    // sx is NEGATIVE (a flipped glyph) and larger in magnitude than sy — proves BOTH the max
    // rule (result tracks 3, not 2, not their average) and Math.abs (a flip must not go negative
    // or silently pick the wrong axis via a signed max()).
    const text = spawnText(world, traits, canvas.id(), { fontSize: BASE }, { sx: -3, sy: 2 });
    step();

    expect(uScreenPxRange(renderer, text.id())).toBe(BASE * 3);
  });

  it("6) a uniform canvas resize (scaleX and scaleY both move together, comp stays 1,1) still refreshes the uniform — the 'changed' predicate hole", async () => {
    const { traits, world, pool, step, fontLoader, renderer } = await setupText();
    fontLoader.__setProvider(makeFontProvider());
    const canvas = spawnCanvas(world, traits);
    step();
    setCanvasHeight(pool, canvas.id(), 1920); // canvas scale = 1

    const text = spawnText(world, traits, canvas.id(), { fontSize: BASE }); // Transform untouched (sx=sy=1)
    step();
    const mfkBefore = renderer.slots.get(text.id()).meshFrameKey;
    expect(uScreenPxRange(renderer, text.id())).toBe(BASE);

    // Resize ONLY the canvas backing size — no ECS trait on ANY entity changes this frame, and
    // 'fitH' keeps scaleX===scaleY (and so compensateX===compensateY===1) at every size, so the
    // per-entity snapshot's x/y/rz/sx/sy/compX/compY are all identical to the previous frame.
    // Only the canvas's own `scale` moved.
    setCanvasHeight(pool, canvas.id(), 960); // scale = 0.5
    step();

    expect(renderer.slots.get(text.id()).meshFrameKey).toBe(mfkBefore); // still no rebuild
    expect(uScreenPxRange(renderer, text.id())).toBe(BASE * 0.5); // refreshed, not stale at BASE
  });

  it("7) scaleMode 'fill' (the ONLY mode where comp != 1): effScale uses the canvas's uniform scale and does NOT double-count comp", async () => {
    // Every other test here runs a uniform scaleMode, where compensateX === compensateY === 1 —
    // so they pass whether or not `comp` is (wrongly) multiplied into effScale, and the load-
    // bearing half of the derivation is asserted by nothing. `fill` is the discriminating case.
    //
    // ref 1080x1920, backing 1080x960 =>
    //   scaleX = 1080/1080 = 1 ; scaleY = 960/1920 = 0.5
    //   scale  = min(1, 0.5)  = 0.5
    //   comp   = (scale/scaleX, scale/scaleY) = (0.5, 1)
    // The on-screen factor per axis is scaleX*comp.x === scaleY*comp.y === scale, so effScale is
    // `scale * max(|sx|,|sy|)` = 0.5. Multiplying comp.x back in would give 0.25 — the exact
    // double-count the comment at Scene2D.tsx's effScale derivation warns against.
    const { traits, world, pool, step, fontLoader, renderer } = await setupText();
    fontLoader.__setProvider(makeFontProvider());
    const canvas = spawnCanvasMode(world, traits, 'fill');
    step(); // allocates the canvas pool slot
    setCanvasSize(pool, canvas.id(), 1080, 960);

    const text = spawnText(world, traits, canvas.id(), { fontSize: BASE }, { sx: 1, sy: 1 });
    step();

    expect(uScreenPxRange(renderer, text.id())).toBe(BASE * 0.5);      // correct: scale only
    expect(uScreenPxRange(renderer, text.id())).not.toBe(BASE * 0.25); // comp.x double-counted
    expect(uScreenPxRange(renderer, text.id())).not.toBe(BASE);        // canvas ignored entirely
  });
});
