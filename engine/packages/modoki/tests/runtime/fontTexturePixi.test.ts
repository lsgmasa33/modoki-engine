/** getFontTexturePixi — every renderer waiting on an atlas load must be woken, not just the first.
 *
 *  #1368: the wake is now the font family's SHARED hub, `markTextDirty(fontId)`, fired by the
 *  store — not a per-caller `onReady` set. The tests below count it through `getTextDirtyVersion`
 *  (per-font, so parallel cases cannot bleed into each other) and `onTextDirty` (what a surface
 *  actually subscribes to). The history below is why a per-caller channel was the wrong shape.
 *
 *  ⚠️ **The bug this pins.** `cache`/`loading` are MODULE-level and shared by every
 *  `Scene2DRenderer`, and the editor always runs two of them (the Game panel and the Scene panel).
 *  Both ask for the same font atlas in the same frame. The first started the load and registered
 *  its `onReady`; the second hit a `loading.has(key)` early-return that dropped its `onReady` on
 *  the floor. When the texture landed only ONE renderer was marked dirty — the other kept its last
 *  frame, which had every primitive (those draw synchronously) and NO TEXT, indefinitely.
 *
 *  Reported against Court's tray-badge prefab: *"the texts are not rendered when I open the prefab.
 *  I have to click on the entity to see the text."* Clicking changes the selection, which marks the
 *  panel dirty, and by then the atlas is cached so the text draws — which is exactly why it reads
 *  as a text bug rather than a wake-up bug.
 *
 *  ⚠️ It cannot be caught by a screenshot: the losing panel is one repaint behind, and ANY
 *  interaction (including the one you make to go and look) fixes it. It is pinned here by counting
 *  the wake-ups instead. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unload = vi.fn(() => Promise.resolve());
vi.mock('pixi.js', () => ({
  Assets: { unload },
  // A real-enough Texture: the #481 tests need `.destroy()` to actually flip `.destroyed`, since
  // that flag is exactly what the guard under test reads.
  Texture: class {
    destroyed = false;
    source: unknown;
    constructor(opts: { source: unknown }) { this.source = opts.source; }
    destroy() { this.destroyed = true; }
  },
  CanvasSource: class {
    update = vi.fn();
    constructor(opts: unknown) { Object.assign(this, opts); }
  },
}));

/** One controllable in-flight load, so the two callers are genuinely concurrent. */
let resolveLoad: (t: unknown) => void;
let rejectLoad: (e: unknown) => void;
let loadCalls = 0;
const loadMtsdfAtlasTexture = vi.fn(() => {
  loadCalls++;
  return new Promise((res, rej) => { resolveLoad = res as typeof resolveLoad; rejectLoad = rej; });
});
vi.mock('../../src/runtime/rendering/pixiTextureLoad', () => ({ loadMtsdfAtlasTexture }));

const { getFontTexturePixi } = await import('../../src/runtime/rendering/text/fontTexturePixi');
const { BakedFontProvider } = await import('../../src/runtime/rendering/text/fontProvider');
const { DynamicFontProvider } = await import('../../src/runtime/rendering/text/dynamicFontProvider');
const { getTextDirtyVersion, onTextDirty } = await import('../../src/runtime/rendering/text/textDirty');
const { setManualNow, advanceManual, restoreRealClock } = await import('../../src/runtime/core/clock');
const { RETRY_BASE_MS } = await import('../../src/runtime/core/loadFailureMemo');
const { MissingAssetError } = await import('../../src/runtime/core/assetLoadErrors');

/** How many text-dirty wakes attributed to `fontId` land from now on. */
function wakesFor(fontId: string): () => number {
  const v0 = getTextDirtyVersion(fontId);
  return () => getTextDirtyVersion(fontId) - v0;
}

/** A baked (image-URL) provider. `atlasCanvasAt` absent → the baked path, not the dynamic one. */
function provider(id: string) {
  return {
    id,
    atlasVersion: 1,
    atlasImageUrl: `/fonts/${id}~atlas.png`,
    addDisposable: vi.fn(),
  } as never;
}

/** A Texture stand-in — the code sets three fields on `.source` and calls `update()`. */
const fakeTexture = () => ({ source: { scaleMode: '', alphaMode: '', update: vi.fn() }, destroy: vi.fn() });

