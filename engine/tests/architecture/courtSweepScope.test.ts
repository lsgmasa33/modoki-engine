/** ⚠️ **Court's sweep gate names the paths it watches BY HAND, and nothing checked that list
 *  against what Court's tests actually depend on (#787).**
 *
 *  `WATCHED` in `engine/scripts/courtAuthored.mjs` decides two things: whether vitest discovers
 *  `games/court/tests/**` at all, and whether the `COURT_SWEEPS`/`COURT_CORPUS` tiers arm. It was:
 *
 *      ['games/court', 'engine/packages/modoki/src/runtime/rendering/text']
 *
 *  `games/court/tests/narrationRoom.test.ts` derives its whole device sweep from `DEVICE_PRESETS`
 *  in `src/editor/scene/devicePresets.ts` — deliberately, so the geometry is never transcribed —
 *  and **no `WATCHED` entry covered `src/editor`**. A clone that re-measured a device preset and
 *  touched nothing under `games/court` skipped the one suite built to catch the effect.
 *
 *  ⚠️ **The failure is quiet by construction, which is why a test and not a bigger list.** Court's
 *  assertions stayed GREEN through that miss (tablets never bind), so it would never have surfaced
 *  as a red run — it would have surfaced as a doc that silently stopped being true. It did: the
 *  `4ccf132a4` close-out found three stale "all 15 shipping presets" claims and a moved tablet band.
 *
 *  ## What this guard can and cannot see — read before widening it
 *
 *  Coverage is asserted at **BARREL** granularity, not per file, and that is a real limit rather
 *  than an oversight. Court's tests import `@modoki/engine/runtime` **104 times**: they depend on
 *  the runtime barrel wholesale, so "every file Court transitively depends on must be watched"
 *  resolves to *all of `src/runtime`* — which `courtAuthored.mjs`'s own docblock rules out, because
 *  widening `WATCHED` to `engine/` "would make the gate a no-op on most sessions, which is the cost
 *  it exists to avoid".
 *
 *  So the rule here is the honest weaker one: **a barrel Court imports must have SOME watched
 *  coverage; a barrel with NONE is a hole.** That catches the `#787` shape — an entire engine
 *  surface nobody thought about — and does NOT catch a newly-depended-on subdirectory of an
 *  already-partly-watched barrel. Stated rather than implied, because the defect this whole family
 *  is about is a guard whose scope claim is wider than its reach.
 *
 *  The barrel -> source-directory mapping is DERIVED from `@modoki/engine`'s own `exports` map, not
 *  transcribed here. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';
import { importsIn, parseSource } from '@modoki/engine/testing/sourceAst';
import { hasInternalGames } from '../helpers/repoLayout';

const REPO = path.resolve(__dirname, '../../..');
const PKG_DIR = 'engine/packages/modoki';
const AUTHORED = path.join(REPO, 'engine/scripts/courtAuthored.mjs');
const SWEEP_GATE = path.join(REPO, 'games/court/tests/sweepGate.ts');
const CHANGED_LEVELS = path.join(REPO, 'games/court/tests/changedLevels.ts');

/* ⚠️ **No COVERAGE_EXEMPT ledger (#1140).** It held one row, `@modoki/engine/testing` ("test
 *  INFRASTRUCTURE, not engine behaviour Court measures"), and that barrel HAS watched coverage — so
 *  the row pardoned nothing. Its staleness check asked only that Court still imported the barrel,
 *  which stays true for an exemption that is no longer needed. Found when the row was put on the
 *  spending ledger (#1140). A barrel that genuinely cannot shift a measured value takes a counted
 *  `assertExemptionLedger` row with that reason. */

/** `const WATCHED = [...]` as written in a file. Both copies are plain source, read through the
 *  shared scanner so a commented-out entry cannot be mistaken for a live one. */
