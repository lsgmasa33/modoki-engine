/** Wiring coverage for #692/#766/#715 — `mtsdfMaterialReuse.test.ts` pins
 *  `canReuseMtsdfMaterial` as a DECISION; nothing there exercises the `syncText3D` WIRING
 *  that consumes it (the reclaim-or-build branch, the layout-only fast path, and the
 *  build-before-dispose ordering in `scene3DSync.ts`). A fix that only gets the decision
 *  right can still ship as a silent no-op (never actually reused, or the fast path never
 *  fires), a silent leak (reclaimed but never freed), or a transient double-free (disposed
 *  before the replacement is built) with every other gate green — this file drives the
 *  real, exported `syncText3D` through a real koota `World` with the real `Transform`/
 *  `Text3D` traits (mirroring `billboard3DSync.test.ts`, which proves the traits module
 *  doesn't need mocking) to catch exactly that.
 *
 *  Everything ASSET/GPU-shaped is mocked: `makeMtsdfMaterial` (a stub material that
 *  populates `userData` the way the real one does, so `canReuseMtsdfMaterial` — left
 *  REAL, not mocked, since it's what a passing wiring test must actually exercise —
 *  can evaluate it), `getFontTexture` (a STABLE per-page object; the real
 *  `getFontTexture` genuinely returns the same texture across frames for an unchanged
 *  page, verified independently against its cache keys, so a mock that minted a fresh
 *  object per call would make the reuse assertions pass for the wrong reason),
 *  `layoutText`/`buildTextGeometryByPage`/`buildTextPositionsByPage` (deterministic quads +
 *  page sets over a real 4-vertex glyph quad, so the same per-page vertex COUNT
 *  `canWriteTextPositionsInPlace` — also left REAL — checks is exercised at its real
 *  cardinality, not a 3-vertex stand-in that happens to agree with itself), and the
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
 *  `THREE.BufferGeometry`/`BufferAttribute` construction to succeed. Four vertices, matching
 *  the real per-glyph quad shape (`textMesh.ts` always emits 2 triangles / 4 corners per
 *  glyph) — a 3-vertex stand-in can't catch a per-page LENGTH mismatch that only shows up
 *  against a real 4-vertex quad. */
function fakeGeo() {
  return {
    positions: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), // (0,0) (1,0) (0,1) (1,1)
    uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    colors: new Float32Array(16).fill(1),
    indices: new Uint16Array([0, 1, 2, 2, 1, 3]),
  };
}

interface SetupOpts {
  /** Pages `buildTextGeometryByPage` returns, indexed by (0-based) REBUILD call —
   *  i.e. one entry per `syncText3D` call that actually goes through the FULL rebuild
   *  (a fast-path frame calls neither `buildTextGeometryByPage` nor advances this index). */
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
  // `width`/`height` stay fixed so anchor math (`-anchorX*width`, `anchorY*height`) is
  // driven purely by the trait's anchor fields in the anchor test below.
  vi.doMock('../../src/runtime/rendering/text/layoutText', () => ({
    layoutText: vi.fn(() => ({ quads: [], width: 10, height: 10 })),
  }));
  let rebuildCall = -1;
  vi.doMock('../../src/runtime/rendering/text/textMesh', async (importOriginal) => {
    // `canWriteTextPositionsInPlace` is left REAL — an explicit-export mock omitting it would
    // fail at IMPORT-BINDING time (scene3DSync.ts imports it too), not in an assertion, and
    // it's the guard this file's fast-path assertions are ultimately trusting `syncText3D` to
    // call correctly, same posture as `canReuseMtsdfMaterial` above.
    const actual = await importOriginal<typeof import('../../src/runtime/rendering/text/textMesh')>();
    return {
      ...actual,
      buildTextGeometryByPage: vi.fn(() => {
        rebuildCall++;
        const pages = opts.pagesPerRebuild[rebuildCall] ?? opts.pagesPerRebuild[opts.pagesPerRebuild.length - 1];
        return pages.map((page) => ({ page, geo: fakeGeo() }));
      }),
      // Consistent with `fakeGeo()`'s single-page (page 0), 4-vertex positions — same 2-component
      // values a full rebuild would feed through `positionsTo3D`, so the fast path and a full
      // rebuild land on identical final positions once `entry.ax/ay` is added on top of both.
      buildTextPositionsByPage: vi.fn(() => [{ page: 0, positions: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]) }]),
      buildTextColorsByPage: vi.fn(() => []),
    };
  });

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
    world, scene, state, e, sync, traits, provider, T,
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

