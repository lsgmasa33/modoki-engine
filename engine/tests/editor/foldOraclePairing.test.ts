/** The #2009 P1 oracle's pairing rules (`foldOracle.ts` `pairUnused`), pure: the fuzzer cannot pin them, because the
 *  real fold never takes the branches that tell them apart. Each case is a close-out re-review finding. */

import { describe, it, expect } from 'vitest';
import { pairUnused } from './foldOracle';
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

  it('(unprojected) marks an own link only on a row whose member no document holds, never a legacy one', () => {
    expect(pairUnused([], [{ key: '/m', leaf: 'own' }], none, [], none, none)).toEqual(['kept-only unused /m own (unprojected)']);
    expect(pairUnused([], [{ key: '/m', leaf: 'own' }], () => true, [], none, none)).toEqual(['kept-only unused /m own']);
    expect(pairUnused([], [{ key: '(legacy)', leaf: 'own' }], none, [], none, none)).toEqual(['kept-only unused (legacy) own']);
    // HELD: a document holds the member, a layer removed it. The fold's link is an `own heldNode` record, and losing
    // it is not #2018's mechanism, so the line stays unmarked (and unwaived).
    expect(pairUnused([], [{ key: '/m', leaf: 'own' }], none, [], none, () => true)).toEqual(['kept-only unused /m own']);
  });
});
