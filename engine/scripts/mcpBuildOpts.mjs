/**
 * The esbuild options that produce the shipped MCP bundle — DECLARATION ONLY.
 *
 * Extracted from `build-electron.mjs` (#945 B1) for one reason: that script runs
 * `await esbuild.build(...)` at module top level, so importing it to reach these options
 * would run a whole Electron build as an import side effect. This repo has been bitten by
 * exactly that shape before — importing a constant from a CLI module re-encoded 24 committed
 * assets. So the options live here, where importing costs nothing, and BOTH the builder and
 * `engine/tests/electron/mcpBundle.test.ts` read them from this one place.
 *
 * ⚠️ **Do not restate these in a test.** The whole defect class #945 records is a verification
 * that rebuilds its own private copy of what ships: the test used to inline its own options
 * "mirroring build-electron.mjs", and they had ALREADY drifted in two fields (`sourcemap`, and
 * the outfile extension) while staying green. A test that builds its own artifact cannot fail
 * when the shipped one is stale or wrong.
 *
 * ⚠️ **Nothing may be executed at import time in this file.** That is the property that makes
 * it importable from a test, and it is the whole point of the split.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `engine/tools/modoki-mcp` — the tool is deliberately NOT a root workspace. */
export const mcpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'modoki-mcp');

/** The entry the bundle is built FROM. */
export const mcpEntry = path.join(mcpDir, 'src', 'index.ts');

/** The artifact that actually SHIPS, and that `connectClaude.ts` writes into the user's
 *  `.mcp.json` as `node <this>` — packaged on every platform, and dev on Windows. */
export const mcpOutfile = path.join(mcpDir, 'dist', 'index.js');

/** @type {import('esbuild').BuildOptions} */
export const mcpOpts = {
  entryPoints: [mcpEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: mcpOutfile,
  packages: 'bundle', // inline node_modules (not external) → zero runtime deps
  sourcemap: true,
  logLevel: 'info',
};
