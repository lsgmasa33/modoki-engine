/** Red-green cover for `tests/helpers/exemptionLedger.ts` (#1123).
 *
 *  The case that matters is `REJECTS a SECOND occurrence`: every guard this helper is replacing is
 *  green on exactly that input today, and a migration mutation-checked only by DELETING an
 *  occurrence would pass while still shipping the defect. So the accept/reject pair is written per
 *  DIRECTION, not per field.
 *
 *  ⚠️ It sits in `tests/helpers/` beside the helper, which is collected HERE and would not be in
 *  `engine/tests/` — the engine project's include list has no `tests/helpers/**` glob, so a spec
 *  there runs nowhere (`declaredList.test.ts`'s own header records that trap). This package's
 *  project does collect them: `sourceScanner.test.ts`, `tapTargetFloor.test.ts`,
 *  `prefabInstances.test.ts` and `importClosure.test.ts` are all siblings.
 *
 *  MUTATION CHECK (2026-09-12), each reddening only its own case: drop the multiset decrement ->
 *  "REJECTS a SECOND occurrence"; drop the over-blessed check -> "blesses MORE than exists" + the
 *  spare-budget case; drop the floor -> "below the floor"; drop the stale-sanctioned check -> its
 *  own case; count sanctioned items -> the structural-split accept case. ⚠️ The floor mutation
 *  needs an anchor unique to THIS function — its message tail is shared verbatim with
 *  `declaredList.ts`'s floor assert, and two attempts reported a false pass because the edit never
 *  applied. */

import { describe, it, expect } from 'vitest';
import { assertExemptionLedger } from './exemptionLedger';

const ledger = {
  label: 'TEST_LEDGER',
  floor: 2,
  fix: 'Stop doing the banned thing.',
};

/** One occurrence, spelled the way a caller composes it. */
const at = (item: string, site: string) => ({ item, site });

