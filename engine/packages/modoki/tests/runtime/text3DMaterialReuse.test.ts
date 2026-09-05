/** Wiring coverage for #692 — `mtsdfMaterialReuse.test.ts` pins `canReuseMtsdfMaterial`
 *  as a DECISION; nothing there exercises the `syncText3D` WIRING that consumes it
 *  (the reclaim-or-build branch and the `finally` cleanup in `scene3DSync.ts`). A fix
 *  that only gets the decision right can still ship as a silent no-op (never actually
 *  reused) or a silent leak (reclaimed but never freed) with every other gate green —
 *  this file drives the real, exported `syncText3D` through a real koota `World` with
 *  the real `Transform`/`Text3D` traits (mirroring `billboard3DSync.test.ts`, which
 *  proves the traits module doesn't need mocking) to catch exactly that.
 *
 *  Everything ASSET/GPU-shaped is mocked: `makeMtsdfMaterial` (a stub material that
 *  populates `userData` the way the real one does, so `canReuseMtsdfMaterial` — left
 *  REAL, not mocked, since it's what a passing wiring test must actually exercise —
 *  can evaluate it), `getFontTexture` (a STABLE per-page object; the real
 *  `getFontTexture` genuinely returns the same texture across frames for an unchanged
 *  page, verified independently against its cache keys, so a mock that minted a fresh
 *  object per call would make the reuse assertions pass for the wrong reason),
 *  `layoutText`/`buildTextGeometryByPage` (deterministic quads + page sets), and the
 *  loader/dirty-version plumbing. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => { vi.resetModules(); });

// `three/webgpu` is unresolvable in this package's node test env (see
// scene3DSync.test.ts's identical note) — mtsdfShader.ts imports `MeshBasicNodeMaterial`
// from it at module scope, so it must resolve even though our mocked `makeMtsdfMaterial`
// never calls the real one.
vi.mock('three/webgpu', () => ({ WebGPURenderer: class {}, MeshBasicNodeMaterial: class {} }));

interface Atlas { width: number; height: number; distanceRange: number; size: number; type: 'mtsdf' | 'msdf' }
const ATLAS: Atlas = { width: 512, height: 512, distanceRange: 8, size: 32, type: 'mtsdf' };

/** A minimal, valid single-quad geometry payload standing in for
 *  `buildTextGeometryByPage`'s real return shape — just enough for
 *  `THREE.BufferGeometry`/`BufferAttribute` construction to succeed. */
function fakeGeo() {
  return {
    positions: new Float32Array([0, 0, 1, 0, 1, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1]),
    colors: new Float32Array(12).fill(1),
    indices: new Uint16Array([0, 1, 2]),
  };
}

interface SetupOpts {
  /** Pages `buildTextGeometryByPage` returns, indexed by (0-based) REBUILD call —
   *  i.e. one entry per `syncText3D` call that actually changes `hash`. */
  pagesPerRebuild: number[][];
  /** If set, `getFontTexture` throws for this page — but only once `armThrow()` (returned
   *  by `setup`) has been called, and only AFTER any earlier page in the same rebuild has
   *  already been processed (mirrors "the loop got partway through, then blew up"). */
  throwForPage?: number;
}

