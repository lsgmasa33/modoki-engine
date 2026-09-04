/** Guard: the `uuid`/`nanoid` transitive-dep pins documented in docs/native-and-sdks.md §
 *  "Pinned transitive deps" actually hold across the tree.
 *
 *  `@capacitor/cli` -> `xcode` -> `uuid@^7.0.3` is vulnerable and upstream will not fix it
 *  (`xcode@latest` still pins `uuid ^7`), so every project that depends on `@capacitor/cli` must
 *  carry an `overrides.uuid` pin to `^11.1.1`. `postcss` -> `nanoid@^3.3.16` is the sibling case
 *  (vulnerable, fixed in 3.3.17), pinned at the repo root and in `site/`.
 *
 *  This test exists because the doc's own postmortem says the drift was invisible the first time:
 *  "the drift was invisible because the doc asserted the invariant instead of the re-check command
 *  proving it" (#177) — seven projects were missing the `uuid` pin while the doc claimed every
 *  project had it. Nothing under `engine/tests/` proved the invariant, so the doc's re-check
 *  command (below, assertion (a)) had to be run BY HAND to catch a recurrence. It recurred:
 *  `games/iap-test` shipped with no `overrides` block at all and its lockfile resolved `uuid` at
 *  7.0.3, discovered and fixed alongside this test.
 *
 *  Two assertions, matching the doc's two layers:
 *   (a) RESOLUTION FLOOR (ground truth) — no tracked package-lock.json may actually resolve a
 *       known-vulnerable pinned version. This is the doc's own re-check command, verbatim.
 *   (b) STRUCTURAL DECLARATION (catches it earlier) — every tracked package.json that depends on
 *       `@capacitor/cli` must declare `overrides.uuid`. Deliberately `uuid`-only: the `nanoid`
 *       pin's owning parents (vite/vitest/vitepress) are not uniform across projects the way
 *       `@capacitor/cli` is, so a structural rule there would be wrong.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, hasInternalGames } from '../helpers/repoLayout';

const repoRoot = REPO_ROOT;

/** Vacuity floors are a premise about the TREE'S SHAPE, not about the invariant, and the two trees
 *  this suite runs in have very different shapes. The private repo ships `games/` + `demos/`
 *  (29 tracked lockfiles, 42 `package.json`, of which 23 depend on `@capacitor/cli`);
 *  `scripts/publish-engine-oss.sh` assembles a public snapshot that drops `games/` entirely and
 *  strips each demo's `packages/`+`plugins/` AND its lockfile — measured at 4 lockfiles and 12
 *  `package.json`, of which 3 declare `@capacitor/cli` (all correctly pinned). A single hardcoded
 *  floor of 10 therefore passes here and fails the public gate, which is exactly what it did on
 *  this test's first `verify:publish`.
 *
 *  So gate on `hasInternalGames()` — the thing that actually makes 10 the right number — rather
 *  than dropping the floor to something both trees satisfy, which would make it vacuous where it
 *  matters most. Both branches keep a REAL floor: a broken glob or a renamed helper still fails
 *  loudly in either tree. This is repoLayout.ts's standing lesson ("gate on the thing the test
 *  actually needs, not on a proxy that happens to correlate with it today") applied to a count. */
const LOCKFILE_FLOOR = hasInternalGames() ? 10 : 3;
const PACKAGE_JSON_FLOOR = hasInternalGames() ? 10 : 5;

/** DETECTION floors (as opposed to the two FILE-COUNT floors above): these prove the detector
 *  itself still matches something, not merely that enumeration found files. Both a lockfile
 *  resolving `uuid` and a manifest depending on `@capacitor/cli` are private-tree facts — the
 *  public snapshot's composition isn't stable enough to floor (its 4 lockfiles / 12 package.json
 *  are a moving target of whichever demos happen to be published) and every real project lives in
 *  the private tree anyway — so, like the file-count floors, gate on `hasInternalGames()` and only
 *  apply in the private tree. Measured today (private tree): 13 of 29 tracked lockfiles resolve a
 *  `uuid` entry; 23 of 42 tracked package.json depend on `@capacitor/cli`. Both floors sit
 *  comfortably under their measured count. */
const UUID_LOCKFILE_DETECTION_FLOOR = 8;
const CLI_MANIFEST_DETECTION_FLOOR = 15;

