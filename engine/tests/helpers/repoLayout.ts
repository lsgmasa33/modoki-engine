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
import { execFileSync } from 'node:child_process';
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

/** True when the root `scripts/` publish tooling (`publish-engine-oss.sh`, `publish-demo.sh`
 *  and their helpers) is present in this checkout.
 *
 *  Separate from `hasPrivateTooling()` on purpose: that one answers "is `.mcp.json` here",
 *  which is a PROXY for the publish scripts, not the thing a publish-script guard reads. The
 *  two happen to coincide today (the snapshot ships neither), and gating on the proxy is
 *  exactly the mistake `hasInternalGames()`'s comment below was written about. A guard that
 *  parses `scripts/publish-engine-oss.sh` should say so. */
export function hasPublishScripts(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, 'scripts', 'publish-engine-oss.sh'));
}

/** True when this checkout carries the Claude skill runbooks (`.claude/skills/`).
 *
 *  Separate from `hasPrivateTooling()` DELIBERATELY, for the reason `hasPublishScripts()`
 *  gives: `.mcp.json` is a proxy for "this is a developer clone", not the thing a skill
 *  guard reads. They coincide today (the snapshot ships neither `.claude/` nor `.mcp.json`
 *  — see scripts/publish-engine-oss.sh), and #159's recipe guard is the standing proof that
 *  a guard pinned on `.claude/skills/**` goes red on the public gate if it does not gate at
 *  all. Naming the real dependency keeps that honest. */
export function hasSkills(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, '.claude', 'skills'));
}

/** True when this checkout carries the Claude subagent definitions (`.claude/agents/`).
 *
 *  Separate from `hasSkills()` even though both live under `.claude/` and the snapshot ships
 *  neither: skills and agents are independently deletable, and a guard that reads
 *  `.claude/agents/**` should say so rather than borrow a predicate about a sibling
 *  directory. Same reasoning as `hasPublishScripts()` vs `hasPrivateTooling()` above. */
export function hasAgentDefinitions(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, '.claude', 'agents'));
}

/** True when the `oss/` publish overlay (the workflows rewritten onto the public repo by
 *  `scripts/publish-engine-oss.sh`) is present in this checkout. */
export function hasOssOverlay(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, 'oss', '.github', 'workflows'));
}

/** True when the INTERNAL `games/` root exists and holds at least one project.
 *
 *  Deliberately NOT "any project under any root". `discoverProjects()` also enumerates
 *  `demos/`, and the CI snapshot DOES ship two demos — so a `length > 0` check reads TRUE
 *  there and the guarded test runs anyway, against content that cannot satisfy it. That is
 *  not hypothetical: it is how this failed twice. `assetRefIntegrity`'s own `hasGames` guard
 *  went true once demos shipped and the test failed instead of skipping; then the first
 *  version of THIS helper repeated the mistake, and four audits kept failing on the public
 *  gate for exactly the same reason.
 *
 *  Every caller polices `games/` content specifically — baselines of blank asset refs,
 *  the pending-migration backlog, KNOWN_ESCAPES, a minimum game-`.ts` count. Two published
 *  demos satisfy "a project exists" without satisfying any of those premises.
 *
 *  The lesson, worth keeping: gate on the thing the test actually needs, not on a proxy that
 *  happens to correlate with it today. */
export function hasInternalGames(): boolean {
  return discoverProjects(REPO_ROOT).some((p) => p.root === 'games');
}

/** True when ANY project exists under ANY root — `games/` OR `demos/`.
 *
 *  The honest name for the loose check. Use it ONLY where "is there something to scan?" is
 *  genuinely the question — e.g. a sanity assertion that a walk found assets at all. If the
 *  test needs internal game CONTENT (a baseline, an allowlist, a specific asset), it wants
 *  `hasInternalGames()` instead; the two are NOT interchangeable, and the CI snapshot is the
 *  case that separates them (it ships demos, no games).
 *
 *  This exists as a named export rather than an inline `discoverProjects(...).length > 0`
 *  precisely so the choice between loose and strict is visible at the call site. */
export function hasAnyProject(): boolean {
  return discoverProjects(REPO_ROOT).length > 0;
}

/** True when at least one project carries a COMMITTED vendored plugin tarball
 *  (`<project>/plugins/*.tgz`).
 *
 *  Narrower than `hasAnyProject()`, and the CI snapshot is what separates them:
 *  `scripts/publish-engine-oss.sh` deletes `ios android packages plugins` from every demo it
 *  stages AND strips every `file:` dependency from its package.json, so the snapshot has
 *  projects and no vendored plugins at all. #375's guards open those tarballs and assert they
 *  opened at least one, so on the loose predicate they would fail the public gate for having
 *  nothing to check.
 *
 *  ⚠️ It reads the TARBALLS, not the dependency specs those guards iterate — deliberately. A
 *  predicate computed from the guard's own join is self-disabling: rename what
 *  `listEnginePlugins()` reports, or move the `file:` pin into `devDependencies`, and the
 *  premise silently goes false, the guards skip, and `npm run verify` stays green with #375's
 *  check dead. Reading a different fact means that breakage lands as a RED "checked nothing"
 *  instead. Same lesson as `hasInternalGames()` above, one notch over. */
export function hasVendoredPluginTarballs(): boolean {
  return discoverProjects(REPO_ROOT).some((p) => {
    try {
      return fs.readdirSync(path.join(p.dir, 'plugins')).some((f) => f.endsWith('.tgz'));
    } catch {
      return false; // no plugins/ dir — the snapshot's state, and a legitimate project's
    }
  });
}

/** True when at least one TRACKED iOS Xcode project (`project.pbxproj`) exists.
 *
 *  Narrower than `hasAnyProject()` on purpose, and the CI snapshot is exactly what separates
 *  them: `scripts/publish-engine-oss.sh` deletes `ios android packages plugins` from every
 *  demo it stages, so the snapshot HAS projects and has no native at all. A test that walks
 *  pbxproj content therefore finds nothing there while `hasAnyProject()` still reads true.
 *
 *  ⚠️ **Tracked, via `git ls-files` — deliberately NOT `fs.existsSync`.** Its consumers grep
 *  the INDEX (`git grep`), so an on-disk check would gate on a different question than the one
 *  the assertion asks, which is the `hasAnyProject`/`hasInternalGames` mistake this file is a
 *  monument to, moved one notch over. The reachable failure: a user of the public snapshot
 *  scaffolds a project and runs a native build, `healNativeConfig.ts` writes a NEW UNTRACKED
 *  pbxproj, an on-disk predicate flips true while `git grep` still sees nothing — and the
 *  guarded test goes red on the public gate, the exact outcome the gating exists to prevent.
 *
 *  Returns false rather than throwing when git cannot answer (absent, or not a checkout); the
 *  consumers' own `git grep` fails the same way in that case, so both go quiet together
 *  instead of disagreeing. */
export function hasNativeProjects(): boolean {
  try {
    const out = execFileSync('git', ['ls-files', '--', '*/ios/App/App.xcodeproj/project.pbxproj'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() !== '';
  } catch {
    return false;
  }
}