async function setup(opts: SetupOpts) {
  // Some tests call `setup()` more than once (a fresh module graph per scenario) — the
  // `beforeEach` hook only resets before the FIRST call in a test, so reset again here
  // to guarantee every `setup()` gets its OWN mocked closures, not a cached, stale
  // module graph bound to a previous call's spies (which silently swallowed calls into
  // the wrong `ctx` and made this test lie).
  vi.resetModules();
  vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
  vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms: new Map(), deactivatedEntities: new Set(),
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(), resolveMeshLodInfo: vi.fn(), resolveMaterialForMesh: vi.fn(),
    resolveMaterial: vi.fn(), getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
    onModelInvalidated: vi.fn(), getMeshAsset: vi.fn(),
  }));
  vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));
  vi.doMock('../../src/runtime/loaders/riggedModelCache', () => ({
    getRiggedModel: vi.fn(), ensureRiggedModelLoaded: vi.fn(), ensureRiggedModelLoadedFor: vi.fn(),
  }));
  vi.doMock('three/examples/jsm/utils/SkeletonUtils.js', () => ({ clone: vi.fn(), retargetClip: vi.fn() }));
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    setActiveRenderer: vi.fn(), loadTexture3D: vi.fn(), releaseTexture3D: vi.fn(),
    getKTX2Loader: vi.fn(), getEnvFormat: vi.fn(), ensureKtx2Caps: vi.fn(),
    onRendererReady: (fn: () => void) => fn(),
  }));

  // ── Text-path deps: deterministic stand-ins for #692's wiring. ──────────────
  const provider = { atlasVersion: 1, atlas: { ...ATLAS }, ensureGlyphs: vi.fn() };
  let dirtyVersion = 0;
  vi.doMock('../../src/runtime/loaders/fontAtlasLoader', () => ({
    ensureFontLoaded: vi.fn(),
    getLoadedFont: vi.fn(() => provider),
  }));
  vi.doMock('../../src/runtime/rendering/text/textDirty', () => ({
    getTextDirtyVersion: vi.fn(() => dirtyVersion),
  }));
  vi.doMock('../../src/runtime/rendering/text/layoutText', () => ({
    layoutText: vi.fn(() => ({ quads: [], width: 10, height: 10 })),
  }));
  let rebuildCall = -1;
  vi.doMock('../../src/runtime/rendering/text/textMesh', () => ({
    buildTextGeometryByPage: vi.fn(() => {
      rebuildCall++;
      const pages = opts.pagesPerRebuild[rebuildCall] ?? opts.pagesPerRebuild[opts.pagesPerRebuild.length - 1];
      return pages.map((page) => ({ page, geo: fakeGeo() }));
    }),
    buildTextPositionsByPage: vi.fn(() => []),
    buildTextColorsByPage: vi.fn(() => []),
  }));

  // STABLE per-page object — same identity across calls for the same page, exactly
  // the real `getFontTexture`'s cache behaviour (keyed by `${provider.id}:...:${page}`).
  const texturesByPage = new Map<number, { __page: number }>();
  const throwArmed = { on: false };
  const getFontTexture = vi.fn((_provider: unknown, page = 0) => {
    if (opts.throwForPage === page && throwArmed.on) throw new Error(`getFontTexture boom on page ${page}`);
    if (!texturesByPage.has(page)) texturesByPage.set(page, { __page: page });
    return texturesByPage.get(page);
  });
  vi.doMock('../../src/runtime/rendering/text/fontTextureThree', () => ({ getFontTexture }));

  let matSeq = 0;
  const makeMtsdfMaterialCalls: unknown[] = [];
  const makeMtsdfMaterial = vi.fn((tex: unknown, atlasWidth: number, atlasHeight: number, distanceRange: number, atlasSize: number, _style: unknown, hasTrueSdf: boolean) => {
    const mat = {
      __tag: `mat-${matSeq++}`,
      dispose: vi.fn(),
      userData: {
        mtsdfUniforms: {},
        mtsdfShadowScale: { x: 1, y: 1 },
        mtsdfAtlas: { size: atlasSize, distanceRange, width: atlasWidth, height: atlasHeight, hasTrueSdf },
        mtsdfTexture: tex,
      },
    };
    makeMtsdfMaterialCalls.push(mat);
    return mat;
  });
  const updateMtsdfStyle = vi.fn();
  vi.doMock('../../src/runtime/rendering/text/mtsdfShader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/runtime/rendering/text/mtsdfShader')>();
    // `canReuseMtsdfMaterial` is left REAL — it's the thing this file's assertions
    // are ultimately trusting `syncText3D` to call correctly.
    return { ...actual, makeMtsdfMaterial, updateMtsdfStyle };
  });

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const T = await import('three');

  const world = createWorld();
  const scene = new T.Scene();
  const state = sync.createRenderState();
  const e = world.spawn(
    traits.Transform({}),
    traits.Text3D({ font: 'font-guid-1', text: 'A' }),
  );

  return {
    world, scene, state, e, sync, traits, provider,
    makeMtsdfMaterialCalls, getFontTexture,
    bumpAtlasVersion: () => { provider.atlasVersion++; },
    bumpTextDirty: () => { dirtyVersion++; },
    armThrow: () => { throwArmed.on = true; },
    runFrame: () => sync.syncText3D(world, scene, state),
    // `THREE.Mesh.material` types as `Material | Material[]`; our stub material is
    // neither, so callers cast through `unknown` (below) rather than this helper lying
    // about the type.
    pageMaterial: (page: number): unknown => state.textMeshes.get(e.id())!.pages.get(page)!.material,
    pageGeometry: (page: number) => state.textMeshes.get(e.id())!.pages.get(page)!.geometry,
  };
}

