import { expect } from 'vitest';

/** ⚠️ **An exemption must be keyed at the same grain as the rule it pardons (#1123).**
 *
 *  ⚠️ **It lives in the PACKAGE, not in `engine/tests/helpers/`, and that is load-bearing** — the
 *  same reason `tapTargetFloor.ts` gives. The guards that need it are spread across three test
 *  surfaces: `engine/tests/**`, this package's own `tests/**` (`determinismGuard`,
 *  `inputSourceGuard`, `keymapHmrEpochGuard`), and a PROJECT's own `tests/**`
 *  (`games/court/tests/worldSwap.test.ts`, `games/wordweave/tests/difficulty.test.ts`). A game is
 *  copied out of the monorepo and a demo is published as a standalone snapshot carrying only its
 *  own `tests/`, so `engine/tests/…` is unreachable from either by construction —
 *  `gitReadIsBounded`'s own EXEMPT row records hitting exactly this wall ("Cannot import the engine
 *  helper anyway — #29 / gamePortability.test.ts bars a game reaching into engine/"). Exported as
 *  `@modoki/engine/testing/exemptionLedger`, which is the only specifier all three can name.
 *
 *  Sibling of `engine/tests/helpers/declaredList.ts`'s `assertDeclaredListIsComplete` (#830): that
 *  one asks "does the hand-list cover the population?", this one asks the question one level in —
 *  **how MANY occurrences does one row pardon?** They are different defects and both are live, so
 *  they are separate entry points rather than one flag. `declaredList` stays engine-side because its
 *  population is an engine-wide marker sweep; this one is reached from everywhere.
 *
 *  ## The defect it exists to kill
 *
 *  A guard bans a per-OCCURRENCE pattern — a line, a call, a literal — and keys its pardon by the
 *  FILE. The `reason` then argues about one occurrence while the key covers every occurrence that
 *  file will ever contain, so the guard is blind exactly where somebody already had a reason to
 *  look. Measured across this repo 2026-09-12: **16 guards, 9 of them already holding an exempt
 *  file with more occurrences than its reason argues for.**
 *
 *  The instance that proved it is `gitReadIsBounded.test.ts`, the guard written to stop git reads
 *  running on the default 1 MiB buffer. It exempted `engine/scripts/repoCorpus.mjs` for one
 *  bounded-by-nature `rev-parse --show-toplevel`; that file also holds the two `git ls-files` reads
 *  the entire repo's corpus enumeration runs on, so deleting `maxBuffer` from those left the guard
 *  **GREEN**. A guard against fail-open guards, failing open — and found only because the mutation
 *  check was run, because this defect is invisible to every green run by construction.
 *
 *  ## Why a COUNT and not just a finer key
 *
 *  A bare count was the first fix attempted in #1120 and it is not sufficient ALONE: with
 *  `count: 1`, binding the `rev-parse` while unbinding one `ls-files` keeps the count at 1 and stays
 *  green. What closes it in both directions is a count over a key that NAMES the occurrence — so
 *  compose `item` as `file::token` wherever the detector can tell two occurrences apart, and fall
 *  back to the bare file plus a count only where it genuinely cannot.
 *
 *  ## One ledger per BAN, never one ledger for two
 *
 *  Three of the 16 serve two independent bans from one row, so a reason written about one ban
 *  excuses the other — `commentStripperIsShared` is the sharpest, where the staleness check is
 *  `blockStripper || lineStripper` and dropping one while keeping the other stays green. If a guard
 *  has two rules it gets two ledgers, or the ban goes in the `item`.
 *
 *  ⚠️ **`sanctioned` is not a short exemption.** The one legitimate implementer of a pattern, and a
 *  guard file that must quote what it forbids in order to explain it, are STRUCTURAL — they are not
 *  decisions anybody should re-review, and leaving them as rows dilutes the list a reviewer is
 *  supposed to read. `clientJsonWriteSeam.test.ts` already splits them this way; this generalises
 *  it. They are still staleness-checked: a sanctioned name that matches nothing is a claim with no
 *  subject.
 *
 *  ⚠️ **Mutation-checking THIS file from a git worktree can report a FALSE GREEN.** It is reached
 *  two ways — its own spec imports it by relative path (`./exemptionLedger`), while every engine-side
 *  guard imports the specifier `@modoki/engine/testing/exemptionLedger`. In a worktree,
 *  `node_modules/@modoki/engine` is a symlink back into the PARENT clone, so a mutation here is seen
 *  by the relative-path spec and NOT by the specifier-importing guards: break an arm, run an engine
 *  guard, watch it pass. See `docs/falsifiable-tests.md` § Shape (C1). Mutate from the real clone, or
 *  rebuild the link inside the worktree first.
 *
 *  ⚠️ **Count on the source the DETECTOR sees, not on raw text.** Every guard in this family strips
 *  comments first, and these files' own docblocks quote the pattern being banned — #1123 was filed
 *  with `grep` counts and 7 of its 16 figures were inflated by docblock mentions, one of them by 9x
 *  in the title. `docs/verify-and-ci.md` already warns that "comment-stripping silently changes a
 *  population"; it changes a multiplicity the same way. */