describe('getFontTexturePixi — concurrent renderers', () => {
  beforeEach(() => { loadCalls = 0; loadMtsdfAtlasTexture.mockClear(); unload.mockClear(); });

  it('one shared load wakes EVERY surface through the shared text hub, attributed to its font (#1368)', async () => {
    const p = provider('font-both');
    const woke = wakesFor('font-both');
    // Two surfaces, subscribed the way Scene2D / Scene3D / SceneView are — neither passes anything in.
    const surfaceA = vi.fn();
    const surfaceB = vi.fn();
    const offA = onTextDirty(surfaceA);
    const offB = onTextDirty(surfaceB);

    // Frame N: the Game panel asks first and starts the load; the Scene panel asks second.
    expect(getFontTexturePixi(p, 0), 'nothing to draw yet').toBeNull();
    expect(getFontTexturePixi(p, 0), 'and the second caller waits too').toBeNull();
    expect(loadCalls, 'ONE network load is shared — the second must not kick a duplicate').toBe(1);

    resolveLoad(fakeTexture());
    await vi.waitFor(() => expect(woke()).toBe(1));

    // THE REGRESSION: the second panel's wake used to be dropped, so its text stayed missing until
    // an unrelated dirty event. A shared hub cannot drop a subscriber that never had to register.
    expect(surfaceA).toHaveBeenCalledTimes(1);
    expect(surfaceB, 'the SECOND surface is woken too — this is the whole bug').toHaveBeenCalledTimes(1);
    offA(); offB();
  });

  it('serves the cached texture synchronously afterwards, with no further load or wake', async () => {
    const p = provider('font-cached');
    const woke = wakesFor('font-cached');
    getFontTexturePixi(p, 0);
    resolveLoad(fakeTexture());
    await vi.waitFor(() => expect(woke()).toBe(1));

    const tex = getFontTexturePixi(p, 0);
    expect(tex, 'a later caller gets the texture straight back').not.toBeNull();
    expect(woke(), 'a cache HIT never wakes — a per-frame caller cannot keep a surface awake').toBe(1);
    expect(loadCalls, 'still one load').toBe(1);
  });

  it('caches the texture BEFORE waking, so a synchronous re-render finds it', async () => {
    // A surface that re-renders inside its own wake-up must see the cache populated, or it kicks a
    // second load and draws nothing again.
    const p = provider('font-order');
    let seenDuringWake: unknown = 'not-called';
    getFontTexturePixi(p, 0);
    const off = onTextDirty(() => { seenDuringWake = getFontTexturePixi(p, 0); });
    resolveLoad(fakeTexture());
    await vi.waitFor(() => expect(seenDuringWake).not.toBe('not-called'));
    off();
    expect(seenDuringWake, 'the texture is already cached when the wake-up fires').not.toBeNull();
    expect(loadCalls, 'so no second load is kicked').toBe(1);
  });

  it('a FAILED load wakes nobody, and backs off before re-attempting (#1397 — was: the very next call)', async () => {
    setManualNow(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = provider('font-fail');
    const woke = wakesFor('font-fail');
    getFontTexturePixi(p, 0);
    rejectLoad(new TypeError('Failed to fetch'));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    // Not woken: there is nothing to draw. And not re-attempted on the next frame either — that
    // was a request per Scene2D text pass for as long as the atlas stayed unreachable.
    expect(woke(), 'no wake-up for a load with no texture').toBe(0);
    getFontTexturePixi(p, 0);
    expect(loadCalls, 'backing off: the next frame does not refetch').toBe(1);
    advanceManual(RETRY_BASE_MS);
    getFontTexturePixi(p, 0);
    expect(loadCalls, 'the backoff expired: the next call re-attempts').toBe(2);
    resolveLoad(fakeTexture());
    await vi.waitFor(() => expect(woke()).toBe(1));
    warn.mockRestore();
    restoreRealClock();
  });

  it('an atlas MISSING from a native app bundle (the request fails, no status) stays failed like a 404 (#1402)', async () => {
    setManualNow(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    vi.stubGlobal('location', { href: 'capacitor://localhost/', protocol: 'capacitor:', host: 'localhost' });
    try {
      const p = { ...(provider('font-ios-missing') as object), addDisposable: () => {} } as never;
      getFontTexturePixi(p, 0);
      // What reaches this record site in production: the no-createImageBitmap fallback, Pixi's
      // `<img>` path, wrapped by Pixi's Loader. (The createImageBitmap path is already typed at its
      // fetch by rethrowFetchFailure.)
      rejectLoad(new Error('[Loader.load] Failed to load capacitor://localhost/fonts/a.png.\n[object Event]'));
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      advanceManual(60 * 60 * 1000);
      getFontTexturePixi(p, 0);
      expect(loadCalls).toBe(1);
    } finally { vi.unstubAllGlobals(); warn.mockRestore(); restoreRealClock(); }
  });

  it('a 404 atlas stays failed until the provider is disposed (#1397)', async () => {
    setManualNow(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const disposers: Array<() => void> = [];
    const p = { ...(provider('font-404') as object), addDisposable: (fn: () => void) => { disposers.push(fn); } } as never;
    getFontTexturePixi(p, 0);
    rejectLoad(new MissingAssetError('404', { status: 404, absent: true }));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    advanceManual(60 * 60 * 1000);
    getFontTexturePixi(p, 0);
    expect(loadCalls).toBe(1);
    for (const d of disposers) d(); // the font is released (invalidateFont / scene swap)
    getFontTexturePixi(p, 0);
    expect(loadCalls).toBe(2);
    rejectLoad(new Error('settle'));
    warn.mockRestore();
    restoreRealClock();
  });

  it('a load that fails after its provider was disposed wakes the stranded successor, and does not block it (#1397 review)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fns: Array<() => void> = [];
    let dead = false;
    const p1 = { ...(provider('font-succ') as object), addDisposable: (fn: () => void) => { if (dead) fn(); else fns.push(fn); } } as never;
    getFontTexturePixi(p1, 0);
    const woke = wakesFor('font-succ');
    dead = true; for (const f of fns.splice(0)) f(); // invalidateFont disposes P1 mid-load
    getFontTexturePixi(provider('font-succ'), 0);      // P2's repaint finds P1 in flight
    expect(loadCalls).toBe(1);
    rejectLoad(new TypeError('Failed to fetch'));
    await vi.waitFor(() => expect(woke(), 'the successor is woken').toBe(1));
    getFontTexturePixi(provider('font-succ'), 0);
    expect(loadCalls, 'and its repaint starts its own load').toBe(2);
    rejectLoad(new Error('settle'));
    warn.mockRestore();
  });

  it('a backing-off atlas repaints its font\'s text when the retry is due (#1397)', async () => {
    setManualNow(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const p = provider('font-wake');
      getFontTexturePixi(p, 0);
      rejectLoad(new TypeError('Failed to fetch'));
      await vi.advanceTimersByTimeAsync(0);
      const woke = wakesFor('font-wake');
      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 10);
      expect(woke()).toBe(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(woke()).toBe(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
      restoreRealClock();
    }
  });
});

/** #828 — every test above uses a DIFFERENT `provider.id` per case and never resets the
 *  module-level `cache`, so the key's `${provider.id}` discriminant has never actually been
 *  asserted: a regression that dropped it from the key would still pass every test above
 *  (each one only ever looks up the id it just built). This is the one that would catch it —
 *  two providers, constructed in the SAME test, sharing the atlas-image cache map. */
describe('per-provider discriminant — two providers, same page (#828)', () => {
  beforeEach(() => { loadCalls = 0; loadMtsdfAtlasTexture.mockClear(); });

  it('two providers with different ids get DISTINCT textures for the SAME page', async () => {
    const a = provider('font-two-a');
    const b = provider('font-two-b');

    // The shared module-level `resolveLoad`/`rejectLoad` (used by every OTHER test in this file)
    // only ever track the LATEST in-flight load, which can't drive two genuinely concurrent
    // loads — so capture each call's own resolver instead.
    let resolveA!: (t: unknown) => void;
    let resolveB!: (t: unknown) => void;
    loadMtsdfAtlasTexture.mockImplementationOnce(() => {
      loadCalls++;
      return new Promise((res) => { resolveA = res as typeof resolveA; });
    });
    loadMtsdfAtlasTexture.mockImplementationOnce(() => {
      loadCalls++;
      return new Promise((res) => { resolveB = res as typeof resolveB; });
    });

    expect(getFontTexturePixi(a, 0), 'nothing to draw yet for A').toBeNull();
    expect(getFontTexturePixi(b, 0), 'nothing to draw yet for B').toBeNull();
    // A shared `${...}:image` key (dropping provider.id) would route B's request onto A's
    // already-in-flight load via `addWaiter` instead of starting a second one.
    expect(loadCalls, 'a shared key would have joined B onto A\'s in-flight load').toBe(2);

    const texA = fakeTexture();
    const texB = fakeTexture();
    resolveA(texA);
    await vi.waitFor(() => expect(getFontTexturePixi(a, 0)).not.toBeNull());
    resolveB(texB);
    await vi.waitFor(() => expect(getFontTexturePixi(b, 0)).not.toBeNull());

    expect(getFontTexturePixi(a, 0), 'a shared cache would hand B\'s texture back for A').toBe(texA);
    expect(getFontTexturePixi(b, 0), 'a shared cache would hand A\'s texture back for B').toBe(texB);
  });
});

/** Page 0's IMAGE texture must survive glyph generation.
 *
 *  A baked-seeded dynamic font bumps `atlasVersion` on every generated batch while serving page 0
 *  as the baked atlas IMAGE. Keyed by version, each batch minted a new cache key: the lookup
 *  missed, the getter returned null while re-loading the SAME url, and every baked glyph vanished
 *  for those frames — typing CJK made the Latin text flicker, and the superseded Texture leaked
 *  until the font was released. Counting loads is the assertion: one url, one load, forever. */
describe('the baked page-0 image is cached independently of atlasVersion', () => {
  beforeEach(() => { loadCalls = 0; loadMtsdfAtlasTexture.mockClear(); });
  it('does not re-load the image when a generation bumps the version', async () => {
    const p = provider('hybrid') as unknown as { atlasVersion: number };
    const woke = wakesFor('hybrid');
    expect(getFontTexturePixi(p as never, 0)).toBeNull();  // starts exactly one load
    expect(loadCalls).toBe(1);

    const tex = fakeTexture();
    resolveLoad(tex);
    await vi.waitFor(() => expect(woke()).toBe(1));
    expect(getFontTexturePixi(p as never, 0)).toBe(tex);

    // A glyph batch lands: the generated CANVAS pages changed; the baked image did not.
    p.atlasVersion = 7;
    expect(getFontTexturePixi(p as never, 0), 'the baked image must still be cached').toBe(tex);
    expect(loadCalls, 'a version bump must not re-fetch the immutable baked atlas').toBe(1);
  });
});

/** A font INVALIDATED mid-load must not pin the superseded atlas forever.
 *
 *  `invalidateFont(guid)` disposes the live provider and re-acquires a fresh one under the SAME
 *  guid (a Font-Inspector mode flip or a re-bake). The cache key is `${provider.id}:image`, so the
 *  new provider looks the old one up — which is fine only while the disposal actually cleared the
 *  entry. It does not when the load was still in flight: `addDisposable` is registered inside the
 *  `.then()`, and a provider that has already run `dispose()` pushes it onto an array nothing will
 *  ever drain. The entry then survives every release, and the re-baked font keeps drawing the old
 *  atlas until a page reload. */
describe('a provider disposed mid-load must not leave its texture in the cache', () => {
  beforeEach(() => { loadCalls = 0; loadMtsdfAtlasTexture.mockClear(); unload.mockClear(); });

  /** The REAL provider, not a stub: `addDisposable`/`dispose` are exactly what is under test here,
   *  so a hand-rolled pair would only assert the fixture. The glyph atlas is never read (no layout
   *  happens in this test) — only the id and the image URL matter. */
  const liveProvider = (id: string) =>
    new BakedFontProvider(id, {} as never, `/fonts/${id}~atlas.png`);

  it('drops the entry when the load lands after invalidateFont disposed the provider, and STILL wakes the waiter', async () => {
    const p1 = liveProvider('font-invalidated');
    const woke = wakesFor('font-invalidated');
    expect(getFontTexturePixi(p1 as never, 0), 'load in flight').toBeNull();

    // The human re-bakes the font: invalidateFont disposes p1 and re-acquires under the same guid.
    p1.dispose();
    const stale = fakeTexture();
    resolveLoad(stale);
    await vi.waitFor(() => expect(loadMtsdfAtlasTexture).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    // The cleanup ran late instead of never: the entry is gone and the atlas is released.
    // ⚠️ Released by DESTROYING it, not by `Assets.unload` (#1045): the atlas is loaded outside
    // Pixi's Assets cache now, so `unload` would be a silent no-op that leaks the whole 8 MB page.
    expect(stale.destroy, 'the superseded atlas is released, not leaked').toHaveBeenCalledTimes(1);
    expect(stale.destroy, 'and its SOURCE goes with it, not just the wrapper').toHaveBeenCalledWith(true);
    expect(unload, 'Assets never owned this texture, so unloading it would be a no-op').not.toHaveBeenCalled();

    // ⚠️ THE WAKE MUST STILL FIRE, and an earlier version of this fix asserted the exact
    // opposite. `inFlight` is keyed by the font GUID, so it outlives the provider INSTANCE while
    // the cache entry does not: a repaint for the live successor (p2 below) finds p1's load in
    // flight and returns null without starting its own. Not waking strands that repaint — the
    // "texts are not rendered until I click the entity" bug. `markTextDirty` is keyed by the same
    // guid, so the wake reaches p2's text.
    //
    // It cannot loop: a woken repaint resolves its provider through `getLoadedFont(guid)`, and
    // every disposal path deletes from `providers` synchronously, so the retry gets the LIVE
    // provider or none — never the disposed p1 that landed here. Bounded at one iteration, which
    // is what the `loadCalls === 2` assertion below measures.
    expect(woke(), 'a live successor may be waiting on this load — wake it').toBe(1);

    const p2 = liveProvider('font-invalidated');
    expect(getFontTexturePixi(p2 as never, 0), 'the DEAD provider’s atlas must not be served')
      .not.toBe(stale);
    expect(loadCalls, 'the re-acquired provider fetches the re-baked atlas itself').toBe(2);
  });

  it('runs a post-dispose registration immediately on BOTH provider kinds', () => {
    // The contract the fix above rests on, asserted directly rather than through the cache.
    const baked = new BakedFontProvider('contract-baked', {} as never, '/fonts/x~atlas.png');
    baked.dispose();
    const bakedCleanup = vi.fn();
    baked.addDisposable(bakedCleanup);
    expect(bakedCleanup, 'baked: a late cleanup runs now, not never').toHaveBeenCalledTimes(1);

    // `DynamicFontProvider.create` needs real font bytes + a canvas, so the instance is built on
    // the prototype with only the fields `dispose` touches. The METHODS under test are the real
    // ones — that is what the assertion rests on.
    const dyn = Object.create(DynamicFontProvider.prototype) as typeof DynamicFontProvider.prototype;
    Object.assign(dyn, {
      disposables: [], glyphMap: new Map(), kern: new Map(), pages: [], ctxs: [],
      // #635 fix 4: dispose() → cancelFlushRetry() now iterates `retryBatch` unconditionally
      // (re-adding any still-pending cp to `requested` before clearing the timer) — a NEW field
      // `dispose` touches, so it belongs on this list for the same reason the others are here.
      retryBatch: new Set(),
    });
    dyn.dispose();
    const dynCleanup = vi.fn();
    dyn.addDisposable(dynCleanup);
    expect(dynCleanup, 'dynamic: same contract').toHaveBeenCalledTimes(1);
  });
});

/** #481 — `addDisposable` on an ALREADY-disposed provider runs its callback SYNCHRONOUSLY
 *  (asserted directly above). `getDynamicFontTexturePixi` mints a Texture, caches it, then calls
 *  `provider.addDisposable(...)`, so a provider that is already disposed by the time this runs
 *  destroys the texture it just minted and evicts it from the cache — all before the function
 *  returns it. Latent today (nothing constructs a route from a disposed provider to here), so this
 *  closes a contract hole rather than pins a reproduced failure.
 *
 *  ⚠️ The fake below MUST mirror `BakedFontProvider.addDisposable`'s real disposed-branch exactly
 *  (`try { fn(); } catch {} `, called synchronously) — a fake that queued the callback instead
 *  would vouch for the bug (this repo has a scar for exactly this class of fake). */
describe('a dynamic texture built for an ALREADY-disposed provider (#481)', () => {
  beforeEach(() => { loadCalls = 0; loadMtsdfAtlasTexture.mockClear(); });

  function disposedDynamicProvider(id: string) {
    return {
      id,
      atlasVersion: 1,
      atlasCanvasAt: () => ({} as HTMLCanvasElement),
      addDisposable: (fn: () => void) => {
        // Mirrors BakedFontProvider.addDisposable's `if (this.disposed) { try { fn(); } catch {} return; }`
        try { fn(); } catch { /* ignore */ }
      },
    } as never;
  }

  it('returns null instead of a destroyed Texture, and does not leave it cached', () => {
    const p = disposedDynamicProvider('font-disposed');

    const tex = getFontTexturePixi(p, 0);
    expect(tex, 'a corpse texture must never be handed back').toBeNull();

    // The cache must not retain the destroyed entry either — a later call must mint fresh (and,
    // since the provider is still disposed, be destroyed again), never serve the dead one back.
    const second = getFontTexturePixi(p, 0);
    expect(second).toBeNull();
  });
});

/** The cache-hit guard for the BAKED (image) path: `if (existing?.destroyed) cache.delete(key);
 *  else if (existing) return existing;`. A destroyed page-0 image texture sitting in the cache
 *  (its disposer did not evict it — e.g. something destroyed the Texture directly, bypassing
 *  `provider.addDisposable`'s callback) must not be handed back; the cache must be evicted and a
 *  fresh load started instead. */
describe('a destroyed baked image texture already in the cache is evicted, not served (#481 sibling)', () => {
  beforeEach(() => { loadCalls = 0; loadMtsdfAtlasTexture.mockClear(); });

  it('evicts and starts a fresh load instead of returning the destroyed texture', async () => {
    const p = provider('font-baked-destroyed');
    const woke = wakesFor('font-baked-destroyed');
    expect(getFontTexturePixi(p, 0), 'load in flight').toBeNull();

    const tex1 = fakeTexture() as unknown as { source: unknown; destroyed?: boolean };
    resolveLoad(tex1);
    await vi.waitFor(() => expect(woke()).toBe(1));
    expect(getFontTexturePixi(p, 0), 'cached after landing').toBe(tex1);

    // Destroy the texture WITHOUT going through the provider's disposer (a real
    // `Texture.destroy()` flips `.destroyed`, but nothing here evicts the cache entry) — this
    // is exactly the "disposer did not evict it" case the guard defends against.
    tex1.destroyed = true;

    const result = getFontTexturePixi(p, 0);
    expect(result, 'must not hand back the destroyed texture').not.toBe(tex1);
    expect(result, 'a fresh load starts instead').toBeNull();
    expect(loadCalls, 'a second load is kicked for the evicted entry').toBe(2);
  });
});

/** #481's eviction branch in the DYNAMIC path (`getDynamicFontTexturePixi`) is unreachable by the
 *  existing #481 suite: there, the disposer always runs (synchronously, on an already-disposed
 *  provider) and evicts BEFORE destroying, so `tex?.destroyed` is never true at the top of the
 *  function. Seed a destroyed texture that the disposer did NOT evict (bypassing it, same as the
 *  baked case above) to actually exercise the branch. */
describe('the dynamic-path eviction branch is reachable independently of the disposer (#481 coverage)', () => {
  beforeEach(() => { loadCalls = 0; loadMtsdfAtlasTexture.mockClear(); });

  function dynamicProvider(id: string) {
    let disposeFn: (() => void) | undefined;
    return {
      id,
      atlasVersion: 1,
      atlasCanvasAt: () => ({} as HTMLCanvasElement),
      addDisposable: (fn: () => void) => { disposeFn = fn; },
      // exposed for the test only — not part of FontProvider
      __runDispose: () => disposeFn?.(),
    } as unknown as { id: string; atlasVersion: number; atlasCanvasAt: () => HTMLCanvasElement };
  }

  it('evicts a destroyed cached texture and mints a fresh, live one', () => {
    const p = dynamicProvider('font-dynamic-destroyed');

    const tex1 = getFontTexturePixi(p as never, 0) as unknown as { destroyed?: boolean } | null;
    expect(tex1, 'first call mints a texture').not.toBeNull();

    // Destroy it directly, WITHOUT running the registered disposer — the disposer is what
    // normally evicts the cache entry, and this is the "eviction didn't happen" case.
    (tex1 as { destroyed: boolean }).destroyed = true;

    const tex2 = getFontTexturePixi(p as never, 0);
    expect(tex2, 'must not be null').not.toBeNull();
    expect(tex2, 'must not be the destroyed texture').not.toBe(tex1);
    expect((tex2 as unknown as { destroyed?: boolean }).destroyed, 'the fresh texture is live').toBeFalsy();
  });
});