describe('syncText3D material reuse wiring (#692)', () => {
  it('a text-only change reuses the material (no shader recompile for a layout-only edit)', async () => {
    const ctx = await setup({ pagesPerRebuild: [[0], [0]] });
    ctx.runFrame();
    const mat1 = ctx.pageMaterial(0);
    const geo1 = ctx.pageGeometry(0);

    ctx.e.set(ctx.traits.Text3D, { ...ctx.e.get(ctx.traits.Text3D)!, text: 'B' });
    ctx.runFrame();
    const mat2 = ctx.pageMaterial(0);
    const geo2 = ctx.pageGeometry(0);

    expect(ctx.makeMtsdfMaterialCalls).toHaveLength(1); // never rebuilt the shader
    expect(mat2).toBe(mat1);                            // same material object...
    expect((mat1 as { dispose: ReturnType<typeof vi.fn> }).dispose).not.toHaveBeenCalled();
    expect(geo2).not.toBe(geo1);                         // ...but geometry DID rebuild (proves the frame actually ran)
  });

  it('an atlas change does NOT reuse the material, and frees the old one (no leak)', async () => {
    for (const trigger of ['atlasVersion', 'textDirty'] as const) {
      const ctx = await setup({ pagesPerRebuild: [[0], [0]] });
      ctx.runFrame();
      const mat1 = ctx.pageMaterial(0) as { dispose: ReturnType<typeof vi.fn> };

      if (trigger === 'atlasVersion') ctx.bumpAtlasVersion(); else ctx.bumpTextDirty();
      ctx.runFrame();
      const mat2 = ctx.pageMaterial(0);

      expect(ctx.makeMtsdfMaterialCalls).toHaveLength(2); // built a fresh material...
      expect(mat2).not.toBe(mat1);                        // ...a genuinely different object...
      expect(mat1.dispose).toHaveBeenCalledTimes(1);       // ...and the old one was freed exactly once
    }
  });

  it('a page the text no longer touches has its material disposed; a page it still touches does not', async () => {
    const ctx = await setup({ pagesPerRebuild: [[0, 1], [0]] });
    ctx.runFrame();
    const mat0a = ctx.pageMaterial(0) as { dispose: ReturnType<typeof vi.fn> };
    const mat1a = ctx.pageMaterial(1) as { dispose: ReturnType<typeof vi.fn> };

    ctx.e.set(ctx.traits.Text3D, { ...ctx.e.get(ctx.traits.Text3D)!, text: 'B' }); // hash changes, atlas doesn't
    ctx.runFrame();

    expect(mat1a.dispose).toHaveBeenCalledTimes(1); // page 1 no longer touched -> freed by the `finally` cleanup
    expect(mat0a.dispose).not.toHaveBeenCalled();   // page 0 still touched -> reclaimed, not freed
    expect(ctx.pageMaterial(0)).toBe(mat0a);
  });

  it('a throw mid-loop does not strand a reclaimed-but-unclaimed material (the reason the brief demanded `finally`)', async () => {
    const ctx = await setup({ pagesPerRebuild: [[0, 1], [0, 1]], throwForPage: 1 });
    ctx.runFrame();
    const mat0a = ctx.pageMaterial(0) as { dispose: ReturnType<typeof vi.fn> };
    const mat1a = ctx.pageMaterial(1) as { dispose: ReturnType<typeof vi.fn> };

    ctx.e.set(ctx.traits.Text3D, { ...ctx.e.get(ctx.traits.Text3D)!, text: 'B' }); // atlas unchanged -> both reclaimed into `reusable`
    ctx.armThrow(); // getFontTexture throws for page 1, AFTER page 0 is fully processed
    expect(() => ctx.runFrame()).toThrow(/boom/);

    // Page 1's original material was reclaimed into `reusable` but never re-claimed
    // before the throw — without `finally` it would be stranded (leaked) forever.
    expect(mat1a.dispose).toHaveBeenCalledTimes(1);
    // Page 0 was fully processed (reclaimed) before the throw — untouched.
    expect(mat0a.dispose).not.toHaveBeenCalled();
  });
});
