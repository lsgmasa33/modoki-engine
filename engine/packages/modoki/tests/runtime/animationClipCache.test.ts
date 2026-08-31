/** animationClipCache integration tests — async `.anim.json` loading lifecycle
 *  through the asset manifest (GUID resolution) + a mocked `fetch`:
 *  null-while-loading → cached/normalized, failed-stays-failed, GUID → path
 *  resolution, self-registration of the clip's id, and editor seed/invalidate. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { completeResponse } from '../stubs/assetResponse';
import { ASSET_FETCH_INIT } from '../../src/runtime/loaders/assetFetch';

const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup() {
  vi.resetModules();
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  const cache = await import('../../src/runtime/loaders/animationClipCache');
  return { manifest, cache };
}

function mockFetch(impl: (url: string) => Promise<unknown>) {
  // completeResponse fills in text() — the stubs below only supply json(), and the loaders read
  // the body as text so they can spot Vite's index.html SPA fallback. See tests/stubs/assetResponse.ts.
  const fn = vi.fn(async (url: string) => completeResponse(await impl(url)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CLIP_JSON = {
  id: '11111111-2222-4333-8444-555555555555',
  name: 'Walk',
  duration: 2,
  frameRate: 30,
  tracks: [{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [{ t: 0, v: 0, inTangent: 0, outTangent: 0 }] }],
};

describe('getAnimationClip', () => {
  it('returns null for empty ref without fetching', async () => {
    const { cache } = await setup();
    const fetchFn = mockFetch(async () => ({ ok: true, json: async () => ({}) }));
    expect(cache.getAnimationClip('')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns null while loading, then the normalized clip; missing fields filled', async () => {
    const { cache } = await setup();
    const fetchFn = mockFetch(async () => ({ ok: true, json: async () => ({ name: 'Bare' }) }));
    expect(cache.getAnimationClip('anims/bare.anim.json')).toBeNull();
    await flush();
    const clip = cache.getAnimationClip('anims/bare.anim.json');
    expect(clip).not.toBeNull();
    expect(clip!.name).toBe('Bare');
    expect(clip!.duration).toBe(1);   // default
    expect(clip!.frameRate).toBe(60); // default
    expect(clip!.loop).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('marks a failed load as failed and does not retry', async () => {
    const { cache } = await setup();
    const fetchFn = mockFetch(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
    expect(cache.getAnimationClip('anims/missing.anim.json')).toBeNull();
    await flush();
    expect(cache.getAnimationClip('anims/missing.anim.json')).toBeNull();
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('resolves a GUID ref through the manifest and self-registers the clip id', async () => {
    const { manifest, cache } = await setup();
    const guid = CLIP_JSON.id;
    manifest.registerAsset(guid, 'anims/walk.anim.json', 'animation');
    const fetchFn = mockFetch(async () => ({ ok: true, json: async () => CLIP_JSON }));
    expect(cache.getAnimationClip(guid)).toBeNull();
    await flush();
    const clip = cache.getAnimationClip(guid);
    expect(clip!.name).toBe('Walk');
    expect(fetchFn).toHaveBeenCalledWith('anims/walk.anim.json', ASSET_FETCH_INIT);
    // self-registration kept the guid → path mapping resolvable
    expect(manifest.resolveGuidToPath(guid)).toBe('anims/walk.anim.json');
  });

  it('editor seed/invalidate bypasses + clears the cache', async () => {
    const { cache } = await setup();
    const fetchFn = mockFetch(async () => ({ ok: true, json: async () => CLIP_JSON }));
    cache.setAnimationClip('anims/seed.anim.json', { ...CLIP_JSON, name: 'Seeded' } as never);
    expect(cache.getAnimationClip('anims/seed.anim.json')!.name).toBe('Seeded');
    expect(fetchFn).not.toHaveBeenCalled(); // served from seed, no fetch
    cache.invalidateAnimationClip('anims/seed.anim.json');
    expect(cache.getAnimationClip('anims/seed.anim.json')).toBeNull(); // now re-fetches
  });

  it('invalidateAnimationClip mid-flight refuses a fetch that resolves with the OLD def (#487 item 8)', async () => {
    const { cache } = await setup();
    let resolveOld: (v: unknown) => void = () => {};
    const fetchFn = vi.fn(() => new Promise((r) => { resolveOld = r; }));
    vi.stubGlobal('fetch', fetchFn);

    expect(cache.getAnimationClip('anims/race.anim.json')).toBeNull(); // kicks off the in-flight load
    cache.invalidateAnimationClip('anims/race.anim.json');               // re-import lands mid-flight

    resolveOld(await completeResponse({ ok: true, json: async () => ({ ...CLIP_JSON, name: 'STALE' }) }));
    await flush();

    // Genuinely EMPTY (peek, no new fetch) — not merely shadowed by a fresher value.
    expect(cache.getAnimationClip('anims/race.anim.json', { load: false })).toBeNull();
  });

  // THE DECISIVE case (#499): `generation` is module-wide, so a per-key `invalidateAnimationClip`
  // that bumped it would refuse every OTHER key's in-flight load too. Must FAIL against the
  // module-wide-`generation++` version and PASS once invalidation is scoped per path.
  it('invalidating an UNRELATED clip while A is in flight leaves A cacheable', async () => {
    const { cache } = await setup();
    let resolveA: (v: unknown) => void = () => {};
    const fetchFn = vi.fn(() => new Promise((r) => { resolveA = r; }));
    vi.stubGlobal('fetch', fetchFn);

    expect(cache.getAnimationClip('anims/cross.a.anim.json')).toBeNull(); // kicks off A's load
    cache.invalidateAnimationClip('anims/cross.b.anim.json');              // UNRELATED path

    resolveA(await completeResponse({ ok: true, json: async () => ({ ...CLIP_JSON, name: 'A' }) }));
    await flush();

    expect(cache.getAnimationClip('anims/cross.a.anim.json')?.name).toBe('A'); // must be cached
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // `runtime/animation/**` had zero console.warn calls (QA-ANIM-0018): an Animator whose bank
  // referenced a deleted/renamed-away clip GUID posed nothing, with no trace in the console — a
  // parity gap against the 3D-material and 2D-sprite paths, which both warn once per unresolved
  // guid via `resolveRefWarnOnce`.
  it('warns once for a clip GUID absent from the manifest (parity with MeshCache/Sprite2D)', async () => {
    const { cache } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guid = '99999999-2222-4333-8444-555555555555'; // never registered
    expect(cache.getAnimationClip(guid)).toBeNull();
    expect(cache.getAnimationClip(guid)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(guid);
  });

  it('forgets an unresolved guid once it resolves, so a later real deletion warns again', async () => {
    const { manifest, cache } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guid = CLIP_JSON.id;
    mockFetch(async () => ({ ok: true, json: async () => CLIP_JSON }));

    expect(cache.getAnimationClip(guid)).toBeNull();       // transient miss — not registered yet
    expect(warn).toHaveBeenCalledTimes(1);

    manifest.registerAsset(guid, 'anims/walk.anim.json', 'animation');
    expect(cache.getAnimationClip(guid)).toBeNull();      // guid now resolves — kicks off the fetch
    await flush();
    expect(cache.getAnimationClip(guid)).not.toBeNull();  // loaded — and the guid is forgotten

    manifest.clearManifest();                              // genuinely deleted later
    expect(cache.getAnimationClip(guid)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
