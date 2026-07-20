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
 * Runs from the root `postinstall`. Guarded on a missing node_modules so re-installs are cheap, and
 * mirrors bootstrap-game-deps.mjs (execFileSync as a completed child process → sidesteps npm #4828,
 * shell:true on Windows for npm.cmd).
 */

import { readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const toolsDir = path.join(repoRoot, 'engine', 'tools');

const isWindows = process.platform === 'win32';
const npmRun = (args, cwd) => execFileSync('npm', args, { cwd, stdio: 'inherit', shell: isWindows });

if (!existsSync(toolsDir)) process.exit(0);

for (const dir of readdirSync(toolsDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const toolDir = path.join(toolsDir, dir.name);
  if (!existsSync(path.join(toolDir, 'package.json'))) continue;
  if (existsSync(path.join(toolDir, 'node_modules'))) continue; // already installed → skip (cheap re-install)

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
