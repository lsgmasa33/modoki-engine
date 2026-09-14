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
import { accessPath, calleeName, callsTo, findNodes, lineOf, parseSource, stringValueOf, ts, unwrapValue } from '@modoki/engine/testing/sourceAst';
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
 *  implementation — not a decision anybody should re-review, so not a ledger row: it is
 *  `SANCTIONED`, the split `clientJsonWriteSeam.test.ts` makes. (This guard's OWN file was a second
 *  sanctioned entry while the detectors were text regexes: its `what:` labels spell the forbidden
 *  shapes, so it flagged itself. Since #1179 the shapes are found in the parse, a string literal is
 *  not a call, and that entry went stale — removed.)
 *
 *  The third, `e2e/hostProject.ts`, is the real reasoned exemption — and it belonged to rule 2
 *  ONLY. Measured 2026-09-12 on work-ai2: it matches rule 1's shapes **zero** times, so its rule-1
 *  pardon was inert and covered whatever inline check somebody added there later. One row, one rule.
 *
 *  Repo-relative POSIX literals — matched against `rel` (git's own repo-relative string), never
 *  against an independently `path.join`-built absolute path (#849). */
const SANCTIONED: readonly string[] = [
  'engine/tests/helpers/repoLayout.ts',
];

/* ⚠️ **`sanctioned` is file-grained and carries no count, so this RECLASSIFIES rule 1's pardons
 *  rather than closing #1123 for them** — a new inline presence check added to the sanctioned file is still
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

/**
 * Inline computations of project presence in one file's comment-stripped code — the shapes that
 * have actually appeared — found in the PARSE (#1179), so a formatter-wrapped
 * `discoverProjects(root)\n  .length > 0` or `existsSync(\n  path.join(root, 'games'),\n)` is caught:
 *  - a comparison with `discoverProjects(…).length` as an operand (`!==` included; the regex's
 *    `[><=]` let `!== 0` through);
 *  - `discoverProjects(…).some(…)`;
 *  - `existsSync(path.join(…, 'games'))` — `'games'` as the LAST join segment.
 */
function inlinePresenceChecks(code: string, label: string): Array<{ line: number; what: string }> {
  const sf = parseSource(code, label);
  const isDiscover = (e: ts.Expression): boolean => { const u = unwrapValue(e); return ts.isCallExpression(u) && calleeName(u) === 'discoverProjects'; };
  const COMPARE = new Set([ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);
  const lengthCompares = findNodes(sf, (n): n is ts.BinaryExpression => ts.isBinaryExpression(n) && COMPARE.has(n.operatorToken.kind))
    .filter((b) => [b.left, b.right].some((s) => { const u = unwrapValue(s); return ts.isPropertyAccessExpression(u) && u.name.text === 'length' && isDiscover(u.expression); }))
    .map((n) => ({ line: lineOf(n), what: 'discoverProjects(...).length comparison' }));
  const somes = callsTo(sf, 'some').filter((c) => ts.isPropertyAccessExpression(c.expression) && isDiscover(c.expression.expression))
    .map((n) => ({ line: lineOf(n), what: 'discoverProjects(...).some(...)' }));
  const gamesExists = callsTo(sf, 'existsSync').filter((c) => {
    const joined = c.arguments[0] && unwrapValue(c.arguments[0]);
    if (!joined || !ts.isCallExpression(joined) || !['path.join', 'join'].includes(accessPath(joined.expression) ?? '')) return false;
    return stringValueOf(joined.arguments[joined.arguments.length - 1]) === 'games';
  }).map((n) => ({ line: lineOf(n), what: "existsSync(path.join(..., 'games'))" }));
  return [...lengthCompares, ...somes, ...gamesExists];
}

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

  it('the detector sees each shape wrapped, and not in a string or a non-presence use (#1179)', () => {
    const src = [
      'if (discoverProjects(root)',
      '  .length !== 0) run();',
      'const any = discoverProjects(root).some((p) => p.kind === "game");',
      'if (existsSync(',
      "  path.join(REPO_ROOT, 'games'),",
      ')) run();',
      "const label = 'discoverProjects(...).some(...)'; const n = discoverProjects(root).map((p) => p.id);",
      "if (existsSync(path.join(REPO_ROOT, 'games', 'court'))) run();",
    ].join('\n');
    expect(inlinePresenceChecks(src, 'x.test.ts').map((h) => `${h.line}:${h.what}`)).toEqual([
      '1:discoverProjects(...).length comparison', '3:discoverProjects(...).some(...)', "4:existsSync(path.join(..., 'games'))",
    ]);
  });

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
    // to match. Measured both ways 2026-09-12: 5 occurrences either way, so no verdict moves (3 since
    // #1179 parses them — the other 2 were this file's own string labels).
    const hits = files.flatMap(({ rel, abs }) => inlinePresenceChecks(readScannedSource(abs).code, rel)
      .map((h) => ({ item: rel, site: `${rel}:${h.line} — ${h.what}` })));
    assertExemptionLedger({
      label: 'inline presence checks in projectPresencePredicate (rule 1)',
      population: hits,
      sanctioned: SANCTIONED,
      // 3 measured 2026-09-14 (#1179), ALL in the sanctioned implementation — the regex's other 2
      // were this file's own string labels. A reasoned pardon here is zero, which is the point.
      // Floored under 3 so the sanctioned row's staleness is what reports a removal, rather than this.
      floor: 2,
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
      // Every CALL, from the parse (#1179) — a wrapped `discoverProjects\n  (root)` is still one.
      for (const c of callsTo(parseSource(readScannedSource(abs).code, rel), 'discoverProjects')) {
        calls.push({ item: rel, site: `${rel}:${lineOf(c)}` });
      }
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
