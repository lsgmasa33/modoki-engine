/**
 * No committed `.prefab.json` authors an inert UI trait — a value a sibling `UIAnchor` overrides
 * in total silence (#42, widened by #757's margin arm — both fire from the same
 * `validatePrefabData`/`inertLayoutWarnings` this test drives, so this guard now covers both, not
 * just size).
 *
 * The two shapes this can take:
 *   - size (#42): `UIElement.width`/`height` authored on an axis a stretched `UIAnchor` sizes
 *     from its own offsets.
 *   - margin (#757): `UIElement.margin*` authored on ANY anchor — `applyAnchorStyle` clears all
 *     four unconditionally, whatever the mode.
 * Both are the same class of finding on the same trait pair, inside the prefab FILE — so
 * every instance silently inherits a dead value, one file further from whoever eventually hits
 * it. The other two authoring shapes are covered against the scene that contains them (#16 plain
 * entity, #35 instance overrides).
 *
 * This is the FILE-level half of the fix. The editor also warns at prefab WRITE time (Save prefab /
 * Apply to Prefab), which reaches the person who just authored it — but a write-time hook only sees
 * prefabs written THROUGH the editor, and in this repo prefab JSON is routinely edited by hand and
 * by agents via `write_asset`. This test is what covers those, and the 89 prefabs that already
 * existed when the check was added. Neither half subsumes the other, which is why both exist.
 *
 * Currently expected to find NOTHING: measured at the time of writing, 89 committed prefabs, only
 * 12 carrying UI traits at all, and 0 authoring any of the three. That makes this a COVERAGE
 * guard, not a bug fix — its job is to keep the count at zero, and its sanity check below is what
 * stops it from passing vacuously if the scan ever stops finding prefabs.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { validatePrefabData } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { hasAnyProject, hasInternalGames } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

// git-backed enumeration replaces the hand-rolled walker (#771/#799). That walker's own
// `dist`/`node_modules`/`ios`/`android` skip list was missing `ads` — a gitignored playable-export
// build dir that can leave STALE prefab copies on disk after a local build — so a from-source
// re-scan could silently double-report a finding against a copy that no longer matches its
// source. `repoFiles()` enumerates tracked-or-untracked-but-not-ignored files, so `ads/` (and any
// OTHER gitignored build dir nobody thought to list) is excluded for free rather than needing a
// sixth skip-list entry; `ios`/`android` are excluded explicitly below because they ARE tracked
// (native mirrors carrying build copies of the same prefabs, not ignored).
//
// `floor: 0` deliberately — the module-scope enumeration must not throw on a checkout that ships
// no games/demos content at all (the public RELEASE snapshot); throwing here would fail COLLECTION
// rather than skip the file. The non-vacuity pin therefore lives in the `hasAnyProject()`-gated
// sanity test below, where it can be skipped — and it is a real floor, not the `> 0` it was before
// this migration, because a shared producer taking `under`/`match` has more ways to return a
// nearly-empty list than the hand-rolled walker did.
const prefabs = repoFiles({
  under: ['games', 'demos', 'engine/templates/starter'],
  match: /\.prefab\.json$/,
  exclude: ['ios', 'android'],
  floor: 0,
}).map(({ abs }) => abs);

describe('committed prefabs author no inert UI trait — size or margin (#42, #757)', () => {
  // Gated on the LOOSE predicate: the prefabs come from whatever projects exist (engine/templates
  // alone contributes none), so "is there anything to scan?" is exactly the question. The public
  // RELEASE snapshot on `main` ships no projects at all — unlike the `ci/main` snapshot, which
  // ships two demos, which is why this only ever went red on `main`.
  it.skipIf(!hasAnyProject())('found prefabs to scan (sanity: the guard is not passing vacuously)', () => {
    // Without this, a broken walk or a moved project root turns the whole file into a silent
    // pass — the failure mode that makes a coverage guard worse than none.
    //
    // A bare `> 0` is too weak to be that pin WHERE A REAL CORPUS EXISTS, now that the enumeration
    // is a shared producer taking `under`/`match`: a typo'd prefix or a `match` that stops matching
    // most of the corpus would leave a handful of files and still pass, which reads identically to
    // health. So the games branch floors far under its real count (85 here = 58 games + 27 demos).
    //
    // ⚠️ The non-games branch is 0, and cannot be raised: it covers TWO snapshot shapes, not one.
    // `scripts/publish-engine-oss.sh` is INCLUDE-ONLY and takes `--with-demos`, so the demos it
    // ships are an argument, not a constant -- the free `ci/main` stage takes all of them (27
    // prefabs), while the hub's `npm run verify:publish` names exactly two (3d-physics-demo,
    // 2d-physics-demo) which between them author exactly ONE prefab (measured in the assembled
    // stage, which is where a floor of 5 went red and blocked a `main` push). Any floor above 0
    // here is really a floor on the caller's demo list, which this file cannot see.
    // `repoFiles`'s own `floor` cannot carry this: it runs at MODULE scope, where throwing on a
    // projectless RELEASE snapshot would fail collection rather than skip.
    expect(prefabs.length).toBeGreaterThan(hasInternalGames() ? 30 : 0);
  });

  it('no prefab authors an inert size or margin against its own anchor', () => {
    const findings: string[] = [];
    for (const abs of prefabs) {
      let data: unknown;
      try {
        data = JSON.parse(fs.readFileSync(abs, 'utf-8'));
      } catch {
        continue; // an unparseable prefab is a louder failure the loader already reports
      }
      const rel = path.relative(PROJECT_ROOT, abs).replace(/\\/g, '/');
      for (const w of validatePrefabData(data).warnings) findings.push(`${rel} → ${w}`);
    }
    // Name whichever class of finding actually fired, rather than assuming it is always
    // width/height (#42's original — and only — shape): a margin finding pointed the author at
    // "drop the width/height" would send them hunting the wrong field entirely.
    const isSize = (w: string) => /UIElement\.(width|height) is inert/.test(w);
    const isMargin = (w: string) => /UIElement\.margin\w+ is inert/.test(w);
    const guidance: string[] = [];
    if (findings.some(isSize)) {
      guidance.push(
        'SIZE: a width/height authored on an axis the anchor stretches is dead — that axis is '
        + 'sized from the anchor\'s own offsets. Drop the width/height, or use an anchor that does '
        + 'not stretch that axis.',
      );
    }
    if (findings.some(isMargin)) {
      guidance.push(
        'MARGIN: a margin authored on ANY anchor is dead — the anchor clears all four '
        + 'unconditionally, whatever its mode. Drop the margin, or move the inset onto the '
        + 'anchor\'s own offsets.',
      );
    }
    expect(
      findings,
      `A trait value authored against a sibling UIAnchor is stored, shown in the Inspector, and `
        + `never applied — and inside a prefab every instance inherits it. `
        + `${guidance.join(' ')} See docs/scene-loading.md (pass 4) and docs/ui-system.md.`,
    ).toEqual([]);
  });
});
