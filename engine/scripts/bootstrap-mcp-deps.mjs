/**
 * bootstrap-mcp-deps.mjs — install the MCP tool packages' deps as part of the root postinstall.
 *
 * engine/tools/modoki-mcp and engine/tools/game-debug-mcp each have their OWN package.json +
 * node_modules — they are NOT root workspaces (workspaces = engine/packages/*). So a plain root
 * `npm install` does NOT install their deps, yet `npm run typecheck` type-checks them
 * (`npm --prefix engine/tools/<tool> run typecheck`). On a clean clone that fails with implicit-any
 * errors (the @modelcontextprotocol/sdk types aren't resolvable). Installing them here makes a
 * fresh clone's typecheck/build work out of the box — private repo AND the OSS public repo.
 *
 * Runs from the root `postinstall`, and is the SOLE owner of installing engine/tools/* — the
 * dev-tool loop that used to sit in bootstrap-game-deps.mjs did the same work a few lines later in
 * the same postinstall, so it always found node_modules already present and never installed
 * anything. Two copies of one rule, one of them unreachable; this is the copy that stays.
 *
 * Selection uses the shared `projectNeedsInstall` rule (#215) and deliberately does NOT skip when
 * node_modules already exists — see the comment on the loop for why that skip was wrong.
 *
 * Mirrors bootstrap-game-deps.mjs mechanically (execFileSync as a completed child process →
 * sidesteps npm #4828, shell:true on Windows for npm.cmd).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectNeedsInstall } from './projectNeedsInstall.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const toolsDir = path.join(repoRoot, 'engine', 'tools');

const isWindows = process.platform === 'win32';
const npmRun = (args, cwd) => execFileSync('npm', args, { cwd, stdio: 'inherit', shell: isWindows });

if (!existsSync(toolsDir)) process.exit(0);

for (const dir of readdirSync(toolsDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const toolDir = path.join(toolsDir, dir.name);
  const pkgPath = path.join(toolDir, 'package.json');
  if (!existsSync(pkgPath)) continue;

  // Same rule the projects use (#215) — deps to INSTALL or sub-packages to LINK.
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    console.warn(`[bootstrap-mcp-deps] skip engine/tools/${dir.name}: unreadable package.json (${e.message})`);
    continue;
  }
  if (!projectNeedsInstall(pkg)) continue;

  // ⚠️ This used to `continue` when `node_modules` existed, as "already installed → cheap
  // re-install". That is #215's exact shape one folder over: a tool that GAINS a dependency has a
  // node_modules that is present but stale, so the skip fires, the dep is never installed, and the
  // MCP server dies on launch with `Cannot find package …` — the very failure this script's header
  // says it exists to prevent. It only ever worked for the clean-clone case. npm is cheap when the
  // tree is already satisfied, so re-running it is the honest check.
  console.log(`[bootstrap-mcp-deps] installing engine/tools/${dir.name} …`);
  try {
    npmRun(['install'], toolDir);
  } catch (e) {
    console.warn(
      `[bootstrap-mcp-deps] WARNING: npm install failed in engine/tools/${dir.name} — ` +
        `its MCP server + the root typecheck of it won't work until its deps install. (${e.message})`
    );
  }
}
