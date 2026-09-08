import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveAnimSetParams, setAnimSet, getAnimSet, invalidateAnimSet, clearAnimSetCache,
  ANIMSET_DEFAULTS,
} from '../../src/runtime/loaders/animSetCache';
import { clearManifest, newGuid } from '../../src/runtime/loaders/assetManifest';

const flush = () => new Promise((r) => setTimeout(r, 0));

// The cache lazily fetches on a miss. Stub fetch so a cold lookup is deterministic
// (rejects) instead of hitting the network; the seed path (setAnimSet) needs no fetch.
beforeEach(() => {
  clearAnimSetCache();
  clearManifest();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearAnimSetCache();
});

// Close-out sweep of QA-ANIM-0018 (animationClipCache's fix): every sibling `*Cache` module
// shared the same `isGuid(ref) ? resolveRef(ref) : ref` cache-key helper, silently returning
// undefined for a guid absent from the manifest with no warning at all.
describe('animSetCache — unresolved guid warns once (parity with animationClipCache)', () => {
  it('warns once for a guid absent from the manifest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guid = newGuid();
    expect(getAnimSet(guid)).toBeNull();
    expect(getAnimSet(guid)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(guid);
    warn.mockRestore();
  });
});

describe('animSetCache.resolveAnimSetParams', () => {
  it('returns engine defaults for an empty ref (no animset)', () => {
    expect(resolveAnimSetParams('', 'Idle')).toEqual(ANIMSET_DEFAULTS);
  });

  it('returns engine defaults when the animset is not yet loaded (cold miss)', () => {
    // 'foo.animset.json' is not a GUID, so the key is the path itself; not cached → defaults.
    expect(resolveAnimSetParams('foo.animset.json', 'Idle')).toEqual(ANIMSET_DEFAULTS);
  });

  it('applies a clip\'s authored params over the defaults', () => {
    setAnimSet('a.animset.json', {
      clips: [{ name: 'Attack', speed: 1.5, loop: false, fadeDuration: 0.2 }],
    });
    expect(resolveAnimSetParams('a.animset.json', 'Attack')).toEqual({
      speed: 1.5, loop: false, fadeDuration: 0.2,
    });
  });

  it('fills missing per-clip fields from the defaults', () => {
    setAnimSet('a.animset.json', { clips: [{ name: 'Walk', speed: 0.5 }] });
    expect(resolveAnimSetParams('a.animset.json', 'Walk')).toEqual({
      speed: 0.5, loop: ANIMSET_DEFAULTS.loop, fadeDuration: ANIMSET_DEFAULTS.fadeDuration,
    });
  });

  it('returns defaults for a clip not listed in the animset', () => {
    setAnimSet('a.animset.json', { clips: [{ name: 'Idle', speed: 2 }] });
    expect(resolveAnimSetParams('a.animset.json', 'Missing')).toEqual(ANIMSET_DEFAULTS);
  });

  it('honors loop:false (not treated as missing)', () => {
    setAnimSet('a.animset.json', { clips: [{ name: 'Die', loop: false }] });
    expect(resolveAnimSetParams('a.animset.json', 'Die').loop).toBe(false);
  });

  it('drops malformed clips (missing name) on normalize', () => {
    setAnimSet('a.animset.json', { clips: [{ speed: 3 } as any, { name: 'Ok', speed: 2 }] });
    const set = getAnimSet('a.animset.json')!;
    expect(set.clips).toHaveLength(1);
    expect(set.clips[0].name).toBe('Ok');
  });

  it('invalidate drops the cached set', () => {
    setAnimSet('a.animset.json', { clips: [{ name: 'Idle', speed: 2 }] });
    expect(getAnimSet('a.animset.json')).not.toBeNull();
    invalidateAnimSet('a.animset.json');
    // After invalidation a cold lookup re-fetches (stubbed to reject) → null this frame.
    expect(getAnimSet('a.animset.json')).toBeNull();
  });
});

