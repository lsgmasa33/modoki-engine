/** parseClipBank / stringifyClipBank / clipRefForKey — the guarded JSON-string
 *  bank codec for AudioSource.clips (mirrors parseColliderPoints' safety contract). */

import { describe, it, expect } from 'vitest';
import { parseClipBank, stringifyClipBank, clipRefForKey } from '../../src/runtime/audio/clipBank';

describe('parseClipBank', () => {
  it('parses a well-formed bank', () => {
    const s = JSON.stringify([{ key: 'a', ref: 'g1' }, { key: 'b', ref: 'g2' }]);
    expect(parseClipBank(s)).toEqual([{ key: 'a', ref: 'g1' }, { key: 'b', ref: 'g2' }]);
  });

  it('returns [] for empty / non-string / malformed / non-array input (never throws)', () => {
    for (const bad of ['', 'not json {', '{"key":"a"}', 'null', '42', undefined, null, 123, {}]) {
      expect(parseClipBank(bad as unknown)).toEqual([]);
    }
  });

  it('drops entries missing a string key or ref', () => {
    const s = JSON.stringify([
      { key: 'ok', ref: 'g1' }, { key: 'x' }, { ref: 'g2' }, { key: 1, ref: 2 }, null, 'str',
    ]);
    expect(parseClipBank(s)).toEqual([{ key: 'ok', ref: 'g1' }]);
  });

  it('round-trips through stringifyClipBank; empty bank → ""', () => {
    const bank = [{ key: 'a', ref: 'g1' }];
    expect(parseClipBank(stringifyClipBank(bank))).toEqual(bank);
    expect(stringifyClipBank([])).toBe('');
  });

  it('clipRefForKey resolves a key or returns "" when absent', () => {
    const s = JSON.stringify([{ key: 'groove', ref: 'g1' }, { key: 'prefunk', ref: 'g2' }]);
    expect(clipRefForKey(s, 'prefunk')).toBe('g2');
    expect(clipRefForKey(s, 'nope')).toBe('');
    expect(clipRefForKey('', 'groove')).toBe('');
  });
});
