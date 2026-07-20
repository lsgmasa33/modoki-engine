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
 * Imports the single TS implementation (Node ≥22.6 strips the types), so there's
 * no duplicated logic. Writes the tarball + rewrites the dep spec; run
 * `npm install` in the project afterward to refresh the lockfile.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendorEnginePlugins } from '../plugins/vendorPlugins.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = process.argv[2];
if (!target) {
  console.error('usage: node engine/scripts/vendor-plugins.mjs <projectDir>');
  process.exit(1);
}
const projectRoot = path.resolve(target);
const r = vendorEnginePlugins(projectRoot, repoRoot);
if (r.vendored.length) console.log(`[vendor] ${path.relative(repoRoot, projectRoot)}: ${r.vendored.join(', ')}${r.needsInstall ? ' (run npm install)' : ''}`);
else console.log(`[vendor] ${path.relative(repoRoot, projectRoot)}: up to date`);
