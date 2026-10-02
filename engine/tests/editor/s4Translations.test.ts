/** S4's I25 translations that are pure functions of their inputs (`prefabFuzz/s4Seams.ts`), held on both sides: the real
 *  fuzz runs reach them only on a KNOWN_OPEN repro, which shows one side. */

import { describe, it, expect } from 'vitest';
import { keptDeletedLinks } from './prefabFuzz/s4Seams';

describe('keptDeletedLinks (KNOWN_OPEN #1931 member 1, #2023)', () => {
  const K = '/R/eeee/a+K';
  const dead = () => false;
  const all = () => true;

  it('names a kept orphan row\'s link to a node no longer live, on a template-added row the record does not link it on', () => {
    expect(keptDeletedLinks({ [K]: { own: [{ guid: 'g1' }, { guid: 'g2' }] } }, new Map(), dead, all)).toEqual([[K, 'g1'], [K, 'g2']]);
    // The record links another node there: only the deleted one is named.
    expect(keptDeletedLinks({ [K]: { own: [{ guid: 'g1' }] } }, new Map([[K, { own: [{ guid: 'g9' }] }]]), dead, all)).toEqual([[K, 'g1']]);
  });

  it('names nothing else: a live node, a link the record keeps, another row, a link without a guid, no store', () => {
    expect(keptDeletedLinks({ [K]: { own: [{ guid: 'g1' }] } }, new Map(), (g) => g === 'g1', all)).toEqual([]);
    expect(keptDeletedLinks({ [K]: { own: [{ guid: 'g1' }] } }, new Map([[K, { own: [{ guid: 'g1' }] }]]), dead, all)).toEqual([]);
    expect(keptDeletedLinks({ '/R/eeee': { own: [{ guid: 'g1' }] } }, new Map(), dead, all)).toEqual([]); // a member row
    expect(keptDeletedLinks({ '/R/a+K/eeee': { own: [{ guid: 'g1' }] } }, new Map(), dead, all)).toEqual([]); // a member under one
    expect(keptDeletedLinks({ '/': { own: [{ guid: 'g1' }] } }, new Map(), dead, all)).toEqual([]); // the instance root
    expect(keptDeletedLinks({ [K]: { own: [{}] } }, new Map(), dead, all)).toEqual([]);
    expect(keptDeletedLinks(undefined, new Map(), dead, all)).toEqual([]);
    // A row the fold no longer declares: its node's template dropped it, so the kept row is a real orphan, not #1931's.
    expect(keptDeletedLinks({ [K]: { own: [{ guid: 'g1' }] } }, new Map(), dead, (k) => k !== K)).toEqual([]);
  });
});