export interface ExemptionLedgerCheck {
  /** What is being guarded, for the failure message. e.g. "ALLOW_WALLCLOCK in determinismGuard". */
  label: string;
  /** **One entry PER OCCURRENCE.** `item` is what an exemption row keys on — compose it as
   *  `file::token` wherever the detector can distinguish two occurrences, else the bare file.
   *  `site` locates it for the failure message (`core/clock.ts:65`) and is never matched on. */
  population: ReadonlyArray<{ item: string; site: string }>;
  /** Pardons, each SPENT rather than matched: `count` (default 1) occurrences of `item` are
   *  excused and the next one is an offender. */
  exempt?: ReadonlyArray<{ item: string; count?: number; reason: string }>;
  /** Structural exclusions — the sanctioned implementation, or the guard quoting its own subject.
   *  Matched against `item`, and staleness-checked like everything else. */
  sanctioned?: readonly string[];
  /** Minimum plausible population size. REQUIRED, for the reason `DeclaredListCheck.floor` is:
   *  a detector that silently stops matching makes every check below vacuous.
   *  ⚠️ Size it against the OSS SNAPSHOT's count where the scan reaches `games/`/`demos/`, not
   *  against this clone's — #1014/#1015, and `gitReadIsBounded` sized one at 1,500 against a
   *  snapshot leg of 1,145. */
  floor: number;
  /** One line telling the reader what to DO about an unexcused occurrence. */
  fix: string;
}

/**
 * Assert that a guard's exemption ledger pardons no more than it says it does.
 *
 * Fails in four independent directions, each with its own message:
 *  1. **vacuous**      — the population is below `floor`; the detector has broken.
 *  2. **unexcused**    — occurrences no row pays for. *This is the defect.*
 *  3. **over-blessed** — a row blesses more occurrences than exist, so a fix was made without
 *                        deducting it. The mirror of (2), and what makes the ledger exact in BOTH
 *                        directions rather than the `>= 1 survives` form #1120 disproved.
 *  4. **stale**        — a `sanctioned` name the detector no longer finds.
 */
