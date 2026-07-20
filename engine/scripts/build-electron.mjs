// Bundle the Electron main + preload TS into electron/dist/*.cjs (ELECTRON_PLAN
// Phase 2). node_modules stay external (resolved at runtime); relative imports
// into plugins/ + packages/modoki/src are bundled so main can run the TS router.
// electron-vite would normally do this, but it only supports vite ≤7 (we're on 8).

import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');

// Resolve electron paths relative to this script (engine/scripts/ → engine/electron),
// so the build works regardless of the CWD it's invoked from.
const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron');

// The app version — the SINGLE source of truth is the root package.json. Bundle it in
// as `__APP_VERSION__` so main.ts can show the real version in the window title even in
// the DEV editor, where Electron is launched with a bare main.cjs (no app package.json)
// and `app.getVersion()` returns ELECTRON's own version (e.g. 42.4.0) instead. Packaged
// builds also get the same value (electron-builder injects package.json version).
const repoRoot = path.resolve(electronDir, '..', '..');
const appVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

/** @type {import('esbuild').BuildOptions} */
const opts = {
  entryPoints: [path.join(electronDir, 'main.ts'), path.join(electronDir, 'preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outdir: path.join(electronDir, 'dist'),
  outExtension: { '.js': '.cjs' },
  // Electron + every npm dependency (sharp, three, gltf-transform, chokidar, …)
  // resolve from node_modules at runtime — only our own TS gets bundled.
  external: ['electron'],
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
};

// Bundle the modoki MCP server into a self-contained ESM dist/index.js so the
// PACKAGED editor can spawn it with plain `node` — no tsx, no
// engine/tools/modoki-mcp/node_modules (that tool is NOT a root workspace, so its
// deps aren't installed by the root `npm ci`/postinstall). `packages: 'bundle'`
// inlines its two deps (@modelcontextprotocol/sdk + zod). Ships via
// `files: engine/**/*` and unpacks via `asarUnpack: **/engine/**`; the "Connect
// Claude Code" flow points the packaged .mcp.json at it. Dev is unaffected — it
// keeps running src/index.ts through tsx.
const mcpDir = path.resolve(electronDir, '..', 'tools', 'modoki-mcp');

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
/** @type {import('esbuild').BuildOptions} */
const mcpOpts = {
  entryPoints: [path.join(mcpDir, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(mcpDir, 'dist', 'index.js'),
  packages: 'bundle', // inline node_modules (not external) → zero runtime deps
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('[build-electron] watching…');
} else {
  await esbuild.build(opts);
  await esbuild.build(mcpOpts);
  console.log('[build-electron] built engine/electron/dist/{main,preload}.cjs + tools/modoki-mcp/dist/index.js');
}