const tracked = (...args: string[]): string[] =>
  execFileSync('git', ['ls-files', ...args], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

/** `package-lock.json`'s `packages` map keys look like `"node_modules/foo/node_modules/uuid"` — the
 *  installed package name is whatever follows the LAST `node_modules/` segment. */
function lastSegmentAfterNodeModules(pkgKey: string): string {
  return pkgKey.split('node_modules/').pop() ?? pkgKey;
}

/** The leading major of a semver RANGE (`^11.1.1` -> 11, `>=12.0.0` -> 12), or NaN if it does not
 *  start with one. Assertion (b) checks a FLOOR rather than string-equality against `^11.1.1`: a
 *  future bump to a still-safe `^12` is a correct fix, and a guard that reddens on it would be
 *  pinning the gate to a measurement instead of to the invariant. */
function rangeMajor(range: unknown): number {
  return typeof range === 'string' ? parseInt(range.replace(/^[^0-9]*/, ''), 10) : NaN;
}

/** Parses a plain `major.minor.patch` version string into a 3-tuple, treating any missing or
 *  non-numeric segment as 0. The tracked lockfiles here only ever resolve plain numeric versions
 *  (no pre-release suffixes), so this doesn't need to be a full semver parser. */
function parseVersionTriple(version: string): [number, number, number] {
  const [major, minor, patch] = version.split('.').map((p) => parseInt(p, 10));
  return [major || 0, minor || 0, patch || 0];
}

/** True when `version` is strictly earlier than `floor` (both `major.minor.patch`), comparing
 *  numerically rather than lexicographically (`3.3.9` < `3.3.10`, which string comparison gets
 *  wrong). Used instead of a fixed-window regex: `/^3\.3\.(?:[0-9]|1[0-6])$/` flagged only
 *  3.3.0-3.3.16 and silently passed every version BELOW that window (3.1.30, 3.2.0, 2.1.11 —
 *  all equally vulnerable), which made the test's own "no tracked lockfile resolves a
 *  known-vulnerable pinned version" name false by construction. A real "earlier than the fixed
 *  version" comparison also naturally leaves 4.x/5.x alone (they compare greater, not "within a
 *  window"), so no separate major-version carve-out is needed. */
function versionBelow(version: string, floor: string): boolean {
  const v = parseVersionTriple(version);
  const f = parseVersionTriple(floor);
  for (let i = 0; i < 3; i++) {
    if (v[i] !== f[i]) return v[i] < f[i];
  }
  return false;
}

describe('pinned transitive deps (uuid/nanoid) — docs/native-and-sdks.md § "Pinned transitive deps" (#177)', () => {
  describe('(a) resolution floor — no tracked lockfile resolves a known-vulnerable pinned version', () => {
    const lockfiles = tracked('*package-lock.json');

    it('finds lockfiles to check — a vacuous pass is a failure', () => {
      // Floor well under the real count for whichever tree this is (29 private / 4 snapshot), so
      // only a broken enumeration (a rename, a glob typo) trips it, not a project being deleted.
      expect(lockfiles.length).toBeGreaterThanOrEqual(LOCKFILE_FLOOR);
    });

    // DETECTION floor (private tree only — the public snapshot's composition isn't stable enough
    // to floor, and every project lives in the private tree anyway). Neither vacuity floor above
    // proves the DETECTOR still matches anything: `dependsOnCli`/the `uuid` name check could go
    // stale (a Capacitor 9 rename, a lockfile shape change) and every offenders-list assertion
    // would pass vacuously forever, silently disabling the whole guard. This asserts the detector
    // itself still fires on real data. Measured today (private tree): 13 of 29 tracked lockfiles
    // resolve at least one `uuid` entry — floor set comfortably under that.
    it.skipIf(!hasInternalGames())('finds at least one uuid-resolving lockfile — a vacuous pass means the detector stopped matching', () => {
      const uuidLockfileCount = lockfiles.filter((rel) => {
        const raw = readFileSync(join(repoRoot, rel), 'utf8');
        const json = JSON.parse(raw) as { packages?: Record<string, { version?: string }> };
        return Object.keys(json.packages ?? {}).some((key) => lastSegmentAfterNodeModules(key) === 'uuid');
      }).length;
      expect(uuidLockfileCount).toBeGreaterThanOrEqual(UUID_LOCKFILE_DETECTION_FLOOR);
    });

    it('every tracked package-lock.json resolves uuid >= 11 and nanoid >= 3.3.17', () => {
      const offenders: string[] = [];
      for (const rel of lockfiles) {
        // Read + JSON.parse rather than require(): keeps this fast on large lockfiles and avoids
        // populating node's require cache with dozens of multi-MB JSON files.
        const raw = readFileSync(join(repoRoot, rel), 'utf8');
        const json = JSON.parse(raw) as { packages?: Record<string, { version?: string }> };
        for (const [key, entry] of Object.entries(json.packages ?? {})) {
          const name = lastSegmentAfterNodeModules(key);
          const version = entry.version;
          if (!version) continue;
          if (name === 'uuid' && parseInt(version, 10) < 11) {
            offenders.push(`${rel}: ${key} resolves uuid@${version} (< 11) — the pinned ` +
              `"@capacitor/cli" -> "xcode" -> "uuid@^7.0.3" vulnerability. Add/refresh the ` +
              `"overrides": { "uuid": "^11.1.1" } pin (see docs/native-and-sdks.md § "Pinned ` +
              `transitive deps") and re-run \`npm install --package-lock-only --ignore-scripts\`. ` +
              `Run a plain \`npm install\` there FIRST — on a stale node_modules it poisons ` +
              `vendored plugins (docs/build.md, #685).`);
          }
          if (name === 'nanoid' && versionBelow(version, '3.3.17')) {
            offenders.push(`${rel}: ${key} resolves nanoid@${version} (vulnerable, fixed in ` +
              `3.3.17) — pin "overrides": { "nanoid": "^3.3.17" } (see docs/native-and-sdks.md § ` +
              `"Pinned transitive deps") and re-run \`npm install --package-lock-only --ignore-scripts\`. ` +
              `Run a plain \`npm install\` there FIRST — on a stale node_modules it poisons ` +
              `vendored plugins (docs/build.md, #685).`);
          }
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  });

  describe('(b) structural declaration — every @capacitor/cli-dependent package.json pins overrides.uuid', () => {
    // No carve-outs on purpose. An earlier draft skipped `*/plugins/*`, which matched nothing
    // tracked — an exemption covering no citation reads as enforcement and enforces nothing, the
    // failure mode docCitations.test.ts checks its own allowlists in both directions to avoid.
    const packageJsons = tracked('*package.json');

    it('finds package.json files to check — a vacuous pass is a failure', () => {
      // Floor well under the real count for whichever tree this is (42 private / 12 snapshot).
      expect(packageJsons.length).toBeGreaterThanOrEqual(PACKAGE_JSON_FLOOR);
    });

    // DETECTION floor (private tree only) — mirrors the lockfile detection floor in (a) above:
    // neither vacuity floor proves `dependsOnCli` still matches anything real, so a renamed
    // `@capacitor/cli` package (a Capacitor 9 rename, say) would make it false for all 42
    // manifests and the offenders-list assertion below would pass vacuously forever. Measured
    // today (private tree): 23 of 42 tracked package.json depend on @capacitor/cli.
    it.skipIf(!hasInternalGames())('finds at least one @capacitor/cli-dependent manifest — a vacuous pass means the detector stopped matching', () => {
      const cliManifestCount = packageJsons.filter((rel) => {
        try {
          const parsed = JSON.parse(readFileSync(join(repoRoot, rel), 'utf8')) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          return !!parsed.dependencies?.['@capacitor/cli'] || !!parsed.devDependencies?.['@capacitor/cli'];
        } catch {
          return false; // unparseable — assertion (b) below flags it separately as an offender
        }
      }).length;
      expect(cliManifestCount).toBeGreaterThanOrEqual(CLI_MANIFEST_DETECTION_FLOOR);
    });

    it('every package.json depending on @capacitor/cli declares overrides.uuid at major >= 11', () => {
      const offenders: string[] = [];
      for (const rel of packageJsons) {
        const raw = readFileSync(join(repoRoot, rel), 'utf8');
        let parsed: {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          overrides?: Record<string, unknown>;
        };
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          // Backwards from assertion (a), which throws loudly on a parse failure: an unparseable
          // package.json used to `continue` here — silently EXEMPTING it from a security
          // requirement instead of flagging it. Whether it depends on @capacitor/cli can't be
          // known without parsing it, so treat "can't verify" as an offender, not a pass.
          offenders.push(
            `${rel}: could not be parsed as JSON, so its @capacitor/cli / overrides.uuid pin ` +
              `could not be verified (${(e as Error).message}) — fix the malformed package.json.`,
          );
          continue;
        }
        const dependsOnCli =
          !!parsed.dependencies?.['@capacitor/cli'] || !!parsed.devDependencies?.['@capacitor/cli'];
        if (!dependsOnCli) continue;
        const pinned = parsed.overrides?.uuid;
        if (!(rangeMajor(pinned) >= 11)) {
          offenders.push(
            `${rel}: depends on @capacitor/cli (-> xcode -> uuid@^7.0.3, vulnerable) but ` +
              `${pinned === undefined ? 'declares no "overrides".uuid pin' : `pins uuid at ${JSON.stringify(pinned)}, which does not exclude the vulnerable majors`}. ` +
              `Add "overrides": { "uuid": "^11.1.1" }, per docs/native-and-sdks.md § "Pinned ` +
              `transitive deps".`,
          );
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  });
});
