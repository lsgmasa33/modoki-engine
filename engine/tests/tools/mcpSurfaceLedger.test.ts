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
  LEDGER_HEADER, parseLedger, lastKnownSizes, corpusBaseline, ledgerDelta, renderLedger,
  appendChunk, assertCsvSafe, ledgerSkipReason, type LedgerRow,
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
    // ⚠️ Accept side, BOTH shapes. A legitimate zero delta is the common row and a negative is the
    // removed-tool row; the first version of this test replaced the `0` case with the `-40` one
    // instead of adding it, leaving the accept side narrower than the comment implied.
    expect(parseLedger(`${LEDGER_HEADER}\n2026-09-10,work-ai3,modoki_tap,0,691,691,abc1234`)[0]
      .deltaBytes).toBe(0);
    expect(parseLedger(`${LEDGER_HEADER}\n2026-09-10,work-ai3,modoki_tap,-40,691,691,abc1234`)[0]
      .deltaBytes).toBe(-40);
  });

  it('a non-finite number is refused on the way OUT too (#894 review)', () => {
    // Both directions, because `NaN` stringifies into a perfectly well-formed CSV field and would
    // otherwise be committed by a writer that never round-tripped it through `parseLedger`.
    // MUTATION CHECK: drop the `Number.isFinite` branch in `assertCsvSafe` and this stops throwing.
    expect(() => assertCsvSafe(row({ deltaBytes: NaN }))).toThrow(/not an integer/);
    expect(() => assertCsvSafe(row({ surfaceBytesAfter: Infinity }))).toThrow(/not an integer/);
    // ⚠️ And a NON-INTEGER, so the writer cannot emit something `parseLedger` refuses to read back.
    // `Number.isFinite` accepted 1.5 while the reader requires `/^-?\d+$/` — a file this module
    // produced and could not parse, throwing on every later run. Flagged as a latent asymmetry in
    // review; pinned rather than left, because it is invisible until it fires.
    // MUTATION CHECK: revert `Number.isInteger` to `Number.isFinite` and this line goes red while
    // the NaN/Infinity lines above stay green — which is exactly why they did not cover it.
    expect(() => assertCsvSafe(row({ deltaBytes: 1.5 }))).toThrow(/not an integer/);
    // a legitimate integer row still passes, so the guard is not simply rejecting everything
    expect(() => assertCsvSafe(row({ deltaBytes: -40, toolBytesAfter: 0 }))).not.toThrow();
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

  it('INTEGRATION branches keep no ledger — main and release_* alike (#894 review)', () => {
    // This decision is unreachable from any clone that could exercise it in the script: a worker
    // cannot be on `main`, and its only lever (MODOKI_LEDGER_CLONE) DISABLES the check. So a typo
    // like 'Main' would be invisible to verify, to CI and to every worker, and would first execute
    // on the hub — once — seeding the very file it exists to prevent. Hence a pure function.
    //
    // ⚠️ `release_*` is here because the first version of the guard argued it was a WORKER concern
    // and could be left alone. CLAUDE.md § Dev Workflow says the opposite in as many words: the HUB
    // cuts the release branch and merges it back. It is the hub under another name.
    //
    // MUTATION CHECK: drop the `release[_-]` branch → the release cases go red; drop the
    // `main` branch → the main case goes red; each 1 of 15, nothing else.
    expect(ledgerSkipReason('main')).toMatch(/integration branch/);
    expect(ledgerSkipReason('release_0_7_0')).toMatch(/release branch/);
    expect(ledgerSkipReason('release-0-7-0')).toMatch(/release branch/);
    // workers keep theirs
    for (const worker of ['work-ai', 'work-ai2', 'work-ai3', 'work-qa', 'win']) {
      expect(ledgerSkipReason(worker), worker).toBeUndefined();
    }
    // a branch merely CONTAINING the word is not an integration branch
    expect(ledgerSkipReason('fix-main-thread-stall')).toBeUndefined();
    expect(ledgerSkipReason('prerelease')).toBeUndefined();
    // the override wins everywhere, which is what makes this a default rather than a prohibition
    expect(ledgerSkipReason('main', { MODOKI_LEDGER_CLONE: 'main' })).toBeUndefined();
  });

  it('appendChunk heals a missing trailing newline, so two rows cannot fuse (#894 review)', () => {
    // The un-killed residual from the second review, fixed rather than documented once the damage
    // was measured: appending onto a file whose last line lost its newline concatenates the two
    // rows into ONE 13-field line, which destroys the EARLIER row as well as the new one, and
    // `parseLedger` then throws on every later run until somebody repairs the file by hand. Loud,
    // but not local, and not recoverable from the ledger itself.
    //
    // MUTATION CHECK: drop the `existing.endsWith('\n')` branch and this test goes red — and the
    // round-trip assertion below is what makes it red for the RIGHT reason (a 13-field line),
    // rather than merely on a string mismatch.
    const bare = `${LEDGER_HEADER}\n2026-09-10,work-ai3,a,0,10,10,abc1234`;   // no trailing \n
    const added = [row({ tool: 'b', deltaBytes: 5, toolBytesAfter: 20, surfaceBytesAfter: 30 })];
    const healed = bare + appendChunk(bare, added);
    expect(parseLedger(healed)).toHaveLength(2);
    expect(parseLedger(healed)[0].tool).toBe('a');

    // and a well-formed file is NOT given a spurious blank line
    const ok = `${LEDGER_HEADER}\n2026-09-10,work-ai3,a,0,10,10,abc1234\n`;
    expect(parseLedger(ok + appendChunk(ok, added))).toHaveLength(2);
    expect(appendChunk(ok, added).startsWith('\n')).toBe(false);

    // nothing to append stays nothing, on either shape
    expect(appendChunk(bare, [])).toBe('');
    expect(appendChunk('', added)).toBe(renderLedger(added, { withHeader: false }));
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

describe('the baseline is the CORPUS, so a merge books nothing (#1103)', () => {
  /** The numbers here are the REAL ones from the committed corpus on 2026-09-12, because the bug
   *  was found there and a synthetic pair would not show that the same bytes were booked three
   *  times: `work-ai3` authored `modoki_press_key`'s +361 at `0d034e370` (2473 -> 2834), and
   *  `work-ai2` and `work-qa` each booked the identical 361 after merely merging it. */
  const PRESS_BEFORE = 2473;
  const PRESS_AFTER = 2834;

  /** Rank 0 is HEAD, larger is older — the shape `gen-surface-ledger.ts` builds from `git rev-list`. */
  const order = (pairs: Record<string, number>) => new Map(Object.entries(pairs));

  it('does NOT re-book a tool whose change arrived by merge', () => {
    // work-qa's own file stops at the pre-change size; work-ai3's row (newer commit) carries the
    // change, and arrived in work-qa's tree with the merge.
    const rows = [
      row({ clone: 'work-qa', tool: 'modoki_press_key', toolBytesAfter: PRESS_BEFORE, sha: 'old11111' }),
      row({ clone: 'work-ai3', tool: 'modoki_press_key', toolBytesAfter: PRESS_AFTER, sha: 'new22222' }),
    ];
    const lastKnown = corpusBaseline({
      rows, order: order({ old11111: 9, new22222: 3 }), fallbackClone: 'work-qa',
    });
    expect(lastKnown.get('modoki_press_key')).toBe(PRESS_AFTER);

    const added = ledgerDelta({
      perTool: new Map([['modoki_press_key', PRESS_AFTER]]),
      lastKnown, date: '2026-09-12', clone: 'work-qa', sha: 'merge333',
    });
    expect(added).toEqual([]); // the pre-#1103 answer was one row booking +361 against work-qa
  });

  it('books only what THIS clone added on top of what it inherited', () => {
    const rows = [
      row({ clone: 'work-qa', tool: 'modoki_press_key', toolBytesAfter: PRESS_BEFORE, sha: 'old11111' }),
      row({ clone: 'work-ai3', tool: 'modoki_press_key', toolBytesAfter: PRESS_AFTER, sha: 'new22222' }),
    ];
    const lastKnown = corpusBaseline({
      rows, order: order({ old11111: 9, new22222: 3 }), fallbackClone: 'work-qa',
    });
    const added = ledgerDelta({
      perTool: new Map([['modoki_press_key', 3170]]),
      lastKnown, date: '2026-09-12', clone: 'work-qa', sha: 'mine4444',
    });
    // 3170 - 2834 (inherited), NOT 3170 - 2473 (this clone's own last row).
    expect(added).toHaveLength(1);
    expect(added[0].deltaBytes).toBe(336);
  });

  it('orders by ANCESTRY, not by position in the file', () => {
    // The NEWER commit is listed FIRST, so a "later row wins" reader picks the stale 2473.
    const rows = [
      row({ clone: 'work-ai3', tool: 'modoki_press_key', toolBytesAfter: PRESS_AFTER, sha: 'newaaaa' }),
      row({ clone: 'work-ai2', tool: 'modoki_press_key', toolBytesAfter: PRESS_BEFORE, sha: 'oldbbbb' }),
    ];
    const lastKnown = corpusBaseline({
      rows, order: order({ newaaaa: 2, oldbbbb: 40 }), fallbackClone: 'work-ai2',
    });
    expect(lastKnown.get('modoki_press_key')).toBe(PRESS_AFTER);
  });

  it('ignores a row whose commit is NOT in this tree — it describes a tree we do not have', () => {
    const rows = [
      row({ clone: 'work-qa', tool: 'modoki_press_key', toolBytesAfter: PRESS_BEFORE, sha: 'inhist1' }),
      row({ clone: 'win', tool: 'modoki_press_key', toolBytesAfter: 99999, sha: 'unmerged' }),
    ];
    const lastKnown = corpusBaseline({
      rows, order: order({ inhist1: 5 }), fallbackClone: 'work-qa',   // 'unmerged' unranked
    });
    expect(lastKnown.get('modoki_press_key')).toBe(PRESS_BEFORE);
  });

  it('falls back to this clone\'s own file, in file order, when git could not be asked', () => {
    // ⚠️ An EMPTY order means "could not rank anything", not "nothing is an ancestor". Treating it
    // as the latter would leave the baseline empty, which reads as a clean tree — and the run would
    // book the entire surface against whoever hit the git failure.
    const rows = [
      row({ clone: 'work-qa', tool: 'modoki_press_key', toolBytesAfter: PRESS_BEFORE, sha: 'a' }),
      row({ clone: 'work-ai3', tool: 'modoki_press_key', toolBytesAfter: PRESS_AFTER, sha: 'b' }),
    ];
    const lastKnown = corpusBaseline({ rows, order: new Map(), fallbackClone: 'work-qa' });
    expect(lastKnown.get('modoki_press_key')).toBe(PRESS_BEFORE); // work-qa's own row, not the corpus
  });

  it('seeds only on a genuinely EMPTY corpus, not on a fresh clone joining an established one', () => {
    const established = [
      row({ clone: 'work-ai3', tool: 'modoki_press_key', toolBytesAfter: PRESS_AFTER, sha: 'seen111' }),
    ];
    const inherited = corpusBaseline({
      rows: established, order: order({ seen111: 1 }), fallbackClone: 'work-ai',
    });
    expect(inherited.size).toBe(1); // a brand-new clone still has a baseline…

    const added = ledgerDelta({
      perTool: new Map([['modoki_press_key', 3170]]),
      lastKnown: inherited, date: '2026-09-12', clone: 'work-ai', sha: 'fresh22',
      seeding: inherited.size === 0,
    });
    // …so its first run books its real 336, not a fictional 3170-byte "first observation".
    expect(added).toHaveLength(1);
    expect(added[0].deltaBytes).toBe(336);

    const empty = corpusBaseline({ rows: [], order: new Map(), fallbackClone: 'work-ai' });
    expect(empty.size).toBe(0); // and a truly empty corpus still seeds
  });
});
