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
  LEDGER_HEADER, parseLedger, lastKnownSizes, buildAncestry, corpusBaseline, ledgerDelta,
  renderLedger, appendChunk, assertCsvSafe, ledgerSkipReason,
  type LedgerRow, type BaselineAmbiguity,
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

describe('the baseline is the CORPUS, ordered by ANCESTRY (#1103, corrected by #1114)', () => {
  /** Real numbers from the committed corpus on 2026-09-12, because the bug was found there and a
   *  synthetic pair would not show that the same bytes were booked three times: `work-ai3` authored
   *  `modoki_press_key`'s +361 at `0d034e370` (2473 -> 2834), and `work-ai2` and `work-qa` each
   *  booked the identical 361 after merely merging it. */
  const PRESS_BEFORE = 2473;
  const PRESS_AFTER = 2834;
  const TOOL = 'modoki_press_key';

  /** `git rev-list --topo-order --parents` text for a hand-written DAG, children first: each entry
   *  is `[commit, ...parents]`. ⚠️ Everything in this block runs off text like this and never
   *  touches a git repo — that IS #1114's second half. #1103 put this predicate in
   *  `gen-surface-ledger.ts`, the thin shell with no tests, where nothing could drive it. */
  const dag = (...entries: string[][]) => entries.map((e) => e.join(' ')).join('\n');
  const anc = (revListParents: string, ...shas: string[]) =>
    buildAncestry({ revListParents, shas });

  /** 100 -> 200 -> 150, newest first. Every pair is comparable, so the tie-break never runs. */
  const LINEAR = dag(['ccccc33', 'ccccc22'], ['ccccc22', 'ccccc11'], ['ccccc11']);

  /** One merge over two divergent tips. `TIP_RECENT` is the tip a DATE order ranks first — #1103's
   *  `rev-list` position — and `TIP_OLDER` the other. Neither descends from the other, and a merge
   *  never makes them comparable, so this ambiguity is permanent. */
  const TIP_RECENT = 'recent1';
  const TIP_OLDER = 'older11';
  const DIVERGENT = dag(
    ['merge11', TIP_RECENT, TIP_OLDER],
    [TIP_RECENT, 'base111'],
    [TIP_OLDER, 'base111'],
    ['base111'],
  );

  it('buildAncestry reads the DAG from TEXT alone — no git, no repo (#1114)', () => {
    const a = anc(LINEAR, 'ccccc11', 'ccccc22', 'ccccc33');
    expect(a.size).toBe(3);
    expect(a.isAncestor('ccccc11', 'ccccc33')).toBe(true);    // older is an ancestor of newer
    expect(a.isAncestor('ccccc33', 'ccccc11')).toBe(false);   // and not the other way round
    expect(a.isAncestor('ccccc22', 'ccccc22')).toBe(true);    // reflexive
  });

  it('two divergent tips are incomparable — FALSE in both directions, permanently', () => {
    // MUTATION CHECK: make `isAncestor` return true unconditionally -> red here.
    //
    // ⚠️ This is why "refuse to choose when incomparable" is not an available answer, and why the
    // issue's scope question rested on a premise that does not hold: #1103's own headline case has
    // exactly this shape, so a design that bails here bails on it, forever.
    const a = anc(DIVERGENT, TIP_RECENT, TIP_OLDER);
    expect(a.isAncestor(TIP_RECENT, TIP_OLDER)).toBe(false);
    expect(a.isAncestor(TIP_OLDER, TIP_RECENT)).toBe(false);
  });

  it('a LINEAR history takes the latest ancestor, even when an older row is NEARER the current size', () => {
    // 100 -> 200 -> 150, measuring 190 now. Nearest-to-current alone picks 200; the answer is 150,
    // because 150 is simply the latest observation and nothing here is ambiguous.
    //
    // MUTATION CHECK: delete the maxima filter, keeping only the nearest-to-current sort -> red
    // (picks 200). This is the test that proves the ancestry half is not decorative.
    const rows = [
      row({ tool: TOOL, toolBytesAfter: 100, sha: 'ccccc11' }),
      row({ tool: TOOL, toolBytesAfter: 200, sha: 'ccccc22' }),
      row({ tool: TOOL, toolBytesAfter: 150, sha: 'ccccc33' }),
    ];
    const lastKnown = corpusBaseline({
      rows,
      ancestry: anc(LINEAR, 'ccccc11', 'ccccc22', 'ccccc33'),
      current: new Map([[TOOL, 190]]),
      fallbackClone: 'work-qa',
    });
    expect(lastKnown.get(TOOL)).toBe(150);
  });

  it("#1103's case: a change that arrived by MERGE is not re-booked", () => {
    // work-qa's own file stops at the pre-change size; work-ai3's row carries the change and
    // arrived in work-qa's tree with the merge. The correct row is ALSO the later-dated one here,
    // which is exactly why #1103's date ordering worked on this case and was never caught.
    //
    // MUTATION CHECK: swap the tie-break to "later committer date" (i.e. prefer TIP_RECENT) ->
    // STAYS GREEN. Paired with the hazard test below — same mutation, goes RED — that is the pair
    // that tells the two cases apart. Neither test alone can.
    const rows = [
      row({ clone: 'work-ai3', tool: TOOL, toolBytesAfter: PRESS_AFTER, sha: TIP_RECENT }),
      row({ clone: 'work-qa', tool: TOOL, toolBytesAfter: PRESS_BEFORE, sha: TIP_OLDER }),
    ];
    const lastKnown = corpusBaseline({
      rows,
      ancestry: anc(DIVERGENT, TIP_RECENT, TIP_OLDER),
      current: new Map([[TOOL, PRESS_AFTER]]),
      fallbackClone: 'work-qa',
    });
    expect(lastKnown.get(TOOL)).toBe(PRESS_AFTER);

    const added = ledgerDelta({
      perTool: new Map([[TOOL, PRESS_AFTER]]),
      lastKnown, date: '2026-09-12', clone: 'work-qa', sha: 'merge11',
    });
    expect(added).toEqual([]);   // the pre-#1103 answer was one row booking +361 against work-qa
  });

  it("#1114's hazard: the later-DATED row is the STALE one, and date ordering inverts it", () => {
    // `win` seeds a row at a later-dated commit that predates work-ai's change, on a divergent
    // branch. Rank-by-date reverts the baseline BELOW what was already recorded, so the next run
    // books the same bytes a second time — the exact double-count #1103 removed.
    //
    // MUTATION CHECK: swap the tie-break to "later committer date" -> RED (picks 100).
    const rows = [
      row({ clone: 'win', tool: TOOL, toolBytesAfter: 100, sha: TIP_RECENT }),
      row({ clone: 'work-ai', tool: TOOL, toolBytesAfter: 461, sha: TIP_OLDER }),
    ];
    const lastKnown = corpusBaseline({
      rows,
      ancestry: anc(DIVERGENT, TIP_RECENT, TIP_OLDER),
      current: new Map([[TOOL, 461]]),
      fallbackClone: 'work-ai',
    });
    expect(lastKnown.get(TOOL)).toBe(461);

    const added = ledgerDelta({
      perTool: new Map([[TOOL, 461]]),
      lastKnown, date: '2026-09-12', clone: 'work-ai', sha: 'merge11',
    });
    expect(added).toEqual([]);   // rank-by-date would have booked +361 against work-ai again
  });

  it('resolves the SHRINK direction too — a larger stale candidate does not win', () => {
    // MUTATION CHECK: change the tie-break to "always take the larger recorded size" -> red.
    const rows = [
      row({ clone: 'win', tool: TOOL, toolBytesAfter: 461, sha: TIP_RECENT }),     // stale
      row({ clone: 'work-ai', tool: TOOL, toolBytesAfter: 100, sha: TIP_OLDER }),  // merged in
    ];
    const lastKnown = corpusBaseline({
      rows,
      ancestry: anc(DIVERGENT, TIP_RECENT, TIP_OLDER),
      current: new Map([[TOOL, 100]]),
      fallbackClone: 'work-ai',
    });
    expect(lastKnown.get(TOOL)).toBe(100);
  });

  it('an equidistant tie is deterministic, books the SMALLER delta, and WARNS', () => {
    // Owner, 2026-09-12: the residual arbitrary choice errs toward UNDER-booking. The CSV is
    // automated and never hand-corrected, so the error is permanent either way, and a permanent
    // over-bill is the exact defect #1103 removed.
    //
    // MUTATION CHECK: drop the `onAmbiguity?.(...)` call -> red on `seen`. Flip the byte
    // comparator to ascending -> red on the 300.
    const seen: BaselineAmbiguity[] = [];
    const rows = [
      row({ clone: 'win', tool: TOOL, toolBytesAfter: 100, sha: TIP_RECENT }),
      row({ clone: 'work-ai', tool: TOOL, toolBytesAfter: 300, sha: TIP_OLDER }),
    ];
    const lastKnown = corpusBaseline({
      rows,
      ancestry: anc(DIVERGENT, TIP_RECENT, TIP_OLDER),
      current: new Map([[TOOL, 200]]),   // exactly 100 from each candidate
      fallbackClone: 'work-ai',
      onAmbiguity: (a) => seen.push(a),
    });
    expect(lastKnown.get(TOOL)).toBe(300);
    expect(seen).toHaveLength(1);
    expect(seen[0].tool).toBe(TOOL);
    expect(seen[0].chosen).toBe(300);
    expect(seen[0].current).toBe(200);
    expect(seen[0].candidates.map((c) => c.bytes).sort((x, y) => x - y)).toEqual([100, 300]);
  });

  it('a SETTLED baseline does not warn — the ambiguity line has to mean something', () => {
    // ⚠️ Non-vacuity for the test above: without this, "it warns" passes just as well on an
    // implementation that warns on every tool, and the close-out log would be noise nobody reads.
    //
    // MUTATION CHECK: fire `onAmbiguity` unconditionally -> red.
    const seen: BaselineAmbiguity[] = [];
    corpusBaseline({
      rows: [row({ tool: TOOL, toolBytesAfter: 150, sha: 'ccccc33' })],
      ancestry: anc(LINEAR, 'ccccc33'),
      current: new Map([[TOOL, 150]]),
      fallbackClone: 'work-qa',
      onAmbiguity: (a) => seen.push(a),
    });
    expect(seen).toEqual([]);
  });

  it('two SPELLINGS of one commit do not annihilate each other (they are not strict descendants)', () => {
    // ⚠️ Found by review, not by the gate. Abbreviation length is not fixed — `rev-parse --short`
    // picks it from the LOCAL object count — so two clones can spell one commit 9 and 10 chars.
    // Those are different `sha` STRINGS resolving to one commit, so each is an ancestor of the
    // other. The maxima filter eliminated `r` whenever any `o` with a different STRING was an
    // ancestor of it, so both rows eliminated each other, `maxima` came out EMPTY, and
    // `ranked[0].toolBytesAfter` threw a TypeError — an uncaught crash in /close-out § 6, in the
    // one sub-case the code's own comment claimed to handle.
    //
    // MUTATION CHECK: restore the filter to `o.sha !== r.sha && ancestry.isAncestor(r.sha, o.sha)`
    // (i.e. drop the strictness) -> red with that TypeError.
    const FULL = 'abc1234def5678';
    const ancestry = buildAncestry({
      revListParents: dag([FULL, 'base111'], ['base111']),
      shas: ['abc1234', 'abc1234d'],
    });
    expect(ancestry.isAncestor('abc1234', 'abc1234d')).toBe(true);   // both directions, because
    expect(ancestry.isAncestor('abc1234d', 'abc1234')).toBe(true);   // they are the same commit

    const rows = [
      row({ clone: 'work-ai', tool: TOOL, toolBytesAfter: 500, sha: 'abc1234' }),
      row({ clone: 'work-qa', tool: TOOL, toolBytesAfter: 500, sha: 'abc1234d' }),
    ];
    const lastKnown = corpusBaseline({
      rows, ancestry, current: new Map([[TOOL, 500]]), fallbackClone: 'work-ai',
    });
    expect(lastKnown.get(TOOL)).toBe(500);   // agreed measurement, no crash, no ambiguity
  });

  it('two spellings of one commit that DISAGREE are settled, not crashed', () => {
    // The same shape where the bytes differ — reachable only via a hand-edit or a
    // non-deterministic measurement, but it must resolve rather than throw.
    const FULL = 'abc1234def5678';
    const seen: BaselineAmbiguity[] = [];
    const rows = [
      row({ clone: 'work-ai', tool: TOOL, toolBytesAfter: 500, sha: 'abc1234' }),
      row({ clone: 'work-qa', tool: TOOL, toolBytesAfter: 600, sha: 'abc1234d' }),
    ];
    const lastKnown = corpusBaseline({
      rows,
      ancestry: buildAncestry({
        revListParents: dag([FULL, 'base111'], ['base111']),
        shas: ['abc1234', 'abc1234d'],
      }),
      current: new Map([[TOOL, 600]]),
      fallbackClone: 'work-ai',
      onAmbiguity: (a) => seen.push(a),
    });
    expect(lastKnown.get(TOOL)).toBe(600);   // nearest to the current measurement
    expect(seen).toHaveLength(1);
  });

  it('resolves an ABBREVIATED sha by prefix, and reads a too-short one as UNKNOWN', () => {
    // Abbreviation length is not fixed — git widens it as a repo grows — so full shas are indexed
    // on 7 chars and prefix-matched. A sha too short to disambiguate must read as unknown, never as
    // a match: a relation that silently resolves nothing is indistinguishable from a clean tree,
    // and the run would book the entire ~150 KB surface against whoever hit it.
    const FULL = '1234567abcdef';
    const a = buildAncestry({
      revListParents: dag([FULL, 'base111'], ['base111']),
      shas: [FULL.slice(0, 7), FULL.slice(0, 6)],
    });
    expect(a.has('1234567')).toBe(true);
    expect(a.has('123456')).toBe(false);
    expect(a.isAncestor('1234567', '1234567')).toBe(true);
  });

  it('books only what THIS clone added on top of what it inherited', () => {
    const rows = [
      row({ clone: 'work-qa', tool: TOOL, toolBytesAfter: PRESS_BEFORE, sha: TIP_OLDER }),
      row({ clone: 'work-ai3', tool: TOOL, toolBytesAfter: PRESS_AFTER, sha: TIP_RECENT }),
    ];
    const lastKnown = corpusBaseline({
      rows,
      ancestry: anc(DIVERGENT, TIP_RECENT, TIP_OLDER),
      current: new Map([[TOOL, 3170]]),
      fallbackClone: 'work-qa',
    });
    const added = ledgerDelta({
      perTool: new Map([[TOOL, 3170]]),
      lastKnown, date: '2026-09-12', clone: 'work-qa', sha: 'mine444',
    });
    // 3170 - 2834 (inherited), NOT 3170 - 2473 (this clone's own last row).
    expect(added).toHaveLength(1);
    expect(added[0].deltaBytes).toBe(336);
  });

  it('ignores a row whose commit is NOT in this tree — it describes a tree we do not have', () => {
    const rows = [
      row({ clone: 'work-qa', tool: TOOL, toolBytesAfter: PRESS_BEFORE, sha: TIP_OLDER }),
      row({ clone: 'win', tool: TOOL, toolBytesAfter: 99999, sha: 'unmerg1' }),
    ];
    const lastKnown = corpusBaseline({
      rows,
      ancestry: anc(DIVERGENT, TIP_OLDER, 'unmerg1'),   // 'unmerg1' appears in no DAG line
      current: new Map([[TOOL, PRESS_BEFORE]]),
      fallbackClone: 'work-qa',
    });
    expect(lastKnown.get(TOOL)).toBe(PRESS_BEFORE);
  });

  it("falls back to this clone's own file, in file order, when git could not be asked", () => {
    // ⚠️ An EMPTY relation means "could not resolve anything", not "nothing is an ancestor".
    // Treating it as the latter would leave the baseline empty, which reads as a clean tree — and
    // the run would book the entire surface against whoever hit the git failure.
    const rows = [
      row({ clone: 'work-qa', tool: TOOL, toolBytesAfter: PRESS_BEFORE, sha: 'aaaaaa1' }),
      row({ clone: 'work-ai3', tool: TOOL, toolBytesAfter: PRESS_AFTER, sha: 'bbbbbb1' }),
    ];
    const lastKnown = corpusBaseline({
      rows,
      ancestry: buildAncestry({ revListParents: '', shas: [] }),
      current: new Map([[TOOL, PRESS_AFTER]]),
      fallbackClone: 'work-qa',
    });
    expect(lastKnown.get(TOOL)).toBe(PRESS_BEFORE);   // work-qa's own row, not the corpus
  });

  it('seeds only on a genuinely EMPTY corpus, not on a fresh clone joining an established one', () => {
    const established = [
      row({ clone: 'work-ai3', tool: TOOL, toolBytesAfter: PRESS_AFTER, sha: 'ccccc33' }),
    ];
    const inherited = corpusBaseline({
      rows: established,
      ancestry: anc(LINEAR, 'ccccc33'),
      current: new Map([[TOOL, 3170]]),
      fallbackClone: 'work-ai',
    });
    expect(inherited.size).toBe(1);   // a brand-new clone still has a baseline…

    const added = ledgerDelta({
      perTool: new Map([[TOOL, 3170]]),
      lastKnown: inherited, date: '2026-09-12', clone: 'work-ai', sha: 'fresh22',
      seeding: inherited.size === 0,
    });
    // …so its first run books its real 336, not a fictional 3170-byte "first observation".
    expect(added).toHaveLength(1);
    expect(added[0].deltaBytes).toBe(336);

    const empty = corpusBaseline({
      rows: [],
      ancestry: buildAncestry({ revListParents: '', shas: [] }),
      current: new Map(),
      fallbackClone: 'work-ai',
    });
    expect(empty.size).toBe(0);   // and a truly empty corpus still seeds
  });
});
