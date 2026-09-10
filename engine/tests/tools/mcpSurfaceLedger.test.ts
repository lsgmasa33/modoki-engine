/** The #894 ledger's pure half — parse, diff, render.
 *
 *  The ledger is DATA, never a verdict: `DEFINITION_BYTES` in `mcpRegistry.test.ts` remains the
 *  only thing that decides red or green. What these tests protect is that the data is not quietly
 *  wrong, because a ledger that is silently incomplete while still looking authoritative is worse
 *  than not having one. The cross-check against the GATE lives beside the gate
 *  (`mcpRegistry.test.ts`, "the ledger prices the surface identically to the gate, tool for tool").
 *  ⚠️ Read that test's own comment for what it does and does not police before citing it: it catches
 *  a divergent enumeration or a divergent pricing FUNCTION, but not a walk that is wrong the same
 *  way on both sides. */

import { describe, it, expect } from 'vitest';
import {
  LEDGER_HEADER, parseLedger, lastKnownSizes, ledgerDelta, renderLedger, assertCsvSafe,
  type LedgerRow,
} from '../../tools/modoki-mcp/surfaceLedger';

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  date: '2026-09-10', clone: 'work-ai3', tool: 'modoki_tap',
  deltaBytes: 0, toolBytesAfter: 100, surfaceBytesAfter: 100, sha: 'abc1234', ...over,
});

