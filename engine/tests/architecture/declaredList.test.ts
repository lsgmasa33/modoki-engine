/** Red-green cover for `tests/helpers/declaredList.ts` (#830).
 *
 *  This helper is about to be the thing ~10 scope guards lean on, so its own failure modes need
 *  proving in BOTH directions. A guard helper that only ever REJECTS is as useless as one that
 *  only accepts: the accept side is what stops the next author working around it.
 *
 *  ⚠️ It lives in `tests/architecture/` and not beside the helper in `tests/helpers/` because
 *  `engine/vite.config.ts`'s include list has no `tests/helpers/**` glob — a `.test.ts` there is
 *  collected by NOTHING and would silently never run. Which is `testFilesAreCollected.test.ts`'s
 *  whole subject, and would have been a poor way to open a change about unreachable guards. */

import { describe, it, expect } from 'vitest';
import { assertDeclaredListIsComplete } from '../helpers/declaredList';

const base = {
  label: 'TEST_LIST',
  floor: 2,
  fix: 'Add it to the list.',
};

describe('assertDeclaredListIsComplete (#830)', () => {
  it('ACCEPTS a list that names the whole population', () => {
    expect(() => assertDeclaredListIsComplete({
      ...base,
      declared: ['a', 'b', 'c'],
      population: ['a', 'b', 'c'],
    })).not.toThrow();
  });

  it('ACCEPTS a list whose gap is covered by a reasoned exemption', () => {
    expect(() => assertDeclaredListIsComplete({
      ...base,
      declared: ['a', 'b'],
      population: ['a', 'b', 'c'],
      exempt: [{ item: 'c', reason: 'deliberately out of scope, for a stated reason' }],
    })).not.toThrow();
  });

  it('REJECTS a population member the list does not name — the defect this exists for', () => {
    // The direction every hand-rolled self-check in this repo missed: a list filtered by itself
    // can only see a DELETION. Growth is invisible to it, and growth is what actually happens.
    expect(() => assertDeclaredListIsComplete({
      ...base,
      declared: ['a', 'b'],
      population: ['a', 'b', 'c'],
    })).toThrow(/does not name them/);
  });

  it('REJECTS a list entry the marker no longer finds', () => {
    expect(() => assertDeclaredListIsComplete({
      ...base,
      declared: ['a', 'b', 'gone'],
      population: ['a', 'b'],
    })).toThrow(/does not find them/);
  });

  it('REJECTS a population below the floor, BEFORE comparing anything', () => {
    // A marker that stops matching makes every other check pass vacuously. This must fail even
    // though the (empty) population is trivially "covered" by the declared list.
    expect(() => assertDeclaredListIsComplete({
      ...base,
      declared: ['a', 'b'],
      population: [],
    })).toThrow(/below the floor/);
  });

  it('REJECTS a stale exemption — a row for something the marker no longer finds', () => {
    expect(() => assertDeclaredListIsComplete({
      ...base,
      declared: ['a', 'b'],
      population: ['a', 'b'],
      exempt: [{ item: 'vanished', reason: 'was excluded once' }],
    })).toThrow(/no longer finds/);
  });

  it('ACCEPTS a declared entry the marker cannot see, when it carries a reason', () => {
    expect(() => assertDeclaredListIsComplete({
      ...base,
      declared: ['a', 'b', 'byHand'],
      population: ['a', 'b'],
      extraDeclared: [{ item: 'byHand', reason: 'the marker cannot see this one, and should not' }],
    })).not.toThrow();
  });

  it('REJECTS an extraDeclared row for something the marker DOES find', () => {
    // Otherwise the row outlives its reason and quietly excuses a real member later.
    expect(() => assertDeclaredListIsComplete({
      ...base,
      declared: ['a', 'b'],
      population: ['a', 'b'],
      extraDeclared: [{ item: 'b', reason: 'stale justification' }],
    })).toThrow(/explains\s+nothing/);
  });

  it('an exemption does NOT excuse a different missing member', () => {
    // Guards against the exemption list quietly becoming a blanket off-switch: exempting `c` must
    // not also excuse `d`.
    expect(() => assertDeclaredListIsComplete({
      ...base,
      declared: ['a'],
      population: ['a', 'c', 'd'],
      exempt: [{ item: 'c', reason: 'stated' }],
    })).toThrow(/\bd\b/);
  });
});
