/** Every debug surface in a project's NATIVE tree agrees with its `build.debugBuild` (#112).
 *
 *  Why this guard exists — and why it is not optional. `build.debugBuild` is the single source of
 *  truth for "does this build carry the debug bridge", and **this exact invariant has already
 *  drifted once**: `engine/app/main.tsx:42` records it — *"Previously this was ungated on native,
 *  so a RELEASE build shipped the eval-capable server."* A single source of truth that nothing
 *  verifies will drift again, and the next drift is a store submission carrying a TCP server with
 *  `handleEval` (arbitrary JS) on it.
 *
 *  It also asserts the half of #112 that is genuinely a GUARANTEE. The archive-time warning
 *  (Phase 2) deliberately prevents nothing — TestFlight builds run with the flag on, and a
 *  TestFlight archive is bit-identical to a store archive, so there is no build-time signal to
 *  refuse on. What CAN be held is the other direction: **flag OFF ⇒ every debug surface is gone.**
 *  That is what this file pins.
 *
 *  Two tiers, because they fail for different reasons:
 *
 *  1. **The committed projects agree with their own flag.** Catches drift in THIS repo — a
 *     hand-edited pbxproj, or a flag flipped in `project.config.json` without reopening the
 *     project so `healNativeConfig` could run. This is the state an IPA/APK is actually built from.
 *
 *  2. **A synthetic flag-off sweep** over a scaffolded temp project: NO debug marker may appear
 *     anywhere under `ios/` + `android/`. A flag-ON control asserts each marker DOES appear
 *     otherwise — without it the sweep could pass by finding nothing for the wrong reason (a
 *     mis-scaffolded fixture), which is how a guard quietly stops guarding.
 *
 *  What this does NOT reach: the JS bundle. That needs a real vite build and lives in
 *  `engine/scripts/smoke-debug-build-flag.mjs` (`npm run smoke:debug-flag`), too slow for the gate.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { healNativeConfig } from '../../plugins/healNativeConfig';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The markers that must appear iff `build.debugBuild` is true. Each is `[label, file, needle]`
 *  relative to the project root — one per surface #112 unified, so a surface that silently stops
 *  following the flag names itself in the failure. */
const NATIVE_MARKERS: Array<{ label: string; file: string; needle: string }> = [
  { label: 'iOS plugin registration', file: 'ios/App/App/MyViewController.swift', needle: 'registerPluginInstance(gameDebugPlugin)' },
  { label: 'iOS Local Network plist key', file: 'ios/App/App/Info.plist', needle: 'NSLocalNetworkUsageDescription' },
  { label: 'iOS Bonjour plist key', file: 'ios/App/App/Info.plist', needle: 'NSBonjourServices' },
  // #278 — the iOS mirror of the Android meta-data below, and the gate `triggerFault` reads. The
  // needle is the TRUE form: a flag-off project keeps the key with `<false/>`, which is a
  // deliberate write (a write-once flag would leave the capability behind on a project that turned
  // debugBuild off — exactly the state that must not be able to crash on demand).
  { label: 'iOS ModokiDebugBuild plist key', file: 'ios/App/App/Info.plist', needle: '<key>ModokiDebugBuild</key>\n\t<true/>' },
  { label: 'iOS archive warning phase', file: 'ios/App/App.xcodeproj/project.pbxproj', needle: "Warn: Modoki 'Debug build' is ON" },
  { label: 'Android debug-build meta-data', file: 'android/app/src/main/AndroidManifest.xml', needle: 'com.modokiengine.gamedebug.DEBUG_BUILD" android:value="true"' },
  { label: 'Android release-build warning', file: 'android/app/build.gradle', needle: 'modoki:debug-build-warning-begin' },
];

/** The retired `CONFIGURATION == Release` gate. It must not come back in ANY project — it is the
 *  second source of truth #112 removed, and re-adding it would silently reintroduce the
 *  "debugBuild:true + Release configuration = a debug build that cannot debug" failure. */
const RETIRED_GATES: Array<{ label: string; file: string; needle: string }> = [
  { label: 'retired Release Info.plist-strip phase', file: 'ios/App/App.xcodeproj/project.pbxproj', needle: 'Strip debug-only Info.plist keys' },
  { label: 'retired #if DEBUG registration gate', file: 'ios/App/App/MyViewController.swift', needle: '#if DEBUG' },
];

