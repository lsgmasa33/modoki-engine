/** animationClipCache integration tests — async `.anim.json` loading lifecycle
 *  through the asset manifest (GUID resolution) + a mocked `fetch`:
 *  null-while-loading → cached/normalized, failed-stays-failed, GUID → path
 *  resolution, self-registration of the clip's id, and editor seed/invalidate. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  const fn = vi.fn((url: string) => impl(url));
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
});
