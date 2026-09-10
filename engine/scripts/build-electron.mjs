// Bundle the Electron main + preload TS into electron/dist/*.cjs (ELECTRON_PLAN
// Phase 2). node_modules stay external (resolved at runtime); relative imports
// into plugins/ + packages/modoki/src are bundled so main can run the TS router.
// electron-vite would normally do this, but it only supports vite ≤7 (we're on 8).

import esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
// The MCP bundle's options live in a DECLARATION-ONLY module so the test that verifies the
// shipped artifact can import them instead of restating them (#945 B1) — this file runs
// esbuild at top level, so it cannot be imported for them.
import { mcpDir, mcpOpts } from './mcpBuildOpts.mjs';
// Same split, same reason, for the MAIN bundle (#1035): the guard that proves no bare
// `@modoki/*` require reaches main.cjs must build with the REAL options, and cannot import
// them from here without running this build as a side effect.
import { electronOpts } from './electronBuildOpts.mjs';

const watch = process.argv.includes('--watch');

// The build options — and `electronDir`, the app version, and the entry points with them — are
// declared in electronBuildOpts.mjs so the packaging guard can read the SHIPPED ones instead of
// restating them. Restating is the #945 B1 defect class: a test that mirrors a build's options
// drifts from them silently and then cannot fail.
const opts = electronOpts();

// Bundle the modoki MCP server into a self-contained ESM dist/index.js so the
// PACKAGED editor can spawn it with plain `node` — no tsx, no
// engine/tools/modoki-mcp/node_modules (that tool is NOT a root workspace, so its
// deps aren't installed by the root `npm ci`/postinstall). `packages: 'bundle'`
// inlines its two deps (@modelcontextprotocol/sdk + zod). Ships via
// `files: engine/**/*` and unpacks via `asarUnpack: **/engine/**`; the "Connect
// Claude Code" flow points the packaged .mcp.json at it. Dev is unaffected — it
// keeps running src/index.ts through tsx.

// The tool is deliberately NOT a root workspace, so NOTHING in the standard install
// flow populates its node_modules — a fresh clone, a `npm ci --ignore-scripts` CI
// runner (release-windows.yml), and the macOS release job all reach this esbuild with
// no @modelcontextprotocol/sdk to inline → "Could not resolve …/sdk/server/mcp.js".
// Self-heal at this single choke point (every packaging path — dist:mac/win/dir,
// smoke:packaged — runs build-electron), so the deps are guaranteed present exactly
// where esbuild resolves them (mcpDir/node_modules). Idempotent: skipped when already
// installed (local dev, warm CI cache). execSync (shell) so `npm` resolves to npm.cmd
// on Windows without the .cmd spawn EINVAL that execFile hits.
const mcpSdkMarker = path.join(mcpDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
if (!existsSync(mcpSdkMarker)) {
  console.log('[build-electron] modoki-mcp deps missing → npm install in engine/tools/modoki-mcp');
  execSync('npm install --no-audit --no-fund', { cwd: mcpDir, stdio: 'inherit' });
}

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('[build-electron] watching…');
} else {
  await esbuild.build(opts);
  await esbuild.build(mcpOpts);
  console.log('[build-electron] built engine/electron/dist/{main,preload}.cjs + tools/modoki-mcp/dist/index.js');
}