function readIf(dir: string, rel: string): string | undefined {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
}

/** Committed projects that own native folders AND depend on the game-debug bridge — the only ones
 *  the heals touch. */
function nativeGameDebugProjects(): { id: string; dir: string; debugBuild: boolean }[] {
  const out: { id: string; dir: string; debugBuild: boolean }[] = [];
  for (const root of PROJECT_ROOT_DIRS) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(abs, entry.name);
      const pkgRaw = readIf(dir, 'package.json');
      const cfgRaw = readIf(dir, 'project.config.json');
      if (!pkgRaw || !cfgRaw) continue;
      if (!fs.existsSync(path.join(dir, 'ios')) && !fs.existsSync(path.join(dir, 'android'))) continue;
      let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      let cfg: { build?: { debugBuild?: boolean } };
      try {
        pkg = JSON.parse(pkgRaw);
        cfg = JSON.parse(cfgRaw);
      } catch { continue; }
      if (!(pkg.dependencies?.['capacitor-game-debug'] || pkg.devDependencies?.['capacitor-game-debug'])) continue;
      out.push({ id: `${root}/${entry.name}`, dir, debugBuild: cfg.build?.debugBuild === true });
    }
  }
  return out;
}

describe('build.debugBuild is the single gate — committed native projects (#112)', () => {
  const projects = nativeGameDebugProjects();

  // The OSS snapshot ships no projects with native folders, so there is nothing to check there.
  // Skipping is correct; passing vacuously without saying so is how a guard rots unnoticed.
  it.skipIf(projects.length === 0)('finds native game-debug projects to check', () => {
    expect(projects.length).toBeGreaterThan(0);
  });

  it.skipIf(projects.length === 0)('every native debug surface matches the project\'s own flag', () => {
    const wrong: string[] = [];
    for (const p of projects) {
      for (const m of NATIVE_MARKERS) {
        const text = readIf(p.dir, m.file);
        if (text === undefined) continue; // that platform isn't scaffolded for this project
        const present = text.includes(m.needle);
        if (present !== p.debugBuild) {
          wrong.push(`${p.id} (debugBuild: ${p.debugBuild}) — ${m.label} is ${present ? 'PRESENT' : 'ABSENT'} in ${m.file}`);
        }
      }
    }
    expect(wrong, wrong.length
      ? 'Native debug surfaces disagree with build.debugBuild. An IPA/APK is built from THIS state, '
        + 'so a mismatch ships a debug surface the project says it does not want (or omits one it '
        + 'does).\n  ' + wrong.join('\n  ')
        + '\n\nFix: reopen each project in the editor (heal-on-open runs healNativeConfig), or call '
        + 'healNativeConfig(projectRoot) directly.'
      : '',
    ).toEqual([]);
  });

  it.skipIf(projects.length === 0)('no project has resurrected a build-configuration gate', () => {
    const found: string[] = [];
    for (const p of projects) {
      for (const g of RETIRED_GATES) {
        const text = readIf(p.dir, g.file);
        if (text?.includes(g.needle)) found.push(`${p.id} — ${g.label} in ${g.file}`);
      }
    }
    expect(found, found.length
      ? 'A retired Xcode-CONFIGURATION gate is back. That is the second source of truth #112 '
        + 'removed: it makes `debugBuild: true` + a Release configuration produce a debug build '
        + 'that cannot debug, with nothing explaining why.\n  ' + found.join('\n  ')
      : '',
    ).toEqual([]);
  });
});

