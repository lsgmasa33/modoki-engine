// @vitest-environment jsdom
/** getFontTexture (the Three.js atlas-texture cache) — #828: this module had ZERO tests, so its
 *  `${provider.id}:...` cache keys were never proven to actually discriminate between two live
 *  font providers. Every OTHER reference to this module (`text3DMaterialReuse.test.ts`) mocks it
 *  away entirely, so a regression collapsing the per-provider cache to a shared one would pass
 *  every existing gate.
 *
 *  Covers four things, per the module's own comments:
 *   1. two providers with different `id`s get DISTINCT textures for the same page (the cache-key
 *      discriminant this whole file is about).
 *   2. the `uploadedVersion`/`atlasVersion` re-upload path on the dynamic (canvas) branch — a
 *      version bump bumps the texture's `version` (via `needsUpdate = true`) exactly once per
 *      bump, not once per call.
 *   3. baked page 0 is deliberately EXCLUDED from versioning (its key has no atlasVersion — see
 *      fontTextureThree.ts's comment on why).
 *   4. the module registers TWO separate `addDisposable` eviction closures — one in the canvas
 *      branch, one in the baked branch — and each is exercised on its OWN branch: driving the
 *      canvas branch's closure disposes/evicts only that branch's cache entry, and likewise for
 *      the baked branch's. A test that only ever built a canvas provider would leave the baked
 *      branch's closure — and a regression to it — untouched. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { getFontTexture } from '../../src/runtime/rendering/text/fontTextureThree';
import type { FontProvider } from '../../src/runtime/rendering/text/fontProvider';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';
import { RETRY_BASE_MS } from '../../src/runtime/core/loadFailureMemo';
import { getTextDirtyVersion } from '../../src/runtime/rendering/text/textDirty';

/** A dynamic-style fake provider: `atlasCanvasAt` returns a real canvas, so `getFontTexture`
 *  takes the CanvasTexture branch. `addDisposable` just records the last registered closure —
 *  enough for these tests, which never register more than one per provider. */
function canvasProvider(id: string, atlasVersion = 1): FontProvider & { __runDispose: () => void } {
  const canvas = document.createElement('canvas');
  let disposeFn: (() => void) | undefined;
  return {
    id,
    atlasVersion,
    atlasCanvasAt: () => canvas,
    addDisposable: (fn: () => void) => { disposeFn = fn; },
    // test-only accessor
    __runDispose: () => disposeFn?.(),
  } as unknown as FontProvider & { __runDispose: () => void };
}

/** A baked-style fake provider: no `atlasCanvasAt` at all, so page 0 takes the immutable-image
 *  branch (`loader.load(...)`, no version gating at all). `addDisposable` records the closure
 *  (same shape as `canvasProvider`'s, not a `() => {}` stub) so a test can actually drive the
 *  BAKED branch's own eviction path — a stub here would leave that closure untestable and a
 *  regression to it silent. */
function bakedProvider(id: string, atlasVersion = 0): FontProvider & { atlasVersion: number; __runDispose: () => void } {
  let disposeFn: (() => void) | undefined;
  return {
    id,
    atlasVersion,
    atlasImageUrl: `/fonts/${id}~atlas.png`,
    addDisposable: (fn: () => void) => { disposeFn = fn; },
    // test-only accessor
    __runDispose: () => disposeFn?.(),
  } as unknown as FontProvider & { atlasVersion: number; __runDispose: () => void };
}

describe('per-provider discriminant — two providers, same page', () => {
  it('two providers with different ids get DISTINCT textures for the SAME page', () => {
    const a = canvasProvider('font-a');
    const b = canvasProvider('font-b');

    const texA = getFontTexture(a, 0);
    const texB = getFontTexture(b, 0);

    expect(texA).toBeTruthy();
    expect(texB).toBeTruthy();
    expect(texB, 'a shared cache would hand provider B the texture built for A').not.toBe(texA);
  });

  it('building B does not disturb A\'s own cache hit', () => {
    const a = canvasProvider('font-a2');
    const b = canvasProvider('font-b2');

    const firstA = getFontTexture(a, 0);
    getFontTexture(b, 0); // touch the cache for a second provider in between
    const secondA = getFontTexture(a, 0);

    expect(secondA, 'A must still be served from its own cache entry').toBe(firstA);
  });
});

