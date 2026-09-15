/** Guard: `three` stays within the releases VERIFIED on a device by QA-RENDER-0008. (#966, #957)
 *
 *  History, because the constant's meaning changed. #956 measured `three@0.185.1` black-screening
 *  every iOS device on the first launch after a clean install, and #966 pinned `three` below r185
 *  behind this guard. #957 then found the cause was the ENGINE's — two of its own async shader
 *  compiles overlapping on one renderer — and measured the same overlap on 0.184.0 as well (it
 *  escaped there only because the overlap lasted 1.5 s instead of 5.8 s). So there is no known-bad
 *  three release any more; what remains true is the thing that made #956 ship:
 *
 *  ⚠️ **No automated gate in this repo can see this class of defect.** It needs a COLD pipeline
 *  cache — a clean install on a real device. `npm run verify`, `verify:all`, both CI legs and both
 *  signed release builds were all green on the affected tree. The one check that observes it is
 *  QA-RENDER-0008 (`qa/cases/rendering/ios-clean-install-postfx-first-launch.md`), run by hand on
 *  the iPad. So a three bump is asserted as a DECLARATION: the ceiling is the first release that
 *  has NOT been through that run, and raising it is a deliberate edit made after the run passes.
 *
 *  **Why a test and not only a `dependabot.yml` ignore** (both exist; they cover disjoint vectors):
 *  Dependabot's version-update PRs are off (`open-pull-requests-limit: 0`), so an `ignore:` entry
 *  guards a dormant path gated on somebody re-enabling it. These are live today and it cannot touch
 *  any of them — `npm install three@latest` / `npm update`; a lockfile regeneration resolving
 *  against the peer range; another clone editing `package.json`.
 *
 *  ⚠️ **`require('three/package.json')` THROWS** `ERR_PACKAGE_PATH_NOT_EXPORTED` — three's `exports`
 *  map does not expose it. The resolved-version check below reads the file through `createRequire`
 *  + `fs` for that reason. A `try/catch` around a `require` here would make this guard vacuous in
 *  the one direction that matters, so there is deliberately no catch. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import semver from 'semver';
import { REPO_ROOT, hasQaSuite } from '../helpers/repoLayout';

/** THE CEILING (exclusive): the first `three` release NOT yet verified by QA-RENDER-0008.
 *
 *  0.185.1 passed on 2026-09-15 (#957). ⚠️ 0.186.0 is not merely unverified — it is measured BAD:
 *  its GTAONode samples the depth with `textureGather`, which WGSL has no overload for on a
 *  multisampled depth texture, so every AO pass under MSAA (the high tier) fails to compile. It
 *  passed the clean-install launch, then broke at `demos/postfx-demo`'s AO station — seen on a WARM
 *  relaunch on the iPad and in desktop Chromium (`docs/rendering.md` § "three r185 → r186").
 *  ⚠️ The range still admits 0.183.x–0.185.0; only 0.185.1 itself went through QA-RENDER-0008 with
 *  the #957 fix. The bound is the ceiling, not a list of verified releases. Raising this is a DECISION
 *  made after that case passes on the iPad against the new version — never to make a bump go green. */
const UNVERIFIED_FLOOR = '0.186.0';

/** The QA case whose passing run is what licenses raising the ceiling. Checked to exist, so the
 *  pointer every failure message gives cannot rot silently. */
const GATE_CASE = 'qa/cases/rendering/ios-clean-install-postfx-first-launch.md';

/** Every place the `three` version constraint is DECLARED. Both must exclude the ceiling — the root
 *  pin is what the monorepo installs, and the peer range is what a lockfile regeneration resolves
 *  against, so a ceiling in only one of them is a ceiling that a `rm package-lock.json` walks past. */
const DECLARATION_SITES = [
  { file: 'package.json', field: 'dependencies' },
  { file: 'engine/packages/modoki/package.json', field: 'peerDependencies' },
] as const;

function readJson(rel: string): Record<string, Record<string, string>> {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
}

/** The version actually on disk. Read via `createRequire().resolve` + `fs` — see the header note on
 *  why `require('three/package.json')` cannot be used. Resolving the ENTRY point and walking up to
 *  its package root is what makes this immune to the `exports` map. */
function resolvedThreeVersion(): string {
  const req = createRequire(path.join(REPO_ROOT, 'package.json'));
  // `three` resolves to build/three.core.js (or similar) — walk up to the dir holding package.json.
  let dir = path.dirname(req.resolve('three'));
  for (let i = 0; i < 8; i++) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as { name?: string; version?: string };
      if (pkg.name === 'three' && pkg.version) return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not read the installed three package.json — this guard cannot answer, which is a '
    + 'failure and not a pass. Run `npm install` and re-run.',
  );
}

const HOW_TO_RAISE = `Run QA-RENDER-0008 (${GATE_CASE}) on the iPad against the new version first — a `
  + 'clean-install first launch is the only thing that observes this defect class (#956, #957) — '
  + 'then raise UNVERIFIED_FLOOR deliberately. Do not widen the range to make this pass.';

describe('three version ceiling (#966, #957)', () => {
  it('the INSTALLED three is below the first release the clean-install device gate has not passed', () => {
    // Covers every vector a manifest assertion cannot: `npm update`, `npm install three@latest`, a
    // lockfile regeneration, or a merge that took someone else's bump.
    const installed = resolvedThreeVersion();
    expect(
      semver.lt(installed, UNVERIFIED_FLOOR),
      `three@${installed} is at or above ${UNVERIFIED_FLOOR}, which no clean-install device run has `
      + `verified. ${HOW_TO_RAISE}`,
    ).toBe(true);
  });

  it.each(DECLARATION_SITES)('$file cannot resolve an unverified three', ({ file, field }) => {
    const declared = readJson(file)[field]?.three;
    expect(declared, `${file} no longer declares three under "${field}" — this guard has gone blind`)
      .toBeTruthy();
    expect(
      semver.subset(declared, `<${UNVERIFIED_FLOOR}`),
      `${file} declares three as "${declared}" (${field}), which permits ${UNVERIFIED_FLOOR} and above. `
      + `Bound it — e.g. ">=0.183.0 <${UNVERIFIED_FLOOR}". ${HOW_TO_RAISE}`,
    ).toBe(true);
  });

  // qa/ is not staged into the public snapshot, so the case can only be checked where it ships.
  it.skipIf(!hasQaSuite())('the gate case every message points at exists', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, GATE_CASE)), `${GATE_CASE} is gone — repoint GATE_CASE`)
      .toBe(true);
  });

  it('THE PROBE DETECTS THE POSITIVE CASE — an unverified version is actually rejected', () => {
    // ⚠️ Without this, the assertions above would still pass if `UNVERIFIED_FLOOR` were set to
    // something absurd like '99.0.0': every real version is below it and every real range is a
    // subset of `<99.0.0`. That is a guard that cannot fire, dressed as a guard that passes. Pin it
    // against the release immediately above the verified one.
    expect(semver.lt('0.186.0', UNVERIFIED_FLOOR)).toBe(false);
    expect(semver.lt('0.185.1', UNVERIFIED_FLOOR)).toBe(true);
    expect(semver.subset('>=0.183.0', `<${UNVERIFIED_FLOOR}`)).toBe(false);
    expect(semver.subset(`>=0.183.0 <${UNVERIFIED_FLOOR}`, `<${UNVERIFIED_FLOOR}`)).toBe(true);
  });
});
