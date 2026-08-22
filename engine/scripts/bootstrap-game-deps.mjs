#!/usr/bin/env node
/**
 * Bootstrap in-repo game dependencies (fresh-clone setup).
 *
 * Each game under games/ can be its OWN npm workspace root (e.g.
 * games/3d-test/package.json declares `workspaces: ["packages/*"]` so its
 * game-owned packages — @3d-test/app-services, native plugins — resolve from
 * games/3d-test/node_modules). The repo's ROOT workspaces only cover
 * engine/packages/*, so a plain `npm install` at the root never links those
 * game packages. Without them, opening such a game in the editor 500s with
 * `Failed to resolve import "@3d-test/app-services"`.
 *
 * This runs from the root `postinstall`: for every project that owns sub-packages
 * to LINK (`workspaces`) **or declares dependencies to INSTALL**, run `npm install`
 * in that folder. A failure for one project is logged but does NOT fail the root
 * install — the engine core still works; only that project would be broken.
 *
 * ⚠️ The second half of that test is not decoration (#215). It used to be
 * `workspaces` alone, which silently skipped the 14 projects that have real deps
 * but own no sub-packages — so a fresh clone got no node_modules for any of them
 * and their native builds died at package resolution, on a `Package.swift` that
 * correctly points at the project's OWN node_modules. The selection rule lives in
 * `projectNeedsInstall.mjs` so a test can sweep every real project against it.
 *
 * After a game's deps are linked we also run its `build:plugins` script IF it
 * defines one. A game's native Capacitor plugins (e.g. capacitor-applovin-max)
 * ship their JS only in a gitignored `dist/`, so without this a fresh
 * clone/worktree fails at runtime with `Failed to resolve import "capacitor-…"`
 * — exactly the manual post-merge step this script exists to eliminate. Games
 * with no native plugins (no `build:plugins` script) are skipped silently.
 *
 * NOTE on npm #4828 ordering: that bug only bites when a build runs from the
 * SAME install's postinstall, before `.bin` symlinks are linked. Here each
 * game's `npm install` is a fully-completed child process, so its `.bin` (incl.
 * rollup) is already linked by the time we invoke `build:plugins` afterwards.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from './projectRoots.mjs';
import { projectNeedsInstall } from './projectNeedsInstall.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// On Windows npm is `npm.cmd`, which execFile can't resolve (ENOENT) — and naming
// `npm.cmd` explicitly now throws EINVAL under Node's CVE-2024-27980 hardening
// (spawning a .cmd/.bat requires a shell). Run through the shell on Windows so
// cmd.exe resolves npm → npm.cmd; the args below are static literals, so this is
// injection-safe. (POSIX keeps the direct exec — no shell.)
const isWindows = process.platform === 'win32';
const npmRun = (args, cwd) =>
  execFileSync('npm', args, { cwd, stdio: 'inherit', shell: isWindows });

// Projects live under games/ AND demos/ (see engine/scripts/projectRoots.mjs).
// Not all checkouts ship either folder (e.g. a packaged/external project, or the
// public OSS repo) — discoverProjects returns [] rather than throwing.
const projects = discoverProjects(repoRoot);
let installed = 0;
let built = 0;

for (const proj of projects) {
  const gameDir = proj.dir;
  const label = `${proj.root}/${proj.name}`;
  const pkgPath = path.join(gameDir, 'package.json');
  if (!existsSync(pkgPath)) continue; // game has no game-owned packages

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    console.warn(`[bootstrap-game-deps] skip ${label}: unreadable package.json (${e.message})`);
    continue;
  }
  // Two reasons to install: it owns sub-packages to LINK (`workspaces`), or it declares real
  // dependencies to INSTALL. The rule lives in projectNeedsInstall.mjs so a test can sweep every
  // real project against it — `!pkg.workspaces` alone silently skipped 14 projects (#215).
  if (!projectNeedsInstall(pkg)) continue;

  // ⚠️ Deliberately NOT skipped when `node_modules` already exists. That shortcut is what #215
  // looked like from the inside: `games/court/node_modules` was PRESENT but stale — every
  // `@capacitor/*` except the one added last — so "already installed" was true and wrong, and the
  // iOS build failed on the missing package. npm is cheap when the tree is already satisfied
  // (~0.3s for a no-op), so re-running it is the honest check. `bootstrap-mcp-deps.mjs` carried
  // the same wrong shortcut for engine/tools/* and no longer does.
  console.log(`[bootstrap-game-deps] installing ${label} …`);
  try {
    npmRun(['install'], gameDir);
    installed++;
  } catch (e) {
    console.warn(
      `[bootstrap-game-deps] WARNING: npm install failed in ${label} — ` +
        `that project won't load in the editor until its deps install. (${e.message})`
    );
    continue; // no point building plugins if install failed
  }

  // Build the game's native-plugin dist/ (gitignored) when it has one.
  if (pkg.scripts?.['build:plugins']) {
    console.log(`[bootstrap-game-deps] building plugins for ${label} …`);
    try {
      npmRun(['run', 'build:plugins'], gameDir);
      built++;
    } catch (e) {
      console.warn(
        `[bootstrap-game-deps] WARNING: build:plugins failed in ${label} — ` +
          `that project's native plugins won't resolve until built. (${e.message})`
      );
    }
  }
}

// NOTE: engine/tools/* (the MCP servers) are installed by `bootstrap-mcp-deps.mjs`, which runs
// immediately BEFORE this script in the root postinstall. A duplicate loop lived here and was
// unreachable in the normal flow for exactly that reason — the earlier script had already created
// each tool's node_modules, so this one's "skip if present" guard always fired and it installed
// nothing. Two copies of one rule, one of them dead; the dedicated script owns the job.

console.log(
  `[bootstrap-game-deps] done (${installed} project(s) installed, ` +
    `${built} built native plugins).`
);
