/**
 * ONE definition of "does this checkout have projects?" — no test may compute it inline.
 *
 * Why this guard exists, concretely. The question has two answers that differ in exactly one
 * case, and that case is the CI snapshot:
 *
 *   hasInternalGames()  → is `games/` present?          (snapshot: FALSE — it ships no games)
 *   hasAnyProject()     → is ANY project present?       (snapshot: TRUE  — it ships two demos)
 *
 * Every dev clone has BOTH, so locally the two are indistinguishable and a wrong choice is
 * invisible. Only the public gate can tell them apart — which is why this went wrong three
 * times in one session (2026-08-02): `assetRefIntegrity`'s original `hasGames` guard went TRUE
 * once demos shipped, so its test RAN and failed instead of skipping; the first shared helper
 * repeated the flaw under the name `hasRealProjects`; and a subagent then propagated it to four
 * more files. Each time the symptom was a green local run and a red public one.
 *
 * A comment saying "use the helper" cannot stop the fourth variant. This can.
 *
 * If you are here because this test failed: you added an inline project-presence check. Decide
 * which question you are ACTUALLY asking — do you need internal game content (a baseline, an
 * allowlist, a specific game's asset), or merely something to scan? — and import the matching
 * predicate from `engine/tests/helpers/repoLayout.ts`. Do not add a third.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repoLayout';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** Every test root in the repo, not the two somebody listed (#830). The claim this guard makes is
 *  universal — "**no test** may compute it inline" — and `games/<id>/tests/` and `demos/<id>/tests/`
 *  are test roots the sibling guards (`commentStripperIsShared`, `testFilesAreCollected`) both
 *  enumerate. No offender lives there today, so this widening is latent-by-measurement rather than
 *  a fix; the point is that the scope now matches the sentence. */
const TEST_DIRS = [
  path.join(REPO_ROOT, 'engine', 'tests'),
  path.join(REPO_ROOT, 'engine', 'packages', 'modoki', 'tests'),
  path.join(REPO_ROOT, 'games'),
  path.join(REPO_ROOT, 'demos'),
];

/** ⚠️ **One bare-file `ALLOWED` Set used to serve BOTH rules in this file, and two of its three
 *  entries were never exemptions at all (#1123).** `repoLayout.ts` is the one legitimate
 *  implementation and this guard must SPELL OUT the shapes it forbids — its `what:` labels
 *  literally contain `discoverProjects(...).some(...)`, so it flags itself otherwise (it did, first
 *  run). Neither is a decision anybody should re-review, so neither is a ledger row: they are
 *  `SANCTIONED`, the split `clientJsonWriteSeam.test.ts` makes.
 *
 *  The third, `e2e/hostProject.ts`, is the real reasoned exemption — and it belonged to rule 2
 *  ONLY. Measured 2026-09-12 on work-ai2: it matches rule 1's `INLINE_PATTERNS` **zero** times, so its rule-1
 *  pardon was inert and covered whatever inline check somebody added there later. One row, one rule.
 *
 *  Repo-relative POSIX literals — matched against `rel` (git's own repo-relative string), never
 *  against an independently `path.join`-built absolute path (#849). */
const SANCTIONED: readonly string[] = [
  'engine/tests/helpers/repoLayout.ts',
  'engine/tests/architecture/projectPresencePredicate.test.ts',
];

/* ⚠️ **`sanctioned` is file-grained and carries no count, so this RECLASSIFIES rule 1's pardons
 *  rather than closing #1123 for them** — a new inline presence check added to either file is still
 *  green. Deliberate, and defensible only because a second guard covers it:
 *  `architecture/layoutConditionalTestLedger.test.ts` pins this file's conditional-gate list as
 *  empty, so a real `existsSync(path.join(REPO_ROOT, 'games'))` here would redden THERE. Do not copy
 *  the pattern to a guard with no such backstop — give those a counted row instead. */

/** The one legitimate `discoverProjects` call under `e2e/` — rule 2's single pardon. */
const E2E_EXEMPT = [
  {
    item: 'engine/tests/e2e/hostProject.ts',
    reason: 'pickHostProject() is the one place an e2e run may ask. It returns null instead of '
      + 'throwing, so a spec test.skip()s rather than killing COLLECTION for the whole suite — see '
      + 'the describe block below for the release that cost.',
  },
] as const;

