/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * beforePack stager: emit `engine/vite.config.cjs`, the PACKAGED editor's Vite config (#326).
 *
 * Why a second copy of the config exists at all — the packaged editor's REPO_ROOT is
 * `<Resources>/app.asar.unpacked`, i.e. INSIDE the signed `.app`. Vite's default `bundle`
 * config loader compiles the config with esbuild and, on its ESM branch, WRITES the result to
 * `<nearest node_modules>/.vite-temp/…mjs` before importing it. From a config at
 * `engine/vite.config.ts` that lands in `engine/node_modules/.vite-temp` — inside the bundle.
 * On macOS the write succeeds (a bundle is writable; the signature is an integrity seal, not a
 * permission), so nothing errors and `codesign --verify` / `spctl --assess` start failing after
 * the user's FIRST build. On Windows the same write raises EPERM under `C:\Program Files`.
 *
 * The fix rests on one asymmetry in `loadConfigFromBundledFile`: its CJS branch hooks
 * `require.extensions` and compiles the bundled code IN MEMORY — it writes nothing at all. Vite
 * picks the branch from `isFilePathESM(configPath)`, which is decided by extension first, so a
 * `.cjs` config takes the no-write path. `build-web.mjs` hands Vite this file when it exists.
 *
 * ⚠️ Emitted, never committed (gitignored) and regenerated on every pack. Its twin
 * `clean-vite-config.cjs` deletes it again at `afterPack` — but a pack that FAILS or is
 * interrupted in between leaves it in the source tree, so "cannot drift" is not something this
 * stager can promise. `chooseViteConfig()` closes that hole from the other end: it decides on
 * packaged-ness rather than on the file existing, so a stray copy in a clone is inert. It is written NEXT TO the original on purpose: the bundle collapses the
 * plugin graph into one file, and several modules in that graph locate themselves relative to
 * their own path. Same directory ⇒ `__dirname` matches what `import.meta.url` gave them.
 *
 * ⚠️ Do NOT add `--define:import.meta.url=…` to "fix" the empty-`import.meta` warnings. Three
 * modules in this graph (`native-dynamic-import.ts`, `font-instance.ts`, `nodeProvision.ts`)
 * DEPEND on it being empty under CJS and branch to a `__filename`/`__dirname` path; defining it
 * would silently take the wrong branch. The warnings are the design working.
 */

const path = require('node:path');

exports.default = async function stageViteConfig(context) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const entry = path.join(repoRoot, 'engine', 'vite.config.ts');
  const outfile = path.join(repoRoot, 'engine', 'vite.config.cjs');
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    // Graceful like the other stagers: without it the packaged editor still builds, it just
    // keeps breaking its own signature. Loud, because that is not a state to ship quietly.
    console.warn('[stage-vite-config] esbuild not resolvable — SKIPPING. The packaged editor will '
      + 'write node_modules/.vite-temp inside its own bundle and break its code signature (#326).');
    return;
  }
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    // Only the relative `./plugins/*` + `./scripts/*` graph is inlined; every bare specifier
    // still resolves from the app's own node_modules at runtime.
    packages: 'external',
    logLevel: 'silent',
  });
  console.log(`[stage-vite-config] emitted ${path.relative(repoRoot, outfile)} (packaged Vite config, #326)`);
  void context;
};
