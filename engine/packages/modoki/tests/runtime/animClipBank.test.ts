/** animClipBank — decode + resolve the Animator.clips JSON-string bank. */

import { describe, it, expect } from 'vitest';
import {
  parseAnimClipBank,
  stringifyAnimClipBank,
  resolveActiveClip,
  animatorHasClip,
} from '../../src/runtime/animation/animClipBank';

const G = 'aaaaaaaa-1111-2222-3333-444444444444';
const H = 'bbbbbbbb-1111-2222-3333-444444444444';

describe('parseAnimClipBank', () => {
  it('parses a well-formed bank, keeping optional per-clip fields', () => {
    const bank = parseAnimClipBank(JSON.stringify([
      { name: 'idle', clip: G },
      { name: 'walk', clip: H, speed: 2, loop: false, fadeDuration: 0.3 },
    ]));
    expect(bank).toEqual([
      { name: 'idle', clip: G },
      { name: 'walk', clip: H, speed: 2, loop: false, fadeDuration: 0.3 },
    ]);
  });

  it('is guarded: empty / non-string / malformed / non-array → []', () => {
    expect(parseAnimClipBank('')).toEqual([]);
    expect(parseAnimClipBank(undefined)).toEqual([]);
    expect(parseAnimClipBank(42)).toEqual([]);
    expect(parseAnimClipBank('{not json')).toEqual([]);
    expect(parseAnimClipBank('{"name":"x"}')).toEqual([]); // object, not array
  });

  it('drops entries missing a string name or clip', () => {
    const bank = parseAnimClipBank(JSON.stringify([
      { name: 'ok', clip: G },
      { name: 'no-clip' },
      { clip: H },
      { name: 5, clip: G },
      null,
      'nope',
    ]));
    expect(bank).toEqual([{ name: 'ok', clip: G }]);
  });

  it('round-trips through stringify (empty → "[]")', () => {
    expect(stringifyAnimClipBank([])).toBe('[]');
    const entries = [{ name: 'a', clip: G }];
    expect(parseAnimClipBank(stringifyAnimClipBank(entries))).toEqual(entries);
  });
});

describe('resolveActiveClip', () => {
  const clips = JSON.stringify([
    { name: 'idle', clip: G },
    { name: 'walk', clip: H, speed: 2 },
  ]);

  it('resolves by active name, carrying per-clip overrides', () => {
    expect(resolveActiveClip({ clips, clip: 'walk' })).toEqual({
      name: 'walk', ref: H, speed: 2, loop: undefined, fadeDuration: undefined,
    });
  });

  it('empty active name → first entry', () => {
    expect(resolveActiveClip({ clips, clip: '' })?.name).toBe('idle');
    expect(resolveActiveClip({ clips })?.ref).toBe(G);
  });

  it('empty bank or unknown name → null', () => {
    expect(resolveActiveClip({ clips: '[]', clip: '' })).toBeNull();
    expect(resolveActiveClip({ clips, clip: 'run' })).toBeNull();
  });
});

describe('animatorHasClip', () => {
  const clips = JSON.stringify([{ name: 'idle', clip: G }]);
  it('true only for a present name', () => {
    expect(animatorHasClip({ clips }, 'idle')).toBe(true);
    expect(animatorHasClip({ clips }, 'walk')).toBe(false);
    expect(animatorHasClip({ clips }, '')).toBe(false);
  });
});
