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
import { hasInternalGames } from '../helpers/repoLayout';

const REPO = path.resolve(__dirname, '../../..');
const PKG_DIR = 'engine/packages/modoki';
const AUTHORED = path.join(REPO, 'engine/scripts/courtAuthored.mjs');
const SWEEP_GATE = path.join(REPO, 'games/court/tests/sweepGate.ts');

/** Barrels whose lack of `WATCHED` coverage is deliberate, each with the reason it is safe.
 *  A ledger, not an off-switch: every entry must still be a barrel Court actually imports (asserted
 *  below), so a stale row fails rather than rotting. */
const COVERAGE_EXEMPT: ReadonlyArray<{ barrel: string; reason: string }> = [
  {
    barrel: '@modoki/engine/testing',
    reason: 'Test INFRASTRUCTURE (tests/helpers/sourceScanner.ts), not engine behaviour Court '
      + 'measures. A change there breaks Court\'s suite LOUDLY — a scanner that stops stripping '
      + 'fails its own assertions — rather than silently shifting a measured value, and silent '
      + 'shifting is the only failure this gate exists to catch.',
  },
];

/** `const WATCHED = [...]` as written in a file. Both copies are plain source, read through the
 *  shared scanner so a commented-out entry cannot be mistaken for a live one. */
function watchedIn(absPath: string): string[] {
  const src = readScannedSource(absPath).code;
  const m = /const WATCHED = \[([^\]]*)\]/.exec(src);
  expect(m, `${path.relative(REPO, absPath)}: no \`const WATCHED = [...]\` found — renamed or `
    + 'reshaped? This guard cannot vouch for a list it cannot read.').not.toBeNull();
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Every `@modoki/engine/...` specifier `games/court/tests/**` imports. */
function courtImportedBarrels(): string[] {
  const files = repoFiles({ under: 'games/court/tests', match: /\.tsx?$/, floor: 10 });
  const out = new Set<string>();
  for (const { abs } of files) {
    const code = readScannedSource(abs).code;
    for (const m of code.matchAll(/from '(@modoki\/engine[^']*)'/g)) out.add(m[1]);
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

  it('every engine barrel Court\'s tests import has SOME watched coverage', () => {
    const watched = watchedIn(AUTHORED);
    const exempt = new Map(COVERAGE_EXEMPT.map((e) => [e.barrel, e.reason]));
    const barrels = courtImportedBarrels();

    // Non-vacuity: Court imports engine barrels in quantity; an empty read means the scan broke.
    expect(barrels.length, 'no @modoki/engine imports found under games/court/tests — the scan has '
      + 'broken, and every assertion below would pass having examined nothing').toBeGreaterThan(1);

    const uncovered: string[] = [];
    for (const barrel of barrels) {
      if (exempt.has(barrel)) continue;
      const dir = barrelSourceDir(barrel);
      if (dir === null) {
        uncovered.push(`${barrel}  (not in @modoki/engine's exports map — cannot resolve)`);
        continue;
      }
      const covered = watched.some((w) => w === dir || w.startsWith(`${dir}/`));
      if (!covered) uncovered.push(`${barrel}  ->  ${dir}`);
    }

    expect(uncovered, [
      "Court's tests import these engine barrels, and NO `WATCHED` entry in",
      'engine/scripts/courtAuthored.mjs covers any part of them. A clone that changes one of these',
      'surfaces and touches nothing under games/court skips the Court suite entirely — and Court',
      'is where the effect would have shown up (#787).',
      '',
      'Fix by adding the specific subdirectory Court depends on to WATCHED in BOTH copies —',
      'NOT the whole barrel: widening WATCHED to `engine/` makes the gate a no-op, which is the',
      'cost it exists to avoid. If the dependency genuinely cannot shift a measured value, add a',
      'COVERAGE_EXEMPT row saying why.',
      '',
      ...uncovered,
    ].join('\n')).toEqual([]);
  });

  it('every COVERAGE_EXEMPT row is still a barrel Court imports', () => {
    // Keeps the ledger load-bearing: an exemption for a barrel nobody imports any more is vouching
    // for nothing, and would quietly excuse that name if a future test started importing it.
    const barrels = new Set(courtImportedBarrels());
    const stale = COVERAGE_EXEMPT.map((e) => e.barrel).filter((b) => !barrels.has(b));
    expect(stale, 'These COVERAGE_EXEMPT rows name barrels games/court/tests no longer imports. '
      + 'Delete them — a stale exemption is an unexamined hole waiting for the name to come back.')
      .toEqual([]);
  });
});
