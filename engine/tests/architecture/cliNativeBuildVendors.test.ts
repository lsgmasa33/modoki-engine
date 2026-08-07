/** The CLI native build must re-vendor the engine Capacitor plugins (#148).
 *
 *  Games depend on a content-addressed tarball committed into the project, not on the plugin
 *  source — so a plugin edit reaches a device only once that tarball is re-packed and installed.
 *  The editor's `/api/build` did that; `build-web.mjs` (what `npm run build` actually runs, and
 *  what `docs/build.md` presents as the manual EQUIVALENT of Build → iOS Device) did not. Result:
 *  the documented CLI recipe produced an IPA/APK containing the PREVIOUS native code while every
 *  signal reported success. Measured on `games/audio-demo`, whose pin only moved once
 *  `vendor-plugins.mjs` was run by hand.
 *
 *  Why a SOURCE assertion rather than a behavioural one. Driving `build-web.mjs` end to end costs
 *  a full tsc + vite build and mutates a real project's `package.json`/`plugins/`/`node_modules`
 *  — far too heavy for `npm test`. `vendoredPluginFreshness.test.ts` already asserts the STATE
 *  this protects (no project pins a stale hash); what has no other guard is the WIRING, and the
 *  wiring is exactly what was missing for as long as the bug existed. Same posture as
 *  `reapScoping.test.ts`, which pins `pkill` patterns by source for the same reason.
 *
 *  Kept deliberately loose about HOW (any call shape passes) and strict about the two facts that
 *  broke: the vendor step is reachable at all, and it is gated on the native target. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const buildWeb = path.join(repoRoot, 'engine', 'scripts', 'build-web.mjs');

describe('build-web.mjs re-vendors engine plugins on --target native (#148)', () => {
  const src = fs.readFileSync(buildWeb, 'utf8');

  it('imports the vendorPlugins loader', () => {
    expect(src).toMatch(/import\s*\{[^}]*loadVendorPlugins[^}]*\}\s*from\s*'\.\/loadVendorPlugins\.mjs'/);
  });

  it('calls vendorEnginePlugins', () => {
    expect(src).toContain('vendorEnginePlugins(');
  });

  it('installs the project when the plugin content actually changed', () => {
    // A fresh tarball is inert until installed — stopping at the re-pack would leave the exact
    // stale artifact this is about, one step later.
    expect(src).toContain('needsInstall');
    expect(src).toContain('npm install');
    expect(src).toContain('writeVendorMarker(');
  });

  it('gates the vendor step on the NATIVE target', () => {
    // A vendored plugin is a native artifact: a web/playable build has nothing to keep fresh and
    // must not pay the cost (nor mutate the project) for it.
    expect(src).toMatch(/target\s*!==\s*'native'/);
  });

  it('runs the vendor step BEFORE the typecheck', () => {
    // The typecheck resolves the plugin's types out of the project's node_modules, so a
    // re-vendor landing after it would be checked against the old copy.
    const vendorCall = src.indexOf('await vendorNativePlugins()');
    const tscCall = src.indexOf('tsconfig.app.scoped.json`');
    expect(vendorCall).toBeGreaterThan(-1);
    expect(tscCall).toBeGreaterThan(-1);
    expect(vendorCall).toBeLessThan(tscCall);
  });
});

describe('loadVendorPlugins degrades instead of throwing', () => {
  it('returns null when there is no vendorPlugins.ts to load (the packaged editor)', async () => {
    const { loadVendorPlugins } = await import('../../scripts/loadVendorPlugins.mjs');
    // An empty dir has no engine/plugins/vendorPlugins.ts — the packaged editor's situation,
    // where `main.ts` has already vendored on project open and a build must not die for it.
    expect(await loadVendorPlugins(path.join(repoRoot, 'engine', 'tests'))).toBeNull();
  });
});
