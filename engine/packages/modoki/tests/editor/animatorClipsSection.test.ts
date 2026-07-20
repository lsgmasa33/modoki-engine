// @vitest-environment jsdom
/** AnimatorClipsSection pure-helper tests. `uniqueName` suggests a fresh non-colliding
 *  clip name for a new bank entry; the clip-bank row transforms (setRefAt semantics) are
 *  covered as a pure round-trip through parseAnimClipBank/stringifyAnimClipBank — no React
 *  render. The panel imports cleanly (React only, plus the pure animClipBank helpers), so
 *  `uniqueName` is exported in place rather than extracted. */

import { describe, it, expect } from 'vitest';
import { uniqueName } from '../../src/editor/panels/AnimatorClipsSection';
import { parseAnimClipBank, stringifyAnimClipBank, type AnimatorClip } from '../../src/runtime/animation/animClipBank';

describe('uniqueName', () => {
  it('suggests "clip" for an empty bank', () => {
    expect(uniqueName([])).toBe('clip');
  });
  it('suggests "clip2" when "clip" is taken', () => {
    expect(uniqueName([{ name: 'clip', clip: 'g' }])).toBe('clip2');
  });
  it('suggests the first free "clipN" when clip..clip3 are taken', () => {
    expect(uniqueName([{ name: 'clip' }, { name: 'clip2' }, { name: 'clip3' }] as AnimatorClip[])).toBe('clip4');
  });
});

describe('clip-bank row transforms (setRefAt semantics — pure round-trip)', () => {
  // Mirror the panel's `setRefAt` reducer: empty clip ref REMOVES the row (splice);
  // a valid ref replaces `clip` keeping the row's `name`.
  const setRefAt = (i: number, clip: string) => (cur: AnimatorClip[]): AnimatorClip[] => {
    if (!clip) cur.splice(i, 1);
    else if (cur[i]) cur[i] = { ...cur[i], clip };
    return cur;
  };
  const roundTrip = (bank: AnimatorClip[], fn: (cur: AnimatorClip[]) => AnimatorClip[]) =>
    parseAnimClipBank(stringifyAnimClipBank(fn(parseAnimClipBank(stringifyAnimClipBank(bank)))));

  const base: AnimatorClip[] = [{ name: 'idle', clip: 'g-idle' }, { name: 'walk', clip: 'g-walk' }];

  it('an empty ref removes the row', () => {
    expect(roundTrip(base, setRefAt(0, ''))).toEqual([{ name: 'walk', clip: 'g-walk' }]);
  });
  it('a valid ref replaces clip, keeping the row name', () => {
    expect(roundTrip(base, setRefAt(1, 'g-run'))).toEqual([
      { name: 'idle', clip: 'g-idle' },
      { name: 'walk', clip: 'g-run' },
    ]);
  });
});
