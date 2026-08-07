/** Load the SINGLE `vendorPlugins.ts` implementation from a plain-Node `.mjs` script.
 *
 *  Node cannot import that module directly even with type-stripping: it reaches the toolchain
 *  layer as a bundler-style DIRECTORY specifier (`../toolchain` → `engine/toolchain/index.ts`),
 *  which Node's ESM resolver rejects with `ERR_UNSUPPORTED_DIR_IMPORT`. Only a bundler resolves
 *  that, the same way vite/electron do at build time. So: esbuild it to a temp file (node_modules
 *  stay external, so the bundle is tiny and runs against the real deps), import it, delete it.
 *
 *  Extracted from `vendor-plugins.mjs` when `build-web.mjs` needed the same thing for #148 —
 *  duplicating the loader would have been a second place for the temp-file/externals contract to
 *  drift.
 *
 *  Returns `null` when the loader cannot run, rather than throwing:
 *  - **no `vendorPlugins.ts` on disk** — the packaged editor ships built JS and no engine sources.
 *    It also has no need for this: `main.ts` vendors on project open, with `canBuild:false`.
 *  - **no esbuild** — same situation, and a build must not die because an optional freshness
 *    convenience is unavailable.
 *  A caller that REQUIRES vendoring should say so itself; every current caller degrades. */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @returns the vendorPlugins module, or null if it cannot be loaded here. */
export async function loadVendorPlugins(repoRoot) {
  const entry = path.join(repoRoot, 'engine', 'plugins', 'vendorPlugins.ts');
  if (!fs.existsSync(entry)) return null;

  let build;
  try {
    ({ build } = await import('esbuild'));
  } catch {
    return null;
  }

  const outfile = path.join(os.tmpdir(), `modoki-vendor-${process.pid}-${path.basename(repoRoot)}.mjs`);
  await build({
    entryPoints: [entry], outfile, bundle: true,
    platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    fs.rmSync(outfile, { force: true });
  }
}
