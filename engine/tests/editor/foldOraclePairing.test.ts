/** The #2009 P1 oracle's pairing rules (`foldOracle.ts` `pairUnused`), pure: the fuzzer cannot pin them, because the
 *  real fold never takes the branches that tell them apart. Each case is a close-out re-review finding. */

import { describe, it, expect } from 'vitest';
import { keptLeafSkipped, keptRowLeaves, pairUnused } from './foldOracle';
import type { UnusedRecord } from '../../packages/modoki/src/runtime/prefab/instanceRecord';

const removedGone = (key: string): UnusedRecord => ({ key, part: { kind: 'removed' }, cause: 'gone' } as UnusedRecord);
const none = () => false;

describe('#2009 P1 oracle: pairing the fold\'s unused records with today\'s kept leaves', () => {
  it('pairs by row: one row\'s record does not consume another row\'s kept leaf', () => {
    // The fold holds /Z's removal; today keeps /n's and /k's. A leaf-only pairing let /Z take /n and printed /k alone.
    const out = pairUnused([removedGone('/Z')], [{ key: '/n', leaf: 'removed' }, { key: '/k', leaf: 'removed' }], none, ['/n', '/k'], none);
    expect(out).toEqual(['fold-only unused /Z removed (gone)', 'kept-only unused /n removed', 'kept-only unused /k removed']);
  });

  it('a kept legacy leaf, which names no row, still pairs by leaf', () => {
    expect(pairUnused([removedGone('/Z')], [{ key: '(legacy)', leaf: 'removed' }], none, [], none)).toEqual([]);
  });

  it('(applied) only where the record, its removal turned into a restore, projects the member', () => {
    const kept = [{ key: '/m', leaf: 'removed' }];
    expect(pairUnused([], kept, none, ['/m'], (k) => k === '/m')).toEqual(['kept-only unused /m removed (applied)']);
    // A member the fold cannot project at all (gone, ambiguous): its lost "removed, gone" record is not an application.
    expect(pairUnused([], kept, none, ['/m'], none)).toEqual(['kept-only unused /m removed']);
    // The fold projects it: the removal was not applied.
    expect(pairUnused([], kept, (k) => k === '/m', ['/m'], () => true)).toEqual(['kept-only unused /m removed']);
    // The record does not remove it.
    expect(pairUnused([], kept, none, [], () => true)).toEqual(['kept-only unused /m removed']);
  });

  it('(applied) marks a kept link only where the fold links the same guid at the same row (#1931 member 1, #2023)', () => {
    const kept = [{ key: '/m', leaf: 'own', guid: 'g' }];
    const at = (k: string) => (k === '/m' ? ['g'] : []);
    expect(pairUnused([], kept, () => true, [], none, () => true, at)).toEqual(['kept-only unused /m own (applied g)']);
    // Before `(unprojected)`: the fold links it, so it was not lost with its member.
    expect(pairUnused([], kept, none, [], none, none, at)).toEqual(['kept-only unused /m own (applied g)']);
    // Another guid at that row, the same guid at another row, a link with no guid, a legacy channel: not an application.
    expect(pairUnused([], kept, () => true, [], none, () => true, () => ['h'])).toEqual(['kept-only unused /m own']);
    expect(pairUnused([], kept, () => true, [], none, () => true, (k) => (k === '/n' ? ['g'] : []))).toEqual(['kept-only unused /m own']);
    expect(pairUnused([], [{ key: '/m', leaf: 'own' }], () => true, [], none, () => true, at)).toEqual(['kept-only unused /m own']);
    expect(pairUnused([], [{ key: '(legacy)', leaf: 'own', guid: 'g' }], none, [], none, none, () => ['g'])).toEqual(['kept-only unused (legacy) own']);
    // Another leaf on that row is not a link.
    expect(pairUnused([], [{ key: '/m', leaf: 'parent', guid: 'g' }], () => true, [], none, () => true, at)).toEqual(['kept-only unused /m parent']);
  });

  it('a kept row\'s links carry their own guids, in rowLeaves\' order (its added, then its own)', () => {
    const row = { removed: true, added: [{ guid: 'a' }], own: [{ guid: 'b' }, { name: 'no guid' }, { guid: 'c' }] };
    expect(keptRowLeaves('/m', row)).toEqual([
      { key: '/m', leaf: 'removed' },
      { key: '/m', leaf: 'own', guid: 'a' }, { key: '/m', leaf: 'own', guid: 'b' },
      { key: '/m', leaf: 'own', guid: undefined }, { key: '/m', leaf: 'own', guid: 'c' },
    ]);
    // `skip` takes a row's links together, and leaves the rest.
    expect(keptRowLeaves('/m', row, (_k, leaf) => leaf === 'own')).toEqual([{ key: '/m', leaf: 'removed' }]);
  });

  it('under a row the record removes, only that row\'s removal and the links are compared (#2032)', () => {
    const cut = ['/n'];
    // Hunt seed 178: a reference node on /n/c/m, under the scene's own removal of /n. The record keeps it `heldNode`
    // (§ 10.4b) and today keeps the row as an orphan and writes it back, so both sides are paired.
    expect(keptLeafSkipped('/n/c/m', 'own', new Set(), cut)).toBe(false);
    expect(keptLeafSkipped('/n', 'own', new Set(), cut)).toBe(false);
    expect(keptLeafSkipped('/n', 'removed', new Set(), cut)).toBe(false);
    // A gone member's unused part: the save drops it and so does the record (#1914 R4).
    expect(keptLeafSkipped('/n/c/m', 'Transform.x', new Set(), cut)).toBe(true);
    expect(keptLeafSkipped('/n/c/m', 'removed', new Set(), cut)).toBe(true);
    expect(keptLeafSkipped('/n', 'parent', new Set(), cut)).toBe(true);
    // Outside the cut nothing is skipped; under a live placeholder everything is, links included (#2009).
    expect(keptLeafSkipped('/k/m', 'Transform.x', new Set(), cut)).toBe(false);
    expect(keptLeafSkipped('/n/c/m', 'own', new Set(['/n/c']), cut)).toBe(true);
    // A keyed copy reads as an `own` leaf but is a template node's statement, inert in the fold under the cut: skipped
    // there, compared elsewhere (review: unkeyed, it printed a false kept-only line, `(unprojected)` in a missing frame).
    expect(keptLeafSkipped('/n/c/m', 'own', new Set(), cut, true)).toBe(true);
    expect(keptLeafSkipped('/k/m', 'own', new Set(), cut, true)).toBe(false);
  });

  it('a skipped keyed copy takes no guid from the links that stay (#2032)', () => {
    const row = { added: [{ key: 'k1' }, { guid: 'a' }], own: [{ guid: 'b' }] };
    expect(keptRowLeaves('/n/m', row, (k, leaf, keyed) => keptLeafSkipped(k, leaf, new Set(), ['/n'], keyed))).toEqual([
      { key: '/n/m', leaf: 'own', guid: 'a' }, { key: '/n/m', leaf: 'own', guid: 'b' },
    ]);
  });

  it('(unprojected) marks an own link only on a row whose member no document holds, never a legacy one', () => {
    expect(pairUnused([], [{ key: '/m', leaf: 'own' }], none, [], none, none)).toEqual(['kept-only unused /m own (unprojected)']);
    expect(pairUnused([], [{ key: '/m', leaf: 'own' }], () => true, [], none, none)).toEqual(['kept-only unused /m own']);
    expect(pairUnused([], [{ key: '(legacy)', leaf: 'own' }], none, [], none, none)).toEqual(['kept-only unused (legacy) own']);
    // HELD: a document holds the member, a layer removed it. The fold's link is an `own heldNode` record, and losing
    // it is not #2018's mechanism, so the line stays unmarked (and unwaived).
    expect(pairUnused([], [{ key: '/m', leaf: 'own' }], none, [], none, () => true)).toEqual(['kept-only unused /m own']);
  });
});
