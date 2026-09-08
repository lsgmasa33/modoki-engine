/** animClipBank — decode + resolve the Animator.clips JSON-string bank. */

import { describe, it, expect } from 'vitest';
import {
  parseAnimClipBank,
  parseAnimClipBankResult,
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

// #731: parseAnimClipBank's plain `[]`-on-failure contract can't tell "no bank authored" apart
// from "malformed bank" — the build tree-shaker needs that distinction to warn instead of
// silently shaking a clip's asset out of the prod build. parseAnimClipBank itself (above) is
// UNCHANGED and must stay green: it is now a thin delegate over parseAnimClipBankResult.
describe('parseAnimClipBankResult', () => {
  it('malformed: false, entries: [] for "no bank authored" (absent/empty/wrong-type src)', () => {
    expect(parseAnimClipBankResult('')).toEqual({ entries: [], malformed: false });
    expect(parseAnimClipBankResult(undefined)).toEqual({ entries: [], malformed: false });
    expect(parseAnimClipBankResult(42)).toEqual({ entries: [], malformed: false });
  });

  it('malformed: true for a string that could not be decoded into a valid bank array', () => {
    expect(parseAnimClipBankResult('{not json')).toEqual({ entries: [], malformed: true });
    expect(parseAnimClipBankResult('{"name":"x"}')).toEqual({ entries: [], malformed: true }); // object, not array
  });

  it('accept side: a well-formed bank is malformed: false with the same entries parseAnimClipBank returns', () => {
    const src = JSON.stringify([{ name: 'idle', clip: G }, { name: 'walk', clip: H, speed: 2 }]);
    const r = parseAnimClipBankResult(src);
    expect(r.malformed).toBe(false);
    expect(r.entries).toEqual(parseAnimClipBank(src));
    expect(r.entries).toEqual([{ name: 'idle', clip: G }, { name: 'walk', clip: H, speed: 2 }]);
  });

  it('does NOT flag malformed for a valid array containing a droppable entry', () => {
    // A dropped entry (missing name/clip) is normal authoring mid-edit, not corruption.
    const r = parseAnimClipBankResult(JSON.stringify([{ name: 'ok', clip: G }, { name: 'no-clip' }]));
    expect(r.malformed).toBe(false);
    expect(r.entries).toEqual([{ name: 'ok', clip: G }]);
  });

  it('parseAnimClipBank is a thin delegate — same entries as .entries on every input above', () => {
    for (const src of ['', undefined, 42, '{not json', '{"name":"x"}', JSON.stringify([{ name: 'a', clip: G }])]) {
      expect(parseAnimClipBank(src)).toEqual(parseAnimClipBankResult(src).entries);
    }
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