function watchedIn(absPath: string): string[] {
  const src = readScannedSource(absPath).code;
  const m = /const WATCHED = \[([^\]]*)\]/.exec(src);
  expect(m, `${path.relative(REPO, absPath)}: no \`const WATCHED = [...]\` found — renamed or `
    + 'reshaped? This guard cannot vouch for a list it cannot read.').not.toBeNull();
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Every `@modoki/engine/...` specifier `games/court/tests/**` imports — static, re-exported or dynamic,
 *  read from the parse (#1193). The regex this replaced, `from '(@modoki/engine…)'`, took single quotes
 *  only and never saw a side-effect import or `await import('…')`; same 10 barrels on 2026-09-15. */
function courtImportedBarrels(): string[] {
  const files = repoFiles({ under: 'games/court/tests', match: /\.tsx?$/, floor: 10 });
  const out = new Set<string>();
  for (const { abs, rel } of files) {
    for (const { spec } of importsIn(parseSource(readScannedSource(abs).code, rel))) {
      if (spec === '@modoki/engine' || spec.startsWith('@modoki/engine/')) out.add(spec);
    }
  }
  return [...out].sort();
}

/** barrel specifier -> repo-relative source DIRECTORY, derived from the package's `exports` map. */
function barrelSourceDir(barrel: string): string | null {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, PKG_DIR, 'package.json'), 'utf8'));
  const sub = barrel.replace('@modoki/engine', '.');
  const target: string | undefined = pkg.exports?.[sub];
  if (!target) return null;
  const rel = path.posix.join(PKG_DIR, target.replace(/^\.\//, ''));
  // `src/runtime/index.ts` -> the directory it indexes; a single-file export -> its own dir.
  return path.posix.dirname(rel);
}

/** ⚠️ Every assertion here reads `games/court/**`, which the OSS snapshot does not ship — it
 *  publishes `engine build docs` plus a few root files and NO `games/` rows at all. Ungated, the
 *  `repoFiles({ under: 'games/court/tests', floor: 10 })` below THROWS there and the sweepGate read
 *  ENOENTs, turning the free public CI red on every push to `main`. Gated on `hasInternalGames()`
 *  rather than on `hasPrivateTooling()`, per that helper's own note: gate on the thing the test
 *  needs, not a proxy that correlates with it today. */
describe.skipIf(!hasInternalGames())('Court sweep scope (#787)', () => {
  it('the two WATCHED copies are identical', () => {
    // `courtAuthored.mjs`'s docblock says "KEEP IN SYNC with games/court/tests/sweepGate.ts, which
    // carries a SECOND COPY … The two must agree on the WATCHED list" — and until now nothing
    // checked it. The duplication is forced (a game must be self-contained, so a game's tests
    // cannot import engine/scripts — same constraint as PROJECT_ROOT_DIRS), so the copy stays;
    // what changes is that drifting it now fails here instead of silently splitting the gate.
    expect(watchedIn(SWEEP_GATE)).toEqual(watchedIn(AUTHORED));
  });

  it('every #826 site binds the SAME reason to the SAME arm', () => {
    // ⚠️ **This asserts ARM -> REASON, not the SET of reasons, and the difference is the guard.**
    // A first version collected every `return '<literal>'` in the body and compared the set; that
    // passes with the two literals SWAPPED — attach `'git-failed'` to the degenerate arm and
    // `'no-own-commits'` to the dirty-tree failure and #826 is restored verbatim, with every one of
    // Court's own suites green (they exercise reason -> sentence, never arm -> reason).
    //
    // ⚠️ **THREE files, not two.** A second version read only the two `courtTouched` copies — and
    // `changedLevels.ts` is the site that actually RENDERS the sentence, the one the release-version
    // skill now quotes. Swapping its literals restored #826 in the one place a human reads, with
    // this guard green. That is the same defect this whole family is about: a guard whose scope
    // claim is wider than its reach. `typecheck-projects.mjs` is the fourth site and is covered
    // end-to-end by `typecheckProjectsSelection.test.ts`, which drives the real CLI against a temp
    // repo that genuinely produces `origin/main === HEAD` — a stronger test than this one, so it is
    // deliberately not duplicated here.
    //
    // Read as SOURCE rather than by calling anything: these functions shell out to git against
    // whatever repo the suite runs in, so their ANSWER is a fact about this checkout, not the code.
    // `readScannedSource` blanks comment CONTENT while preserving structure, so a prose copy of a
    // literal cannot satisfy a match, and `\n\s*` still spans an interleaved comment.
    const DEGENERATE = /if \(base\.trim\(\) === git\('rev-parse', 'HEAD'\)\?\.trim\(\)\) return '([^']+)';/g;
    const DIRTY_FAILED = /const dirty = git\('status'[^\n]*\n\s*if \(dirty === null\) return '([^']+)';/g;
    const BASE_FAILED = /const base = git\('merge-base', 'HEAD', 'origin\/main'\);\n\s*if \(base === null\) return '([^']+)';/g;
    // The FOURTH arm, which the first version of this guard missed even though the same commit's
    // test-cost.md edit newly enumerated it. Different shape per file: a `??` fallback in the two
    // `courtTouched` copies, an `if` on the diff in `changedLevels`.
    const AUTHORED_FALLBACK = /return authoredInRange\(git, base\.trim\(\)\) \?\? '([^']+)';/g;
    const COMMITTED_FAILED = /const committed = git\('diff'[^\n]*\n\s*if \(committed === null\) return '([^']+)';/g;

    const SITES = [
      { file: SWEEP_GATE, fourth: AUTHORED_FALLBACK, fourthName: 'authoredInRange fallback' },
      { file: AUTHORED, fourth: AUTHORED_FALLBACK, fourthName: 'authoredInRange fallback' },
      { file: CHANGED_LEVELS, fourth: COMMITTED_FAILED, fourthName: 'failed git diff' },
    ];

    for (const { file, fourth, fourthName } of SITES) {
      const code = readScannedSource(file).code;
      const rel = path.relative(REPO, file);
      const arm = (re: RegExp, what: string): string => {
        const all = [...code.matchAll(re)];
        // ⚠️ Exactly one, not "the first" — two functions in one file each carrying this arm would
        // make a `.exec` silently vouch for whichever came first and ignore the other.
        expect(all.length, `${rel}: expected exactly ONE ${what} arm, found ${all.length}. Renamed, `
          + 'reshaped, or duplicated? This guard cannot vouch for an arm it cannot read, and a '
          + 'silently unreadable arm is how #826 survived in the first place.').toBe(1);
        return all[0][1];
      };

      expect(arm(DEGENERATE, 'degenerate merge-base === HEAD'),
        `${rel}: the degenerate range is NOT a failure — git answered, HEAD merely has no commits `
        + 'of its own. Reporting it as one is #826, and it is the message the hub prints after every '
        + 'push and a worker after every fast-forward merge.').toBe('no-own-commits');
      expect(arm(DIRTY_FAILED, 'failed git status'),
        `${rel}: a failed git status IS a real failure`).toBe('git-failed');
      expect(arm(BASE_FAILED, 'failed merge-base'),
        `${rel}: a failed merge-base IS a real failure`).toBe('git-failed');
      expect(arm(fourth, fourthName),
        `${rel}: the ${fourthName} arm is a real failure, not the degenerate range`).toBe('git-failed');
    }
  });

  it('every engine barrel Court\'s tests import has SOME watched coverage', () => {
    const watched = watchedIn(AUTHORED);
    const barrels = courtImportedBarrels();

    // Non-vacuity: Court imports engine barrels in quantity; an empty read means the scan broke.
    expect(barrels.length, 'no @modoki/engine imports found under games/court/tests — the scan has '
      + 'broken, and every assertion below would pass having examined nothing').toBeGreaterThan(1);

    const uncovered: Array<{ site: string }> = [];
    for (const barrel of barrels) {
      const dir = barrelSourceDir(barrel);
      if (dir === null) {
        uncovered.push({ site: `${barrel}  (not in @modoki/engine's exports map — cannot resolve)` });
        continue;
      }
      if (!watched.some((w) => w === dir || w.startsWith(`${dir}/`))) uncovered.push({ site: `${barrel}  ->  ${dir}` });
    }

    expect(uncovered.map((u) => u.site), [
      "Court's tests import these engine barrels, and NO `WATCHED` entry in",
      'engine/scripts/courtAuthored.mjs covers any part of them. A clone that changes one of these',
      'surfaces and touches nothing under games/court skips the Court suite entirely — and Court',
      'is where the effect would have shown up (#787).',
      '',
      'Fix by adding the specific subdirectory Court depends on to WATCHED in BOTH copies —',
      'NOT the whole barrel: widening WATCHED to `engine/` makes the gate a no-op, which is the',
      'cost it exists to avoid.',
    ].join('\n')).toEqual([]);
  });
});
