/** assetMerge unit tests — the batch-Inspector merge helper (representative value
 *  + "mixed" key set across a multi-asset selection). */

import { describe, it, expect } from 'vitest';
import { mergeRecords } from '../../src/editor/panels/assetMerge';

describe('mergeRecords', () => {
  it('returns empty for no records', () => {
    const { merged, mixed } = mergeRecords([], ['a']);
    expect(merged).toEqual({});
    expect(mixed.size).toBe(0);
  });

  it('single record: every key merged, none mixed', () => {
    const { merged, mixed } = mergeRecords([{ a: 1, b: 'x' }], ['a', 'b']);
    expect(merged).toEqual({ a: 1, b: 'x' });
    expect(mixed.size).toBe(0);
  });

  it('identical records across the selection: nothing mixed', () => {
    const recs = [{ a: 1, b: 'x' }, { a: 1, b: 'x' }, { a: 1, b: 'x' }];
    const { merged, mixed } = mergeRecords(recs, ['a', 'b']);
    expect(merged).toEqual({ a: 1, b: 'x' });
    expect(mixed.size).toBe(0);
  });

  it('marks only the keys whose values differ', () => {
    const recs = [{ a: 1, b: 'x', c: true }, { a: 1, b: 'y', c: false }];
    const { merged, mixed } = mergeRecords(recs, ['a', 'b', 'c']);
    expect(merged.a).toBe(1);            // shared → representative value
    expect(mixed.has('a')).toBe(false);
    expect(mixed.has('b')).toBe(true);
    expect(mixed.has('c')).toBe(true);
  });

  it('representative value comes from the first record', () => {
    const recs = [{ a: 'first' }, { a: 'second' }];
    const { merged } = mergeRecords(recs, ['a']);
    expect(merged.a).toBe('first');
  });

  it('only compares the requested keys', () => {
    const recs = [{ a: 1, extra: 1 }, { a: 1, extra: 2 }];
    const { mixed } = mergeRecords(recs, ['a']);
    expect(mixed.size).toBe(0); // `extra` differs but wasn't requested
  });
});
