/** getFontTexturePixi — every renderer waiting on an atlas load must be woken, not just the first.
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
const loadPixiTexture = vi.fn(() => {
  loadCalls++;
  return new Promise((res, rej) => { resolveLoad = res as typeof resolveLoad; rejectLoad = rej; });
});
vi.mock('../../src/runtime/rendering/pixiTextureLoad', () => ({ loadPixiTexture }));

const { getFontTexturePixi } = await import('../../src/runtime/rendering/text/fontTexturePixi');
const { BakedFontProvider } = await import('../../src/runtime/rendering/text/fontProvider');
const { DynamicFontProvider } = await import('../../src/runtime/rendering/text/dynamicFontProvider');

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
const fakeTexture = () => ({ source: { scaleMode: '', alphaMode: '', update: vi.fn() } });

describe('getFontTexturePixi — concurrent renderers', () => {
  beforeEach(() => { loadCalls = 0; loadPixiTexture.mockClear(); unload.mockClear(); });

  it('wakes BOTH renderers when one shared atlas load lands', async () => {
    const p = provider('font-both');
    const wakeA = vi.fn();
    const wakeB = vi.fn();

    // Frame N: the Game panel asks first and starts the load; the Scene panel asks second.
    expect(getFontTexturePixi(p, 0, wakeA), 'nothing to draw yet').toBeNull();
    expect(getFontTexturePixi(p, 0, wakeB), 'and the second caller waits too').toBeNull();
    expect(loadCalls, 'ONE network load is shared — the second must not kick a duplicate').toBe(1);

    resolveLoad(fakeTexture());
    await vi.waitFor(() => expect(wakeA).toHaveBeenCalledTimes(1));

    // THE REGRESSION: wakeB used to be dropped, so the second panel never repainted and its text
    // stayed missing until an unrelated dirty event.
    expect(wakeB, 'the SECOND renderer is woken too — this is the whole bug').toHaveBeenCalledTimes(1);
  });

  it('serves the cached texture synchronously afterwards, with no further load or wake', async () => {
    const p = provider('font-cached');
    const wake = vi.fn();
    getFontTexturePixi(p, 0, wake);
    resolveLoad(fakeTexture());
    await vi.waitFor(() => expect(wake).toHaveBeenCalled());

    const late = vi.fn();
    const tex = getFontTexturePixi(p, 0, late);
    expect(tex, 'a later caller gets the texture straight back').not.toBeNull();
    expect(late, 'and is NOT called back — it already has what it asked for').not.toHaveBeenCalled();
    expect(loadCalls, 'still one load').toBe(1);
  });

  it('caches the texture BEFORE waking, so a synchronous re-render finds it', async () => {
    // A waiter that re-renders inside its own wake-up must see the cache populated, or it kicks a
    // second load and draws nothing again.
    const p = provider('font-order');
    let seenDuringWake: unknown = 'not-called';
    getFontTexturePixi(p, 0, () => { seenDuringWake = getFontTexturePixi(p, 0); });
    resolveLoad(fakeTexture());
    await vi.waitFor(() => expect(seenDuringWake).not.toBe('not-called'));
    expect(seenDuringWake, 'the texture is already cached when the wake-up fires').not.toBeNull();
    expect(loadCalls, 'so no second load is kicked').toBe(1);
  });

  it('a FAILED load drops its waiters and frees the key for a retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = provider('font-fail');
    const wake = vi.fn();
    getFontTexturePixi(p, 0, wake);
    rejectLoad(new Error('404'));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    // Not woken: there is nothing to draw. But the key must be free, or a later attempt would be
    // queued behind a dead load forever — and its wake-ups would never fire either.
    expect(wake, 'no wake-up for a load with no texture').not.toHaveBeenCalled();
    const retry = vi.fn();
    getFontTexturePixi(p, 0, retry);
    expect(loadCalls, 'the next call re-attempts rather than joining the dead load').toBe(2);
    resolveLoad(fakeTexture());
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    warn.mockRestore();
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
  beforeEach(() => { loadCalls = 0; loadPixiTexture.mockClear(); });
  it('does not re-load the image when a generation bumps the version', async () => {
    const p = provider('hybrid') as unknown as { atlasVersion: number };
    const wake = vi.fn();
    expect(getFontTexturePixi(p as never, 0, wake)).toBeNull();  // starts exactly one load
    expect(loadCalls).toBe(1);

    const tex = fakeTexture();
    resolveLoad(tex);
    await vi.waitFor(() => expect(wake).toHaveBeenCalled());
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
  beforeEach(() => { loadCalls = 0; loadPixiTexture.mockClear(); unload.mockClear(); });

  /** The REAL provider, not a stub: `addDisposable`/`dispose` are exactly what is under test here,
   *  so a hand-rolled pair would only assert the fixture. The glyph atlas is never read (no layout
   *  happens in this test) — only the id and the image URL matter. */
  const liveProvider = (id: string) =>
    new BakedFontProvider(id, {} as never, `/fonts/${id}~atlas.png`);

  it('drops the entry when the load lands after invalidateFont disposed the provider, and STILL wakes the waiter', async () => {
    const p1 = liveProvider('font-invalidated');
    const wake = vi.fn();
    expect(getFontTexturePixi(p1 as never, 0, wake), 'load in flight').toBeNull();

    // The human re-bakes the font: invalidateFont disposes p1 and re-acquires under the same guid.
    p1.dispose();
    const stale = fakeTexture();
    resolveLoad(stale);
    await vi.waitFor(() => expect(loadPixiTexture).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    // The cleanup ran late instead of never: the entry is gone and the atlas is unloaded.
    expect(unload, 'the superseded atlas is released, not leaked').toHaveBeenCalledTimes(1);

    // ⚠️ THE WAITER MUST STILL BE WOKEN, and an earlier version of this fix asserted the exact
    // opposite. `waiters` is keyed by the font GUID, so it outlives the provider INSTANCE while
    // the cache entry does not: the set can hold a waiter belonging to the live successor (p2
    // below), queued behind p1's still-in-flight load. Not waking strands that renderer — the
    // "texts are not rendered until I click the entity" bug the waiters set exists to prevent.
    //
    // It cannot loop: a woken repaint resolves its provider through `getLoadedFont(guid)`, and
    // every disposal path deletes from `providers` synchronously, so the retry gets the LIVE
    // provider or none — never the disposed p1 that landed here. Bounded at one iteration, which
    // is what the `loadCalls === 2` assertion below measures.
    expect(wake, 'a live successor may be queued behind this load — wake it').toHaveBeenCalledTimes(1);

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
  beforeEach(() => { loadCalls = 0; loadPixiTexture.mockClear(); });

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
  beforeEach(() => { loadCalls = 0; loadPixiTexture.mockClear(); });

  it('evicts and starts a fresh load instead of returning the destroyed texture', async () => {
    const p = provider('font-baked-destroyed');
    const wake1 = vi.fn();
    expect(getFontTexturePixi(p, 0, wake1), 'load in flight').toBeNull();

    const tex1 = fakeTexture() as unknown as { source: unknown; destroyed?: boolean };
    resolveLoad(tex1);
    await vi.waitFor(() => expect(wake1).toHaveBeenCalled());
    expect(getFontTexturePixi(p, 0), 'cached after landing').toBe(tex1);

    // Destroy the texture WITHOUT going through the provider's disposer (a real
    // `Texture.destroy()` flips `.destroyed`, but nothing here evicts the cache entry) — this
    // is exactly the "disposer did not evict it" case the guard defends against.
    tex1.destroyed = true;

    const wake2 = vi.fn();
    const result = getFontTexturePixi(p, 0, wake2);
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
  beforeEach(() => { loadCalls = 0; loadPixiTexture.mockClear(); });

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
