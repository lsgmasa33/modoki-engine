/** Unit cover for `pickHostProject` (engine/tests/e2e/hostProject.ts).
 *
 *  This exists because the project-less path — a release snapshot of the public OSS repo,
 *  which publishes `main` with NEITHER `games/` nor `demos/` — cannot be exercised on a dev
 *  clone: every clone here has at least one project on disk, so a Playwright run against
 *  the real filesystem never hits the `[]` case. This unit test is the only thing that
 *  covers it before the next release publish.
 */
import { describe, expect, it } from 'vitest';
import { pickHostProject, type HostProject } from '../e2e/hostProject';

describe('pickHostProject', () => {
  it('returns null for a project-less snapshot (the release-publish case)', () => {
    expect(pickHostProject([])).toBeNull();
  });

  it('falls back to a demos/ project when games/ is absent', () => {
    const demo: HostProject = { root: 'demos', name: 'forest-camp', dir: '/repo/demos/forest-camp' };
    expect(pickHostProject([demo])).toBe(demo);
  });

  it('prefers games/ over demos/ regardless of array order', () => {
    const demo: HostProject = { root: 'demos', name: 'forest-camp', dir: '/repo/demos/forest-camp' };
    const game: HostProject = { root: 'games', name: '3d-test', dir: '/repo/games/3d-test' };

    expect(pickHostProject([demo, game])).toBe(game);
    expect(pickHostProject([game, demo])).toBe(game);
  });
});