describe('dynamic (canvas) page — uploadedVersion re-upload gating', () => {
  it('bumps the texture version exactly once per atlasVersion bump, not once per call', () => {
    const p = canvasProvider('font-version', 1);

    const tex = getFontTexture(p, 0) as THREE.CanvasTexture;
    const afterBuild = tex.version;

    // Same atlasVersion again — must NOT re-upload.
    getFontTexture(p, 0);
    expect(tex.version, 'no atlasVersion change → no needsUpdate bump').toBe(afterBuild);

    // atlasVersion bumps once — must re-upload exactly once.
    (p as { atlasVersion: number }).atlasVersion = 2;
    getFontTexture(p, 0);
    expect(tex.version, 'one atlasVersion bump → exactly one needsUpdate bump').toBe(afterBuild + 1);

    // Calling again at the SAME (new) atlasVersion must not bump a second time.
    getFontTexture(p, 0);
    expect(tex.version, 'a second call at the same version must not re-bump').toBe(afterBuild + 1);
  });
});

describe('baked page 0 — excluded from versioning', () => {
  it('page 0\'s image texture is unaffected by atlasVersion bumps (key carries no version)', () => {
    const p = bakedProvider('font-baked');

    const tex = getFontTexture(p, 0);
    expect(tex).toBeTruthy();

    // A baked-seeded dynamic font bumps atlasVersion on every generated glyph batch — page 0's
    // IMMUTABLE image must not be affected: same object back, no rebuild.
    (p as { atlasVersion: number }).atlasVersion = 99;
    expect(getFontTexture(p, 0), 'the baked image is cached independently of atlasVersion').toBe(tex);
  });
});

describe('addDisposable eviction — each branch registers, and is exercised on, ITS OWN closure', () => {
  // The canvas branch and the baked branch each register their OWN `addDisposable` closure
  // (fontTextureThree.ts's two `provider.addDisposable(() => { ... })` call sites), over two
  // separate cache entries (`${id}:canvas:${page}` vs `${id}:image`). These two tests must stay
  // INDEPENDENT: deleting either branch's closure in the source must redden only its own test here,
  // never the other one.
  it('the CANVAS branch\'s addDisposable closure disposes the texture and drops its cache entry', () => {
    const p = canvasProvider('font-dispose');
    const tex = getFontTexture(p, 0) as THREE.CanvasTexture;
    const disposeSpy = vi.spyOn(tex, 'dispose');

    p.__runDispose();

    expect(disposeSpy, 'the texture must be disposed').toHaveBeenCalledTimes(1);

    // The cache entry is gone — the next call mints a fresh texture, not the disposed one.
    const rebuilt = getFontTexture(p, 0);
    expect(rebuilt, 'a rebuilt texture after eviction must be a NEW object').not.toBe(tex);
  });

  it('the BAKED branch\'s addDisposable closure disposes the texture and drops its cache entry', () => {
    const p = bakedProvider('font-baked-dispose');
    const tex = getFontTexture(p, 0) as THREE.Texture;
    const disposeSpy = vi.spyOn(tex, 'dispose');

    p.__runDispose();

    expect(disposeSpy, 'the baked texture must be disposed').toHaveBeenCalledTimes(1);

    // The cache entry is gone — the next call mints a fresh texture, not the disposed one.
    const rebuilt = getFontTexture(p, 0);
    expect(rebuilt, 'a rebuilt baked texture after eviction must be a NEW object').not.toBe(tex);
  });
});

/** #1397 — a failed atlas load used to leave the image-less placeholder cached for the provider's
 *  whole life, so 3D text stayed invisible after a network blip until the scene changed. */
