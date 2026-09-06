/** Guard: no COMMITTED project config carries a private build field, and no `project.user.json`
 *  is tracked at all.
 *
 *  #172 moved five owner-private values (`PRIVATE_BUILD_FIELDS` — Apple Team ID, the internal
 *  deploy buckets, the deploy command) out of the committed `project.config.json` and into a
 *  gitignored per-project `project.user.json`, overlaid back at load time. The invariant that
 *  migration established is the one asserted here: **a tracked file never holds one of those
 *  values.**
 *
 *  Why this needs a test in the FAST gate, when `publish-engine-oss.sh` already checks it:
 *
 *  - That script is **hub-only** (bash + rsync, and only the hub publishes), so a worker clone
 *    can commit and push a re-leak with nothing objecting. The leak then surfaces on `main`,
 *    after the merge — twice already, per CLAUDE.md: a real Team ID in a test fixture, then three
 *    real device UDIDs in the #143 fixture. Both rode a branch that forked BEFORE the privacy
 *    fix, and git presents the un-scrubbed side as newer, so **the merge resolves toward the
 *    leak**. `npm test` runs on every clone; this is the earliest place the class can be caught.
 *  - The publish guard also only sees what the SNAPSHOT ships. `games/` never ships, so a Team ID
 *    reintroduced into `games/<id>/project.config.json` is invisible to it — and is exactly what
 *    a stale branch merge produces. This test reads the repo, not the snapshot.
 *
 *  What it deliberately does NOT do: hunt for the owner's real values by pattern. A real Apple
 *  Team ID is `[A-Z0-9]{10}` and so are the fixtures' own fakes (`ABCDE12345`, `REALTEAM99`,
 *  `EXTTEAM123`), so shape cannot separate them without an allowlist every new test would be
 *  appended to. It asserts the STRUCTURAL invariant instead — the field is blank or absent —
 *  which needs no knowledge of the real value and so runs identically on CI and on a fresh clone.
 *  Catching a real ID pasted into prose remains the hub's `verify:publish` job (#178). */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIVATE_BUILD_FIELDS } from '../../project-config';
import { REPO_ROOT, hasAnyProject, hasInternalGames } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const repoRoot = REPO_ROOT;

/** The non-vacuity floor is LAYOUT-DEPENDENT, and getting that wrong is this repo's
 *  best-documented test trap. Gate on the shared predicates rather than hand-rolling a
 *  presence check (`projectPresencePredicate.test.ts` enforces that).
 *
 *  There are THREE layouts, not two — the distinction that cost the v0.4.0 release its first
 *  publish attempt, exactly as docs/engine-oss-publishing.md warns:
 *
 *    dev clone   games/ + demos/   ~24 configs   floor 10
 *    `ci/main`   demos only          4 configs   floor  3   (2 demos + the two engine-owned ones)
 *    `main`      neither             2 configs   floor  2   (release snapshot — no projects at all)
 *
 *  The two that survive every layout are `engine/templates/starter/` and the testbed fixture:
 *  engine-owned, so no project deletion can drop the count below 2. That makes 2 a real floor
 *  rather than a slack one — an engine-side rename WILL trip it, which is the review this guard
 *  is for. A two-branch floor read `>= 3` on the release layout and could not be satisfied by a
 *  snapshot that ships no projects by design. */
const CONFIG_FLOOR = hasInternalGames() ? 10 : hasAnyProject() ? 3 : 2;

// `includeUntracked: false` — this guard's whole subject is what a COMMITTED file holds (a value
// that leaks reaches other clones and the public snapshot only once it is tracked); an uncommitted
// edit is not yet a leak anyone else can pull. Preserves this guard's original tracked-only
// `git ls-files` behaviour.
const trackedMatching = (match: RegExp): string[] =>
  repoFiles({ match, floor: 0, includeUntracked: false }).map((f) => f.rel);

describe('private build fields never reach a committed file (#172)', () => {
  const configs = trackedMatching(/(^|\/)project\.config\.json$/);

  it('finds project configs to check — a vacuous pass is a failure', () => {
    // Not a formality. This guard's whole value is that it ran; if the glob stops matching
    // (a rename, a layout change) every assertion below passes by checking nothing, and the
    // green tick is indistinguishable from an honest one. Each floor sits at or under its real
    // count (24 dev / 4 ci-main / 2 release) so deleting a project is not a false red.
    expect(configs.length).toBeGreaterThanOrEqual(CONFIG_FLOOR);
  });

  it.each(PRIVATE_BUILD_FIELDS)('no committed project.config.json sets build.%s', (field) => {
    const offenders = configs.filter((rel) => {
      const raw = readFileSync(join(repoRoot, rel), 'utf8');
      // An unparseable config is a failure, not a skip: one this guard cannot read is one it
      // cannot clear, and skipping it silently is the no-op the guard exists to prevent.
      const parsed = JSON.parse(raw) as { build?: Record<string, unknown> };
      const value = parsed.build?.[field];
      return typeof value === 'string' && value.trim() !== '';
    });
    expect(offenders, `${field} must live in the gitignored project.user.json, not a committed config`).toEqual([]);
  });

  it('no project.user.json is tracked by git', () => {
    // `.gitignore` covers it, but `git add -f` overrides that — and the snapshot manifest is built
    // from `git ls-files`, so a force-added one WOULD ship. This is the file where the real values
    // live, so its presence in the index is itself the leak, whatever it happens to contain.
    expect(trackedMatching(/(^|\/)project\.user\.json$/)).toEqual([]);
  });
});