export function assertExemptionLedger(check: ExemptionLedgerCheck): void {
  const { label, population, exempt = [], sanctioned = [], floor, fix } = check;

  // ⚠️ **The inputs are validated first, because two values silently DISARM an arm below.** Found by
  // review, not by the gate. `count: 0` made the over-blessed comparison `found(0) < 0` — false — so
  // a permanently dead pardon was the one staleness case nothing reported, which is exactly the rot
  // `sanctioned`'s own check forbids. A NEGATIVE count made `sites.slice(paid)` a negative slice,
  // returning the LAST |count| offenders instead of all of them: still red, but a reviewer fixes one
  // site and re-runs to find two more. And `floor: 0` reinstates the vacuity the field is required
  // for. None of the three is a thing anybody means to write, so they are refused rather than
  // interpreted.
  const badCounts = exempt
    .filter((e) => e.count !== undefined && (!Number.isInteger(e.count) || e.count < 1))
    .map((e) => `${e.item} — count: ${e.count}`)
    .sort();
  expect(
    badCounts,
    `${label}: a row's \`count\` must be a positive integer — it is how many occurrences the row `
    + 'SPENDS. 0 writes a pardon that can never be stale; a negative one truncates the offender '
    + `list. Omit it for 1, or delete the row.\n${badCounts.join('\n')}`,
  ).toEqual([]);

  expect(
    floor,
    `${label}: \`floor\` must be at least 1. It is required so that a detector which silently stops `
    + 'matching cannot green every check below it, and 0 is the one value that gives that back.',
  ).toBeGreaterThanOrEqual(1);

  expect(
    population.length,
    `${label}: the detector found ${population.length} occurrence(s), below the floor of ${floor}. `
    + 'It has stopped matching — every check below would pass having examined nothing, which is '
    + 'exactly the failure this helper exists to prevent.',
  ).toBeGreaterThanOrEqual(floor);

  const occurrences = new Map<string, string[]>();
  for (const { item, site } of population) {
    const sites = occurrences.get(item);
    if (sites) sites.push(site);
    else occurrences.set(item, [site]);
  }
  const found = (item: string): number => occurrences.get(item)?.length ?? 0;

  // (4) first: a stale structural name would otherwise silently absorb a real offender below.
  const staleSanctioned = sanctioned.filter((s) => found(s) === 0).sort();
  expect(
    staleSanctioned,
    `${label}: these are declared SANCTIONED and the detector no longer finds them. Drop them — a `
    + 'structural exclusion that matches nothing is a claim with no subject, and it would silently '
    + `excuse the name if it came back.\n${staleSanctioned.join('\n')}`,
  ).toEqual([]);

  // The budget is built BEFORE the over-blessed arm, because that arm must measure the SUM.
  const budget = new Map<string, number>();
  for (const e of exempt) budget.set(e.item, (budget.get(e.item) ?? 0) + (e.count ?? 1));

  // (3) before (2), so a row whose occurrence was fixed is reported as the bookkeeping error it is
  // rather than as a mysteriously shrinking offender list.
  //
  // ⚠️ **Per ITEM, against the summed budget — NOT per row.** The first cut filtered `exempt`
  // row-by-row, so one row over-blessing was caught and TWO rows jointly over-blessing were not:
  // `[{item:'x',count:2},{item:'x',count:2}]` against three occurrences left one unit of standing
  // pre-approval that nothing reported, and adding a fourth occurrence of `x` was green. That is
  // #1123's own defect, reproduced inside the helper written to kill it — and the unexcused message
  // below invites exactly that spelling by saying "add an `exempt` row". Found by review.
  const overBlessed = [...budget.entries()]
    .filter(([item, paid]) => found(item) < paid)
    .map(([item, paid]) => `${item} — blesses ${paid}, found ${found(item)}`)
    .sort();
  expect(
    overBlessed,
    `${label}: these rows pardon more occurrences than exist. A fix must DEDUCT from its row in the `
    + 'same commit — a row left blessing an occurrence that is gone is a pre-approval for the next '
    + `one somebody writes.\n${overBlessed.join('\n')}`,
  ).toEqual([]);

  const unexcused: string[] = [];
  for (const [item, sites] of occurrences) {
    if (sanctioned.includes(item)) continue;
    const paid = budget.get(item) ?? 0;
    // Report the TAIL, so the sites named are the ones beyond what the row pays for. Which
    // occurrence is "the excused one" is arbitrary when the key is a bare file — naming the
    // surplus is the honest framing either way.
    for (const site of sites.slice(paid)) unexcused.push(site);
  }
  unexcused.sort();
  expect(
    unexcused,
    `${label}: these occurrences are pardoned by nothing.\n\n${fix}\n\n`
    + 'If one genuinely needs excusing, add an `exempt` row — or raise an existing row\'s `count` '
    + 'and say in its reason why the SECOND occurrence is safe too, which is the sentence a '
    + `file-keyed allowlist never made anybody write (#1123).\n\n${unexcused.join('\n')}`,
  ).toEqual([]);
}
