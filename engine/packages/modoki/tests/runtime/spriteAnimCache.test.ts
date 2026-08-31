/** spriteAnimCache — resolves `.spriteanim.json` flipbook clip sets by GUID/path,
 *  lazy-fetch on a cold miss, seedable for editor live-preview. Mirrors the
 *  animSetCache tests: fetch is stubbed so a cold lookup is deterministic. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getSpriteAnim, resolveSpriteClip, activeSpriteClip, spriteAnimHasClip,
  setSpriteAnim, invalidateSpriteAnim, clearSpriteAnimCache,
} from '../../src/runtime/loaders/spriteAnimCache';
import { clearManifest, newGuid } from '../../src/runtime/loaders/assetManifest';

const flush = () => new Promise((r) => setTimeout(r, 0));
// text() as well as json(): the loaders read the body as TEXT so they can spot Vite's index.html
// SPA fallback and report a MISSING asset instead of a JSON syntax error.
const okResponse = (body: unknown) => {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(text), json: () => Promise.resolve(body) };
};

beforeEach(() => {
  clearSpriteAnimCache();
  clearManifest();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearSpriteAnimCache();
});

// Close-out sweep of QA-ANIM-0018 (animationClipCache's fix): every sibling `*Cache` module
// shared the same `isGuid(ref) ? resolveRef(ref) : ref` cache-key helper, silently returning
// undefined for a guid absent from the manifest with no warning at all.
describe('spriteAnimCache — unresolved guid warns once (parity with animationClipCache)', () => {
  it('warns once for a guid absent from the manifest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guid = newGuid();
    expect(getSpriteAnim(guid)).toBeNull();
    expect(getSpriteAnim(guid)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(guid);
    warn.mockRestore();
  });
});

describe('spriteAnimCache', () => {
  it('returns null/undefined for an empty ref', () => {
    expect(getSpriteAnim('')).toBeNull();
    expect(resolveSpriteClip('', 'walk')).toBeUndefined();
  });

  it('returns null on a cold miss (not yet loaded) — caller retries next frame', () => {
    // Not a GUID → key is the path itself; nothing cached → null.
    expect(getSpriteAnim('foo.spriteanim.json')).toBeNull();
    expect(resolveSpriteClip('foo.spriteanim.json', 'walk')).toBeUndefined();
  });

  it('{load:false} PEEKS a cold miss without starting a fetch', () => {
    // The `read-asset-def` agent op's contract: report what is in the live cache right
    // now, never kick off a background load for a question it is about to refuse anyway.
    expect(getSpriteAnim('peek.spriteanim.json', { load: false })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves a seeded clip by name', () => {
    setSpriteAnim('a.spriteanim.json', {
      clips: { walk: { frames: ['g1', 'g2'], fps: 10, mode: 'loop', cycles: 0 } },
    });
    expect(resolveSpriteClip('a.spriteanim.json', 'walk')).toEqual({
      frames: ['g1', 'g2'], fps: 10, mode: 'loop', cycles: 0,
    });
  });

  it('empty clip name resolves the first clip (stable insertion order)', () => {
    setSpriteAnim('a.spriteanim.json', {
      clips: {
        idle: { frames: ['i1'], fps: 8, mode: 'loop', cycles: 0 },
        walk: { frames: ['w1'], fps: 12, mode: 'loop', cycles: 0 },
      },
    });
    expect(resolveSpriteClip('a.spriteanim.json', '')?.frames).toEqual(['i1']);
  });

  it('normalizes malformed seed data (drops non-string frames, fills timing defaults)', () => {
    // Deliberately partial/malformed clip (missing fps/mode/cycles, junk frame entries) —
    // exercises the normalizer's defaulting/filtering, so the cast is the point of the test.
    setSpriteAnim('b.spriteanim.json', {
      clips: { walk: { frames: ['ok', 5, null] } as unknown as import('../../src/runtime/traits/SpriteAnimator').SpriteClip },
    });
    const clip = resolveSpriteClip('b.spriteanim.json', 'walk')!;
    expect(clip.frames).toEqual(['ok']);       // non-strings dropped
    expect(typeof clip.fps).toBe('number');    // defaulted
    expect(clip.mode).toBe('loop');            // defaulted
  });

  it('invalidate drops the seeded entry (cold again → null)', () => {
    setSpriteAnim('c.spriteanim.json', { clips: { walk: { frames: ['x'], fps: 12, mode: 'loop', cycles: 0 } } });
    expect(getSpriteAnim('c.spriteanim.json')).not.toBeNull();
    invalidateSpriteAnim('c.spriteanim.json');
    expect(getSpriteAnim('c.spriteanim.json')).toBeNull();
  });

  it('invalidateSpriteAnim mid-flight refuses a fetch that resolves with the OLD def (#487 item 8)', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { resolveOld = r; })));

    expect(getSpriteAnim('race.spriteanim.json')).toBeNull();  // kicks off the in-flight load
    invalidateSpriteAnim('race.spriteanim.json');                 // re-import lands mid-flight

    resolveOld(okResponse({ clips: { walk: { frames: ['STALE'], fps: 12, mode: 'loop', cycles: 0 } } }));
    await flush();

    // Genuinely EMPTY (peek, no new fetch) — not merely shadowed by a fresher value.
    expect(getSpriteAnim('race.spriteanim.json', { load: false })).toBeNull();
  });

  // THE DECISIVE case (#499): `generation` is module-wide, so a per-key `invalidateSpriteAnim`
  // that bumped it would refuse every OTHER key's in-flight load too. Must FAIL against the
  // module-wide-`generation++` version and PASS once invalidation is scoped per path.
  it('invalidating an UNRELATED set while A is in flight leaves A cacheable', async () => {
    let resolveA: (v: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { resolveA = r; })));

    expect(getSpriteAnim('cross.a.spriteanim.json')).toBeNull(); // kicks off A's load
    invalidateSpriteAnim('cross.b.spriteanim.json');               // UNRELATED path

    resolveA(okResponse({ clips: { walk: { frames: ['a'], fps: 12, mode: 'loop', cycles: 0 } } }));
    await flush();

    expect(getSpriteAnim('cross.a.spriteanim.json')?.clips.walk.frames).toEqual(['a']);
  });

  it('returns undefined for a clip name not present in the set', () => {
    setSpriteAnim('d.spriteanim.json', { clips: { idle: { frames: ['i'], fps: 12, mode: 'loop', cycles: 0 } } });
    expect(resolveSpriteClip('d.spriteanim.json', 'nope')).toBeUndefined();
  });
});

describe('activeSpriteClip (resolves the active clip from the clipSet asset)', () => {
  it('resolves the named active clip from the clipSet asset', () => {
    setSpriteAnim('set.spriteanim.json', { clips: { walk: { frames: ['a'], fps: 10, mode: 'loop', cycles: 0 } } });
    const clip = activeSpriteClip({ clipSet: 'set.spriteanim.json', clip: 'walk' });
    expect(clip?.frames).toEqual(['a']);
  });

  it('empty active clip resolves the first clip in the set', () => {
    setSpriteAnim('set2.spriteanim.json', { clips: { idle: { frames: ['i'], fps: 8, mode: 'loop', cycles: 0 } } });
    expect(activeSpriteClip({ clipSet: 'set2.spriteanim.json', clip: '' })?.frames).toEqual(['i']);
  });

  it('returns undefined with no clipSet', () => {
    expect(activeSpriteClip({ clip: 'walk' })).toBeUndefined();
    expect(activeSpriteClip({})).toBeUndefined();
  });

  it('returns undefined while the clipSet asset is still loading (caller retries)', () => {
    expect(activeSpriteClip({ clipSet: 'cold.spriteanim.json', clip: 'walk' })).toBeUndefined();
  });
});

describe('spriteAnimHasClip', () => {
  it('sees a clip in the clipSet asset', () => {
    setSpriteAnim('h.spriteanim.json', { clips: { jump: { frames: ['j'], fps: 12, mode: 'once', cycles: 1 } } });
    expect(spriteAnimHasClip({ clipSet: 'h.spriteanim.json' }, 'jump')).toBe(true);
    expect(spriteAnimHasClip({ clipSet: 'h.spriteanim.json' }, 'walk')).toBe(false);
  });

  it('is false for an empty name, no clipSet, or an unloaded clipSet', () => {
    setSpriteAnim('h2.spriteanim.json', { clips: { walk: { frames: ['w'], fps: 12, mode: 'loop', cycles: 0 } } });
    expect(spriteAnimHasClip({ clipSet: 'h2.spriteanim.json' }, '')).toBe(false);
    expect(spriteAnimHasClip({ clip: 'walk' }, 'walk')).toBe(false);
    expect(spriteAnimHasClip({ clipSet: 'cold2.spriteanim.json' }, 'walk')).toBe(false);
  });
});