describe('a failed atlas load backs off and retries (#1397)', () => {
  afterEach(() => { vi.restoreAllMocks(); restoreRealClock(); vi.useRealTimers(); });

  /** Stub the image load: every call fails (or succeeds) on the next microtask. */
  function stubLoader(fail: () => boolean) {
    // Cast: three types `load` generically over the image type, which a stub has no reason to match.
    return vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(((
      _url: string, onLoad?: (t: THREE.Texture) => void, _p?: unknown, onError?: (e: unknown) => void,
    ) => {
      const tex = new THREE.Texture();
      queueMicrotask(() => { if (fail()) onError?.(new Event('error')); else onLoad?.(tex); });
      return tex;
    }) as never);
  }

  it('evicts the placeholder, returns null while backing off, then loads a fresh texture', async () => {
    setManualNow(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failing = true;
    const load = stubLoader(() => failing);
    const p = bakedProvider('font-3d-fail');
    const first = getFontTexture(p, 0);
    expect(first).toBeTruthy();
    await Promise.resolve(); await Promise.resolve();
    expect(getFontTexture(p, 0), 'backing off: no placeholder, no refetch').toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    advanceManual(RETRY_BASE_MS);
    failing = false;
    const second = getFontTexture(p, 0);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(load).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(getFontTexture(p, 0), 'a landed load is served from the cache').toBe(second);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('repaints the font\'s text when the retry is due', async () => {
    setManualNow(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubLoader(() => true);
    const p = bakedProvider('font-3d-wake');
    getFontTexture(p, 0);
    await vi.advanceTimersByTimeAsync(0);
    const v0 = getTextDirtyVersion('font-3d-wake');
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 10);
    expect(getTextDirtyVersion('font-3d-wake')).toBe(v0);
    await vi.advanceTimersByTimeAsync(10);
    expect(getTextDirtyVersion('font-3d-wake')).toBe(v0 + 1);
  });
});

describe('the atlas failure memo against provider lifetimes (#1397 review)', () => {
  afterEach(() => { vi.restoreAllMocks(); restoreRealClock(); });

  /** A provider with a real disposer list: `dispose()` runs them, and a registration after that
   *  runs immediately (fontProvider.ts's documented contract). */
  function liveProvider(id: string) {
    const fns: Array<() => void> = [];
    let dead = false;
    return {
      id, atlasVersion: 0, atlasImageUrl: `/fonts/${id}~atlas.png`,
      addDisposable: (fn: () => void) => { if (dead) fn(); else fns.push(fn); },
      dispose: () => { dead = true; for (const f of fns.splice(0)) f(); },
      get registered() { return fns.length; },
    };
  }
  function stub(outcome: () => 'ok' | 'fail') {
    return vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(((
      _u: string, onLoad?: (t: THREE.Texture) => void, _p?: unknown, onError?: (e: unknown) => void,
    ) => {
      const tex = new THREE.Texture();
      queueMicrotask(() => { if (outcome() === 'ok') onLoad?.(tex); else onError?.(new Event('error')); });
      return tex;
    }) as never);
  }

  it('repaints the font\'s text when the atlas LANDS, not only when the retry starts', async () => {
    stub(() => 'ok');
    const p = liveProvider('font-3d-land');
    const v0 = getTextDirtyVersion('font-3d-land');
    getFontTexture(p as never, 0);
    await Promise.resolve(); await Promise.resolve();
    expect(getTextDirtyVersion('font-3d-land')).toBe(v0 + 1);
  });

  it('registers ONE disposer per provider however many retries an outage costs', async () => {
    setManualNow(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub(() => 'fail');
    const p = liveProvider('font-3d-once');
    for (let i = 0; i < 4; i++) {
      getFontTexture(p as never, 0);
      await Promise.resolve(); await Promise.resolve();
      advanceManual(60 * 60 * 1000);
    }
    expect(p.registered).toBe(1);
  });

  it('a load that fails after its provider was disposed does not block the successor', async () => {
    setManualNow(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const load = stub(() => 'fail');
    const p1 = liveProvider('font-3d-succ');
    getFontTexture(p1 as never, 0);
    p1.dispose();                  // invalidateFont, while the load is in flight
    await Promise.resolve(); await Promise.resolve(); // …and then it fails
    const p2 = liveProvider('font-3d-succ');
    expect(getFontTexture(p2 as never, 0), 'the successor loads rather than inheriting a backoff').toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
