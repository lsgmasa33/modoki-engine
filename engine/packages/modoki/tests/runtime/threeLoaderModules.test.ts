/** `threeLoaderModules` — the on-demand accessors for three's example loaders (#254).
 *
 *  The *graph* half of this change (nothing statically imports a loader; every `import()` sits
 *  behind the `render3d` gate) is pinned in `render3dBoundary.test.ts`, where it costs
 *  milliseconds instead of a build. What is pinned HERE is the runtime behaviour that graph
 *  fix bought us and could silently break: one import per loader however many callers race for
 *  it, and a GLTFLoader that always arrives with its meshopt decoder attached.
 *
 *  ⚠️ The `!__MODOKI_MODULE_RENDER3D__` branches are NOT reachable from here: vitest defines the
 *  flag as the literal `true` (see `vitest.config.ts`), so those rejections are dead code under
 *  test. They are covered by the source-shape assertion in `render3dBoundary.test.ts` instead —
 *  the same split #214 used, and the reason that guard exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const gltfCalls = vi.hoisted(() => ({ n: 0 }));
const meshoptCalls = vi.hoisted(() => ({ n: 0 }));

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    decoder: unknown = null;
    constructor() { gltfCalls.n++; }
    setMeshoptDecoder(d: unknown) { this.decoder = d; }
  },
}));
vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => {
  meshoptCalls.n++;
  return { MeshoptDecoder: { tag: 'meshopt' } };
});
vi.mock('three/examples/jsm/loaders/KTX2Loader.js', () => ({ KTX2Loader: class {} }));
vi.mock('three/examples/jsm/loaders/HDRLoader.js', () => ({ HDRLoader: class {} }));
vi.mock('three/examples/jsm/loaders/UltraHDRLoader.js', () => ({ UltraHDRLoader: class {} }));

import {
  gltfLoaderCtor, ktx2LoaderCtor, hdrLoaderCtor, ultraHdrLoaderCtor,
  meshoptDecoder, makeGltfLoader, prewarmGlbLoaders,
} from '../../src/runtime/loaders/threeLoaderModules';

describe('threeLoaderModules — on-demand three example loaders (#254)', () => {
  beforeEach(() => { gltfCalls.n = 0; });

  it.each([
    ['gltfLoaderCtor', gltfLoaderCtor],
    ['ktx2LoaderCtor', ktx2LoaderCtor],
    ['hdrLoaderCtor', hdrLoaderCtor],
    ['ultraHdrLoaderCtor', ultraHdrLoaderCtor],
  ])('%s resolves to a constructible class', async (_name, accessor) => {
    const Ctor = await accessor();
    expect(typeof Ctor).toBe('function');
    expect(() => new (Ctor as new () => unknown)()).not.toThrow();
  });

  it('memoises: N callers share ONE import, not N', async () => {
    // Asserted by PROMISE IDENTITY, which is order-independent and says exactly what the `??=`
    // guarantees. A module-eval counter would not: vitest's registry evaluates a mocked module
    // once regardless of how many `import()`s my code issues, so a counter here would pass just
    // as happily against a version with no memo at all — vacuous precisely where it matters,
    // since in a browser each un-memoised `import()` is a real chunk fetch.
    expect(meshoptDecoder()).toBe(meshoptDecoder());
    expect(gltfLoaderCtor()).toBe(gltfLoaderCtor());
    expect(ktx2LoaderCtor()).toBe(ktx2LoaderCtor());
    expect(hdrLoaderCtor()).toBe(hdrLoaderCtor());
    expect(ultraHdrLoaderCtor()).toBe(ultraHdrLoaderCtor());
    const all = await Promise.all([meshoptDecoder(), meshoptDecoder(), meshoptDecoder()]);
    expect(new Set(all).size).toBe(1); // and every caller got the same value
    expect(meshoptCalls.n).toBe(1);    // the module really was evaluated, exactly once
  });

  it('makeGltfLoader always attaches the meshopt decoder', async () => {
    // A bare GLTFLoader silently fails to parse any gltfpack-produced LOD or optimized rig
    // (EXT_meshopt_compression), and this is exactly the half that is easy to forget at a new
    // call site — which is why the pairing lives in one helper rather than in each caller.
    const loader = await makeGltfLoader() as unknown as { decoder: unknown };
    expect(loader.decoder).toEqual({ tag: 'meshopt' });
  });

  it('makeGltfLoader hands each caller its OWN loader', async () => {
    // Deliberately NOT memoised: three's GLTFLoader carries per-load state (KTX2 loader, path,
    // request headers), and ModelPreview/riggedModelCache each configure their own.
    const [a, b] = await Promise.all([makeGltfLoader(), makeGltfLoader()]);
    expect(a).not.toBe(b);
    expect(gltfCalls.n).toBe(2);
  });

  it('prewarmGlbLoaders returns synchronously and leaves no unhandled rejection', async () => {
    // It is called from `setActiveRenderer`, which must not become slower or throw because a
    // loader chunk is missing — the real caller reports that failure with its own path.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(prewarmGlbLoaders()).toBeUndefined();
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
