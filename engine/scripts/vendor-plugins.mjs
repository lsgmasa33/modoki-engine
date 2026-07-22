#!/usr/bin/env node
/**
 * Manually (re)vendor engine Capacitor plugins into a game project — the same
 * thing the editor does on open (heal) / "Add Native Target". Normally you don't
 * need this: the content-addressed tarball is committed, and the editor re-packs
 * automatically when a plugin's content changes. Use it to re-vendor from the CLI
 * (e.g. after editing an engine plugin without opening the editor):
 *
 *   node engine/scripts/vendor-plugins.mjs games/3d-test
 *
 * Runs the SINGLE TS implementation (no duplicated logic) by bundling it with
 * esbuild first. We can't just let Node's native type-stripping import
 * vendorPlugins.ts directly: it imports the toolchain layer as a bundler-style
 * DIRECTORY specifier (`../toolchain` → engine/toolchain/index.ts), which Node's
 * ESM resolver rejects (ERR_UNSUPPORTED_DIR_IMPORT) — only a bundler resolves it,
 * the same way vite/electron do at build time. node_modules stay external, so the
 * bundle is tiny and runs on the real deps. Writes the tarball + rewrites the dep
 * spec; run `npm install` in the project afterward to refresh the lockfile.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const target = process.argv[2];
if (!target) {
  console.error('usage: node engine/scripts/vendor-plugins.mjs <projectDir>');
  process.exit(1);
}
const projectRoot = path.resolve(target);

// Bundle vendorPlugins.ts (resolves the bundler-style directory imports) with all
// node_modules external, then import the result. Temp file in the OS tmpdir so no
// build artifact lands in the repo.
const entry = path.join(repoRoot, 'engine', 'plugins', 'vendorPlugins.ts');
const outfile = path.join(os.tmpdir(), `modoki-vendor-${process.pid}.mjs`);
await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
let vendorEnginePlugins;
try {
  ({ vendorEnginePlugins } = await import(pathToFileURL(outfile).href));
} finally {
  fs.rmSync(outfile, { force: true });
}

const r = vendorEnginePlugins(projectRoot, repoRoot);
if (r.vendored.length) console.log(`[vendor] ${path.relative(repoRoot, projectRoot)}: ${r.vendored.join(', ')}${r.needsInstall ? ' (run npm install)' : ''}`);
else console.log(`[vendor] ${path.relative(repoRoot, projectRoot)}: up to date`);
