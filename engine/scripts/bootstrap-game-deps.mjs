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
 * This runs from the root `postinstall`: for every games/<g>/package.json that
 * declares `workspaces`, run `npm install` in that folder so its package links
 * exist. A failure for one game is logged but does NOT fail the root install —
 * the engine core still works; only that game would be broken.
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
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from './projectRoots.mjs';

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
  if (!pkg.workspaces) continue; // not a workspace root → nothing to link

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

// ── Dev MCP tool deps (engine/tools/*) ──────────────────────────────────────
// The repo's root workspaces cover engine/packages/* only, so a stdio MCP server
// under engine/tools/ (e.g. modoki-mcp, spawned by .mcp.json via `npx tsx`) never
// gets its deps from a root `npm install`. Without them it crashes on launch with
// `Cannot find package '@modelcontextprotocol/sdk'`, so the editor MCP silently
// fails to connect in a fresh clone/worktree. Install each tool that declares
// dependencies and is missing its node_modules (idempotent — skips if present).
const toolsDir = path.join(repoRoot, 'engine', 'tools');
let toolsInstalled = 0;
if (existsSync(toolsDir)) {
  for (const dir of readdirSync(toolsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const toolDir = path.join(toolsDir, dir.name);
    const pkgPath = path.join(toolDir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) continue;
    if (existsSync(path.join(toolDir, 'node_modules'))) continue; // already installed
    console.log(`[bootstrap-game-deps] installing engine/tools/${dir.name} (MCP/dev tool) …`);
    try {
      npmRun(['install'], toolDir);
      toolsInstalled++;
    } catch (e) {
      console.warn(
        `[bootstrap-game-deps] WARNING: npm install failed in engine/tools/${dir.name} — ` +
          `its MCP server won't launch until its deps install. (${e.message})`
      );
    }
  }
}

console.log(
  `[bootstrap-game-deps] done (${installed} game workspace(s) installed, ` +
    `${built} built native plugins, ${toolsInstalled} dev tool(s) installed).`
);
