/**
 * (#866) A corpus consumer that discards `rel` must pin non-vacuity.
 *
 * `repoFiles()` returns `{ rel, abs }`. `rel` is git's own repo-relative POSIX string and is
 * derivation-free; `abs` is `path.join(gitRoot, rel)`. A guard that keeps `rel` cannot have this
 * bug. A guard that DISCARDS it and rebuilds a comparison key against a second, independently
 * derived root can — and the comparison then fails SILENTLY, so the guard goes green having
 * checked nothing.
 *
 * #799 closed this at the PRODUCER end (`floor` is a required parameter, so an empty enumeration
 * throws) and #814 widened `corpusProducerIsShared` to the whole repo. Neither says anything about
 * what a consumer then DOES with the output, and that is where instance 9 (#847) and all nine of
 * #849's landed.
 *
 * ── Why this shape of guard, and not a scan for the bad pattern ──
 * #866 measured the obvious alternative and it does not work: flagging the rel-discarding map
 * shape (the two spellings `DISCARDS_REL` builds below)
 * outright hits all 32 surviving files, and the natural narrowing — "two root derivations in one
 * file" — matches 24 of those 32. The discriminator does not discriminate, and a 32-entry
 * allowlist is exactly the outcome `posixPathGuard.test.ts`'s own docblock predicts.
 *
 * So this guard does not try to detect the DEFECT. It enforces the cheaper rule that
 * `docs/windows.md` § Paths already prescribes — *"when you write one, pin non-vacuity in the same
 * commit"* — which #866 measured as turning 7 of the 9 known instances from silent into loud. The
 * class still gets WRITTEN; it can no longer hide. That was a deliberate call (owner, 2026-09-07)
 * over the alternative of making `rel` hard to drop at the API, on the grounds that a push to
 * `main` auto-runs the free public CI whose `windows-latest` leg is where this becomes visible —
 * so detection lands within one merge cycle rather than "someone finds it days later".
 *
 * ⚠️ **This file must exclude ITSELF.** It necessarily contains both spellings it searches for, in
 * order to search for them. That is not pedantry: the same self-match made a re-derived census of
 * #866 read 36 sites / 33 files instead of 34 / 32, because `docs/windows.md` quotes both patterns
 * in prose and one line matches BOTH. The exclusion is by `rel`, which is the point of the ticket.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** The two spellings that throw `rel` away. Built rather than written as one literal so this file
 *  does not trip its own search in a way the self-exclusion below would then have to hide. */
const DISCARDS_REL = [
  /\.map\(\(\{ abs \}\) => abs\)/,
  /\.map\(\([A-Za-z_$][A-Za-z0-9_$]*\) => [A-Za-z_$][A-Za-z0-9_$]*\.abs\)/,
];

/** What counts as a non-vacuity pin: an assertion that the set the guard actually SCANS, or the
 *  keys it matches against, is not empty. `floor:` alone does not count when it is zero — that is
 *  the documented "this corpus may legitimately be empty" answer, not a pin. */
const PINS = [
  /toBeGreaterThan\(/,
  /toBeGreaterThanOrEqual\(\s*[1-9]/,
  /not\.toHaveLength\(0\)/,
  /floor:\s*[1-9]/,
];

/** ⚠️ **What this guard proves, and what it does NOT.** `PINS` is tested against the WHOLE FILE,
 *  so it establishes that a non-vacuity assertion EXISTS somewhere in a rel-discarding file — not
 *  that the assertion CONSTRAINS the scan whose `rel` was discarded. Two ways that gap shows up,
 *  both found by the #865/#866 close-out review rather than by this guard:
 *
 *    - the pin measures a DIFFERENT producer (`codeAssetRefs.test.ts` was credited for a
 *      `discoverProjects(...).length` assertion, which says nothing about `repoFiles`);
 *    - the pin is `skipIf`-gated, so it does not execute on the very checkout that matters — a
 *      tree without `games/`, which is the public snapshot and the `windows-latest` CI leg that
 *      `docs/windows.md` § Paths names as the thing that makes a vacuous guard go red.
 *
 *  Closing that properly means recognising which assertion binds which scan, which is the same
 *  recognition problem #866 measured and rejected. This guard is deliberately the cheap half: it
 *  makes an ABSENT pin impossible to land, and leaves a MISDIRECTED pin to review. Do not read a
 *  green run here as 'every corpus scan in the repo is pinned'. */
const SELF = 'engine/tests/architecture/corpusConsumerPins.test.ts';

/** Consumers that discard `rel` but are NOT guards, so a vacuous run is a no-op rather than a
 *  false green. Migration scripts rewrite files; they assert nothing and vouch for nothing.
 *  ⚠️ This list is for NON-GUARDS only. A guard that "does not need a pin" is the exact reasoning
 *  the two silent instances in #849's mutation matrix were written under. */
const NOT_A_GUARD = new Set<string>([
  'engine/scripts/check-prefab-churn.mjs',
  'engine/scripts/migrate-font-family-refs.mjs',
]);

describe('#866 corpus consumers that discard rel pin non-vacuity', () => {
  const candidates = repoFiles({
    // Test ROOTS plus `engine/scripts`, and every `.ts` in them — not just `*.test.ts`. Two of
    // the consumers are plain `.ts` helpers (`moduleGraph.ts`, `rendererConstructionCensus.ts`)
    // that guards import, where a broken derivation is silent in the importer rather than here.
    under: ['engine/tests', 'engine/packages/modoki/tests', 'engine/scripts'],
    match: /.(ts|tsx|mjs)$/,
    floor: 50,
  })
    .filter(({ rel }) => rel !== SELF && !NOT_A_GUARD.has(rel))
    .map((row) => ({ rel: row.rel, src: readFileSync(row.abs, 'utf8') }))
    .filter(({ src }) => DISCARDS_REL.some((re) => re.test(src)));

  it('the scan finds the population it is supposed to guard', () => {
    // Non-vacuity for THIS guard. Without it, a change to `repoFiles`, to the two spellings, or to
    // the match pattern would leave this file asserting an empty list is empty — the very shape it
    // exists to outlaw. #866 measured ~30 such files; a floor well under that catches a collapse
    // without going red every time one is legitimately refactored away.
    expect(
      candidates.length,
      'this guard matched almost no corpus consumers — its own scan is broken, not the repo clean',
    ).toBeGreaterThan(20);
  });

  it('every one of them carries a non-vacuity pin', () => {
    const unpinned = candidates
      .filter(({ src }) => !PINS.some((re) => re.test(src)))
      .map(({ rel }) => rel);
    expect(
      unpinned,
      'These files discard git\'s `rel` and rebuild a comparison key from their own root, but '
      + 'assert nothing about the size of what they scanned — so on Windows, where the two root '
      + 'derivations can disagree (drive-letter case, a `subst`ed or symlinked checkout, an 8.3 '
      + 'short path), they pass having matched NOTHING and report green. Add an assertion that the '
      + 'scanned set — or the allowlist keys it matches against — is non-empty, per '
      + 'docs/windows.md § Paths. If the file is not a guard at all, add it to NOT_A_GUARD with '
      + `a reason.\n${unpinned.join('\n')}`,
    ).toEqual([]);
  });
});
