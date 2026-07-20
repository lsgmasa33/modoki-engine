/** particleCache integration tests — the async `.particle.json` loading lifecycle
 *  wired through the asset manifest (GUID resolution) + a mocked `fetch`:
 *  null-while-loading → cached, normalize-on-load, failed-stays-failed (no re-fetch),
 *  GUID → path resolution, and editor seed/invalidate. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Flush the fetch().then().then().finally() microtask chain + one macrotask. */
const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup() {
  vi.resetModules();
  // particleCache + assetManifest share one module instance in this fresh graph.
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  const cache = await import('../../src/runtime/loaders/particleCache');
  const types = await import('../../src/runtime/particles/types');
  return { manifest, cache, types };
}

function mockFetch(impl: (url: string) => Promise<unknown>) {
  const fn = vi.fn((url: string) => impl(url));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  // particleCache logs a warning on failed loads — keep test output clean.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getParticleEffect', () => {
  it('returns null for an empty ref without fetching', async () => {
    const { cache } = await setup();
    const fetchFn = mockFetch(async () => ({ ok: true, json: async () => ({}) }));
    expect(cache.getParticleEffect('')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns null while loading, then the normalized def once fetched', async () => {
    const { cache } = await setup();
    const json = { version: 1, name: 'Spark', maxParticles: 42, emission: { rateOverTime: 7 } };
    const fetchFn = mockFetch(async () => ({ ok: true, json: async () => json }));

    expect(cache.getParticleEffect('fx/spark.particle.json')).toBeNull(); // kicks off fetch
    await flush();

    const def = cache.getParticleEffect('fx/spark.particle.json');
    expect(def).not.toBeNull();
    expect(def!.maxParticles).toBe(42);
    expect(def!.emission.rateOverTime).toBe(7);
    // normalized: missing nested fields filled from the default effect
    expect(def!.shape.type).toBe('cone');
    expect(def!.render.blend).toBe('additive');
    expect(fetchFn).toHaveBeenCalledTimes(1); // cached after first resolve
  });

  it('marks a failed load as failed and does not retry the fetch', async () => {
    const { cache } = await setup();
    const fetchFn = mockFetch(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));

    expect(cache.getParticleEffect('fx/missing.particle.json')).toBeNull();
    await flush();
    expect(cache.getParticleEffect('fx/missing.particle.json')).toBeNull();
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('resolves a GUID ref through the manifest before fetching', async () => {
    const { manifest, cache } = await setup();
    const guid = '11111111-2222-4333-8444-555555555555';
    manifest.registerAsset(guid, 'fx/fire.particle.json', 'scene');
    const fetchFn = mockFetch(async () => ({ ok: true, json: async () => ({ version: 1, maxParticles: 9 }) }));

    expect(cache.getParticleEffect(guid)).toBeNull();
    await flush();

    expect(cache.getParticleEffect(guid)!.maxParticles).toBe(9);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0][0])).toContain('fire.particle.json');
  });

  it('returns null for an unknown GUID (unresolvable) without fetching', async () => {
    const { cache } = await setup();
    const fetchFn = mockFetch(async () => ({ ok: true, json: async () => ({}) }));
    expect(cache.getParticleEffect('99999999-9999-4999-8999-999999999999')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("re-affirms the loaded effect's in-file id → path on fetch, and caches for later GUID refs", async () => {
    // References are GUID-only: a scene/sub-emitter references the effect by guid,
    // which resolves through the manifest to the path. On fetch the loader re-registers
    // the in-file id → path (a defensive no-op when already registered) and caches the
    // def, so a second guid access resolves from cache without a 2nd fetch.
    const { manifest, cache } = await setup();
    const guid = '1cd1ed3b-4d9a-4b19-9e93-0ff54eb79e32';
    const path = '/games/x/assets/particles/confetti.particle.json';
    manifest.registerAsset(guid, path, 'particle');
    const def = { version: 1, id: guid, name: 'Confetti', maxParticles: 55 };
    const fetchFn = mockFetch(async () => ({ ok: true, json: async () => def }));

    // First access by guid kicks off the fetch.
    expect(cache.getParticleEffect(guid)).toBeNull();
    await flush();
    expect(cache.getParticleEffect(guid)!.maxParticles).toBe(55);

    // The in-file id remains registered to the same path; cached, no 2nd fetch.
    expect(manifest.resolveRef(guid)).toBe(path);
    expect(cache.getParticleEffect(guid)!.maxParticles).toBe(55);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed in-file id (does not register a non-guid path mapping)', async () => {
    const { manifest, cache } = await setup();
    const guid = '2cd1ed3b-4d9a-4b19-9e93-0ff54eb79e32';
    const path = '/fx/bad.particle.json';
    manifest.registerAsset(guid, path, 'particle');
    const fetchFn = mockFetch(async () => ({ ok: true, json: async () => ({ version: 1, id: 'not-a-guid', maxParticles: 3 }) }));
    expect(cache.getParticleEffect(guid)).toBeNull();
    await flush();
    expect(cache.getParticleEffect(guid)!.maxParticles).toBe(3); // still loads
    // The bogus in-file id never displaced the real guid → path mapping.
    expect(manifest.getGuidForPath(path)).toBe(guid);
    fetchFn.mockClear();
  });
});

describe('setParticleEffect / invalidateParticleEffect', () => {
  it('seeds the cache synchronously without a fetch (editor live-preview)', async () => {
    const { cache, types } = await setup();
    const fetchFn = mockFetch(async () => { throw new Error('should not fetch a seeded effect'); });
    cache.setParticleEffect('fx/seeded.particle.json', { ...types.defaultParticleEffect(), maxParticles: 123 });

    expect(cache.getParticleEffect('fx/seeded.particle.json')!.maxParticles).toBe(123);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('seeds by an internal asset path (editor cache key) and reads back by GUID', async () => {
    // The editor live-preview seeds by the asset's actual file path (its cache key),
    // which the GUID-only resolveRef would reject — setParticleEffect must accept it.
    // A scene that references the same effect by GUID then resolves to the same entry.
    const { manifest, cache, types } = await setup();
    const guid = '3cd1ed3b-4d9a-4b19-9e93-0ff54eb79e32';
    const path = '/games/x/assets/particles/seeded.particle.json';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    cache.setParticleEffect(path, { ...types.defaultParticleEffect(), maxParticles: 77 });
    // No path-ref rejection — the path was used directly as the cache key.
    expect(err).not.toHaveBeenCalled();
    // Same effect resolves through the manifest when referenced by GUID.
    manifest.registerAsset(guid, path, 'particle');
    expect(cache.getParticleEffect(guid)!.maxParticles).toBe(77);
    err.mockRestore();
  });

  it('drops the cache so the next access re-fetches', async () => {
    const { cache, types } = await setup();
    const fetchFn = mockFetch(async () => ({ ok: true, json: async () => ({ version: 1, maxParticles: 555 }) }));

    cache.setParticleEffect('fx/x.particle.json', { ...types.defaultParticleEffect(), maxParticles: 1 });
    expect(cache.getParticleEffect('fx/x.particle.json')!.maxParticles).toBe(1);

    cache.invalidateParticleEffect('fx/x.particle.json');
    expect(cache.getParticleEffect('fx/x.particle.json')).toBeNull(); // re-enters loading
    await flush();
    expect(cache.getParticleEffect('fx/x.particle.json')!.maxParticles).toBe(555);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('clearParticleCache (scene swap)', () => {
  it('clears all cached defs', async () => {
    const { cache } = await setup();
    mockFetch(async () => ({ ok: true, json: async () => ({ version: 1, maxParticles: 10 }) }));
    expect(cache.getParticleEffect('fx/a.particle.json')).toBeNull();
    await flush();
    expect(cache.getParticleEffect('fx/a.particle.json')).not.toBeNull();

    cache.clearParticleCache();
    // Cache emptied: next access re-enters loading (returns null until re-fetched).
    expect(cache.getParticleEffect('fx/a.particle.json')).toBeNull();
  });

  it('discards an in-flight fetch that resolves after a clear (no stale repopulation)', async () => {
    // Regression: a fetch started before a scene swap must NOT repopulate the
    // cache (or re-register a guid→path) when it resolves afterward.
    const { cache } = await setup();
    mockFetch(async () => ({ ok: true, json: async () => ({ version: 1, maxParticles: 99 }) }));

    expect(cache.getParticleEffect('fx/late.particle.json')).toBeNull(); // fetch in flight
    cache.clearParticleCache();                                          // scene swap mid-flight
    await flush();                                                       // fetch resolves now

    // The stale result was dropped — the path is not cached. Accessing it kicks
    // off a fresh fetch (null this tick) rather than returning the stale def.
    expect(cache.getParticleEffect('fx/late.particle.json')).toBeNull();
  });

  it('an in-flight fetch does not clobber an editor seed that landed during the load', async () => {
    // Regression: setParticleEffect (live-preview) during an in-flight load must win.
    const { cache, types } = await setup();
    mockFetch(async () => ({ ok: true, json: async () => ({ version: 1, maxParticles: 1 }) }));

    expect(cache.getParticleEffect('fx/edit.particle.json')).toBeNull(); // fetch in flight
    cache.setParticleEffect('fx/edit.particle.json', { ...types.defaultParticleEffect(), maxParticles: 4242 });
    await flush(); // disk fetch resolves — must NOT overwrite the seed

    expect(cache.getParticleEffect('fx/edit.particle.json')!.maxParticles).toBe(4242);
  });
});
