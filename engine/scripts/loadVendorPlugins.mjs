/** Load an `engine/plugins/*.ts` implementation from a plain-Node `.mjs` script.
 *
 *  Node cannot import those modules directly even with type-stripping: they reach the toolchain
 *  layer as a bundler-style DIRECTORY specifier (`../toolchain` → `engine/toolchain/index.ts`),
 *  which Node's ESM resolver rejects with `ERR_UNSUPPORTED_DIR_IMPORT`. Only a bundler resolves
 *  that, the same way vite/electron do at build time. So: esbuild it to a temp file (node_modules
 *  stay external, so the bundle is tiny and runs against the real deps), import it, delete it.
 *
 *  Originally extracted from `vendor-plugins.mjs` when `build-web.mjs` needed the same thing for
 *  #148 (`vendorPlugins.ts` only); generalized for #150 so `build-web.mjs` can load
 *  `healNativeConfig.ts` and `addNativeTarget.ts` (`ensureCapacitorDeps`) through the same seam
 *  instead of a second copy of the temp-file/externals contract.
 *
 *  Returns `null` when the loader cannot run, rather than throwing:
 *  - **no source file on disk** — a build against something other than a source checkout (e.g. a
 *    tarball snapshot with no `engine/plugins/*.ts`). `main.ts` heals/vendors on project open with
 *    `canBuild:false`, so nothing here needs to run either.
 *  - **no esbuild** — measured (#714) in the PACKAGED editor: `app.asar.unpacked/engine/plugins/
 *    vendorPlugins.ts` IS present, but `node_modules/esbuild` is not — it's a devDependency,
 *    pruned by electron-builder. So the packaged editor is THIS case, not the no-source one; a
 *    build must not die because an optional freshness convenience is unavailable.
 *  A caller that REQUIRES the heal should say so itself; every current caller degrades.
 *
 *  `loadEnginePluginModuleResult` (below) tells a caller WHICH of the two fired, for a caller that
 *  wants to report it; `loadEnginePluginModule` stays the plain module-or-null contract every
 *  existing caller already relies on. */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @param repoRoot repo root (contains `engine/`).
 *  @param relPathFromEngineDir path to the entry module, relative to `engine/` (e.g.
 *    `plugins/vendorPlugins.ts`).
 *  @returns {Promise<{module: object, reason: null} | {module: null, reason: 'no-source'|'no-esbuild'}>}
 *    the loaded module, or which of the two degrade cases stopped it. A failure of the bundle
 *    build or the final `import()` still THROWS — those are genuine errors, not degrade cases. */
export async function loadEnginePluginModuleResult(repoRoot, relPathFromEngineDir) {
  const entry = path.join(repoRoot, 'engine', relPathFromEngineDir);
  if (!fs.existsSync(entry)) return { module: null, reason: 'no-source' };

  let build;
  try {
    ({ build } = await import('esbuild'));
  } catch {
    return { module: null, reason: 'no-esbuild' };
  }

  // Include the entry's basename so concurrent loads (vendorPlugins + healNativeConfig +
  // addNativeTarget, all healing the same native build) can't collide on one temp path.
  const outfile = path.join(
    os.tmpdir(),
    `modoki-plugin-${path.basename(relPathFromEngineDir, '.ts')}-${process.pid}-${path.basename(repoRoot)}.mjs`,
  );
  await build({
    entryPoints: [entry], outfile, bundle: true,
    platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
  });
  try {
    return { module: await import(pathToFileURL(outfile).href), reason: null };
  } finally {
    fs.rmSync(outfile, { force: true });
  }
}

/** @param repoRoot repo root (contains `engine/`).
 *  @param relPathFromEngineDir path to the entry module, relative to `engine/` (e.g.
 *    `plugins/vendorPlugins.ts`).
 *  @returns the loaded module, or null if it cannot be loaded here. */
export async function loadEnginePluginModule(repoRoot, relPathFromEngineDir) {
  const { module } = await loadEnginePluginModuleResult(repoRoot, relPathFromEngineDir);
  return module;
}

/** Why a REQUIRED load failed, as one sentence a human running a CLI script can act on. Internal:
 *  the two degrade reasons mean different things to fix, and collapsing them into "could not load"
 *  is what sent #714 looking for a missing source file in a packaged editor that had every one. */
function describeRequiredLoadFailure(relPathFromEngineDir, reason, purpose) {
  // Both callers build this with `path.join`, so on Windows it arrives back-slashed and the message
  // would read `engine/plugins\addNativeTarget.ts` — half one separator, half the other. The
  // message is the only consumer, so normalise here rather than constraining how callers spell it.
  //
  // ⚠️ A separator CLASS, not `split(path.sep)`. `path.sep` is `/` on POSIX, so that version was an
  // identity on every non-Windows box — it could not be exercised, or falsified, from a Mac, which
  // on this repo means it was not verified at all (`docs/windows.md`: the local gate cannot see
  // Windows). Splitting on either separator fixes the same Windows message AND makes a
  // back-slashed input testable everywhere.
  const rel = relPathFromEngineDir.split(/[\\/]/).join('/');
  const why = reason === 'no-esbuild'
    ? `esbuild could not be imported, so engine/${rel} could not be bundled. `
      + 'esbuild is a devDependency: a packaged editor prunes it (#714), and a fresh clone needs '
      + '`npm install`.'
    : `engine/${rel} is not on disk, so there is nothing to bundle. This is not an `
      + 'engine SOURCE checkout — a tarball snapshot ships no `engine/**/*.ts`.';
  return `${purpose} cannot run: ${why}`;
}

/** Load engine modules a caller CANNOT run without — same loader as above, opposite disposition.
 *
 *  The degrade-to-null contract documented at the top of this file is right for a caller whose step
 *  is an optional convenience (every heal caller is), and wrong for a caller whose entire job IS the
 *  module. Why that gap cost the repo two extra copies of this loader, and which callers are on
 *  which side, is in `docs/build.md` § "Degrading is a disposition" — not restated here.
 *
 *  So this THROWS, naming the entry and which of the two reasons fired, rather than handing back a
 *  null the caller derefs into `x is not a function` several lines from the real cause. `purpose`
 *  completes the sentence "<purpose> cannot run: …" — name the script, not the step.
 *
 *  ⚠️ Returns the namespaces as an ARRAY, in the order requested, and deliberately does NOT merge
 *  them: a merge resolves a name exported by two entries silently in favour of the last one. A
 *  caller wanting one object spreads them at its own call site, where the entries being combined
 *  are visible together.
 *
 *  @param repoRoot repo root (contains `engine/`).
 *  @param relPathsFromEngineDir entry modules, each relative to `engine/`.
 *  @param purpose what cannot run without them — used verbatim in the thrown message.
 *  @returns {Promise<object[]>} the loaded namespaces, in the order requested. */
export async function loadRequiredEngineModules(repoRoot, relPathsFromEngineDir, purpose) {
  const loaded = [];
  for (const rel of relPathsFromEngineDir) {
    const { module, reason } = await loadEnginePluginModuleResult(repoRoot, rel);
    if (!module) throw new Error(describeRequiredLoadFailure(rel, reason, purpose));
    loaded.push(module);
  }
  return loaded;
}

/** @returns the vendorPlugins module, or null if it cannot be loaded here.
 *  Thin wrapper over {@link loadEnginePluginModule} kept for existing callers
 *  (`vendor-plugins.mjs`). */
export async function loadVendorPlugins(repoRoot) {
  return loadEnginePluginModule(repoRoot, path.join('plugins', 'vendorPlugins.ts'));
}