describe('animSetCache lazy fetch', () => {
  it('loads + parses an animset from fetch, then resolves per-clip params', async () => {
    const def = { id: 'x', source: 'model.glb', clips: [{ name: 'Run', speed: 1.25, loop: true }] };
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      // text() too — the loader reads the body as TEXT to spot Vite's index.html SPA fallback.
      text: () => Promise.resolve(JSON.stringify(def)),
      json: () => Promise.resolve(def),
    } as any));
    vi.stubGlobal('fetch', fetchMock);

    expect(getAnimSet('run.animset.json')).toBeNull(); // kicks off the fetch
    // let the in-flight promise settle
    await vi.waitFor(() => expect(getAnimSet('run.animset.json')).not.toBeNull());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveAnimSetParams('run.animset.json', 'Run')).toEqual({
      speed: 1.25, loop: true, fadeDuration: 0,
    });
  });
});

describe('animSetCache — invalidateAnimSet mid-flight bumps generation (#487 item 8)', () => {
  it('refuses a fetch that resolves with the OLD def AFTER invalidateAnimSet ran mid-flight', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    const fetchMock = vi.fn(() => new Promise((r) => { resolveOld = r; }));
    vi.stubGlobal('fetch', fetchMock);

    expect(getAnimSet('race.animset.json')).toBeNull(); // kicks off the in-flight load
    invalidateAnimSet('race.animset.json');               // re-import lands mid-flight — must bump generation

    const stale = { id: 'stale', clips: [{ name: 'Stale' }] };
    resolveOld({ ok: true, text: () => Promise.resolve(JSON.stringify(stale)), json: () => Promise.resolve(stale) } as any);
    await flush();

    // No `{load:false}` peek exists on this cache (unlike its siblings) — prove the cache is
    // genuinely EMPTY, not merely holding something that happens to look absent, by resolving a
    // SECOND, FRESH fetch and confirming that's what wins: a populated cache would answer from
    // it and never start fetch #2 at all.
    const fresh = { id: 'fresh', clips: [{ name: 'Fresh' }] };
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(fresh)), json: () => Promise.resolve(fresh) } as any));
    expect(getAnimSet('race.animset.json')).toBeNull(); // still cold → kicks fetch #2
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(getAnimSet('race.animset.json')?.id).toBe('fresh'));
  });

  it('keep-direction: with no invalidation in between, the same load still caches normally', async () => {
    const def = { id: 'ok', clips: [{ name: 'Ok' }] };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(def)), json: () => Promise.resolve(def) } as any)));
    expect(getAnimSet('keep.animset.json')).toBeNull();
    await vi.waitFor(() => expect(getAnimSet('keep.animset.json')?.id).toBe('ok'));
  });

  // THE DECISIVE case (#499): `generation` is module-wide, so a per-key `invalidateAnimSet` that
  // bumped it would refuse every OTHER key's in-flight load too. Must FAIL against the
  // module-wide-`generation++` version and PASS once invalidation is scoped per path.
  it('invalidating an UNRELATED animset while A is in flight leaves A cacheable', async () => {
    let resolveA: (v: unknown) => void = () => {};
    const fetchMock = vi.fn(() => new Promise((r) => { resolveA = r; }));
    vi.stubGlobal('fetch', fetchMock);

    expect(getAnimSet('cross.a.animset.json')).toBeNull(); // kicks off A's load
    invalidateAnimSet('cross.b.animset.json');               // UNRELATED path

    const aDef = { id: 'a-def', clips: [{ name: 'A' }] };
    resolveA({ ok: true, text: () => Promise.resolve(JSON.stringify(aDef)), json: () => Promise.resolve(aDef) } as any);
    await vi.waitFor(() => expect(getAnimSet('cross.a.animset.json')?.id).toBe('a-def'));

    expect(fetchMock).toHaveBeenCalledTimes(1); // no spurious re-fetch of A
  });
});
