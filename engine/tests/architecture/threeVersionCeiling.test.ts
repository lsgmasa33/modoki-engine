/** Guard: `three` stays BELOW the version that black-screens iOS. (#966, defending #956)
 *
 *  #956 measured `three@0.185.1` black-screening EVERY iOS device on first launch after a clean
 *  install, and pinned `three` to an exact `0.184.0` in the root `package.json`. That pin is the
 *  only thing between the engine and a shipped app that never draws a frame.
 *
 *  ⚠️ **Nothing could fail when it moved.** The ceiling existed as an exact pin whose MEANING was
 *  undocumented at the pin site, as prose in `.claude/skills/release-version/SKILL.md`, and — worst
 *  — as an argument to the CONTRARY in `docs/rendering.md`, which measured the r185 bump as a 67%
 *  cut in texture-memory growth and recommended it. Meanwhile `CLAUDE.md` § Tech Stack stated only
 *  a FLOOR (`>= r183`), and this package's own `peerDependencies` said `>=0.183.0` — a range that
 *  cheerfully permits the known-bad release.
 *
 *  ⚠️ **No gate in this repo can see the defect itself.** #956's repro is first-launch-after-clean-
 *  install only; a warm pipeline cache hides it. `npm run verify`, `verify:all`, both CI legs and
 *  both signed release builds were all green on the affected tree. So a version bump that reverts
 *  the pin ships green through everything — which is why the ceiling has to be asserted as a
 *  DECLARATION rather than caught as a behaviour.
 *
 *  **Why a test and not only a `dependabot.yml` ignore** (both landed; they cover disjoint vectors):
 *  Dependabot's version-update PRs are off (`open-pull-requests-limit: 0`), so an `ignore:` entry
 *  guards a dormant path gated on somebody re-enabling it. These are live today and it cannot touch
 *  any of them — `npm install three@latest` / `npm update`; a lockfile regeneration resolving
 *  against the peer range; another clone editing `package.json` without reading the release skill.
 *
 *  ⚠️ **`require('three/package.json')` THROWS** `ERR_PACKAGE_PATH_NOT_EXPORTED` — three's `exports`
 *  map does not expose it. The resolved-version check below reads the file through `createRequire`
 *  + `fs` for that reason. A `try/catch` around a `require` here would make this guard vacuous in
 *  the one direction that matters, so there is deliberately no catch: an unreadable `three` fails
 *  loudly rather than passing quietly.
 *
 *  **When #956 is fixed forward (#957), this guard goes RED.** That is the point — raising the
 *  ceiling is then one deliberate edit to `KNOWN_BAD_FLOOR` with a reason, not a drift. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import semver from 'semver';
import { REPO_ROOT } from '../helpers/repoLayout';

/** THE CEILING. The lowest `three` release known to black-screen iOS on first launch (#956).
 *
 *  Raising this is a DECISION — it needs an on-device clean-install check on a real iPhone, which
 *  is the only thing that can observe the defect (#957 exists for exactly that). Do not raise it to
 *  make a bump go green. */
const KNOWN_BAD_FLOOR = '0.185.0';

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

describe('three version ceiling (#966, defending #956)', () => {
  it('the INSTALLED three is below the iOS-black-screen floor', () => {
    // Covers every vector a manifest assertion cannot: `npm update`, `npm install three@latest`, a
    // lockfile regeneration, or a merge that took someone else's bump.
    const installed = resolvedThreeVersion();
    expect(
      semver.lt(installed, KNOWN_BAD_FLOOR),
      `three@${installed} is at or above ${KNOWN_BAD_FLOOR}, which black-screens EVERY iOS device `
      + 'on first launch after a clean install (#956). No gate in this repo can observe that — it '
      + 'reproduces only on a cold install on a real device — so this declaration is the guard. '
      + 'If the fix-forward (#957) has landed and been verified on an iPhone, raise KNOWN_BAD_FLOOR '
      + 'deliberately; do not widen the pin to make this pass.',
    ).toBe(true);
  });

  it.each(DECLARATION_SITES)('$file cannot resolve three at or above the floor', ({ file, field }) => {
    const declared = readJson(file)[field]?.three;
    expect(declared, `${file} no longer declares three under "${field}" — this guard has gone blind`)
      .toBeTruthy();
    expect(
      semver.subset(declared, `<${KNOWN_BAD_FLOOR}`),
      `${file} declares three as "${declared}" (${field}), which permits ${KNOWN_BAD_FLOOR} and `
      + `above. Narrow it — e.g. ">=0.183.0 <${KNOWN_BAD_FLOOR}" — so a lockfile regeneration or a `
      + 'fresh resolve cannot land on the known-bad release (#956).',
    ).toBe(true);
  });

  it('THE PROBE DETECTS THE POSITIVE CASE — the known-bad version is actually rejected', () => {
    // ⚠️ Without this, all three assertions above would still pass if `KNOWN_BAD_FLOOR` were set to
    // something absurd like '99.0.0': every real version is below it and every real range is a
    // subset of `<99.0.0`. That is a guard that cannot fire, dressed as a guard that passes. Pin
    // the constant against the version #956 actually measured.
    expect(semver.lt('0.185.1', KNOWN_BAD_FLOOR)).toBe(false);
    expect(semver.subset('>=0.183.0', `<${KNOWN_BAD_FLOOR}`)).toBe(false);
    expect(semver.subset(`>=0.183.0 <${KNOWN_BAD_FLOOR}`, `<${KNOWN_BAD_FLOOR}`)).toBe(true);
  });
});
