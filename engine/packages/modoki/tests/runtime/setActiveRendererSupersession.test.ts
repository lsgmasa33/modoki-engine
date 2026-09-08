/** Regression for docs/async-lifetime.md: `setActiveRenderer` writes the module-level
 *  `detectedCaps` (and, unconditionally, activates its renderer via `setActiveRendererHandle`)
 *  after `await getKTX2Loader()`, with no liveness check.
 *
 *  PRODUCTION DRIVER: a viewport remount / HMR reinit / a second viewport activating. The editor
 *  mounts two 3D viewports (SceneView + GameView per `activeRenderer.ts`'s own comments on
 *  `RendererLostInfo`), and a renderer rebuild (a GPU device-loss recovery, a Fast-Refresh
 *  remount) calls `setActiveRenderer` again for the NEW renderer while the OLD renderer's own
 *  `setActiveRenderer` call may still be awaiting `getKTX2Loader()`. Both calls resolve against
 *  the SAME memoised `KTX2Loader` singleton, so if the OLDER call's await settles LAST, it would
 *  overwrite `detectedCaps` with a stale detection and re-activate a renderer instance a rebuild
 *  has already discarded — corrupting every texture-variant decision (`resolveTextureVariantUrl`)
 *  made after the newer, correct call already won. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deferred `ktx2LoaderCtor`: each call gets its OWN controllable promise, so the test can choose
// which of two overlapping `setActiveRenderer` calls resolves first — independent of `getKTX2Loader`'s
// own singleton memoization (which still shares ONE constructed loader instance across both calls,
// exactly as production does).
const ctorGate = vi.hoisted(() => ({
  resolvers: [] as Array<(v: unknown) => void>,
}));

vi.mock('../../src/runtime/loaders/threeLoaderModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/loaders/threeLoaderModules')>();
  return {
    ...actual,
    ktx2LoaderCtor: vi.fn(() => new Promise((resolve) => { ctorGate.resolvers.push(resolve); })),
  };
});

// A fake KTX2Loader whose `detectSupport` reads capability off the RENDERER passed to it — so two
// overlapping calls with different renderers produce distinguishably different `detectedCaps`.
class FakeKTX2Loader {
  workerConfig?: { astcSupported?: boolean };
  setTranscoderPath(_p: string) {}
  detectSupport(renderer: { astc?: boolean }) {
    this.workerConfig = { astcSupported: !!renderer?.astc };
    return this;
  }
}

beforeEach(() => {
  vi.resetModules();
  ctorGate.resolvers.length = 0;
});

describe('setActiveRenderer — a newer call must win over a stale in-flight one', () => {
  it('does not let an older call overwrite detectedCaps or re-activate its renderer', async () => {
    const textureResolver = await import('../../src/runtime/loaders/textureResolver');
    const { registerAsset, clearManifest } = await import('../../src/runtime/loaders/assetManifest');
    const { DEFAULT_TEXTURE_SETTINGS } = await import('../../src/runtime/loaders/textureSettings');
    clearManifest();
    const GUID = '99999999-8888-4777-8888-000000000001';
    const PATH = '/games/g/assets/tex/race.png';
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-astc' });

    const rendererOld = { astc: false, name: 'old' } as never;
    const rendererNew = { astc: true, name: 'new' } as never;

    const oldCall = textureResolver.setActiveRenderer(rendererOld);
    const newCall = textureResolver.setActiveRenderer(rendererNew);
    // Both calls have issued their `ktx2LoaderCtor()` and are parked on the deferred promise.
    expect(ctorGate.resolvers).toHaveLength(2);

    // Settle the NEWER call FIRST (it wins the loader-construction race and sets caps from
    // rendererNew), then the OLDER one LAST — the exact interleaving that corrupts shared state
    // without a liveness guard.
    ctorGate.resolvers[1](FakeKTX2Loader);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    ctorGate.resolvers[0](FakeKTX2Loader);
    await Promise.all([oldCall, newCall]);

    // The NEWER renderer's detection must stand: astc:true → the native ~astc.ktx2 variant.
    expect(textureResolver.resolveTextureVariantUrl(GUID, '3d')).toContain(PATH + '~astc.ktx2');
    // And the ACTIVE renderer must be the new one, not resurrected back to the stale old one.
    expect((textureResolver.getActiveRenderer() as unknown as { name: string })?.name).toBe('new');
  });
});
