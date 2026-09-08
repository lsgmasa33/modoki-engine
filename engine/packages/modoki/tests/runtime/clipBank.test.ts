/** parseClipBank / stringifyClipBank / clipRefForKey — the guarded JSON-string
 *  bank codec for AudioSource.clips (mirrors parseColliderPoints' safety contract). */

import { describe, it, expect } from 'vitest';
import { parseClipBank, parseClipBankResult, stringifyClipBank, clipRefForKey } from '../../src/runtime/audio/clipBank';

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

// #731: parseClipBank's plain `[]`-on-failure contract can't tell "no bank authored" apart from
// "malformed bank" — the build tree-shaker needs that distinction to warn instead of silently
// shaking a clip's audio asset out of the prod build. parseClipBank itself (above) is UNCHANGED
// and must stay green: it is now a thin delegate over parseClipBankResult.
describe('parseClipBankResult', () => {
  it('malformed: false, entries: [] for "no bank authored" (absent/empty/wrong-type src)', () => {
    for (const notAuthored of ['', undefined, null, 123, {}]) {
      expect(parseClipBankResult(notAuthored as unknown)).toEqual({ entries: [], malformed: false });
    }
  });

  it('malformed: true for a non-empty string that could not be decoded into a valid bank array', () => {
    for (const bad of ['not json {', '{"key":"a"}', 'null', '42']) {
      expect(parseClipBankResult(bad)).toEqual({ entries: [], malformed: true });
    }
  });

  it('accept side: a well-formed bank is malformed: false with the same entries parseClipBank returns', () => {
    const s = JSON.stringify([{ key: 'a', ref: 'g1' }, { key: 'b', ref: 'g2' }]);
    const r = parseClipBankResult(s);
    expect(r.malformed).toBe(false);
    expect(r.entries).toEqual(parseClipBank(s));
    expect(r.entries).toEqual([{ key: 'a', ref: 'g1' }, { key: 'b', ref: 'g2' }]);
  });

  it('does NOT flag malformed for a valid array containing a droppable entry', () => {
    // A dropped entry (missing key/ref) is normal authoring mid-edit, not corruption.
    const r = parseClipBankResult(JSON.stringify([{ key: 'ok', ref: 'g1' }, { key: 'x' }]));
    expect(r.malformed).toBe(false);
    expect(r.entries).toEqual([{ key: 'ok', ref: 'g1' }]);
  });

  it('parseClipBank is a thin delegate — same entries as .entries on every input above', () => {
    for (const src of ['', 'not json {', '{"key":"a"}', 'null', '42', undefined, null, 123, {}, JSON.stringify([{ key: 'a', ref: 'g1' }])]) {
      expect(parseClipBank(src as unknown)).toEqual(parseClipBankResult(src as unknown).entries);
    }
  });
});