describe('build.debugBuild OFF strips every native debug surface (#112)', () => {
  let root: string | undefined;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });

  /** A minimal but structurally faithful native project the heals can act on. */
  function scaffold(debugBuild: boolean): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-debugflag-'));
    fs.writeFileSync(path.join(dir, 'project.config.json'), JSON.stringify({ build: { debugBuild } }));
    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { 'capacitor-game-debug': 'file:plugins/x.tgz' } }));
    // The engine plugin source the iOS wiring references.
    const sw = path.join(dir, 'engine', 'packages', 'capacitor-game-debug', 'ios', 'Sources', 'GameDebugPlugin');
    fs.mkdirSync(sw, { recursive: true });
    fs.writeFileSync(path.join(sw, 'GameDebugPlugin.swift'), '// stub');

    fs.mkdirSync(path.join(dir, 'ios', 'App', 'App', 'Base.lproj'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ios', 'App', 'App', 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>x</string>\n</dict>\n</plist>\n');
    fs.writeFileSync(path.join(dir, 'ios', 'App', 'App', 'Base.lproj', 'Main.storyboard'),
      '<viewController customClass="CAPBridgeViewController" customModule="Capacitor"/>');
    fs.writeFileSync(path.join(dir, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), [
      '// !$*UTF8*$!', '{', '\tobjects = {',
      '/* Begin PBXBuildFile section */',
      '\t\t504EC3081 /* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = 504EC3071 /* AppDelegate.swift */; };',
      '/* End PBXBuildFile section */', '',
      '/* Begin PBXFileReference section */',
      '\t\t504EC3071 /* AppDelegate.swift */ = {isa = PBXFileReference; path = AppDelegate.swift; sourceTree = "<group>"; };',
      '/* End PBXFileReference section */', '',
      '/* Begin PBXGroup section */',
      '\t\t504EC3061 /* App */ = {', '\t\t\tisa = PBXGroup;', '\t\t\tchildren = (',
      '\t\t\t\t504EC3071 /* AppDelegate.swift */,', '\t\t\t);', '\t\t};',
      '/* End PBXGroup section */', '',
      '/* Begin PBXNativeTarget section */',
      '\t\t504EC3031 /* App */ = {', '\t\t\tisa = PBXNativeTarget;', '\t\t\tbuildPhases = (',
      '\t\t\t\t504EC3001 /* Sources */,', '\t\t\t\t504EC3021 /* Resources */,', '\t\t\t);',
      '\t\t\tname = App;', '\t\t};',
      '/* End PBXNativeTarget section */', '',
      '/* Begin PBXSourcesBuildPhase section */',
      '\t\t504EC3001 /* Sources */ = {', '\t\t\tisa = PBXSourcesBuildPhase;', '\t\t\tfiles = (',
      '\t\t\t\t504EC3081 /* AppDelegate.swift in Sources */,', '\t\t\t);', '\t\t};',
      '/* End PBXSourcesBuildPhase section */',
      '\t};', '}', '',
    ].join('\n'));

    fs.mkdirSync(path.join(dir, 'android', 'app', 'src', 'main'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'android', 'app', 'build.gradle'), "apply plugin: 'com.android.application'\n");
    fs.writeFileSync(path.join(dir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
      '<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n'
      + '    <application android:label="x">\n        <activity android:name=".MainActivity" />\n    </application>\n</manifest>\n');
    return dir;
  }

  /** THE CONTROL. Without this the flag-off sweep below could pass by finding nothing for the
   *  wrong reason — a fixture that never grew the surfaces in the first place. Every marker must
   *  be demonstrably findable before "not found" means anything. */
  it('flag ON — every marker is present (so the OFF assertion below can fail)', () => {
    root = scaffold(true);
    healNativeConfig(root);
    const missing = NATIVE_MARKERS.filter((m) => !readIf(root!, m.file)?.includes(m.needle)).map((m) => m.label);
    expect(missing, missing.length
      ? `The control is broken: these markers never appeared even with the flag ON, so the flag-OFF `
        + `sweep proves nothing about them: ${missing.join(', ')}`
      : '').toEqual([]);
  });

  it('flag OFF — not one debug marker survives anywhere in the native tree', () => {
    root = scaffold(false);
    healNativeConfig(root);
    const leaked = NATIVE_MARKERS.filter((m) => readIf(root!, m.file)?.includes(m.needle)).map((m) => m.label);
    expect(leaked, leaked.length
      ? `build.debugBuild is OFF but these debug surfaces are still in the native project — a `
        + `release build would carry them: ${leaked.join(', ')}`
      : '').toEqual([]);
  });

  it('flipping the flag OFF strips a project that was healed ON (not just a fresh one)', () => {
    root = scaffold(true);
    healNativeConfig(root);
    fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ build: { debugBuild: false } }));
    healNativeConfig(root);
    const leaked = NATIVE_MARKERS.filter((m) => readIf(root!, m.file)?.includes(m.needle)).map((m) => m.label);
    expect(leaked, leaked.length ? `Surfaces survived the flag going off: ${leaked.join(', ')}` : '').toEqual([]);
  });
});
