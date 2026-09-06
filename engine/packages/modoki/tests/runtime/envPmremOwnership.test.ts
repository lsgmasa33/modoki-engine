/** The engine now owns PMREM generation for HDR environments instead of leaving it to three's
 *  lazy per-node path (#739).
 *
 *  THE DEFECT THIS PINS. Every scene swap that changed the env texture's OBJECT IDENTITY made
 *  three build a fresh PMREM via a fresh internal `PMREMGenerator` (`PMREMNode.updateBefore`,
 *  reached because a raw equirectangular texture is neither `isPMREMTexture` nor
 *  `CubeUVReflectionMapping`). Three frees only the PMREM *output* texture, via a dispose
 *  listener on the SOURCE texture — the generator's own scratch state (`_pingPongRenderTarget`,
 *  ~6 MB of half-float, plus 11 LOD-mesh geometries) is freed only by `PMREMGenerator.dispose()`,
 *  reachable only through `PMREMNode.dispose()`, which nothing on the scene-swap path ever calls.
 *  Unbounded leak, one generator's worth per environment change.
 *
 *  The fix generates the PMREM itself (`getEnvPMREMTexture`), disposing the generator immediately
 *  after use, and binds ITS output — which three's `PMREMNode` uses directly — to
 *  `scene.environment`. See `envPmrem.ts`'s "Environment PMREM (#739)" section for the mechanism
 *  this test suite pins (moved out of `meshTemplateCache.ts` in #739 — see that module's
 *  "Environment PMREM disposal hook" comment for why). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A fake PMREMGenerator: real generation needs an actual GPU context, which this suite doesn't
// have. What matters here is OWNERSHIP — one generator per call, disposed immediately, its output
// render target kept alive until explicitly disposed — not the pixels it would have produced.
// This mocks `three/webgpu` (NOT `three` — `getEnvPMREMTexture` imports `PMREMGenerator` from
// there specifically, see envPmrem.ts's ⚠️ comment on why the two are not interchangeable).
const pmrem = vi.hoisted(() => ({ generateCalls: 0 }));
vi.mock('three/webgpu', () => ({
  PMREMGenerator: class {
    disposed = false;
    constructor(public renderer: unknown) {}
    fromEquirectangular(source: unknown) {
      pmrem.generateCalls++;
      const rt = {
        texture: { isPMREMTexture: true, uuid: `pmrem-${pmrem.generateCalls}`, dispose: vi.fn() },
        dispose: vi.fn(),
        _source: source,
      };
      return rt;
    }
    dispose() { this.disposed = true; }
  },
}));

import {
  disposeRetiredEnvironment, disposeAllCachedResources,
  acquireEnvironment, releaseEnvironment, invalidateEnvironment, getCachedEnvironment,
  retiredEnvironments,
} from '../../src/runtime/loaders/meshTemplateCache';
import { getEnvPMREMTexture, sourceForEnvPMREM } from '../../src/runtime/rendering/envPmrem';
import { syncEnvironment } from '../../src/runtime/rendering/scene3DSync';
import { registerAsset, clearManifest } from '../../src/runtime/loaders/assetManifest';
import { createWorld } from 'koota';
import { Environment } from '../../src/three/traits/Environment';

// Distinct fake HDR loads (mirrors environmentInvalidationRetires.test.ts) so identity checks are
// meaningful.
const hdr = vi.hoisted(() => ({ n: 0 }));
vi.mock('three/examples/jsm/loaders/HDRLoader.js', () => ({
  HDRLoader: class {
    load(path: string, onLoad: (texture: unknown) => void) {
      const tex = { mapping: 0, isTexture: true, dispose: vi.fn(), uuid: `hdr-${path}-${++hdr.n}` };
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
    expect(sourceForEnvPMREM(first)).toBe(source);

    // disposeRetiredEnvironment requires the texture to actually be in the retired set —
    // mirror that contract rather than calling disposeEnvPMREMFor directly.
    (retiredEnvironments() as Set<THREE.DataTexture>).add(source);
    disposeRetiredEnvironment(source);

    expect(sourceForEnvPMREM(first), 'the reverse mapping must be dropped too').toBeUndefined();

    const second = getEnvPMREMTexture(renderer, source);
    expect(pmrem.generateCalls, 'freeing the PMREM must force a fresh build on next use').toBe(2);
    expect(second).not.toBe(first);
  });
});

describe('sourceForEnvPMREM', () => {
  it('resolves a PMREM output back to its source, and undefined for anything else', () => {
    const renderer = {};
    const source = new THREE.DataTexture();
    const pmremTex = getEnvPMREMTexture(renderer, source)!;

    expect(sourceForEnvPMREM(pmremTex)).toBe(source);
    expect(sourceForEnvPMREM(source), 'the raw equirect itself is not a tracked PMREM output').toBeUndefined();
    expect(sourceForEnvPMREM(new THREE.DataTexture())).toBeUndefined();
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
      expect(sourceForEnvPMREM(scene.environment as THREE.Texture)).toBe(source);

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
    expect(sourceForEnvPMREM(pmremTex)).toBe(source);

    disposeAllCachedResources(); // full teardown — `source` is still live in envCache, not retired
    expect(sourceForEnvPMREM(pmremTex), 'the env dispose hook must run from the envCache loop too').toBeUndefined();
  });
});