/** The SECOND home of the Apple Team ID, and the one #172 never reached: the Xcode project.
 *
 *  `healNativeConfig` writes `build.appleTeamId` into `ios/App/App.xcodeproj/project.pbxproj` as
 *  `DEVELOPMENT_TEAM`, because that file is the BUILD INPUT — signing genuinely needs the value
 *  there, so the #172 trick (keep the committed copy blank, overlay at load) does not transfer.
 *  The pbxproj is also tracked. So the value lands in a committed file by design, and the guard
 *  above cannot see it: it reads `project.config.json`, never a pbxproj.
 *
 *  Found 2026-08-18 while healing a manifest change across every project — the sweep ran the WHOLE
 *  heal, silently planting the owner's real Team ID in a publishable demo's pbxproj. Four such
 *  lines already existed in `demos/2d-physics-demo` + `demos/3d-physics-demo`, committed and green.
 *
 *  Scoped to `demos/` deliberately, and NOT widened to `games/`:
 *
 *  - **`demos/` is the publishable set.** Its whole point is that it can be pushed to a public repo.
 *  - **`games/` never ships** (the snapshot drops it by construction), and the owner signs those
 *    projects from this machine — blanking them would fight the workflow the heal exists to serve,
 *    to protect content that has no publish path. 14 committed Team IDs live there on purpose.
 *
 *  This is NOT the thing standing between the value and a public repo — both publish scripts delete
 *  `ios/` from the stage and verify the deletion, and `publish-engine-oss.sh` step 3b3 greps the
 *  whole stage for the real IDs. It closes the gap those leave: 3b3 is hub-only AND skips when the
 *  gitignored `project.user.json` is absent (so the public CI run never greps at all), and the
 *  `ios/`-drop only protects a demo published WITHOUT native. The moment someone publishes a demo
 *  with its Xcode project — a plausible ask — the incidental protection is gone. `npm test` runs on
 *  every clone.
 *
 *  Reads the INDEX, not the working tree, and that distinction is load-bearing: the heal legitimately
 *  refills the working-tree copy whenever a demo with a local Team ID is opened or built, so a
 *  working-tree read would go red on ordinary work and get muted. What matters is what is about to
 *  be COMMITTED. */
describe('a demo never commits an Apple Team ID in its Xcode project', () => {
  const pbxprojs = trackedMatching(/^demos\/[^/]+\/ios\/(?:.*\/)?project\.pbxproj$/);

  // ⚠️ The FLOOR is layout-gated; the ASSERTION below is NOT, and that split is the point.
  //
  // Gating the whole describe on `hasInternalGames()` was the first version, and it is exactly the
  // proxy mistake `repoLayout.ts` documents ("gate on the thing the test actually needs, not on a
  // proxy that happens to correlate with it today"). What this guard needs is *demo pbxproj files
  // in the index*; `hasInternalGames()` answers a question about `games/`. The two agree on all
  // three layouts that exist today — and disagree on precisely the one this guard exists for: a
  // snapshot shipping demos WITH their Xcode projects, no games. There the proxy reads false and
  // the guard would have switched itself off in the only situation where the Team ID could ship.
  //
  // So: an empty list makes the assertion trivially pass (correct — nothing to check), while the
  // non-vacuity floor runs only where a real count is knowable.
  it.skipIf(!hasInternalGames())('finds demo Xcode projects to check — a vacuous pass is a failure', () => {
    // Six demos carry native today. The floor sits under that so deleting one is not a false red,
    // but above zero so a path/rename change cannot switch the guard off silently.
    expect(pbxprojs.length).toBeGreaterThanOrEqual(4);
  });

  it('every committed demo pbxproj has a blank DEVELOPMENT_TEAM', () => {
    const offenders: string[] = [];
    for (const rel of pbxprojs) {
      // `git show :<path>` is the staged content — what a commit from here would record.
      const staged = execFileSync('git', ['show', `:${rel}`], {
        cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      for (const line of staged.split('\n')) {
        const m = line.match(/DEVELOPMENT_TEAM = (.+);\s*$/);
        // Structural, like the guard above: anything that is not the empty string is a finding,
        // so this needs no knowledge of the owner's real IDs and behaves the same on every clone.
        if (m && m[1].trim() !== '""') offenders.push(`${rel}: ${m[1].trim()}`);
      }
    }
    expect(
      offenders,
      'a demo is publishable — its Team ID belongs in the gitignored project.user.json, which healNativeConfig applies locally',
    ).toEqual([]);
  });
});
