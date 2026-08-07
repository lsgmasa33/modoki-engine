/** The CLI native build must run the SAME three in-process heals as the editor's `/api/build`
 *  before its shell steps: `healNativeConfig` → `ensureCapacitorDeps` → `vendorEnginePlugins`
 *  (#148 landed the third alone; #150 closes the remaining gap).
 *
 *  Games depend on a content-addressed tarball committed into the project, not on the plugin
 *  source — so a plugin edit reaches a device only once that tarball is re-packed and installed.
 *  Likewise machine/identity settings (iOS DEVELOPMENT_TEAM) and engine-required Capacitor deps
 *  only reach a device once they're healed into the project. The editor's `/api/build` did all
 *  three; `build-web.mjs` (what `npm run build` actually runs, and what `docs/build.md` presents
 *  as the manual EQUIVALENT of Build → iOS/Android Device) did none, then only the vendor step
 *  (#148). Result: the documented CLI recipe could produce an IPA/APK signed with a stale team,
 *  missing a newly-required Capacitor plugin, or containing the PREVIOUS native code — while
 *  every signal reported success. Measured on `games/audio-demo`, whose vendor pin only moved
 *  once `vendor-plugins.mjs` was run by hand.
 *
 *  Why a SOURCE assertion rather than a behavioural one. Driving `build-web.mjs` end to end costs
 *  a full tsc + vite build and mutates a real project's `package.json`/`plugins/`/`node_modules`
 *  — far too heavy for `npm test`. `vendoredPluginFreshness.test.ts` already asserts the STATE
 *  this protects (no project pins a stale hash); what has no other guard is the WIRING, and the
 *  wiring is exactly what was missing for as long as the bug existed. Same posture as
 *  `reapScoping.test.ts`, which pins `pkill` patterns by source for the same reason.
 *
 *  Kept deliberately loose about HOW (any call shape passes) and strict about the facts that
 *  broke: each heal is reachable at all, gated on the native target, and — for #150's ordering
 *  trap — `ensureCapacitorDeps` runs BEFORE `vendorEnginePlugins` (vendoring rewrites the
 *  placeholder `capacitor-game-debug` spec that `ensureCapacitorDeps` writes; the other order
 *  around, the placeholder is never rewritten). */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const buildWeb = path.join(repoRoot, 'engine', 'scripts', 'build-web.mjs');

describe('build-web.mjs heals the native project on --target native (#148, #150)', () => {
  const src = fs.readFileSync(buildWeb, 'utf8');

  it('imports the generalized engine-plugin loader', () => {
    expect(src).toMatch(/import\s*\{[^}]*loadEnginePluginModule[^}]*\}\s*from\s*'\.\/loadVendorPlugins\.mjs'/);
  });

  it('calls healNativeConfig', () => {
    expect(src).toContain('healNativeConfig(');
  });

  it('calls ensureCapacitorDeps', () => {
    expect(src).toContain('ensureCapacitorDeps(');
  });

  it('calls vendorEnginePlugins', () => {
    expect(src).toContain('vendorEnginePlugins(');
  });

  it('runs ensureCapacitorDeps BEFORE vendorEnginePlugins (the placeholder-rewrite ordering trap)', () => {
    // ensureCapacitorDeps writes a PLACEHOLDER capacitor-game-debug spec; vendorEnginePlugins
    // rewrites that placeholder to the real file: tarball spec. Vendoring first means the
    // placeholder is never rewritten.
    const depsCall = src.indexOf('ensureCapacitorDeps(');
    const vendorCall = src.indexOf('vendorEnginePlugins(');
    expect(depsCall).toBeGreaterThan(-1);
    expect(vendorCall).toBeGreaterThan(-1);
    expect(depsCall).toBeLessThan(vendorCall);
  });

  it('installs the project when EITHER heal actually changed something', () => {
    // A fresh tarball or a newly-added dep spec is inert until installed — stopping short of
    // install would leave the exact stale artifact this is about, one step later. Gating on
    // only one of the two conditions would silently skip the other's install.
    expect(src).toMatch(/depsChanged\s*\|\|\s*v\?\.needsInstall/);
    expect(src).toContain('npm install');
    expect(src).toContain('writeVendorMarker(');
  });

  it('does not skip the install just because the VENDOR module could not be loaded', () => {
    // The install must be gated on what CHANGED, never on which module happened to load. An
    // early `return` when `vendorEnginePlugins` is unavailable would abandon deps that step 2
    // had already written into package.json — leaving the project claiming a dependency that is
    // not on disk, the same silent-success shape as the bug this whole guard is about.
    const installCall = src.indexOf("execSync('npm install'");
    const vendorLoad = src.indexOf("loadEnginePluginModule(repoRoot, path.join('plugins', 'vendorPlugins.ts'))");
    expect(installCall).toBeGreaterThan(-1);
    expect(vendorLoad).toBeGreaterThan(-1);
    // Nothing between loading the vendor module and the install may bail out on it being null.
    expect(src.slice(vendorLoad, installCall)).not.toMatch(/if\s*\(\s*!vendorMod\s*\)\s*return/);
  });

  it('gates the heal on the NATIVE target', () => {
    // Every heal here is a native-artifact concern: a web/playable build has nothing to keep
    // fresh and must not pay the cost (nor mutate the project) for it.
    expect(src).toMatch(/target\s*!==\s*'native'/);
  });

  it('runs the heal BEFORE the typecheck', () => {
    // The typecheck resolves the plugin's types out of the project's node_modules, so a heal
    // landing after it would be checked against the old copy.
    const healCall = src.indexOf('await healNativeProject()');
    const tscCall = src.indexOf('tsconfig.app.scoped.json`');
    expect(healCall).toBeGreaterThan(-1);
    expect(tscCall).toBeGreaterThan(-1);
    expect(healCall).toBeLessThan(tscCall);
  });
});

describe('loadEnginePluginModule degrades instead of throwing', () => {
  it('returns null when there is no source file to load (the packaged editor)', async () => {
    const { loadEnginePluginModule, loadVendorPlugins } = await import('../../scripts/loadVendorPlugins.mjs');
    // An empty dir has no engine/plugins/*.ts — the packaged editor's situation, where `main.ts`
    // has already healed/vendored on project open and a build must not die for it.
    const emptyRepo = path.join(repoRoot, 'engine', 'tests');
    expect(await loadEnginePluginModule(emptyRepo, path.join('plugins', 'healNativeConfig.ts'))).toBeNull();
    expect(await loadVendorPlugins(emptyRepo)).toBeNull();
  });
});
