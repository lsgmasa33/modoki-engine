import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveAnimSetParams, setAnimSet, getAnimSet, invalidateAnimSet, clearAnimSetCache,
  ANIMSET_DEFAULTS,
} from '../../src/runtime/loaders/animSetCache';

// The cache lazily fetches on a miss. Stub fetch so a cold lookup is deterministic
// (rejects) instead of hitting the network; the seed path (setAnimSet) needs no fetch.
beforeEach(() => {
  clearAnimSetCache();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearAnimSetCache();
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
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(def) } as any));
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
