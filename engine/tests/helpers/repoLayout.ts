/**
 * Repo-layout predicates for tests that depend on something the PUBLIC engine snapshot
 * (lsgmasa33/modoki-engine) does not ship — private agent tooling, the `oss/` publish
 * overlay, or real `games/`/`demos/` project content.
 *
 * A test that assumes one of these is present must gate on the matching predicate here
 * (`describe.skipIf`/`it.skipIf`) rather than hand-rolling its own `fs.existsSync` check —
 * ONE implementation means a broken predicate breaks loudly in ONE place
 * (`repoLayoutGuard.test.ts`) instead of silently going wrong in every test that copied it.
 *
 * CRITICAL: a predicate that is accidentally always false disables its guarded tests in
 * THIS (private) repo too, and a test that never runs looks exactly like a test that
 * passes. `repoLayoutGuard.test.ts` is the tripwire against exactly that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from '../../scripts/projectRoots.mjs';

/** Walk up from this file's own location (not `process.cwd()`, which varies with how the
 *  test runner was invoked) until we find the repo root: a directory holding BOTH a
 *  `package.json` and the `engine/` tree.
 *
 *  Deliberately does NOT key on the package NAME. `scripts/publish-engine-oss.sh` rewrites
 *  it from `modoki-app` to `modoki-engine` when it assembles the public snapshot, so a name
 *  check resolves here and throws there — which is exactly what happened on the public CI's
 *  first run with this helper. The structural marker holds in both repos.
 *
 *  Throws rather than guessing: a helper that silently resolved to the wrong root would make
 *  every predicate below lie, and a predicate that lies switches tests off without a word. */
function findRepoRoot(): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'engine'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repoLayout: could not locate the repo root by walking up from ${start}`);
}

export const REPO_ROOT = findRepoRoot();

/** True when this checkout has the private agent-CLI configs (`.mcp.json` and its
 *  generated siblings) — i.e. this is a developer clone, not the public engine snapshot. */
export function hasPrivateTooling(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, '.mcp.json'));
}

/** True when the `oss/` publish overlay (the workflows rewritten onto the public repo by
 *  `scripts/publish-engine-oss.sh`) is present in this checkout. */
export function hasOssOverlay(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, 'oss', '.github', 'workflows'));
}

/** True when at least one real project exists under `games/` or `demos/` — the public
 *  engine snapshot ships neither, so every audit that polices actual game content is
 *  meaningless (and would false-fail on an empty walk) without this. */
export function hasRealProjects(): boolean {
  return discoverProjects(REPO_ROOT).length > 0;
}
