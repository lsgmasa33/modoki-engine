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
 * Runs the SINGLE TS implementation (no duplicated logic) via `loadVendorPlugins`
 * — see that module for why a plain Node import of vendorPlugins.ts can't work.
 * Writes the tarball + rewrites the dep spec; run `npm install` in the project
 * afterward to refresh the lockfile.
 *
 * As of #148 the CLI native build (`build-web.mjs --target native`) does this for
 * you, so this script is for re-vendoring WITHOUT a build.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVendorPlugins } from './loadVendorPlugins.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const target = process.argv[2];
if (!target) {
  console.error('usage: node engine/scripts/vendor-plugins.mjs <projectDir>');
  process.exit(1);
}
const projectRoot = path.resolve(target);

const mod = await loadVendorPlugins(repoRoot);
if (!mod) {
  // Unlike build-web.mjs, vendoring IS this script's entire job — degrading silently would
  // report "up to date" while doing nothing.
  console.error('[vendor] cannot load engine/plugins/vendorPlugins.ts (missing sources, or esbuild is not installed).');
  process.exit(1);
}

const r = mod.vendorEnginePlugins(projectRoot, repoRoot);
if (r.vendored.length) console.log(`[vendor] ${path.relative(repoRoot, projectRoot)}: ${r.vendored.join(', ')}${r.needsInstall ? ' (run npm install)' : ''}`);
else console.log(`[vendor] ${path.relative(repoRoot, projectRoot)}: up to date`);
