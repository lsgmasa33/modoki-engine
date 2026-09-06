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
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repoLayout';
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

/** The helper is the one legitimate place to compute this. This guard is excluded because it
 *  must SPELL OUT the shapes it forbids — its `what:` labels below literally contain
 *  `discoverProjects(...).some(...)`, so it flags itself otherwise. (It did, first run.) A guard
 *  that reports its own documentation as a violation is one people learn to ignore. */
const ALLOWED = new Set([
  path.join(REPO_ROOT, 'engine', 'tests', 'helpers', 'repoLayout.ts'),
  path.join(REPO_ROOT, 'engine', 'tests', 'architecture', 'projectPresencePredicate.test.ts'),
  // The e2e host-project pick — the one legitimate `discoverProjects` call under e2e/. See the
  // E2E_* describe block below for why every OTHER spec is forbidden from making it.
  path.join(REPO_ROOT, 'engine', 'tests', 'e2e', 'hostProject.ts'),
]);

/** Inline computations of project presence — the shapes that have actually appeared. */
const INLINE_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /discoverProjects\s*\([^)]*\)\s*\.\s*length\s*[><=]/, what: 'discoverProjects(...).length comparison' },
  { re: /discoverProjects\s*\([^)]*\)\s*\.\s*some\s*\(/, what: 'discoverProjects(...).some(...)' },
  { re: /existsSync\s*\(\s*path\.join\s*\([^)]*['"]games['"]\s*\)\s*\)/, what: "existsSync(path.join(..., 'games'))" },
];

/** Every `.tsx?` test source file under `under`, via the shared corpus producer
 *  (#799/#771/#805 Phase 4). */
function walkTests(under: string | string[], floor: number): string[] {
  return repoFiles({
    under,
    match: (rel: string) => /\.tsx?$/.test(rel) && !rel.split('/').some((s) => s.startsWith('.') || s === 'node_modules'),
    floor,
  }).map(({ abs }) => abs);
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
    const offenders: string[] = [];
    for (const abs of files) {
      if (ALLOWED.has(abs)) continue;
      const src = fs.readFileSync(abs, 'utf8');
      for (const { re, what } of INLINE_PATTERNS) {
        // Ignore matches inside comment lines — the rule gets DESCRIBED in prose, and a guard
        // that flags its own documentation trains people to ignore it.
        const hit = src
          .split('\n')
          .some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && re.test(line));
        if (hit) offenders.push(`${path.relative(REPO_ROOT, abs)} — ${what}`);
      }
    }
    expect(offenders, 'inline project-presence checks (use hasInternalGames() / hasAnyProject())')
      .toEqual([]);
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
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of walkTests(E2E_DIR, 15)) {
      if (ALLOWED.has(file)) continue;
      scanned++;
      if (/\bdiscoverProjects\s*\(/.test(fs.readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
    // Non-vacuous: if the walk ever stops finding e2e files, the check above passes for free.
    expect(scanned).toBeGreaterThan(5);
  });
});
