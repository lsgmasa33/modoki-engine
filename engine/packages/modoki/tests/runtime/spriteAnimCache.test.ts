/** spriteAnimCache — resolves `.spriteanim.json` flipbook clip sets by GUID/path,
 *  lazy-fetch on a cold miss, seedable for editor live-preview. Mirrors the
 *  animSetCache tests: fetch is stubbed so a cold lookup is deterministic. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getSpriteAnim, resolveSpriteClip, activeSpriteClip, spriteAnimHasClip,
  setSpriteAnim, invalidateSpriteAnim, clearSpriteAnimCache,
} from '../../src/runtime/loaders/spriteAnimCache';

beforeEach(() => {
  clearSpriteAnimCache();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearSpriteAnimCache();
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
    setSpriteAnim('b.spriteanim.json', {
      clips: { walk: { frames: ['ok', 5, null] as unknown as string[] } },
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
