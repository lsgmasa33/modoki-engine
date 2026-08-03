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

const TEST_DIRS = [
  path.join(REPO_ROOT, 'engine', 'tests'),
  path.join(REPO_ROOT, 'engine', 'packages', 'modoki', 'tests'),
];

/** The helper is the one legitimate place to compute this. This guard is excluded because it
 *  must SPELL OUT the shapes it forbids — its `what:` labels below literally contain
 *  `discoverProjects(...).some(...)`, so it flags itself otherwise. (It did, first run.) A guard
 *  that reports its own documentation as a violation is one people learn to ignore. */
const ALLOWED = new Set([
  path.join(REPO_ROOT, 'engine', 'tests', 'helpers', 'repoLayout.ts'),
  path.join(REPO_ROOT, 'engine', 'tests', 'architecture', 'projectPresencePredicate.test.ts'),
]);

/** Inline computations of project presence — the shapes that have actually appeared. */
const INLINE_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /discoverProjects\s*\([^)]*\)\s*\.\s*length\s*[><=]/, what: 'discoverProjects(...).length comparison' },
  { re: /discoverProjects\s*\([^)]*\)\s*\.\s*some\s*\(/, what: 'discoverProjects(...).some(...)' },
  { re: /existsSync\s*\(\s*path\.join\s*\([^)]*['"]games['"]\s*\)\s*\)/, what: "existsSync(path.join(..., 'games'))" },
];

function* walkTests(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkTests(full);
    else if (/\.tsx?$/.test(e.name)) yield full;
  }
}

describe('project-presence is asked in exactly one place (#98)', () => {
  const files = TEST_DIRS.flatMap((d) => [...walkTests(d)]);

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
