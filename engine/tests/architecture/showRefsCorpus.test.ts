/** Verification bar for #805: `show-refs.mjs --all` must actually reach the repo's scene/prefab
 *  corpus. Before the fix it printed 2 sections total, for two reasons that are BOTH separate
 *  from the Windows separator bug #798 already fixed in this same function (that was instance 8
 *  in docs/windows.md § Paths — its `toPosix` call is correct and stays): the walk root was
 *  `engine/` rather than the repo, and scenes were keyed by a `/scenes/` DIRECTORY check while
 *  prefabs were keyed by extension, so a `.scene.json` outside a `scenes/` folder was invisible
 *  regardless of the root. See the header comment on `show-refs.mjs`.
 *
 *  Runs the script as a real child process rather than importing pieces of it: `--all`'s whole
 *  observable behaviour is its stdout, and the failure this guards against (a broken root, a
 *  broken predicate) is exactly the kind that a piecemeal import could mask by constructing
 *  inputs the real CLI invocation would not. */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { repoRoot } from '../../scripts/repoCorpus.mjs';
import { hasInternalGames } from '../helpers/repoLayout.js';

const ROOT = repoRoot();
const SCRIPT = path.join(ROOT, 'engine/scripts/show-refs.mjs');

/** ⚠️ The WHOLE suite is gated on `hasInternalGames()`, and the reason is that two of its
 *  assertions are UNSATISFIABLE in the public OSS snapshot — not merely tight.
 *
 *  A first version of this gate scaled the floors down instead, reasoning that "the snapshot is
 *  this repo minus `games/`". That model is wrong and it is worth writing down, because it
 *  produced three separate red gates across this change:
 *  `scripts/publish-engine-oss.sh` is **INCLUDE-ONLY** — `git ls-files -- engine build docs`, ~10
 *  named root files, and whatever `--with-demos` adds. So the snapshot is a small explicit subset,
 *  not a subtraction. MEASURED by assembling a real stage: `--all` prints **20** sections there
 *  (19 scenes), against a `TOTAL_FLOOR` of 20 — red by one — and on the `--push` release path,
 *  which ships no demos, **0** prefabs, which the non-vacuity pin below requires to be non-zero.
 *
 *  The unsatisfiable half: `assets.manifest.json` lives at the REPO ROOT and is not in the
 *  include list, so `loadManifest()` can never resolve in the snapshot and the manifest assertion
 *  cannot pass there however the floors are set. That is what makes gating right here rather than
 *  evasive — this is an internal dev tool being exercised end-to-end, and the snapshot has neither
 *  its manifest nor its corpus. Contrast `noNulBytesInSource`, where the guard IS meaningful on
 *  the snapshot and is therefore floored to clear it rather than gated off. */
const SCENE_FLOOR = 50;
const TOTAL_FLOOR = 100;

let stdout: string;
let sections: string[];

const INTERNAL = hasInternalGames();

beforeAll(() => {
  // The suite is skipped without internal games; do not spend a child process to prove it.
  if (!INTERNAL) return;
  stdout = execFileSync('node', [SCRIPT, '--all'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  sections = stdout.split('\n').filter((l) => l.startsWith('== '));
});

describe.skipIf(!INTERNAL)('show-refs.mjs --all (#805)', () => {
  it('reaches a floored count of scene files — well under the real count, so churn stays green', () => {
    const sceneSections = sections.filter((l) => l.includes('.scene.json'));
    expect(sceneSections.length).toBeGreaterThan(SCENE_FLOOR);
  });

  it('reaches a NON-ZERO count of prefab files — the non-vacuity pin this file never had', () => {
    // Before the fix this was 0 forever: the walk root was wrong AND prefabs would have been
    // found by the (correct) extension check if the root had been right, so a 0 here would have
    // meant the root regression specifically, not the scene/directory regression.
    const prefabSections = sections.filter((l) => l.includes('.prefab.json'));
    expect(prefabSections.length).toBeGreaterThan(0);
  });

  it('reaches a .scene.json fixture that lives OUTSIDE any scenes/ directory — the extension-vs-directory regression', () => {
    // These 9 files are the reason "key scenes by directory" was wrong even after the root was
    // fixed: engine/tests/e2e/fixtures/*.scene.json has no `scenes/` segment in its path at all.
    const hit = sections.some((l) => l.includes('e2e-smoke.scene.json'));
    expect(hit).toBe(true);
  });

  it('loadManifest() resolves — the manifest source line is non-null', () => {
    const manifestLine = stdout.split('\n').find((l) => l.startsWith('[show-refs] manifest:'));
    expect(manifestLine).toBeDefined();
    expect(manifestLine).not.toContain('(none found');
  });

  it('reaches a floored total well under the real count, so ordinary churn cannot turn this red', () => {
    expect(sections.length).toBeGreaterThan(TOTAL_FLOOR);
  });
});
