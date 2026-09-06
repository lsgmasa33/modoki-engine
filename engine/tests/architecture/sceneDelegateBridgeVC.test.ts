/** Guard: an iOS `SceneDelegate` must build `MyViewController`, never the base
 *  `CAPBridgeViewController` (#368).
 *
 *  ## The trap
 *
 *  A project's `MyViewController` is what registers `GameDebugPlugin` into the Capacitor bridge
 *  (`bridge?.registerPluginInstance(...)` — SPM's static linker strips a plugin class with no
 *  external framework dependency, so manual registration is what keeps it alive; see
 *  docs/native-and-sdks.md). `Main.storyboard` names it via `customClass="MyViewController"`.
 *
 *  But a `SceneDelegate` that builds its window IN CODE overrides the storyboard entirely:
 *
 *      window?.rootViewController = CAPBridgeViewController()   // ← storyboard never consulted
 *
 *  `MyViewController` is then never instantiated, the registration never runs, and the plugin —
 *  which IS compiled into the binary via the pbxproj file reference — is never wired in.
 *
 *  ## Why it went unnoticed for so long
 *
 *  The failure is invisible everywhere you would look. There is no crash and no render fault: the
 *  WebView loads and the game draws perfectly. The only symptom is
 *  `[debug-bridge] startServer failed: "GameDebug" plugin is not implemented on ios`, in the JS
 *  console — which does NOT reach `go-ios syslog` (the plugin's own logs are `print()`, i.e.
 *  stdout, and its single `NSLog` is inside `triggerFault`). From the host it presents only as
 *  `ECONNREFUSED :9095`, indistinguishable from "the app is not running".
 *
 *  That is what #368 hit. It reported the plugin as missing, blamed `cap sync ios` skipping an
 *  android-only `capacitor` block, and proposed adding an `ios` entry — a fix that would have
 *  broken every iOS build (see `capacitorPlatformDeclarations.test.ts`) while leaving this real
 *  cause untouched. Measured on the iPhone 8, 2026-08-27: with the base VC, port 9095 refused;
 *  after the one-word change, `device_connect` succeeded and `getDeviceIp` returned the LAN IP.
 *
 *  ⚠️ **This was PREDICTED and the prediction was not acted on.** `demos/postfx-demo` fixed it
 *  locally and left a comment saying it was "currently the ONLY project with a SceneDelegate" and
 *  that "if a newer Capacitor iOS template starts shipping a SceneDelegate by default, every NEW
 *  project inherits this". That is exactly what happened — 9 more projects arrived carrying the
 *  base VC, each with a silently dead debug bridge. A comment cannot enforce anything across
 *  projects that do not exist yet; this test can, which is why it exists rather than a nicer
 *  comment. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { REPO_ROOT, hasNativeProjects } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** Tracked SceneDelegate.swift files. `includeUntracked: false` — Tracked, not on-disk: an
 *  untracked one is a local experiment, and a project regenerated but not yet committed is not
 *  something this guard can meaningfully vouch for. */
function sceneDelegates(): string[] {
  return repoFiles({
    // Git's own (non-anchored) glob crosses `/` — see repoLayoutGuard.test.ts's identical note.
    match: /.+\/ios\/App\/App\/SceneDelegate\.swift$/,
    floor: 0,
    includeUntracked: false,
  }).map((f) => f.rel);
}

describe('iOS SceneDelegate builds the plugin-registering bridge VC (#368)', () => {
  const files = sceneDelegates();

  // Anti-vacuity. `sceneDelegates()` swallows any git failure into `[]`, and both assertions are
  // skipIf'd on that — so a renamed path, a non-checkout cwd or a missing git would silently skip
  // the whole guard, which looks identical to passing. This says so out loud wherever native
  // content is expected. (The public snapshot legitimately has none: publish-engine-oss.sh strips
  // `ios` from every staged demo — hence gating on the same predicate rather than asserting flat.)
  it.skipIf(!hasNativeProjects())('finds SceneDelegates to check — a vacuous pass is a failure', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.skipIf(files.length === 0)('no SceneDelegate builds a bare CAPBridgeViewController', () => {
    const offenders = files.filter((f) =>
      // Deliberately NOT /g: `.test()` on a global regex advances `lastIndex`, so hoisting this
      // literal to a module const would make it skip every second offending file. Any-occurrence
      // is all this needs.
      /rootViewController\s*=\s*CAPBridgeViewController\s*\(/.test(
        readScannedSource(path.join(REPO_ROOT, f)).code,
      ),
    );
    expect(
      offenders,
      `${offenders.join(', ')} — this overrides Main.storyboard's customClass, so MyViewController `
        + `never runs and GameDebugPlugin is never registered: the game renders fine and the iOS `
        + `debug bridge is silently dead ("GameDebug" plugin is not implemented on ios; :9095 `
        + `refuses). Use MyViewController(). See docs/native-and-sdks.md § "The SceneDelegate trap".`,
    ).toEqual([]);
  });

  it.skipIf(files.length === 0)('every project with a SceneDelegate also ships MyViewController.swift', () => {
    // The fix above is only meaningful if the class it names exists in that project's target.
    const missing = files
      .map((f) => f.replace(/\/ios\/App\/App\/SceneDelegate\.swift$/, ''))
      .filter((proj) => !fs.existsSync(path.join(REPO_ROOT, proj, 'ios/App/App/MyViewController.swift')));
    expect(missing, `${missing.join(', ')}: SceneDelegate references MyViewController but the project ships none`).toEqual([]);
  });
});