describe('syncText3D layout-only fast path wiring (#766) and rebuild ordering (#715)', () => {
  it('fastpath: a fontSize-only change keeps the same geometry + position attribute object, in place', async () => {
    const ctx = await setup({ pagesPerRebuild: [[0]] });
    ctx.runFrame();
    const geo1 = ctx.pageGeometry(0);
    const attr1 = geo1.getAttribute('position') as InstanceType<typeof ctx.T.BufferAttribute>;
    const version1 = attr1.version;

    ctx.e.set(ctx.traits.Text3D, { ...ctx.e.get(ctx.traits.Text3D)!, fontSize: 2 });
    ctx.runFrame();
    const geo2 = ctx.pageGeometry(0);
    const attr2 = geo2.getAttribute('position') as InstanceType<typeof ctx.T.BufferAttribute>;

    expect(ctx.makeMtsdfMaterialCalls).toHaveLength(1); // never rebuilt — fast path never calls it a 2nd time
    expect(geo2).toBe(geo1);                            // SAME geometry object...
    expect(attr2).toBe(attr1);                          // ...and SAME position attribute object
    // `needsUpdate` is a write-only setter on THREE.BufferAttribute that bumps `.version` —
    // that bump is the only externally-observable proof it was set.
    expect(attr2.version).toBeGreaterThan(version1);

    // Values match what a full rebuild would have produced: mocked positions at
    // (0,0)/(1,0)/(0,1)/(1,1) plus the (unchanged, anchor 0.5/0.5 on a 10x10 layout) anchor
    // offset (ax=-5, ay=+5).
    const arr = attr2.array as Float32Array;
    expect(Array.from(arr)).toEqual([-5, 5, 0, -4, 5, 0, -5, 6, 0, -4, 6, 0]);
  });

  it('anchor: an anchor-only change takes the fast path and updates entry.ax/ay to the NEW values', async () => {
    const ctx = await setup({ pagesPerRebuild: [[0]] });
    ctx.runFrame();
    const geo1 = ctx.pageGeometry(0);
    const entryBefore = ctx.state.textMeshes.get(ctx.e.id())!;
    expect(entryBefore.ax).toBeCloseTo(-5); // -0.5 * width(10)
    expect(entryBefore.ay).toBeCloseTo(5);  // 0.5 * height(10)

    ctx.e.set(ctx.traits.Text3D, { ...ctx.e.get(ctx.traits.Text3D)!, anchorX: 0, anchorY: 1 });
    ctx.runFrame();

    expect(ctx.makeMtsdfMaterialCalls).toHaveLength(1); // still the fast path — no rebuild
    expect(ctx.pageGeometry(0)).toBe(geo1);             // the fast path took over — no new geometry
    const entryAfter = ctx.state.textMeshes.get(ctx.e.id())!;
    expect(entryAfter.ax).toBeCloseTo(0);   // -0 * width
    expect(entryAfter.ay).toBeCloseTo(10);  // 1 * height
  });

  it('refusal: a text change does NOT take the fast path — new geometry, full rebuild', async () => {
    const ctx = await setup({ pagesPerRebuild: [[0], [0]] });
    ctx.runFrame();
    const geo1 = ctx.pageGeometry(0);

    ctx.e.set(ctx.traits.Text3D, { ...ctx.e.get(ctx.traits.Text3D)!, text: 'B' });
    ctx.runFrame();
    const geo2 = ctx.pageGeometry(0);

    expect(ctx.makeMtsdfMaterialCalls).toHaveLength(1); // material still reclaimed (atlas unchanged)...
    expect(geo2).not.toBe(geo1);                        // ...but geometry is NOT the same object — full rebuild ran
  });

  it('fastpath: invalidates the page geometry\'s cached bounding box/sphere so picking/framing re-measure the new extent', async () => {
    const ctx = await setup({ pagesPerRebuild: [[0]] });
    ctx.runFrame();
    const geo1 = ctx.pageGeometry(0);
    geo1.computeBoundingBox();
    geo1.computeBoundingSphere();
    expect(geo1.boundingBox).not.toBeNull();
    expect(geo1.boundingSphere).not.toBeNull();

    ctx.e.set(ctx.traits.Text3D, { ...ctx.e.get(ctx.traits.Text3D)!, fontSize: 16 });
    ctx.runFrame();

    // Same geometry object (fast path), but the STALE bounds must not survive the rewrite.
    expect(ctx.pageGeometry(0)).toBe(geo1);
    expect(geo1.boundingBox).toBeNull();
    expect(geo1.boundingSphere).toBeNull();

    // Recomputing now reflects the NEW positions, not the pre-edit extent.
    geo1.computeBoundingBox();
    const arr = (geo1.getAttribute('position') as InstanceType<typeof ctx.T.BufferAttribute>).array as Float32Array;
    expect(geo1.boundingBox!.max.x).toBeCloseTo(Math.max(arr[0], arr[3], arr[6], arr[9]));
  });

  it('ordering/#715: the replacement mesh already exists at the moment the superseded geometry is disposed', async () => {
    const ctx = await setup({ pagesPerRebuild: [[0], [0]] });
    ctx.runFrame();
    const geo1 = ctx.pageGeometry(0);

    let observed: { replacementInstalled: boolean } | undefined;
    const disposeSpy = vi.spyOn(geo1, 'dispose').mockImplementation(function (this: InstanceType<typeof ctx.T.BufferGeometry>) {
      const current = ctx.state.textMeshes.get(ctx.e.id())!.pages.get(0);
      observed = { replacementInstalled: !!current && current.geometry !== geo1 };
      return ctx.T.BufferGeometry.prototype.dispose.call(this);
    });

    // A `text` edit forces a full rebuild (fast path refuses — buildKey includes `text`).
    ctx.e.set(ctx.traits.Text3D, { ...ctx.e.get(ctx.traits.Text3D)!, text: 'B' });
    ctx.runFrame();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(observed).toBeDefined();
    expect(observed!.replacementInstalled).toBe(true); // the NEW mesh was already installed before dispose ran
  });
});