/** Inline computations of project presence — the shapes that have actually appeared. */
const INLINE_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /discoverProjects\s*\([^)]*\)\s*\.\s*length\s*[><=]/, what: 'discoverProjects(...).length comparison' },
  { re: /discoverProjects\s*\([^)]*\)\s*\.\s*some\s*\(/, what: 'discoverProjects(...).some(...)' },
  { re: /existsSync\s*\(\s*path\.join\s*\([^)]*['"]games['"]\s*\)\s*\)/, what: "existsSync(path.join(..., 'games'))" },
];

/** Every `.tsx?` test source file under `under`, via the shared corpus producer
 *  (#799/#771/#805 Phase 4). */
function walkTests(under: string | string[], floor: number): Array<{ rel: string; abs: string }> {
  return repoFiles({
    under,
    match: (rel: string) => /\.tsx?$/.test(rel) && !rel.split('/').some((s) => s.startsWith('.') || s === 'node_modules'),
    floor,
  });
}

describe('project-presence is asked in exactly one place (#98)', () => {
  // Floored well under the 1259 measured today.
  const files = walkTests(TEST_DIRS, 900);

  it('found test files to scan (sanity: the guard is not passing vacuously)', () => {
    // Without this, a moved test root turns the whole guard into a silent pass — the failure
    // mode that makes a guard worse than none.
    expect(files.length).toBeGreaterThan(100);
  });

  it('no test computes project presence inline — import from helpers/repoLayout instead', () => {
    // ⚠️ `readScannedSource` replaces a hand-rolled "skip lines that look like comments" filter
    // (`/^\s*(\/\/|\*|\/\*)/`), which is the shape `commentStripperIsShared.test.ts` exists to
    // remove: it misses a trailing `// …` and a block comment opened mid-line. The shared reader
    // matters more now that rows carry counts — a prose mention would inflate the number a row has
    // to match. Measured both ways 2026-09-12: 5 occurrences either way, so no verdict moves. The
    // `what:` labels are STRING literals, not comments, so this guard still matches itself and is
    // still SANCTIONED.
    const hits: Array<{ item: string; site: string }> = [];
    for (const { rel, abs } of files) {
      const code = readScannedSource(abs).code;
      code.split('\n').forEach((line, i) => {
        for (const { re, what } of INLINE_PATTERNS) {
          if (re.test(line)) hits.push({ item: rel, site: `${rel}:${i + 1} — ${what}` });
        }
      });
    }
    assertExemptionLedger({
      label: 'INLINE_PATTERNS in projectPresencePredicate (rule 1)',
      population: hits,
      sanctioned: SANCTIONED,
      // 5 measured 2026-09-12, ALL of them in the two sanctioned files — so a reasoned pardon here
      // is zero, which is the point: nothing outside the implementation and this file's own prose
      // asks the question inline. Floored under 5 so the sanctioned rows' staleness is what reports
      // a removal, rather than this.
      floor: 4,
      fix: 'inline project-presence checks: use hasInternalGames() / hasAnyProject() from '
        + 'engine/tests/helpers/repoLayout.ts.',
    });
  });
});

/** A Playwright spec fails DIFFERENTLY from a vitest test, and the difference cost a release.
 *
 *  A vitest file that computes project presence wrongly fails that one test. A Playwright spec
 *  that derives a project at MODULE SCOPE and throws kills COLLECTION for the entire run — every
 *  spec, not just its own. On v0.5.2 that produced `only 0 tests were DISCOVERED, expected at
 *  least 55` from `runCompleteReporter`, on the release publish, after the tag was already cut.
 *  The three specs were not wrong about anything a dev clone can see: they only ever fail where
 *  no project exists, which is exactly the release snapshot of the public repo (`games/` and
 *  `demos/` both absent — only the `ci/main` publish uses `--with-demos`).
 *
 *  So specs do not get to ask the question at all. `pickHostProject()` answers it, returns null
 *  instead of throwing, and the spec `test.skip`s on null. This guard is what keeps the fourth
 *  variant from being written — the same reasoning as the inline-predicate guard above, applied
 *  to the one file shape where the blast radius is the whole suite. */
describe('e2e specs never discover projects themselves (#326 follow-up)', () => {
  const E2E_DIR = path.join(REPO_ROOT, 'engine', 'tests', 'e2e');

  it('no spec under engine/tests/e2e calls discoverProjects — pickHostProject() does', () => {
    const calls: Array<{ item: string; site: string }> = [];
    let scanned = 0;
    for (const { rel, abs } of walkTests(E2E_DIR, 15)) {
      scanned++;
      readScannedSource(abs).code.split('\n').forEach((line, i) => {
        for (let n = (line.match(/\bdiscoverProjects\s*\(/g) ?? []).length; n > 0; n -= 1) {
          calls.push({ item: rel, site: `${rel}:${i + 1}` });
        }
      });
    }
    // Non-vacuous: if the walk ever stops finding e2e files, the check below passes for free.
    expect(scanned).toBeGreaterThan(5);
    assertExemptionLedger({
      label: 'E2E_EXEMPT in projectPresencePredicate (rule 2)',
      population: calls,
      exempt: E2E_EXEMPT,
      // 1 measured 2026-09-12, which is also the pardon; `scanned > 5` above is the detector-broke
      // check, so this floor only stops the ledger meeting an empty scan.
      // ⚠️ `floor` is checked BEFORE `over-blessed`, so migrating this one call reports "the detector
      // has stopped matching" rather than "blesses 1, found 0". Read it as success; delete the row.
      floor: 1,
      fix: 'a spec must not discover projects itself — a module-scope throw kills COLLECTION for '
        + 'the entire run, not just that spec. Call pickHostProject() and test.skip() on null.',
    });
  });
});
