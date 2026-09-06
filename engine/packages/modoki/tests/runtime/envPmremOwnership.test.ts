/** The engine now owns PMREM AND cube derivation for HDR environments instead of leaving either
 *  to three's lazy per-node path (#739, extended to the BACKGROUND by #775/#779).
 *
 *  THE DEFECT THIS PINS. Every scene swap that changed the env texture's OBJECT IDENTITY made
 *  three build a fresh conversion via a fresh internal node (`PMREMNode.updateBefore` /
 *  `CubeMapNode.updateBefore`, reached because a raw equirectangular texture is neither
 *  `isPMREMTexture`/`CubeUVReflectionMapping` nor already a non-equirect mapping). Three frees only
 *  the derived *output* texture, via a dispose listener on the SOURCE texture — the scratch state
 *  each conversion builds along the way (a PMREM generator's `_pingPongRenderTarget`, ~6 MB of
 *  half-float, plus 11 LOD-mesh geometries; or a `CubeRenderTarget`'s scratch render pass) is freed
 *  only by disposing the generator/target itself, which nothing on the scene-swap path ever did.
 *  Unbounded leak, one conversion's worth per environment/background change.
 *
 *  The fix generates both itself (`getEnvPMREMTexture`/`getEnvCubeTexture`), disposing scratch
 *  state immediately after use, and binds the output — which three's `PMREMNode`/`CubeMapNode` use
 *  directly — to `scene.environment`/`scene.background`. See `envPmrem.ts`'s "Environment
 *  PMREM/cube derivation" section for the mechanism this test suite pins (moved out of
 *  `meshTemplateCache.ts` in #739 — see that module's "Environment PMREM disposal hook" comment
 *  for why). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Fakes for the two conversions: real generation needs an actual GPU context, which this suite
// doesn't have. What matters here is OWNERSHIP — one generator/target per call, its scratch state
// disposed immediately, its output kept alive until explicitly disposed — not the pixels it would
// have produced. This mocks `three/webgpu` (NOT `three` — `envPmrem.ts` imports both
// `PMREMGenerator` and `CubeRenderTarget` from there specifically, see its ⚠️ comment on why the
// two `PMREMGenerator`s are not interchangeable).
// `failSources`: a Set of source textures for which the matching mock should throw instead of
// succeeding — lets tests (FIX 3) drive a real failure through `buildEnvDerivedTarget` without a
// real GPU context, independently per kind (`failSources.pmrem` / `failSources.cube`).
const pmrem = vi.hoisted(() => ({ generateCalls: 0, failSources: new Set<unknown>() }));
const cube = vi.hoisted(() => ({ generateCalls: 0, failSources: new Set<unknown>() }));
vi.mock('three/webgpu', () => ({
  PMREMGenerator: class {
    disposed = false;
    constructor(public renderer: unknown) {}
    fromEquirectangular(source: unknown) {
      pmrem.generateCalls++;
      if (pmrem.failSources.has(source)) throw new Error('mock pmrem generation failure');
      const rt = {
        texture: { isTexture: true, isPMREMTexture: true, mapping: 'CubeUVReflectionMapping', uuid: `pmrem-${pmrem.generateCalls}`, dispose: vi.fn() },
        dispose: vi.fn(),
        _source: source,
      };
      return rt;
    }
    dispose() { this.disposed = true; }
  },
  CubeRenderTarget: class {
    texture: unknown;
    _source: unknown;
    constructor(public size: number) {}
    fromEquirectangularTexture(renderer: unknown, source: unknown) {
      cube.generateCalls++;
      if (cube.failSources.has(source)) {
        // Mirror three's REAL `CubeRenderTarget.fromEquirectangularTexture`/`CubeCamera.update`:
        // both dirty the renderer's bound target/MRT/XR-enabled state and the source's
        // minFilter/generateMipmaps on the way to a render, restoring them only on the normal-
        // return path — there is no `finally` upstream. Guarded so the plain `{}` renderers the
        // OTHER failure tests in this file use stay no-ops.
        const r = renderer as { setRenderTarget?: (t: unknown) => void; setMRT?: (m: unknown) => void; xr?: { enabled: boolean } };
        if (typeof r.setRenderTarget === 'function') r.setRenderTarget(this);
        if (typeof r.setMRT === 'function') r.setMRT(null);
        if (r.xr) r.xr.enabled = false;
        // Plain sentinel values, not real THREE filter constants — `vi.mock` factories are
        // hoisted above the `THREE` import, so referencing it here would be a TDZ hazard, and
        // the test only needs "changed to something else", not a faithful filter constant.
        const s = source as { minFilter?: unknown; generateMipmaps?: boolean };
        s.minFilter = 'dirtied-filter';
        s.generateMipmaps = true;
        throw new Error('mock cube generation failure');
      }
      this.texture = { isTexture: true, isCubeTexture: true, uuid: `cube-${cube.generateCalls}`, dispose: vi.fn() };
      this._source = source;
      return this;
    }
    dispose() { (this.texture as { dispose: () => void } | undefined)?.dispose(); }
  },
}));

import {
  disposeRetiredEnvironment, disposeAllCachedResources,
  acquireEnvironment, releaseEnvironment, invalidateEnvironment, getCachedEnvironment,
  retiredEnvironments,
} from '../../src/runtime/loaders/meshTemplateCache';
import { getEnvPMREMTexture, getEnvCubeTexture, sourceForEnvDerived, disposeEnvDerivedFor } from '../../src/runtime/rendering/envPmrem';
import { syncEnvironment } from '../../src/runtime/rendering/scene3DSync';
import { registerAsset, clearManifest } from '../../src/runtime/loaders/assetManifest';
import { setRenderSettings, resetRenderSettings } from '../../src/runtime/rendering/renderSettings';
import { createWorld } from 'koota';
import { Environment } from '../../src/three/traits/Environment';

// Distinct fake HDR loads (mirrors environmentInvalidationRetires.test.ts) so identity checks are
// meaningful.
const hdr = vi.hoisted(() => ({ n: 0 }));
vi.mock('three/examples/jsm/loaders/HDRLoader.js', () => ({
  HDRLoader: class {
    load(path: string, onLoad: (texture: unknown) => void) {
      // `image.height` is real on any THREE texture — `getEnvCubeTexture`'s `CubeRenderTarget`
      // sizing reads it (see `buildEnvDerivedTarget`'s 'cube' branch) — so the fake needs one too.
      const tex = { mapping: 0, isTexture: true, dispose: vi.fn(), image: { height: 512, width: 1024 }, uuid: `hdr-${path}-${++hdr.n}` };
      setTimeout(() => onLoad(tex), 0);
    }
  },
}));

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
};

const GUID = '55555555-6666-4777-8888-999999999999';
const PATH = '/games/g/assets/env/sky2.hdr';

const spawnEnv = (world: ReturnType<typeof createWorld>, showAsBackground = true) =>
  world.spawn(Environment({ hdrPath: GUID, intensity: 1, showAsBackground, backgroundIntensity: 1, backgroundBlurriness: 0 }));

beforeEach(() => {
  pmrem.generateCalls = 0;
  cube.generateCalls = 0;
  pmrem.failSources.clear();
  cube.failSources.clear();
  hdr.n = 0;
  clearManifest();
  registerAsset(GUID, PATH, 'environment');
});

afterEach(() => {
  clearManifest();
});

// Cheap static guard for the bug that nearly shipped alongside #739: importing `PMREMGenerator`
// from `'three'` (core, `ShaderMaterial`-based, only works with `WebGLRenderer`) instead of
// `'three/webgpu'` (the node-based one a `WebGPURenderer` can actually render with). A BEHAVIOURAL
// test cannot catch this — the wrong generator does not throw, it logs `NodeBuilder: Material
// "ShaderMaterial" is not compatible` and hands back a target that rendered nothing, so this
// mocked-fromEquirectangular suite (and every other unit test) stays green while the real thing is
// silently black. So this reads the SOURCE TEXT instead, and asserts the one line that matters.
describe('envPmrem.ts imports the WebGPU PMREMGenerator, not the core one', () => {
  it('imports PMREMGenerator from three/webgpu and never references THREE.PMREMGenerator', () => {
    const src = readFileSync(join(__dirname, '../../src/runtime/rendering/envPmrem.ts'), 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*PMREMGenerator[^}]*\}\s*from\s*'three\/webgpu'/);
    // Checks actual USE (`new THREE.PMREMGenerator(`), not the file's own warning comment about
    // it — that comment names `THREE.PMREMGenerator` on purpose, to explain why it's wrong.
    expect(src).not.toMatch(/new\s+THREE\.PMREMGenerator\s*\(/);
  });
});

describe('getEnvPMREMTexture', () => {
  it('generates once, then returns the cached texture for the same (renderer, source)', () => {
    const renderer = {};
    const source = new THREE.DataTexture();

    const first = getEnvPMREMTexture(renderer, source);
    expect(pmrem.generateCalls).toBe(1);
    expect(first).toBeTruthy();

    const second = getEnvPMREMTexture(renderer, source);
    expect(pmrem.generateCalls, 'a second call for the same pair must NOT regenerate').toBe(1);
    expect(second).toBe(first);
  });

  it('returns undefined when there is no renderer yet', () => {
    const source = new THREE.DataTexture();
    expect(getEnvPMREMTexture(null, source)).toBeUndefined();
    expect(getEnvPMREMTexture(undefined, source)).toBeUndefined();
    expect(pmrem.generateCalls).toBe(0);
  });
});

describe('disposeRetiredEnvironment frees the PMREM with its source', () => {
  it('disposes the render target and lets a later call regenerate', () => {
    const renderer = {};
    const source = new THREE.DataTexture();

    const first = getEnvPMREMTexture(renderer, source)!;
    expect(sourceForEnvDerived(first)).toBe(source);

    // disposeRetiredEnvironment requires the texture to actually be in the retired set —
    // mirror that contract rather than calling disposeEnvDerivedFor directly.
    (retiredEnvironments() as Set<THREE.DataTexture>).add(source);
    disposeRetiredEnvironment(source);

    expect(sourceForEnvDerived(first), 'the reverse mapping must be dropped too').toBeUndefined();

    const second = getEnvPMREMTexture(renderer, source);
    expect(pmrem.generateCalls, 'freeing the PMREM must force a fresh build on next use').toBe(2);
    expect(second).not.toBe(first);
  });
});

describe('sourceForEnvDerived', () => {
  it('resolves a PMREM output back to its source, and undefined for anything else', () => {
    const renderer = {};
    const source = new THREE.DataTexture();
    const pmremTex = getEnvPMREMTexture(renderer, source)!;

    expect(sourceForEnvDerived(pmremTex)).toBe(source);
    expect(sourceForEnvDerived(source), 'the raw equirect itself is not a tracked PMREM output').toBeUndefined();
    expect(sourceForEnvDerived(new THREE.DataTexture())).toBeUndefined();
  });
});

describe('sweepRetiredEnvironments keeps a source alive while its PMREM is still bound (#739)', () => {
  it('does not dispose a retired equirect whose PMREM sits on scene.environment', async () => {
    // syncEnvironment (#739) takes ITS OWN surface's renderer as an explicit argument now, never a
    // global "active renderer" lookup — pass one directly rather than registering it globally.
    const renderer = {};
    try {
      const world = createWorld();
      // showAsBackground OFF: `scene.background` binds the raw equirect directly (unchanged by
      // #739 — only `.environment` moved to the PMREM), which would keep `source` in the sweep's
      // `bound` set through THAT path and mask whether the PMREM reverse-mapping is doing anything.
      spawnEnv(world, false);
      await acquireEnvironment(1, GUID);
      const source = getCachedEnvironment(GUID) as THREE.DataTexture;
      expect(source, 'the HDR fixture must actually load, or this test proves nothing').toBeTruthy();

      const scene = new THREE.Scene();
      syncEnvironment(world, scene, renderer as never);
      // scene.environment now holds the PMREM output, not the raw equirect.
      expect(scene.environment).not.toBe(source);
      expect(sourceForEnvDerived(scene.environment as THREE.Texture)).toBe(source);

      invalidateEnvironment(PATH); // retires `source` while the PMREM built from it is still bound
      expect(retiredEnvironments().has(source)).toBe(true);

      // A frame in the gap before the re-fetch lands: the cache miss branch runs, which does NOT
      // touch scene.environment this frame — it stays on the old PMREM. The sweep at the end of
      // this call is what's under test.
      syncEnvironment(world, scene, renderer as never);

      expect((source as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose,
        'the source is still reachable through the bound PMREM — freeing it here is the #315 shape').not.toHaveBeenCalled();
      expect(retiredEnvironments().has(source), 'still retired, not yet swept').toBe(true);

      await settle(); // let the re-fetch land so the next sync can rebind and the retiree finally frees
      syncEnvironment(world, scene, renderer as never);
      expect((source as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalledTimes(1);
    } finally {
      releaseEnvironment(1, GUID);
    }
  });
});

describe('disposeAllCachedResources runs the env dispose hooks too', () => {
  it('frees a PMREM built from a LIVE (never-retired) cached env, via the envCache loop', async () => {
    // The suite above only exercises `disposeRetiredEnvironment`'s hook fan-out (the `retiredEnvs`
    // loop). `disposeAllCachedResources` has a SECOND, separate call site over `envCache` itself
    // (never-retired, still-live entries) — this pins that one too.
    const renderer = {};
    const world = createWorld();
    spawnEnv(world, false);
    await acquireEnvironment(1, GUID);
    const source = getCachedEnvironment(GUID) as THREE.DataTexture;
    expect(source, 'the HDR fixture must actually load, or this test proves nothing').toBeTruthy();

    const scene = new THREE.Scene();
    syncEnvironment(world, scene, renderer as never);
    const pmremTex = scene.environment as THREE.Texture;
    expect(sourceForEnvDerived(pmremTex)).toBe(source);

    disposeAllCachedResources(); // full teardown — `source` is still live in envCache, not retired
    expect(sourceForEnvDerived(pmremTex), 'the env dispose hook must run from the envCache loop too').toBeUndefined();
  });
});

// ── Background derivation (#775, #779) ─────────────────────────────

describe('syncEnvironment binds a CUBE texture for a sharp background (#775)', () => {
  it('scene.background is a cube texture at backgroundBlurriness 0, never a PMREM', async () => {
    const renderer = {};
    const world = createWorld();
    world.spawn(Environment({ hdrPath: GUID, intensity: 1, showAsBackground: true, backgroundIntensity: 1, backgroundBlurriness: 0 }));
    await acquireEnvironment(1, GUID);
    try {
      const scene = new THREE.Scene();
      syncEnvironment(world, scene, renderer as never);
      const bg = scene.background as unknown as { isCubeTexture?: boolean; isPMREMTexture?: boolean };
      expect(bg?.isCubeTexture, 'a sharp background must go through the cube door, or NodeManager blurs it').toBe(true);
      expect(bg?.isPMREMTexture).toBeUndefined();
      expect(cube.generateCalls).toBe(1);
    } finally {
      releaseEnvironment(1, GUID);
    }
  });
});

describe('syncEnvironment shares ONE PMREM between environment and background for a blurred background (#779)', () => {
  it('scene.background === scene.environment at backgroundBlurriness > 0 — zero extra GPU memory', async () => {
    const renderer = {};
    const world = createWorld();
    world.spawn(Environment({ hdrPath: GUID, intensity: 1, showAsBackground: true, backgroundIntensity: 1, backgroundBlurriness: 0.5 }));
    await acquireEnvironment(1, GUID);
    try {
      const scene = new THREE.Scene();
      syncEnvironment(world, scene, renderer as never);
      const bg = scene.background as unknown as { isPMREMTexture?: boolean };
      expect(bg?.isPMREMTexture).toBe(true);
      // The identity check IS the "zero extra GPU memory" claim — a check that only compares
      // isPMREMTexture flags would pass even if the background built its OWN generator.
      expect(scene.background, 'background and environment must be the SAME object, not two PMREMs of the same source').toBe(scene.environment);
      expect(pmrem.generateCalls, 'one PMREM build shared by both bindings').toBe(1);
    } finally {
      releaseEnvironment(1, GUID);
    }
  });
});

describe('crossing backgroundBlurriness at runtime rebinds the other kind', () => {
  it('flips scene.background from cube to PMREM and back as the authored value changes live', async () => {
    const renderer = {};
    const world = createWorld();
    const entity = world.spawn(Environment({ hdrPath: GUID, intensity: 1, showAsBackground: true, backgroundIntensity: 1, backgroundBlurriness: 0 }));
    await acquireEnvironment(1, GUID);
    try {
      const scene = new THREE.Scene();
      syncEnvironment(world, scene, renderer as never);
      expect((scene.background as unknown as { isCubeTexture?: boolean })?.isCubeTexture).toBe(true);

      entity.set(Environment, { backgroundBlurriness: 0.5 });
      syncEnvironment(world, scene, renderer as never);
      expect((scene.background as unknown as { isPMREMTexture?: boolean })?.isPMREMTexture).toBe(true);

      entity.set(Environment, { backgroundBlurriness: 0 });
      syncEnvironment(world, scene, renderer as never);
      expect((scene.background as unknown as { isCubeTexture?: boolean })?.isCubeTexture).toBe(true);
    } finally {
      releaseEnvironment(1, GUID);
    }
  });
});

describe('disposeEnvDerivedFor covers BOTH kinds built from one source', () => {
  it('disposes the pmrem and cube targets and clears both reverse lookups', () => {
    const renderer = {};
    const source = new THREE.DataTexture();
    const pmremTex = getEnvPMREMTexture(renderer, source)!;
    const cubeTex = getEnvCubeTexture(renderer, source)!;
    expect(sourceForEnvDerived(pmremTex)).toBe(source);
    expect(sourceForEnvDerived(cubeTex)).toBe(source);

    disposeEnvDerivedFor(source);

    expect(sourceForEnvDerived(pmremTex), 'the PMREM reverse mapping must be dropped').toBeUndefined();
    expect(sourceForEnvDerived(cubeTex), 'the cube reverse mapping must be dropped').toBeUndefined();

    // Both must regenerate on next use, independently — the render TARGET is what gets disposed
    // (`rt.dispose()`, mirroring the existing PMREM-only disposal test above), which is why a
    // freed pair can't be reused even though the mock's own `.dispose()` lives on the target, not
    // on the texture handed back to callers.
    const pmremAgain = getEnvPMREMTexture(renderer, source);
    const cubeAgain = getEnvCubeTexture(renderer, source);
    expect(pmrem.generateCalls, 'freeing the PMREM must force a fresh build on next use').toBe(2);
    expect(cube.generateCalls, 'freeing the cube target must force a fresh build on next use').toBe(2);
    expect(pmremAgain).not.toBe(pmremTex);
    expect(cubeAgain).not.toBe(cubeTex);
  });
});

describe('sweepRetiredEnvironments keeps a source alive while ONLY its background derivation is bound (#315, #775/#779)', () => {
  it('does not dispose a retired equirect whose cube background is bound with IBL suppressed', async () => {
    const renderer = {};
    // Force IBL off directly on the base overrides (never mind which tier is active — see
    // `qualityTier.ts`'s `resolveTierOverrides`: `low`/`mid` fall back to the SAME base as `high`
    // when nothing authored a `tiers.low`/`tiers.mid` block, which nothing here does) so
    // `scene.environment` stays null and the ONLY thing that can keep `source` reachable is the
    // background branch this test targets — otherwise the environment branch (already covered
    // above) would mask whether the background resolve-and-add actually does anything.
    setRenderSettings({ three: { ibl: false } });
    try {
      const world = createWorld();
      world.spawn(Environment({ hdrPath: GUID, intensity: 1, showAsBackground: true, backgroundIntensity: 1, backgroundBlurriness: 0 }));
      await acquireEnvironment(1, GUID);
      const source = getCachedEnvironment(GUID) as THREE.DataTexture;
      expect(source, 'the HDR fixture must actually load, or this test proves nothing').toBeTruthy();

      const scene = new THREE.Scene();
      syncEnvironment(world, scene, renderer as never);
      expect(scene.environment, 'IBL is suppressed — environment must not be what protects source here').toBeNull();
      expect(scene.background).not.toBe(source);
      expect(sourceForEnvDerived(scene.background as THREE.Texture)).toBe(source);

      invalidateEnvironment(PATH); // retires `source` while the cube built from it is still bound
      expect(retiredEnvironments().has(source)).toBe(true);

      syncEnvironment(world, scene, renderer as never);
      expect((source as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose,
        'the source is still reachable through the bound cube background — freeing it here is the #315 shape').not.toHaveBeenCalled();
      expect(retiredEnvironments().has(source), 'still retired, not yet swept').toBe(true);

      await settle(); // let the re-fetch land so the next sync can rebind and the retiree finally frees
      syncEnvironment(world, scene, renderer as never);
      expect((source as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalledTimes(1);
    } finally {
      releaseEnvironment(1, GUID);
      resetRenderSettings();
    }
  });
});

describe('per-kind negative cache (adversarial review of #739/#775/#779)', () => {
  // Guards `perRendererFailures[kind]` staying keyed by `kind` in both the early-return check and
  // the `.add()` call in `getEnvDerivedTexture` — a `perRendererFailures.pmrem` typo in either spot
  // makes a CUBE failure poison the PMREM (or vice versa) for the same source, which silently
  // restores the #739/#779 black-environment fallback for a texture whose OTHER kind was never
  // asked to fail.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('kinds fail independently: a cube failure does not poison the pmrem for the same source', () => {
    const renderer = {};
    const source = new THREE.DataTexture();
    source.image = { height: 512, width: 1024 } as never;
    cube.failSources.add(source);

    expect(getEnvCubeTexture(renderer, source)).toBeUndefined();
    expect(getEnvPMREMTexture(renderer, source), 'a cube failure must not suppress the pmrem for the same source').toBeTruthy();
  });

  it('caches the failure: a second call for the same failing triple does not rebuild', () => {
    const renderer = {};
    const source = new THREE.DataTexture();
    source.image = { height: 512, width: 1024 } as never;
    cube.failSources.add(source);

    expect(getEnvCubeTexture(renderer, source)).toBeUndefined();
    expect(cube.generateCalls).toBe(1);

    expect(getEnvCubeTexture(renderer, source), 'a second call for an already-failed triple must not retry').toBeUndefined();
    expect(cube.generateCalls, 'no per-frame retry storm').toBe(1);
  });

  it('disposeEnvDerivedFor clears the failure and lets a legitimate retry succeed', () => {
    const renderer = {};
    const source = new THREE.DataTexture();
    source.image = { height: 512, width: 1024 } as never;
    cube.failSources.add(source);

    expect(getEnvCubeTexture(renderer, source)).toBeUndefined();
    expect(cube.generateCalls).toBe(1);

    disposeEnvDerivedFor(source);
    cube.failSources.delete(source); // the transient condition clears — the retry should now succeed

    const retried = getEnvCubeTexture(renderer, source);
    expect(retried, 'a legitimate retry after disposeEnvDerivedFor must build and return a texture').toBeTruthy();
    expect(cube.generateCalls).toBe(2);
  });

  it('not-ready (FIX 2) is not cached: an image that appears later succeeds with no disposeEnvDerivedFor in between', () => {
    const renderer = {};
    const source = new THREE.DataTexture();
    // No `image` yet — mirrors a source mid-load on the first frame `syncEnvironment` observes it.
    source.image = undefined as never;

    expect(getEnvCubeTexture(renderer, source), 'not-ready must degrade for this frame').toBeUndefined();
    expect(cube.generateCalls, 'not-ready must never even attempt a build').toBe(0);

    // The image populates (load completes) — no disposeEnvDerivedFor call in between, which is
    // exactly the point: not-ready must not have poisoned the failure cache.
    source.image = { height: 512, width: 1024 } as never;

    const ready = getEnvCubeTexture(renderer, source);
    expect(ready, 'once ready, the very next call must succeed without any dispose in between').toBeTruthy();
    expect(cube.generateCalls).toBe(1);
  });
});

describe('a failed cube build restores the renderer and source state it dirtied', () => {
  // Pins `buildEnvDerivedTarget`'s 'cube' branch `finally` (envPmrem.ts) directly: three's real
  // `CubeRenderTarget.fromEquirectangularTexture`/`CubeCamera.update` only restore this state on
  // the normal-return path, so a throw mid-build must be caught by OUR `finally`, not theirs. The
  // mock above dirties the same five things three's real code dirties, THEN throws — a mock that
  // only threw would pass whether or not the `finally` existed and prove nothing.
  it('restores render target, MRT, XR-enabled, and source filter state after a throwing build', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sentinelTarget = { name: 'sentinel-target' };
      const sentinelMRT = { name: 'sentinel-mrt' };
      let currentTarget: unknown = sentinelTarget;
      let currentMRT: unknown = sentinelMRT;
      const renderer = {
        xr: { enabled: true },
        getRenderTarget: () => currentTarget,
        setRenderTarget: (t: unknown) => { currentTarget = t; },
        getMRT: () => currentMRT,
        setMRT: (m: unknown) => { currentMRT = m; },
      };

      const source = new THREE.DataTexture();
      source.image = { height: 512, width: 1024 } as never;
      source.minFilter = THREE.LinearFilter;
      source.generateMipmaps = false;
      cube.failSources.add(source);

      expect(getEnvCubeTexture(renderer, source), 'the failure must still be swallowed').toBeUndefined();

      expect(renderer.getRenderTarget(), 'render target must be restored, not left on the target the mock bound before throwing').toBe(sentinelTarget);
      expect(renderer.getMRT(), 'MRT must be restored, not left null').toBe(sentinelMRT);
      expect(renderer.xr.enabled, 'XR must be restored, not left disabled').toBe(true);
      expect(source.minFilter, 'source minFilter must be restored').toBe(THREE.LinearFilter);
      expect(source.generateMipmaps, 'source generateMipmaps must be restored').toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('syncEnvironment falls back to the raw equirect when there is no renderer (#775/#779)', () => {
  it('binds the raw equirect to scene.background, unchanged degrade', async () => {
    const world = createWorld();
    world.spawn(Environment({ hdrPath: GUID, intensity: 1, showAsBackground: true, backgroundIntensity: 1, backgroundBlurriness: 0 }));
    await acquireEnvironment(1, GUID);
    try {
      const source = getCachedEnvironment(GUID) as THREE.DataTexture;
      expect(source, 'the HDR fixture must actually load, or this test proves nothing').toBeTruthy();
      const scene = new THREE.Scene();
      syncEnvironment(world, scene, undefined);
      expect(scene.background).toBe(source);
      expect(pmrem.generateCalls).toBe(0);
      expect(cube.generateCalls).toBe(0);
    } finally {
      releaseEnvironment(1, GUID);
    }
  });
});