describe('MCP surface ledger (#894)', () => {
  it('a clone that changed nothing appends NOTHING', () => {
    // Load-bearing, not an optimisation. `/close-out` runs the writer unconditionally, so a row
    // per run would add ~105 rows a day of noise and destroy the "by days by tool" query the
    // ledger exists to answer.
    //
    // MUTATION CHECK: delete the `if (!seeding && deltaBytes === 0) continue;` guard in
    // `ledgerDelta` and this goes red with 2 rows.
    const rows = ledgerDelta({
      perTool: new Map([['a', 10], ['b', 20]]),
      lastKnown: new Map([['a', 10], ['b', 20]]),
      date: '2026-09-10', clone: 'work-ai3', sha: 'abc1234',
    });
    expect(rows).toEqual([]);
  });

  it('one changed tool produces exactly one row, with the signed delta', () => {
    // MUTATION CHECK: change `toolBytesAfter - (before ?? 0)` to `(before ?? 0) - toolBytesAfter`
    // and this goes red on the sign (+5 becomes -5).
    const rows = ledgerDelta({
      perTool: new Map([['a', 15], ['b', 20]]),
      lastKnown: new Map([['a', 10], ['b', 20]]),
      date: '2026-09-10', clone: 'work-ai3', sha: 'abc1234',
    });
    expect(rows).toEqual([row({ tool: 'a', deltaBytes: 5, toolBytesAfter: 15, surfaceBytesAfter: 35 })]);
  });

  it('a clone\'s FIRST run seeds every tool at delta 0, not at its full size', () => {
    // A baseline is where this clone started observing. Recording it as a delta would put a
    // fictional six-figure spend against whichever clone happened to run first — and that number
    // would then be the headline of every "who spent it" query.
    //
    // MUTATION CHECK: drop the `seeding ? 0 :` branch and this goes red with deltas of 10 and 20.
    const rows = ledgerDelta({
      perTool: new Map([['a', 10], ['b', 20]]),
      lastKnown: new Map(),
      date: '2026-09-10', clone: 'work-ai3', sha: 'abc1234',
    });
    expect(rows.map((r) => [r.tool, r.deltaBytes, r.toolBytesAfter])).toEqual([
      ['a', 0, 10], ['b', 0, 20],
    ]);
  });

  it('a REMOVED tool is recorded at 0 with a negative delta, not dropped', () => {
    // Dropping it would leave its last size standing as this clone's baseline forever, so the
    // surface would look permanently larger than it is and the next real delta would be wrong.
    //
    // MUTATION CHECK: iterate only `perTool.keys()` instead of the union with `lastKnown` and this
    // goes red — the `gone` row disappears.
    const rows = ledgerDelta({
      perTool: new Map([['a', 10]]),
      lastKnown: new Map([['a', 10], ['gone', 40]]),
      date: '2026-09-10', clone: 'work-ai3', sha: 'abc1234',
    });
    expect(rows).toEqual([
      row({ tool: 'gone', deltaBytes: -40, toolBytesAfter: 0, surfaceBytesAfter: 10 }),
    ]);
  });

  it('lastKnownSizes reads the file as an append-only log — the LATER row wins', () => {
    // MUTATION CHECK: make `lastKnownSizes` skip a tool it has already seen (first-wins) and this
    // goes red with 100 instead of 250.
    expect(lastKnownSizes([
      row({ tool: 'a', toolBytesAfter: 100 }),
      row({ tool: 'a', toolBytesAfter: 250 }),
    ])).toEqual(new Map([['a', 250]]));
  });

  it('round-trips: render → parse gives back the same rows', () => {
    const rows = [row({ tool: 'a', deltaBytes: 5 }), row({ tool: 'b', deltaBytes: -3 })];
    expect(parseLedger(renderLedger(rows, { withHeader: true }))).toEqual(rows);
  });

  it('parse tolerates an absent or blank file, and a trailing newline', () => {
    expect(parseLedger('')).toEqual([]);
    expect(parseLedger(`${LEDGER_HEADER}\n`)).toEqual([]);
  });

  it('parse REFUSES a malformed line rather than skipping it', () => {
    // A silently dropped row reads as "this tool never changed", which skews every later delta.
    // MUTATION CHECK: replace the throw with a filter and both of these stop throwing.
    expect(() => parseLedger('date,clone\n1,2')).toThrow(/unexpected ledger header/);
    expect(() => parseLedger(`${LEDGER_HEADER}\n2026-09-10,work-ai3,a,1`))
      .toThrow(/has 4 fields, expected 7/);
  });

  it('a corrupt NUMBER is refused on the way IN — field count is not field type (#894 review)', () => {
    // The hole that shipped in the first version: `parseLedger` checked only that a line had seven
    // fields, so a typo of `691` → `69l` parsed fine and `Number()` handed back `NaN`. That `NaN`
    // became the tool's baseline; every later delta against it is `NaN`, which is never `=== 0`, so
    // the no-op skip never fires and the `NaN` is rewritten on every run — one tool silently
    // under-reported forever, nothing red anywhere.
    //
    // MUTATION CHECK: remove the `Number.isFinite` loop in `parseLedger` and this stops throwing.
    const bad = `${LEDGER_HEADER}\n2026-09-10,work-ai3,modoki_tap,0,69l,691,abc1234`;
    expect(() => parseLedger(bad)).toThrow(/toolBytesAfter is not a decimal integer/);
    // ⚠️ An EMPTY cell is the more plausible corruption of the two, and a `Number.isFinite` check
    // (the first version of this guard) let it through: `Number('') === 0`, finite. The tool's
    // baseline silently became 0 and the next run booked its whole size as a fresh delta against
    // this clone — the mis-attribution the ledger exists to prevent, with no NaN to notice.
    expect(() => parseLedger(`${LEDGER_HEADER}\n2026-09-10,work-ai3,modoki_tap,0,,691,abc1234`))
      .toThrow(/toolBytesAfter is not a decimal integer/);
    // Hex too — `Number('0x2b3')` is 691, a number the writer never emits.
    expect(() => parseLedger(`${LEDGER_HEADER}\n2026-09-10,work-ai3,modoki_tap,0,0x2b3,691,abc1234`))
      .toThrow(/toolBytesAfter is not a decimal integer/);
    // and the well-formed twin still parses, negatives included, so the guard is not just
    // rejecting everything
    expect(parseLedger(`${LEDGER_HEADER}\n2026-09-10,work-ai3,modoki_tap,-40,691,691,abc1234`))
      .toHaveLength(1);
  });

  it('a non-finite number is refused on the way OUT too (#894 review)', () => {
    // Both directions, because `NaN` stringifies into a perfectly well-formed CSV field and would
    // otherwise be committed by a writer that never round-tripped it through `parseLedger`.
    // MUTATION CHECK: drop the `Number.isFinite` branch in `assertCsvSafe` and this stops throwing.
    expect(() => assertCsvSafe(row({ deltaBytes: NaN }))).toThrow(/not a finite number/);
    expect(() => assertCsvSafe(row({ surfaceBytesAfter: Infinity }))).toThrow(/not a finite number/);
  });

  it('a UTF-8 BOM does not break the header check (#894 review)', () => {
    // Plausible on the `win` clone after a hand-edit: a BOM would make `lines[0] !== LEDGER_HEADER`
    // on an otherwise valid file and throw on every run from then on.
    // MUTATION CHECK: remove the `replace(/^\uFEFF/, '')` and this throws "unexpected ledger header".
    expect(parseLedger(`\uFEFF${LEDGER_HEADER}\n2026-09-10,work-ai3,a,0,10,10,abc1234`))
      .toHaveLength(1);
  });

  it('a field that would need CSV quoting is REFUSED, not quoted', () => {
    // Every field is a tool name, branch, date or sha — none can legally contain a comma, so one
    // that does means the caller is wrong. Quoting it would hide that and corrupt later parses.
    // MUTATION CHECK: weaken the regex to `/\n/` and the comma case stops throwing.
    expect(() => assertCsvSafe(row({ tool: 'modoki_tap,evil' }))).toThrow(/not CSV-safe/);
    expect(() => assertCsvSafe(row({ clone: 'feature/x' }))).not.toThrow();
  });

  it('renderLedger omits the header when appending, and emits nothing to APPEND for no rows', () => {
    // A header-only file is a legitimate empty ledger (`parseLedger` reads it as zero rows), so
    // seeding with no rows still writes the header. Appending nothing must write nothing at all —
    // returning a bare "\n" there would corrupt the file with a blank line on every quiet run.
    expect(renderLedger([row()], { withHeader: false }).startsWith('2026-09-10,')).toBe(true);
    expect(renderLedger([], { withHeader: false })).toBe('');
    expect(renderLedger([], { withHeader: true })).toBe(`${LEDGER_HEADER}\n`);
  });
});