describe('assertExemptionLedger (#1123)', () => {
  it('ACCEPTS occurrences fully paid for by their rows', () => {
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('a.ts', 'a.ts:1'), at('b.ts', 'b.ts:9')],
      exempt: [
        { item: 'a.ts', reason: 'bounded by construction' },
        { item: 'b.ts', reason: 'the sanctioned wrapper' },
      ],
    })).not.toThrow();
  });

  it('REJECTS a SECOND occurrence in an already-exempt file — THE defect (#1123)', () => {
    // ⚠️ This is the whole issue. Before the count, the row below pardoned the file, so `a.ts:2`
    // was invisible — in `gitReadIsBounded` that second occurrence was the two `git ls-files`
    // reads the entire repo's corpus enumeration runs on, pardoned by a row written about a
    // `rev-parse --show-toplevel`.
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('a.ts', 'a.ts:1'), at('a.ts', 'a.ts:2'), at('b.ts', 'b.ts:9')],
      exempt: [
        { item: 'a.ts', reason: 'one occurrence, and only one, is argued for here' },
        { item: 'b.ts', reason: 'fine' },
      ],
    })).toThrow(/a\.ts:2/);
  });

  it('ACCEPTS the second occurrence once the row RAISES its count', () => {
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('a.ts', 'a.ts:1'), at('a.ts', 'a.ts:2'), at('b.ts', 'b.ts:9')],
      exempt: [
        { item: 'a.ts', count: 2, reason: 'both occurrences argued for, each in this sentence' },
        { item: 'b.ts', reason: 'fine' },
      ],
    })).not.toThrow();
  });

  it('REJECTS a row blessing MORE than exists — a fix that did not deduct', () => {
    // The mirror direction, and the one `>= 1 survives` cannot see: with two pardons spent on one
    // surviving occurrence, the row is a standing pre-approval for the next one written.
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('a.ts', 'a.ts:1'), at('b.ts', 'b.ts:9')],
      exempt: [
        { item: 'a.ts', count: 2, reason: 'one of these was fixed and the row was not deducted' },
        { item: 'b.ts', reason: 'fine' },
      ],
    })).toThrow(/blesses 2, found 1/);
  });

  it('REJECTS an occurrence no row pays for at all', () => {
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('a.ts', 'a.ts:1'), at('new.ts', 'new.ts:3')],
      exempt: [{ item: 'a.ts', reason: 'bounded by construction' }],
    })).toThrow(/new\.ts:3/);
  });

  it('REJECTS a population below the floor, BEFORE comparing anything', () => {
    // A detector that stopped matching makes every check above vacuous, so this must fire first —
    // and it must fire even though the (empty) ledger is otherwise perfectly consistent.
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('a.ts', 'a.ts:1')],
      exempt: [{ item: 'a.ts', reason: 'bounded by construction' }],
    })).toThrow(/below the floor of 2/);
  });

  it('ACCEPTS a sanctioned item without a reason, and does not count it against anything', () => {
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('impl.ts', 'impl.ts:1'), at('impl.ts', 'impl.ts:2'), at('a.ts', 'a.ts:1')],
      sanctioned: ['impl.ts'],
      exempt: [{ item: 'a.ts', reason: 'bounded by construction' }],
    })).not.toThrow();
  });

  it('REJECTS a sanctioned item the detector no longer finds', () => {
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('a.ts', 'a.ts:1'), at('b.ts', 'b.ts:2')],
      sanctioned: ['moved.ts'],
      exempt: [
        { item: 'a.ts', reason: 'bounded' },
        { item: 'b.ts', reason: 'bounded' },
      ],
    })).toThrow(/moved\.ts/);
  });

  it('REJECTS two rows that JOINTLY over-bless one item — #1123 inside this helper (F1)', () => {
    // ⚠️ The defect this helper exists to kill, found in the helper by review. The over-blessed arm
    // asked `found(e.item) < (e.count ?? 1)` PER ROW while the spend was SUMMED, so one row
    // over-blessing was caught and two rows over-blessing together were not. Budget 4 against 3
    // occurrences left one unit of standing pre-approval, reported by nothing — and the unexcused
    // message itself says "add an `exempt` row", which IS the duplicate-row spelling.
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('x.ts', 'x.ts:1'), at('x.ts', 'x.ts:2'), at('x.ts', 'x.ts:3')],
      exempt: [
        { item: 'x.ts', count: 2, reason: 'two of them, argued here' },
        { item: 'x.ts', count: 2, reason: 'and two more, argued separately' },
      ],
    })).toThrow(/x\.ts — blesses 4, found 3/);
  });

  it('REJECTS a row with count: 0 for an item that is gone (F3)', () => {
    // `found(0) < 0` is false, so the staleness arm had a hole exactly at zero: a permanently dead
    // pardon nothing reports — the same rot `sanctioned`'s own staleness check forbids.
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('a.ts', 'a.ts:1'), at('b.ts', 'b.ts:1')],
      exempt: [
        { item: 'a.ts', reason: 'live' },
        { item: 'b.ts', reason: 'live' },
        { item: 'gone.ts', count: 0, reason: 'blesses nothing, forever, silently' },
      ],
    })).toThrow(/gone\.ts/);
  });

  it('REJECTS a negative count rather than silently truncating the offender list (F3)', () => {
    // `sites.slice(paid)` with a negative `paid` is a NEGATIVE slice: it returns the LAST |count|
    // entries, so three unexcused occurrences reported only the last one. Still red, but a reviewer
    // fixes one site and re-runs to discover two more.
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('x.ts', 'x.ts:1'), at('x.ts', 'x.ts:2'), at('x.ts', 'x.ts:3')],
      exempt: [{ item: 'x.ts', count: -1, reason: 'nonsense' }],
      // ⚠️ Matching the VALIDATION message, not the bare word "count" — the unexcused message also
      // says "raise an existing row's `count`", so /count/ passed against the unfixed helper. A
      // regex loose enough to match the wrong arm is a test that cannot fail for its own reason.
    })).toThrow(/must be a positive integer/);
  });

  it('REJECTS floor: 0 — the one value that reinstates the vacuity the field exists to stop (F4)', () => {
    expect(() => assertExemptionLedger({
      ...ledger,
      floor: 0,
      population: [],
      exempt: [],
    })).toThrow(/floor/);
  });

  it('reports the surplus of the RIGHT item when two items both overflow (F8)', () => {
    // The per-item keying of `budget`, asserted directly. Review found the old spare-budget case
    // proved this only by accident: collapsing `budget` into one shared pool reddened a different
    // test, and only because a site regex happened to miss. Here `a.ts` is fully paid and `b.ts` is
    // not, so a shared pool would spend a.ts's budget on b.ts and report a.ts's site instead.
    let msg = '';
    try {
      assertExemptionLedger({
        ...ledger,
        // ⚠️ ORDER IS LOAD-BEARING: the UNPAID item comes FIRST. `budget` is a Map and the
        // unexcused loop walks it in population order, so if the paid item came first a shared pool
        // would be drained by it and this case would pass on the broken code too — measured, that is
        // exactly what the first version of this case did. With `b.ts` first, a pool spends a.ts's
        // budget on b.ts and BOTH assertions below flip.
        population: [at('b.ts', 'b.ts:9'), at('a.ts', 'a.ts:1'), at('a.ts', 'a.ts:2')],
        exempt: [{ item: 'a.ts', count: 2, reason: 'both argued' }],
      });
    } catch (e) { msg = String(e); }
    expect(msg).toMatch(/b\.ts:9/);
    expect(msg).not.toMatch(/a\.ts:/);
  });

  it('keys on `item`, so a file+token composition pardons ONE token and not its neighbour', () => {
    // Why the design says "compose item as file::token wherever the detector can tell two
    // occurrences apart": a count alone still fails open within a file. #1120 measured exactly
    // this — with `count: 1`, binding the rev-parse while unbinding a different read keeps it at
    // 1 and stays green. Naming the occurrence is what closes it in both directions.
    expect(() => assertExemptionLedger({
      ...ledger,
      // ⚠️ The second token is `show`, NOT the real `ls`-`files` one from #1120, and that is
      // deliberate: a STRING LITERAL is not a comment, so `stripComments` cannot blank it and
      // `corpusProducerIsShared.test.ts` reads the literal as this file spawning git directly.
      // It did exactly that on the first cut — caught by `npm run verify`, not by review, which is
      // the same way gitReadIsBounded learned to split its own `LS_FILES` constant.
      population: [at('f.mjs::rev-parse', 'f.mjs:3'), at('f.mjs::show', 'f.mjs:40')],
      exempt: [{ item: 'f.mjs::rev-parse', reason: 'one path, cannot grow' }],
    })).toThrow(/f\.mjs:40/);
  });

  it("a row's SPARE budget cannot travel to another item — it surfaces as over-blessing", () => {
    // ⚠️ Named for what this actually proves. Budget is a Map keyed by `item`, so one row
    // subsidising another is structurally impossible and has no observable failure of its own —
    // the mutation check confirmed it: breaking the decrement does not redden this, breaking the
    // over-blessed check does. So the property a reader can rely on is that unspent budget is
    // reported as the bookkeeping error it is, and `b.ts:1` is still flagged by the run that
    // follows the fix. Asserting a mechanism that cannot fail separately would be one more test
    // that cannot fail (docs/falsifiable-tests.md).
    expect(() => assertExemptionLedger({
      ...ledger,
      population: [at('a.ts', 'a.ts:1'), at('b.ts', 'b.ts:1')],
      exempt: [{ item: 'a.ts', count: 2, reason: 'spare budget must not travel' }],
    })).toThrow(/blesses 2, found 1/);
  });
});
