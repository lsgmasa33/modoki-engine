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

const tracked = (...args: string[]): string[] =>
  execFileSync('git', ['ls-files', ...args], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

describe('private build fields never reach a committed file (#172)', () => {
  const configs = tracked('*project.config.json', 'project.config.json');

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
    expect(tracked('*project.user.json', 'project.user.json')).toEqual([]);
  });
});
