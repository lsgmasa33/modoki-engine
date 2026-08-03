/**
 * No committed `.prefab.json` authors a UI size on an axis its own anchor stretches (#42).
 *
 * The third and last shape of the inert-size trap: a size authored on an axis a stretched
 * `UIAnchor` controls is stored, shown in the Inspector, and never applied. The other two shapes
 * are covered against the scene that contains them (#16 plain entity, #35 instance overrides);
 * this one lives inside the prefab file, so every instance silently inherits a dead value and the
 * trap sits one file further from whoever eventually hits it.
 *
 * This is the FILE-level half of the fix. The editor also warns at prefab WRITE time (Save prefab /
 * Apply to Prefab), which reaches the person who just authored it — but a write-time hook only sees
 * prefabs written THROUGH the editor, and in this repo prefab JSON is routinely edited by hand and
 * by agents via `write_asset`. This test is what covers those, and the 89 prefabs that already
 * existed when the check was added. Neither half subsumes the other, which is why both exist.
 *
 * Currently expected to find NOTHING: measured at the time of writing, 89 committed prefabs, only
 * 12 carrying UI traits at all, and 0 authoring an inert size. That makes this a COVERAGE guard,
 * not a bug fix — its job is to keep the count at zero, and its sanity check below is what stops
 * it from passing vacuously if the scan ever stops finding prefabs.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { validatePrefabData } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
import { hasAnyProject } from '../helpers/repoLayout';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    // dist/ and the native mirrors (ios/, android/) contain BUILD COPIES of the same prefabs —
    // scanning them would double-report every finding and, worse, report a stale copy that no
    // longer matches its source.
    if (e.isDirectory()) {
      if (['dist', 'node_modules', 'ios', 'android'].includes(e.name)) continue;
      yield* walk(path.join(dir, e.name));
    } else if (e.name.endsWith('.prefab.json')) {
      yield path.join(dir, e.name);
    }
  }
}

const prefabs = (discoverProjects(PROJECT_ROOT) as { dir: string }[])
  .flatMap((p) => [...walk(p.dir)])
  .concat([...walk(path.join(PROJECT_ROOT, 'engine', 'templates'))]);

describe('committed prefabs author no inert UI size (#42)', () => {
  // Gated on the LOOSE predicate: the prefabs come from whatever projects exist (engine/templates
  // alone contributes none), so "is there anything to scan?" is exactly the question. The public
  // RELEASE snapshot on `main` ships no projects at all — unlike the `ci/main` snapshot, which
  // ships two demos, which is why this only ever went red on `main`.
  it.skipIf(!hasAnyProject())('found prefabs to scan (sanity: the guard is not passing vacuously)', () => {
    // Without this, a broken walk or a moved project root turns the whole file into a silent
    // pass — the failure mode that makes a coverage guard worse than none.
    expect(prefabs.length).toBeGreaterThan(0);
  });

  it('no prefab authors a size on an axis its anchor stretches', () => {
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
    expect(
      findings,
      'A size authored on a STRETCHED axis is dead: the anchor sizes that axis from its two '
        + 'offsets, so the value is stored and displayed but never applied — and inside a prefab '
        + 'every instance inherits it. Either drop the width/height, or use an anchor that does '
        + 'not stretch that axis. See docs/scene-loading.md (pass 4) and docs/ui-system.md.',
    ).toEqual([]);
  });
});
