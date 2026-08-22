/** Picks the project a generated-fixture E2E spec should host its scratch assets in.
 *
 *  Several specs (editor-particles, editor-model-import, editor-unfocused-field-commits)
 *  generate their own fixture (a synthetic particle effect, a GLB, a PNG) at test time and
 *  need only *a* served project asset root to drop it under — never a specific game's real
 *  content. This is the shared pick, so the WHY lives in one place instead of being
 *  duplicated across every spec that needs it.
 *
 *  games/ is PREFERRED over demos/ deliberately: both work, but demos/ is the published
 *  set, so a crash between `beforeAll` and `afterAll` would strand the fixture dir inside
 *  a project that gets snapshotted to a public repo. Where there is a private project to
 *  use, use it.
 *
 *  Returns `null` — never throws — when there is no project at all: a release snapshot of
 *  the public OSS repo publishes to `main` with NO projects (`games/` and `demos/` are both
 *  absent; only the `ci/main` publish uses `--with-demos`). These specs used to derive their
 *  host project at MODULE SCOPE and `throw` when none existed, which kills Playwright's
 *  COLLECTION for the entire run — not just these specs. Returning `null` lets the caller
 *  `test.skip` instead.
 */

import { discoverProjects } from '../../scripts/projectRoots.mjs';

export interface HostProject {
  root: string;
  name: string;
  dir: string;
}

/** Call with no arguments from a spec — the default does the discovery, so a spec never touches
 *  `discoverProjects` itself and cannot reintroduce a module-scope throw. `projectPresencePredicate`
 *  enforces that. The parameter exists so the project-less case (`[]`) is unit-testable on a clone
 *  that always HAS projects — the only way to cover the path this file exists for. */
export function pickHostProject(
  projects: HostProject[] = discoverProjects(process.cwd()) as HostProject[],
): HostProject | null {
  return projects.find((p) => p.root === 'games') ?? projects[0] ?? null;
}
