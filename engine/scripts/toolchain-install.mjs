#!/usr/bin/env node
/**
 * Provision Build-Support tools from a terminal — the SAME `install()` the editor's Build Support
 * dialog runs, into the SAME machine-level toolchain dir.
 *
 *     npm run toolchain:install -- ffmpeg ffprobe
 *
 * ── WHY THIS EXISTS (#1297) ──────────────────────────────────────────────────────────────
 * Asset conversion resolves ONLY the pinned, provisioned ffmpeg/ffprobe — never a PATH binary —
 * so `brew install ffmpeg` no longer makes `npm run build` work. Before this script the only way
 * to provision was to open the Electron editor, which a CI box or a terminal-only session does not
 * have. It delegates, never reimplements: a second install path here would pin a second version.
 *
 * `MODOKI_TOOLCHAIN_DIR` defaults exactly as the editor's does (`toolchainHome.mjs`), and is set
 * BEFORE the toolchain module loads because that module reads it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRequiredEngineModules } from './loadVendorPlugins.mjs';
import { defaultToolchainDir } from './toolchainHome.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.MODOKI_TOOLCHAIN_DIR ??= defaultToolchainDir();
const toolchainDir = process.env.MODOKI_TOOLCHAIN_DIR;

const [toolchain] = await loadRequiredEngineModules(
  repoRoot, [path.join('toolchain', 'index.ts')], 'toolchain-install.mjs',
);
const { install, INSTALLABLE } = toolchain;

const ids = process.argv.slice(2);
const usage = `usage: npm run toolchain:install -- <tool>...   (installable: ${[...INSTALLABLE].join(', ')})`;
if (ids.length === 0) {
  console.error(usage);
  process.exit(2);
}
const unknown = ids.filter((id) => !INSTALLABLE.has(id));
if (unknown.length) {
  console.error(`not installable: ${unknown.join(', ')}\n${usage}`);
  process.exit(2);
}

console.error(`[toolchain] installing into ${toolchainDir}`);
let failed = 0;
for (const id of ids) {
  try {
    const r = await install(id, { toolchainDir, onLog: (line) => console.error(`  ${id}: ${line}`) });
    console.log(`${id}: ${r?.path ?? 'installed'}`);
  } catch (e) {
    failed++;
    console.error(`${id}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(failed ? 1 : 0);
