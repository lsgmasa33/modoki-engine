/** healNativeConfig — heal-on-open native config (android/local.properties +
 *  iOS DEVELOPMENT_TEAM). Exercised against real temp project dirs. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { healNativeConfig, androidSdkDirValue } from '../../plugins/healNativeConfig';
// Read the floors from the schema rather than hardcoding them: this file asserts the WIRING
// (the default reaches the heal at all). The floor VALUES are pinned, deliberately and with
// their rationale, in tests/architecture/buildTargetFloor.test.ts — duplicating them here
// would mean a reviewed floor change had to be edited in two places.
import { DEFAULT_PROJECT_CONFIG } from '../../project-config';

let root: string;
let savedToolchainDir: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-heal-'));
  // The sdk.dir heal resolves the SDK through the shared toolchain probe, which only honours
  // ANDROID_HOME in DEV-editor mode. A dev box that exports MODOKI_TOOLCHAIN_DIR (some do, so CLI
  // builds find toktx) is bundled-only, so the fixture SDK below would be ignored — unset it.
  savedToolchainDir = process.env.MODOKI_TOOLCHAIN_DIR;
  delete process.env.MODOKI_TOOLCHAIN_DIR;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.ANDROID_HOME;
  if (savedToolchainDir === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR;
  else process.env.MODOKI_TOOLCHAIN_DIR = savedToolchainDir;
});

/** `debugBuild` defaults to TRUE here, unlike the product default (false) — the
 *  game-debug heals only DO anything in the on direction, so an on-by-default helper
 *  keeps every pre-#112 test asserting what it was written to assert. Tests that care
 *  about the gate pass it explicitly, in both directions. */
function writeConfig(teamId: string, debugBuild = true) {
  fs.writeFileSync(
    path.join(root, 'project.config.json'),
    JSON.stringify({ build: { appleTeamId: teamId, debugBuild } }),
  );
}

/** Mark the project as a game-debug consumer (gates the game-debug heals). */
function writeGameDebugDep() {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: { 'capacitor-game-debug': 'file:plugins/x.tgz' } }),
  );
}

/** Plant a fake engine GameDebugPlugin.swift so findEngineGameDebugSwift resolves
 *  (the wiring references it by a repo-relative pbxproj path). Returns its path. */
function writeEngineGameDebugSwift(): string {
  const dir = path.join(root, 'engine', 'packages', 'capacitor-game-debug', 'ios', 'Sources', 'GameDebugPlugin');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'GameDebugPlugin.swift');
  fs.writeFileSync(p, '// stub');
  return p;
}

/** Realistic pbxproj fixture: per-target XCBuildConfiguration blocks (24-hex
 *  UUIDs) + an XCConfigurationList per target naming its PBXNativeTarget, so the
 *  heal can scope to the App target's configs. `team` undefined ⇒ no team line;
 *  pass '""' for the empty-quoted form. `ext` adds a second target. */
const U = {
  appDebug: '1111111111111111111111AA', appRelease: '1111111111111111111111BB', appList: '1111111111111111111111CC',
  extDebug: '2222222222222222222222AA', extRelease: '2222222222222222222222BB', extList: '2222222222222222222222CC',
};
function cfgBlock(uuid: string, name: string, team?: string): string {
  const teamLine = team !== undefined ? `\n\t\t\t\tDEVELOPMENT_TEAM = ${team};` : '';
  return `
\t\t${uuid} /* ${name} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.x.y;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";${teamLine}
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t};
\t\t\tname = ${name};
\t\t};`;
}
function listBlock(uuid: string, targetName: string, debugU: string, releaseU: string): string {
  return `
\t\t${uuid} /* Build configuration list for PBXNativeTarget "${targetName}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${debugU} /* Debug */,
\t\t\t\t${releaseU} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t};`;
}
function pbxproj(opts: { team?: string; ext?: { team?: string } } = {}): string {
  let body = cfgBlock(U.appDebug, 'Debug', opts.team) + cfgBlock(U.appRelease, 'Release', opts.team)
    + listBlock(U.appList, 'App', U.appDebug, U.appRelease);
  if (opts.ext) {
    body += cfgBlock(U.extDebug, 'Debug', opts.ext.team) + cfgBlock(U.extRelease, 'Release', opts.ext.team)
      + listBlock(U.extList, 'MyExtension', U.extDebug, U.extRelease);
  }
  // The debug.xcconfig file reference + its group membership are part of EVERY real Capacitor
  // project, and the Release-wrapper attach keys off them (it refuses to invent references into a
  // shape it does not recognise). Without them here the fixture silently skipped that path.
  const xcconfigRefs = `
\t\t958DCC722DB07C7200EA8C5F /* debug.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; name = debug.xcconfig; path = ../debug.xcconfig; sourceTree = SOURCE_ROOT; };
\t\t504EC3061FED79650016851F /* Products */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t958DCC722DB07C7200EA8C5F /* debug.xcconfig */,
\t\t\t);
\t\t};`;
  return `// !$*UTF8*$!\n{${xcconfigRefs}${body}\n}\n`;
}

function writePbxproj(content: string) {
  const dir = path.join(root, 'ios', 'App', 'App.xcodeproj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.pbxproj'), content);
  // Capacitor's own file. Laid down by default because the heal REFUSES to strip the pbxproj
  // team unless both configurations are wired, and Debug's wiring is an include in this file.
  fs.writeFileSync(path.join(root, 'ios', 'debug.xcconfig'), 'CAPACITOR_DEBUG = true\n');
}
function readPbxproj(): string {
  return fs.readFileSync(path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');
}

describe('healNativeConfig — android/local.properties', () => {
  it('writes sdk.dir when android/ exists and the file is missing', () => {
    fs.mkdirSync(path.join(root, 'android'));
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sdk-'));
    // A usable SDK has platform-tools — the shared toolchain probe now requires it (the
    // consistent marker check that unified this with vite-asset-scanner's build-time probe).
    fs.mkdirSync(path.join(sdk, 'platform-tools'));
    process.env.ANDROID_HOME = sdk;
    writeConfig('');
    healNativeConfig(root);
    // sdk.dir is forward-slashed (a Java .properties file escapes backslashes) — so the
    // expected mirrors the code's androidSdkDirValue, not the raw (backslash on Windows) sdk.
    expect(fs.readFileSync(path.join(root, 'android', 'local.properties'), 'utf8')).toBe(`sdk.dir=${sdk.replace(/\\/g, '/')}\n`);
    fs.rmSync(sdk, { recursive: true, force: true });
  });

  it('does NOT clobber an existing local.properties', () => {
    fs.mkdirSync(path.join(root, 'android'));
    const lp = path.join(root, 'android', 'local.properties');
    fs.writeFileSync(lp, 'sdk.dir=/custom/path\n');
    process.env.ANDROID_HOME = os.tmpdir();
    writeConfig('');
    healNativeConfig(root);
    expect(fs.readFileSync(lp, 'utf8')).toBe('sdk.dir=/custom/path\n');
  });

  it('REPAIRS a stale backslash-corrupted sdk.dir (project first built by an older editor)', () => {
    // A project built by editor ≤0.2.8 has a broken local.properties; heal must repair it, not skip.
    fs.mkdirSync(path.join(root, 'android'));
    const lp = path.join(root, 'android', 'local.properties');
    fs.writeFileSync(lp, 'sdk.dir=C:\\Users\\winuser\\AppData\\Roaming\\modoki-app\\toolchain\\android-sdk\n');
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-sdk-'));
    fs.mkdirSync(path.join(sdk, 'platform-tools')); // the toolchain probe requires this marker to accept an SDK — without it detectAndroidSdk returns null on a host with no other discoverable SDK (e.g. Windows CI), so the repair never runs
    process.env.ANDROID_HOME = sdk;
    healNativeConfig(root);
    const out = fs.readFileSync(lp, 'utf8');
    // The invariant: the backslash corruption is gone and a valid sdk.dir line remains. (The exact
    // path is whatever detectAndroidSdk resolves on the host — not what this test pins.)
    expect(out).not.toContain('\\');
    expect(out).toMatch(/^sdk\.dir=\S/m);
  });

  it('sdk.dir forward-slashes a Windows path (a .properties file escapes backslashes)', () => {
    // Regression: a raw `C:\Users\…\toolchain\android-sdk` in local.properties mangled (\t → TAB,
    // \U/\A dropped) → Gradle "The filename, directory name, or volume label syntax is incorrect".
    expect(androidSdkDirValue('C:\\Users\\winuser\\AppData\\Roaming\\modoki-app\\toolchain\\android-sdk'))
      .toBe('C:/Users/winuser/AppData/Roaming/modoki-app/toolchain/android-sdk');
    expect(androidSdkDirValue('C:\\a\\b')).not.toContain('\\');
    expect(androidSdkDirValue('/home/x/Android/Sdk')).toBe('/home/x/Android/Sdk'); // POSIX unchanged
  });

  it('no-op when the project has no android/ folder', () => {
    writeConfig('');
    const { notes } = healNativeConfig(root);
    expect(notes.join()).not.toContain('local.properties');
  });
});

describe('healNativeConfig — iOS DEVELOPMENT_TEAM', () => {
  // ⚠️ These four USED to assert the Team ID was written INTO the pbxproj. That expectation was
  // the defect, not the contract: the pbxproj is tracked, so every heal put an owner-private value
  // back into git where `privateBuildFields.test.ts` could not see it (#172 closed this for
  // project.config.json and missed the second home). The value now lives in the GITIGNORED
  // ios/modoki.local.xcconfig and is stripped OUT of the pbxproj. What survives unchanged is the
  // target scoping — that intent was always right.
  const localXcconfig = () => fs.readFileSync(path.join(root, 'ios', 'modoki.local.xcconfig'), 'utf8');

  it('puts the team in the gitignored xcconfig and NOT in the tracked pbxproj', () => {
    writePbxproj(pbxproj());
    writeConfig('ABCDE12345');
    healNativeConfig(root);
    expect(localXcconfig()).toContain('DEVELOPMENT_TEAM = ABCDE12345');
    expect(readPbxproj()).not.toContain('ABCDE12345');
  });

  it('strips a previously committed team out of the pbxproj', () => {
    writePbxproj(pbxproj({ team: 'OLDTEAM123' }));
    writeConfig('ABCDE12345');
    healNativeConfig(root);
    const out = readPbxproj();
    // Both the stale value and the setting itself are gone — a blank would SHADOW the xcconfig,
    // because a target's buildSettings beat its baseConfigurationReference.
    expect(out).not.toContain('OLDTEAM123');
    expect(out).not.toMatch(/DEVELOPMENT_TEAM/);
    expect(localXcconfig()).toContain('DEVELOPMENT_TEAM = ABCDE12345');
  });

  it('wires BOTH configurations — Debug via debug.xcconfig, Release via its own wrapper', () => {
    // Capacitor attaches debug.xcconfig to the DEBUG configs only, so a Debug-only include leaves
    // the configuration that actually ships with no team. Measured against the real toolchain with
    // `xcodebuild -showBuildSettings -configuration Release`.
    writePbxproj(pbxproj());
    writeConfig('ABCDE12345');
    healNativeConfig(root);
    expect(fs.readFileSync(path.join(root, 'ios', 'debug.xcconfig'), 'utf8'))
      .toContain('#include? "modoki.local.xcconfig"');
    // The Release wrapper is TRACKED, so it must carry the include and never the value.
    const wrapper = fs.readFileSync(path.join(root, 'ios', 'modoki.xcconfig'), 'utf8');
    expect(wrapper).toContain('#include? "modoki.local.xcconfig"');
    expect(wrapper).not.toContain('ABCDE12345');
    const out = readPbxproj();
    expect(out).toContain('modoki.xcconfig');
    // Attached to Release (which Capacitor left with no base configuration) …
    expect(out).toMatch(/\/\* Release \*\/ = \{\n\s*isa = XCBuildConfiguration;\n\s*baseConfigurationReference = \w+ \/\* modoki\.xcconfig \*\//);
    // … and NOT to Debug, whose own base configuration must not be displaced.
    expect(out).not.toMatch(/\/\* Debug \*\/ = \{\n\s*isa = XCBuildConfiguration;\n\s*baseConfigurationReference = \w+ \/\* modoki\.xcconfig \*\//);
  });

  it('is idempotent — a second pass changes nothing', () => {
    writePbxproj(pbxproj());
    writeConfig('ABCDE12345');
    healNativeConfig(root);
    const once = readPbxproj();
    healNativeConfig(root);
    expect(readPbxproj()).toBe(once);
  });

  it('no-op when appleTeamId is empty', () => {
    writePbxproj(pbxproj());
    writeConfig('');
    healNativeConfig(root);
    expect(readPbxproj()).not.toContain('DEVELOPMENT_TEAM');
  });

  it('refuses to strip when a configuration is NOT wired — never leaves a project teamless', () => {
    // The strip destroys the last copy of the value, so it is only safe once something supplies it.
    // Here Debug cannot be wired (no debug.xcconfig), so the committed team must survive — a heal
    // that stripped anyway would break signing with Xcode's cryptic "requires a development team",
    // and there would be nothing left to restore from.
    writePbxproj(pbxproj({ team: 'OLDTEAM123' }));
    fs.rmSync(path.join(root, 'ios', 'debug.xcconfig'));
    writeConfig('ABCDE12345');
    const notes = healNativeConfig(root).notes.join(' ');
    expect(readPbxproj()).toContain('OLDTEAM123');   // untouched
    expect(notes).toContain('not wired');            // and it SAYS so rather than failing silently
  });

  it('does NOT strip a separate target\'s team (D2)', () => {
    // Same intent as before the xcconfig move: the App target is ours to rewrite, an extension's
    // signing is not. Only the direction changed — we remove rather than insert.
    writePbxproj(pbxproj({ ext: { team: 'EXTTEAM123' } }));
    writeConfig('ABCDE12345');
    healNativeConfig(root);
    const out = readPbxproj();
    expect((out.match(/DEVELOPMENT_TEAM = EXTTEAM123;/g) || []).length).toBe(2); // extension untouched
    expect(out).not.toContain('ABCDE12345');
  });

  it('removes the empty-quoted DEVELOPMENT_TEAM = ""; form rather than filling it (D2)', () => {
    // The blank is the dangerous case: left in place it wins over the xcconfig and signing fails
    // in a way that looks exactly like a missing team.
    writePbxproj(pbxproj({ team: '""' }));
    writeConfig('ABCDE12345');
    healNativeConfig(root);
    expect(readPbxproj()).not.toContain('DEVELOPMENT_TEAM = "";');
    expect(localXcconfig()).toContain('DEVELOPMENT_TEAM = ABCDE12345');
  });

  it('bails safely when the App target config list is absent (no flatten)', () => {
    // A pbxproj with build configs but no "PBXNativeTarget \"App\"" list.
    const noList = `// !$*UTF8*$!\n{${cfgBlock(U.appDebug, 'Debug', 'SOMETEAM01')}\n}\n`;
    writePbxproj(noList);
    writeConfig('ABCDE12345');
    healNativeConfig(root);
    expect(readPbxproj()).toContain('SOMETEAM01'); // untouched — couldn't identify App target
  });
});

/** #278 — the iOS MIRROR of the Android `DEBUG_BUILD` meta-data, and the gate
 *  `GameDebugPlugin.triggerFault` reads. Before it, the iOS plugin checked nothing at all: a
 *  shipped binary would have carried a callable "kill the app" method. The key name is a contract
 *  with `GameDebugPlugin.swift`'s `debugBuildPlistKey`. */
/** #279 — iOS crash reports were arriving UNSYMBOLICATED. Court's pbxproj had carried an
 *  "Upload Crashlytics dSYMs" phase since #275 and it exited early on every build, because
 *  `DEBUG_INFORMATION_FORMAT` was plain `dwarf` in Debug — which is the configuration every device
 *  build we test crash reporting with uses. The console accumulated 8 unprocessed crashes while
 *  every signal said the phase was installed.
 *
 *  So the two halves are tested together, because either alone is inert: the SETTING (no dSYM
 *  without it) and the PHASE (nothing uploads it). */
describe('healNativeConfig — iOS Crashlytics dSYMs', () => {
  const PBX = ['ios', 'App', 'App.xcodeproj', 'project.pbxproj'];
  const readPbx = () => fs.readFileSync(path.join(root, ...PBX), 'utf8');

  /** A pbxproj with the App target's buildPhases list + two build configurations: one naming
   *  `dwarf` (Xcode's Debug default, spelled out) and one omitting the key entirely — the two
   *  shapes the heal has to handle differently. */
  function writeDsymPbx() {
    const dir = path.join(root, 'ios', 'App', 'App.xcodeproj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.pbxproj'), [
      '// !$*UTF8*$!',
      '{',
      '/* Begin PBXNativeTarget section */',
      '\t\t504EC3031FED79650016851F /* App */ = {',
      '\t\t\tbuildPhases = (',
      '\t\t\t\t504EC3001FED79650016851F /* Sources */,',
      '\t\t\t\t504EC3021FED79650016851F /* Resources */,',
      '\t\t\t);',
      '\t\t};',
      '/* End PBXNativeTarget section */',
      '/* Begin PBXSourcesBuildPhase section */',
      '/* End PBXSourcesBuildPhase section */',
      '/* Begin XCBuildConfiguration section */',
      '\t\t1111111111111111111111AA /* Debug */ = {',
      '\t\t\tisa = XCBuildConfiguration;',
      '\t\t\tbuildSettings = {',
      '\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;',
      '\t\t\t};',
      '\t\t\tname = Debug;',
      '\t\t};',
      '\t\t1111111111111111111111BB /* Release */ = {',
      '\t\t\tisa = XCBuildConfiguration;',
      '\t\t\tbuildSettings = {',
      '\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";',
      '\t\t\t};',
      '\t\t\tname = Release;',
      '\t\t};',
      '/* End XCBuildConfiguration section */',
      '}',
    ].join('\n'));
  }

  /** Crashlytics is the gate — a project without it has nothing to symbolicate. */
  function writeCrashlyticsDep(withCrashlytics = true) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      dependencies: withCrashlytics ? { '@capacitor-firebase/crashlytics': '^7.0.0' } : {},
    }));
  }

  /**
   * ⚠️ REGRESSION (close-out, 2026-08-20). The dSYM phase and the archive-time "Debug build is ON"
   * phase both spliced themselves in immediately after the `PBXShellScriptBuildPhase` section-open
   * line, so each put ITSELF first and shoved the other to second. On every project open the two
   * objects swapped places, each heal rewrote the pbxproj, and each returned a "synced …" note for
   * work that netted to nothing — measured on games/court: two writes of equal length and opposite
   * content, with the file byte-identical before and after the pass.
   *
   * A heal note is the editor's report to the human that something was repaired. One that fires
   * every single time is a false success, and it hides the real ones. Deterministic slots (warning
   * first, dSYM last) make both heals fixed points, so a note now means a real change.
   */
  it('a second pass over an already-healed project reports nothing and rewrites nothing', () => {
    writeDsymPbx(); writeConfig('TEAMID1234', true);
    // BOTH deps in ONE package.json — the two helpers each write the whole file, so calling them
    // in sequence silently drops the first one's dependency and turns the gate off.
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      dependencies: { '@capacitor-firebase/crashlytics': '^7.0.0', 'capacitor-game-debug': 'file:plugins/x.tgz' },
    }));
    healNativeConfig(root);                       // installs BOTH shell-script phases

    const before = readPbx();
    expect(before, 'both phases are present, so the interaction is live')
      .toContain('Upload Crashlytics dSYMs');
    expect(before).toContain("Warn: Modoki 'Debug build' is ON");

    const notes = healNativeConfig(root).notes.join(' | ');
    expect(readPbx(), 'the second pass leaves the pbxproj byte-identical').toBe(before);
    expect(notes, 'and claims no dSYM work').not.toContain('dSYM upload phase');
    expect(notes, 'and claims no archive-warning work').not.toContain('archive-time');
  });

  it('sets dwarf-with-dsym in EVERY configuration — including the one that omitted the key', () => {
    writeDsymPbx();
    writeConfig('');
    writeCrashlyticsDep();
    healNativeConfig(root);
    const out = readPbx();
    expect(out).not.toContain('DEBUG_INFORMATION_FORMAT = dwarf;');
    // Two configs, so two occurrences — the rewritten one AND the one that had no key at all.
    expect((out.match(/DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";/g) || []).length).toBe(2);
  });

  it('adds the upload phase — both the buildPhases reference and the object', () => {
    writeDsymPbx();
    writeConfig('');
    writeCrashlyticsDep();
    healNativeConfig(root);
    const out = readPbx();
    expect(out).toContain('DD0000000000000000000007 /* Upload Crashlytics dSYMs */,');
    expect(out).toContain('isa = PBXShellScriptBuildPhase;');
    expect(out).toContain('/* Begin PBXShellScriptBuildPhase section */');
  });

  // The failure this guards is a SECOND phase beside the first, which would upload twice and, worse,
  // make the pbxproj's phase list disagree with what anyone reading it expects.
  it('is idempotent — a second pass leaves the pbxproj byte-identical and adds no second phase', () => {
    writeDsymPbx();
    writeConfig('');
    writeCrashlyticsDep();
    healNativeConfig(root);
    const once = readPbx();
    healNativeConfig(root);
    expect(readPbx()).toBe(once);
    expect((readPbx().match(/Upload Crashlytics dSYMs/g) || []).length).toBe(3);
  });

  /** The property strip-and-reinsert exists FOR, and the one idempotence cannot see: a project
   *  healed by an OLDER version of the engine carries that version's script text, and the next
   *  heal must REPLACE it. A "skip if the phase is already there" implementation passes every
   *  other test in this describe — measured, by mutating the heal to do exactly that: 101/101
   *  green. So this test drives the distinguishing case, an existing phase whose body is stale. */
  it('REPLACES a stale phase body rather than leaving the project on the old script', () => {
    writeDsymPbx();
    writeConfig('');
    writeCrashlyticsDep();
    healNativeConfig(root);
    // Simulate a project healed by an older engine: same phase, same UUID, obsolete body.
    // Line-wise, not a quoted-string regex: the real script body contains escaped quotes, so
    // `"[^"]*"` stops inside it and silently matches nothing — which made the first version of this
    // test fail on its own fixture rather than on the behaviour.
    const aged = readPbx().split('\n')
      .map((l) => (l.trimStart().startsWith('shellScript = ') ? '\t\t\tshellScript = "echo OLD-SCRIPT";' : l))
      .join('\n');
    fs.writeFileSync(path.join(root, ...PBX), aged);
    expect(readPbx()).toContain('OLD-SCRIPT'); // the fixture is what we think it is

    healNativeConfig(root);
    expect(readPbx()).not.toContain('OLD-SCRIPT');
    expect(readPbx()).toContain('Crashlytics symbol upload');
    // and still exactly one phase, not the old one plus a new one
    expect((readPbx().match(/Upload Crashlytics dSYMs/g) || []).length).toBe(3);
  });

  it('does nothing for a project without Crashlytics', () => {
    writeDsymPbx();
    writeConfig('');
    writeCrashlyticsDep(false);
    const before = readPbx();
    healNativeConfig(root);
    expect(readPbx()).toBe(before);
  });
});

describe('healNativeConfig — Android Crashlytics gradle wiring (#282)', () => {
  const TOP_GRADLE = ['android', 'build.gradle'];
  const APP_GRADLE = ['android', 'app', 'build.gradle'];
  const readTop = () => fs.readFileSync(path.join(root, ...TOP_GRADLE), 'utf8');
  const readApp = () => fs.readFileSync(path.join(root, ...APP_GRADLE), 'utf8');

  /** Crashlytics is the gate — a project without it has nothing to report. */
  function writeCrashlyticsDep(withCrashlytics = true) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      dependencies: withCrashlytics ? { '@capacitor-firebase/crashlytics': '^7.0.0' } : {},
    }));
  }

  /** A bare `android/build.gradle` with no Crashlytics wiring yet — the fresh-project shape. */
  function writeTopGradle() {
    fs.mkdirSync(path.join(root, 'android'), { recursive: true });
    fs.writeFileSync(path.join(root, ...TOP_GRADLE), [
      'buildscript {',
      '    dependencies {',
      "        classpath 'com.android.tools.build:gradle:8.13.0'",
      "        classpath 'com.google.gms:google-services:4.4.4'",
      '    }',
      '}',
      '',
    ].join('\n'));
  }

  /** A bare `android/app/build.gradle` with the servicesJSON guard but no Crashlytics wiring —
   *  the fresh-project shape. */
  function writeAppGradle() {
    fs.mkdirSync(path.join(root, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, ...APP_GRADLE), [
      "apply plugin: 'com.android.application'",
      '',
      'dependencies {',
      "    implementation fileTree(include: ['*.jar'], dir: 'libs')",
      '}',
      '',
      "try {",
      "    def servicesJSON = file('google-services.json')",
      '    if (servicesJSON.text) {',
      "        apply plugin: 'com.google.gms.google-services'",
      '    }',
      '} catch(Exception e) {',
      '    logger.info("google-services.json not found")',
      '}',
      '',
    ].join('\n'));
  }

  /**
   * ⚠️ REGRESSION (close-out, 2026-08-20). An inline comment on the guard line made the anchor
   * INVISIBLE — `[ \t]*$` demanded the line end in whitespace — so the apply-plugin edit was
   * skipped while the classpath and the NDK artifact still landed AND the heal still returned a
   * success note. Measured against Court's real `app/build.gradle` with one comment added:
   * `["synced Android Crashlytics gradle wiring — Gradle plugin classpath, NDK artifact (#282)"]`
   * with `apply plugin: 'com.google.firebase.crashlytics'` nowhere in the file. Without that
   * apply, the classpath and NDK artifact do nothing — the half-wired shape #282 exists to end.
   */
  it('still finds the guard when the anchor line carries a trailing comment', () => {
    writeTopGradle(); writeCrashlyticsDep();
    fs.mkdirSync(path.join(root, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, ...APP_GRADLE), [
      "apply plugin: 'com.android.application'",
      '',
      'dependencies { // top-level',
      "    implementation fileTree(include: ['*.jar'], dir: 'libs')",
      '}',
      '',
      'try {',
      "    def servicesJSON = file('google-services.json')",
      '    if (servicesJSON.text) {',
      "        apply plugin: 'com.google.gms.google-services' // keep with crashlytics",
      '    }',
      '} catch(Exception e) { }',
      '',
    ].join('\n'));
    healNativeConfig(root);

    const app = readApp();
    expect(app, 'the plugin apply landed despite the comment')
      .toContain("apply plugin: 'com.google.firebase.crashlytics'");
    // and INSIDE the guard, not merely somewhere in the file
    const guardOpen = app.indexOf('if (servicesJSON.text) {');
    const applyIdx = app.indexOf("apply plugin: 'com.google.firebase.crashlytics'");
    expect(applyIdx).toBeGreaterThan(guardOpen);
    expect(applyIdx).toBeLessThan(app.indexOf('} catch(Exception e)'));
    // the commented `dependencies {` anchor survived too
    expect(app).toContain('firebase-crashlytics-ndk');
  });

  /** The other half of the same defect: when the apply genuinely cannot be placed, SAY SO rather
   *  than returning the two cosmetic edits as a success. */
  it('reports a warning instead of success when there is no guard to anchor the apply on', () => {
    writeTopGradle(); writeCrashlyticsDep();
    fs.mkdirSync(path.join(root, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, ...APP_GRADLE), [
      "apply plugin: 'com.android.application'",
      '',
      'dependencies {',
      '}',
      '',
    ].join('\n'));
    const notes = healNativeConfig(root).notes.join(' | ');

    expect(readApp(), 'no apply to anchor on, so none was invented')
      .not.toContain("apply plugin: 'com.google.firebase.crashlytics'");
    expect(notes, 'and the note says the wiring is inert rather than claiming success')
      .toContain('apply-plugin NOT wired');
  });

  /** CRLF must not defeat the fence strip: a `\r` left attached to the previous line makes the
   *  heal rewrite the file on the next two passes and permanently mixes line endings.
   *  `.gitattributes` pins `*.gradle text eol=lf`, so this needs a non-git write path — but the
   *  repo has a documented history of Windows-only path/EOL bugs, and the cost here is one regex. */
  it('keeps CRLF gradle files on CRLF when it edits them, and settles in one pass', () => {
    // ⚠️ The file must NEED an edit for this to test anything. An already-wired CRLF file is left
    // alone by normalization alone — the first version of this test did exactly that and stayed
    // GREEN with the line-ending restore mutated to the identity function, which is a test that
    // cannot see the bug it guards.
    writeTopGradle(); writeAppGradle(); writeCrashlyticsDep();
    for (const parts of [TOP_GRADLE, APP_GRADLE]) {
      const f = path.join(root, ...parts);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
    }

    healNativeConfig(root);                       // this pass WRITES — the wiring is absent

    for (const [label, text] of [['top-level', readTop()], ['app', readApp()]] as const) {
      expect(text, `${label} gradle actually got the wiring`).toContain('modoki:crashlytics-');
      expect(/[^\r]\n/.test(text), `${label} gradle stayed CRLF — no bare-LF line was inserted`)
        .toBe(false);
    }
    const afterFirst = [readTop(), readApp()];
    healNativeConfig(root);
    expect([readTop(), readApp()], 'and the next pass is a no-op').toEqual(afterFirst);
  });

  it('adds all three edits, each in the right place, for a project with none of them', () => {
    writeTopGradle(); writeAppGradle(); writeCrashlyticsDep();
    healNativeConfig(root);

    const top = readTop();
    expect(top).toContain('modoki:crashlytics-classpath-begin');
    expect(top).toContain(`classpath 'com.google.firebase:firebase-crashlytics-gradle:3.0.3'`);
    // anchored after the google-services classpath, not the AGP one
    expect(top.indexOf("google-services:4.4.4'")).toBeLessThan(top.indexOf('firebase-crashlytics-gradle'));

    const app = readApp();
    expect(app).toContain('modoki:crashlytics-ndk-begin');
    // The version is an EXPRESSION, not a literal: the NDK artifact and the one
    // `@capacitor-firebase/crashlytics` resolves are a matched pair, and a mismatch fails at
    // RUNTIME (no NDK reporting) rather than at resolution. Freezing a number here would drift
    // silently the moment the plugin bumps.
    expect(app).toContain("implementation \"com.google.firebase:firebase-crashlytics-ndk:"
      + "${project.hasProperty('firebaseCrashlyticsVersion') ? rootProject.ext.firebaseCrashlyticsVersion : '20.0.3'}\"");
    // right after `dependencies {`
    const depIdx = app.indexOf('dependencies {');
    const ndkIdx = app.indexOf('firebase-crashlytics-ndk');
    const fileTreeIdx = app.indexOf('fileTree');
    expect(depIdx).toBeGreaterThanOrEqual(0);
    expect(ndkIdx).toBeGreaterThan(depIdx);
    expect(ndkIdx).toBeLessThan(fileTreeIdx);

    // the apply-plugin line lands INSIDE the servicesJSON guard, not merely somewhere in the file
    expect(app).toContain('modoki:crashlytics-apply-begin');
    const guardOpen = app.indexOf("if (servicesJSON.text) {");
    const guardClose = app.indexOf('\n    }', guardOpen);
    const applyIdx = app.indexOf("apply plugin: 'com.google.firebase.crashlytics'");
    expect(applyIdx).toBeGreaterThan(guardOpen);
    expect(applyIdx).toBeLessThan(guardClose);
  });

  it('does nothing for a project without the crashlytics dependency', () => {
    writeTopGradle(); writeAppGradle(); writeCrashlyticsDep(false);
    const beforeTop = readTop(); const beforeApp = readApp();
    healNativeConfig(root);
    expect(readTop()).toBe(beforeTop);
    expect(readApp()).toBe(beforeApp);
  });

  it('migrates 3d-test\'s shape (classpath + apply-plugin hand-edited, NDK absent) to exactly one of each, no duplicates', () => {
    fs.mkdirSync(path.join(root, 'android'), { recursive: true });
    fs.writeFileSync(path.join(root, ...TOP_GRADLE), [
      'buildscript {',
      '    dependencies {',
      "        classpath 'com.android.tools.build:gradle:8.13.0'",
      "        classpath 'com.google.gms:google-services:4.4.4'",
      "        classpath 'com.google.firebase:firebase-crashlytics-gradle:3.0.3'",
      '    }',
      '}',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(root, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, ...APP_GRADLE), [
      "apply plugin: 'com.android.application'",
      '',
      'dependencies {',
      "    implementation fileTree(include: ['*.jar'], dir: 'libs')",
      '}',
      '',
      "try {",
      "    def servicesJSON = file('google-services.json')",
      '    if (servicesJSON.text) {',
      "        apply plugin: 'com.google.gms.google-services'",
      "        apply plugin: 'com.google.firebase.crashlytics'",
      '    }',
      '} catch(Exception e) {',
      '    logger.info("google-services.json not found")',
      '}',
      '',
    ].join('\n'));
    writeCrashlyticsDep();

    healNativeConfig(root);

    const top = readTop();
    expect((top.match(/firebase-crashlytics-gradle/g) || []).length).toBe(1);
    expect((top.match(/classpath 'com\.google\.firebase:firebase-crashlytics-gradle:/g) || []).length).toBe(1);

    const app = readApp();
    expect((app.match(/implementation "com\.google\.firebase:firebase-crashlytics-ndk:/g) || []).length).toBe(1);
    expect((app.match(/apply plugin: 'com\.google\.firebase\.crashlytics'/g) || []).length).toBe(1);
  });

  it('is idempotent — a second run returns undefined and the files are byte-identical', () => {
    writeTopGradle(); writeAppGradle(); writeCrashlyticsDep();
    healNativeConfig(root);
    const top1 = readTop(); const app1 = readApp();
    healNativeConfig(root);
    expect(readTop()).toBe(top1);
    expect(readApp()).toBe(app1);
  });

  it('migrates an older unmarked pinned version to the current pin', () => {
    fs.mkdirSync(path.join(root, 'android'), { recursive: true });
    fs.writeFileSync(path.join(root, ...TOP_GRADLE), [
      'buildscript {',
      '    dependencies {',
      "        classpath 'com.android.tools.build:gradle:8.13.0'",
      "        classpath 'com.google.gms:google-services:4.4.4'",
      "        classpath 'com.google.firebase:firebase-crashlytics-gradle:2.9.9'",
      '    }',
      '}',
      '',
    ].join('\n'));
    writeAppGradle();
    writeCrashlyticsDep();

    healNativeConfig(root);
    const top = readTop();
    expect(top).not.toContain('2.9.9');
    expect(top).toContain(`classpath 'com.google.firebase:firebase-crashlytics-gradle:3.0.3'`);
    expect((top.match(/classpath 'com\.google\.firebase:firebase-crashlytics-gradle:/g) || []).length).toBe(1);
  });

  it('returns undefined and does not throw when android/ is missing', () => {
    writeCrashlyticsDep();
    expect(() => healNativeConfig(root)).not.toThrow();
    expect(fs.existsSync(path.join(root, 'android'))).toBe(false);
  });
});

describe('healNativeConfig — iOS ModokiDebugBuild flag', () => {
  const PLIST = ['ios', 'App', 'App', 'Info.plist'];
  function writePlist(body: string) {
    const dir = path.join(root, 'ios', 'App', 'App');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, ...PLIST),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`);
  }
  const readPlist = () => fs.readFileSync(path.join(root, ...PLIST), 'utf8');

  it('writes <true/> when build.debugBuild is on', () => {
    writePlist('\t<key>CFBundleName</key>\n\t<string>x</string>');
    writeConfig('', true);
    writeGameDebugDep();
    healNativeConfig(root);
    expect(readPlist()).toContain('<key>ModokiDebugBuild</key>');
    expect(readPlist()).toMatch(/<key>ModokiDebugBuild<\/key>\s*<true\/>/);
  });

  // The load-bearing direction. A write-once flag would leave the capability behind on a project
  // that turned debugBuild off — which is precisely the state that must NOT be able to crash on
  // demand.
  it('flips to <false/> when build.debugBuild is turned off', () => {
    writePlist('\t<key>CFBundleName</key>\n\t<string>x</string>');
    writeConfig('', true);
    writeGameDebugDep();
    healNativeConfig(root);
    writeConfig('', false);
    healNativeConfig(root);
    expect(readPlist()).toMatch(/<key>ModokiDebugBuild<\/key>\s*<false\/>/);
    expect((readPlist().match(/ModokiDebugBuild/g) || []).length).toBe(1);
  });

  it('is idempotent — a second pass leaves the plist byte-identical', () => {
    writePlist('\t<key>CFBundleName</key>\n\t<string>x</string>');
    writeConfig('', true);
    writeGameDebugDep();
    healNativeConfig(root);
    const once = readPlist();
    healNativeConfig(root);
    expect(readPlist()).toBe(once);
  });
});

describe('healNativeConfig — iOS Local Network / Bonjour keys', () => {
  const PLIST = ['ios', 'App', 'App', 'Info.plist'];
  function writePlist(body: string) {
    const dir = path.join(root, 'ios', 'App', 'App');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, ...PLIST),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`);
  }
  const readPlist = () => fs.readFileSync(path.join(root, ...PLIST), 'utf8');

  it('adds the Local Network + Bonjour keys when absent', () => {
    writePlist('\t<key>CFBundleName</key>\n\t<string>x</string>');
    writeConfig('');
    writeGameDebugDep();
    healNativeConfig(root);
    const out = readPlist();
    expect(out).toContain('NSLocalNetworkUsageDescription');
    expect(out).toContain('<string>_game-debug._tcp</string>');
    expect(out.indexOf('NSBonjourServices')).toBeLessThan(out.lastIndexOf('</dict>')); // before root close
  });

  it('is idempotent — a second pass adds nothing', () => {
    writePlist('\t<key>CFBundleName</key>\n\t<string>x</string>');
    writeConfig('');
    writeGameDebugDep();
    healNativeConfig(root);
    const once = readPlist();
    healNativeConfig(root);
    expect(readPlist()).toBe(once);
    expect((readPlist().match(/NSBonjourServices/g) || []).length).toBe(1);
  });

  // #112 — the keys now follow build.debugBuild in BOTH directions. Before, they were
  // added unconditionally and stripped from the BUILT plist by a `CONFIGURATION ==
  // Release` build phase, so debugBuild:true + a Release configuration shipped a bridge
  // with no Local Network permission and no explanation.
  it('does NOT add the keys when build.debugBuild is off', () => {
    writePlist('\t<key>CFBundleName</key>\n\t<string>x</string>');
    writeConfig('', false);
    writeGameDebugDep();
    healNativeConfig(root);
    expect(readPlist()).not.toContain('NSBonjourServices');
    expect(readPlist()).not.toContain('NSLocalNetworkUsageDescription');
  });

  it('REMOVES the keys when build.debugBuild is turned off', () => {
    writePlist('\t<key>CFBundleName</key>\n\t<string>x</string>');
    writeConfig('', true);
    writeGameDebugDep();
    healNativeConfig(root);
    expect(readPlist()).toContain('NSBonjourServices');

    writeConfig('', false);
    healNativeConfig(root);
    const off = readPlist();
    expect(off).not.toContain('NSBonjourServices');
    expect(off).not.toContain('NSLocalNetworkUsageDescription');
    expect(off).not.toContain('_game-debug._tcp'); // the <array> value went too, not just the <key>
    expect(off).toContain('<key>CFBundleName</key>'); // unrelated keys untouched
    // and back on again — the toggle is not one-way
    writeConfig('', true);
    healNativeConfig(root);
    expect(readPlist()).toContain('NSBonjourServices');
  });

  it('does NOT add the keys for a project that lacks the game-debug dep', () => {
    writePlist('\t<key>CFBundleName</key>\n\t<string>x</string>');
    writeConfig(''); // no package.json / no capacitor-game-debug
    healNativeConfig(root);
    expect(readPlist()).not.toContain('NSBonjourServices');
  });

  it('no-op when the project has no ios/ folder', () => {
    writeConfig('');
    writeGameDebugDep();
    expect(() => healNativeConfig(root)).not.toThrow();
  });
});

describe('healNativeConfig — iOS game-debug wiring (Task 3)', () => {
  /** A structurally-faithful pristine `cap add ios` pbxproj: the AppDelegate.swift
   *  anchors the heal keys off, the App group + Sources phase + target buildPhases. */
  function pristinePbxproj(): string {
    return `// !$*UTF8*$!
{
	objects = {
/* Begin PBXBuildFile section */
		504EC3081 /* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = 504EC3071 /* AppDelegate.swift */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		504EC3071 /* AppDelegate.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXGroup section */
		504EC3061 /* App */ = {
			isa = PBXGroup;
			children = (
				504EC3071 /* AppDelegate.swift */,
				504EC3131 /* Info.plist */,
			);
			path = App;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		504EC3031 /* App */ = {
			isa = PBXNativeTarget;
			buildPhases = (
				504EC3001 /* Sources */,
				504EC3011 /* Frameworks */,
				504EC3021 /* Resources */,
			);
			name = App;
		};
/* End PBXNativeTarget section */

/* Begin PBXSourcesBuildPhase section */
		504EC3001 /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			files = (
				504EC3081 /* AppDelegate.swift in Sources */,
			);
		};
/* End PBXSourcesBuildPhase section */
	};
}
`;
  }
  const PBX = ['ios', 'App', 'App.xcodeproj', 'project.pbxproj'];
  const SB = ['ios', 'App', 'App', 'Base.lproj', 'Main.storyboard'];
  const MVC = ['ios', 'App', 'App', 'MyViewController.swift'];
  function scaffoldIos() {
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App', 'Base.lproj'), { recursive: true });
    fs.writeFileSync(path.join(root, ...PBX), pristinePbxproj());
    fs.writeFileSync(path.join(root, ...SB),
      '<viewController id="BYZ-38-t0r" customClass="CAPBridgeViewController" customModule="Capacitor" sceneMemberID="viewController"/>');
  }
  const readPbx = () => fs.readFileSync(path.join(root, ...PBX), 'utf8');

  it('writes MyViewController.swift, points the storyboard, and wires the pbxproj', () => {
    scaffoldIos(); writeConfig(''); writeGameDebugDep(); writeEngineGameDebugSwift();
    healNativeConfig(root);
    // MyViewController.swift written
    expect(fs.existsSync(path.join(root, ...MVC))).toBe(true);
    expect(fs.readFileSync(path.join(root, ...MVC), 'utf8')).toContain('CAPBridgeViewController');
    // storyboard repointed
    expect(fs.readFileSync(path.join(root, ...SB), 'utf8')).toContain('customClass="MyViewController" customModule="App"');
    // pbxproj: 4 structural lines each (build-file + fileRef + group child + sources phase)
    const pbx = readPbx();
    const lines = pbx.split('\n');
    expect(lines.filter((l) => l.includes('MyViewController.swift')).length).toBe(4);
    expect(lines.filter((l) => l.includes('GameDebugPlugin.swift')).length).toBe(4);
    // engine plugin fileRef uses a repo-relative path from ios/App, SOURCE_ROOT
    const relLine = pbx.split('\n').find((l) => l.includes('GameDebugPlugin.swift') && l.includes('sourceTree = SOURCE_ROOT'));
    expect(relLine).toBeTruthy();
    expect(relLine!).toContain('engine/packages/capacitor-game-debug/ios/Sources/GameDebugPlugin/GameDebugPlugin.swift');
    // resolves to the actual planted swift file
    const m = relLine!.match(/path = "([^"]+)"/);
    expect(fs.existsSync(path.resolve(path.join(root, 'ios', 'App'), m![1]))).toBe(true);
  });

  it('is idempotent — a second pass changes nothing', () => {
    scaffoldIos(); writeConfig(''); writeGameDebugDep(); writeEngineGameDebugSwift();
    healNativeConfig(root);
    const once = readPbx();
    const sbOnce = fs.readFileSync(path.join(root, ...SB), 'utf8');
    healNativeConfig(root);
    expect(readPbx()).toBe(once);
    expect(fs.readFileSync(path.join(root, ...SB), 'utf8')).toBe(sbOnce);
  });

  it('skips wiring when the engine plugin can\'t be found (standalone game)', () => {
    scaffoldIos(); writeConfig(''); writeGameDebugDep(); // no engine/ planted
    healNativeConfig(root);
    expect(fs.existsSync(path.join(root, ...MVC))).toBe(false);
    expect(readPbx()).not.toContain('MyViewController.swift');
  });

  it('skips wiring for a project without the game-debug dep', () => {
    scaffoldIos(); writeConfig(''); writeEngineGameDebugSwift(); // no dep
    healNativeConfig(root);
    expect(fs.existsSync(path.join(root, ...MVC))).toBe(false);
    expect(readPbx()).not.toContain('MyViewController.swift');
  });

  it('bails without a partial edit when an anchor is missing', () => {
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
    // pbxproj with NO AppDelegate anchors — heal must not touch it.
    fs.writeFileSync(path.join(root, ...PBX), '// !$*UTF8*$!\n{ objects = { }; }\n');
    writeConfig(''); writeGameDebugDep(); writeEngineGameDebugSwift();
    healNativeConfig(root);
    expect(readPbx()).not.toContain('MyViewController.swift');
  });

  // #112 — the Release Info.plist-strip phase is RETIRED, not merely re-keyed. It
  // derived the plist keys from CONFIGURATION, which is the second source of truth this
  // issue removes; healIosLocalNetwork now writes the SOURCE plist from the flag instead.
  it('never adds a Release Info.plist-strip build phase', () => {
    scaffoldIos(); writeConfig(''); writeGameDebugDep(); writeEngineGameDebugSwift();
    healNativeConfig(root);
    const pbx = readPbx();
    expect(pbx).not.toContain('Strip debug-only Info.plist keys');
    expect(pbx).not.toContain('PlistBuddy');
    expect(pbx).not.toContain('CONFIGURATION'); // no build-configuration gate survives at all
  });

  it('REMOVES a legacy Release-strip phase from a project that still carries one', () => {
    scaffoldIos(); writeConfig(''); writeGameDebugDep(); writeEngineGameDebugSwift();
    // Re-create the pre-#112 shape by hand: the buildPhases reference + the object.
    const legacyPhase = [
      '/* Begin PBXShellScriptBuildPhase section */',
      '\t\tDD0000000000000000000005 /* Strip debug-only Info.plist keys (Release) */ = {',
      '\t\t\tisa = PBXShellScriptBuildPhase;',
      '\t\t\tname = "Strip debug-only Info.plist keys (Release)";',
      '\t\t\tshellScript = "if [ \\\\"${CONFIGURATION}\\\\" = \\\\"Release\\\\" ]; then PlistBuddy; fi";',
      '\t\t};',
      '/* End PBXShellScriptBuildPhase section */',
      '',
    ].join('\n');
    let seeded = fs.readFileSync(path.join(root, ...PBX), 'utf8');
    seeded = seeded.replace(/(\t\t\t\t504EC3021 \/\* Resources \*\/,\n)/,
      '$1\t\t\t\tDD0000000000000000000005 /* Strip debug-only Info.plist keys (Release) */,\n');
    seeded = seeded.replace('/* Begin PBXSourcesBuildPhase section */', legacyPhase + '\n/* Begin PBXSourcesBuildPhase section */');
    fs.writeFileSync(path.join(root, ...PBX), seeded);
    expect(seeded).toContain('Strip debug-only Info.plist keys');

    healNativeConfig(root);
    const pbx = readPbx();
    expect(pbx).not.toContain('Strip debug-only Info.plist keys');
    expect(pbx).not.toContain('DD0000000000000000000005'); // BOTH the reference and the object
    expect(pbx).not.toContain('PlistBuddy');
    // The section itself survives here because the flag is ON, so the Phase-2 archive
    // warning now occupies it — exactly one shell-script phase, and not the retired one.
    expect((pbx.match(/isa = PBXShellScriptBuildPhase;/g) || []).length).toBe(1);
    expect(pbx).toContain("Warn: Modoki 'Debug build' is ON");
    // the rest of the project survived
    expect(pbx).toContain('504EC3021 /* Resources */,');
    expect(pbx).toContain('/* Begin PBXSourcesBuildPhase section */');
    // idempotent
    healNativeConfig(root);
    expect(readPbx()).toBe(pbx);
  });
});

describe('healNativeConfig — iOS GameDebugPlugin registration follows build.debugBuild (#112)', () => {
  const MVC = ['ios', 'App', 'App', 'MyViewController.swift'];
  const readMvc = () => fs.readFileSync(path.join(root, ...MVC), 'utf8');
  function scaffoldMvc(body: string) {
    const dir = path.join(root, 'ios', 'App', 'App');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, ...MVC), body);
  }
  /** The pre-#112 generated file, verbatim — this is what every existing project has. */
  const LEGACY_MVC = `import UIKit
import Capacitor

/// Custom bridge VC so we can register plugins that SPM won't auto-discover.
///
/// registering the instance here keeps the class alive and wires it into the bridge.
/// DEBUG-only: the TCP debug server + Bonjour never ship in a release build.
class MyViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        #if DEBUG
        let plugin = GameDebugPlugin()
        bridge?.registerPluginInstance(plugin)
        print("[MyViewController] DEBUG — GameDebugPlugin registered: \\(plugin)")
        #else
        print("[MyViewController] RELEASE — GameDebugPlugin skipped")
        #endif
    }
}
`;

  it('a freshly scaffolded file registers the plugin when the flag is on', () => {
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'),
      '// !$*UTF8*$!\n{ objects = { }; }\n');
    writeConfig('', true); writeGameDebugDep(); writeEngineGameDebugSwift();
    healNativeConfig(root);
    const mvc = readMvc();
    expect(mvc).toContain('modoki:game-debug-begin');
    expect(mvc).toContain('bridge?.registerPluginInstance(gameDebugPlugin)');
    expect(mvc).not.toContain('#if DEBUG'); // the Xcode configuration no longer decides
  });

  it('a freshly scaffolded file does NOT register the plugin when the flag is off', () => {
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'),
      '// !$*UTF8*$!\n{ objects = { }; }\n');
    writeConfig('', false); writeGameDebugDep(); writeEngineGameDebugSwift();
    healNativeConfig(root);
    const mvc = readMvc();
    expect(mvc).toContain('modoki:game-debug-begin');
    expect(mvc).not.toContain('registerPluginInstance');
  });

  it('migrates a pre-#112 `#if DEBUG` block to the markers exactly once', () => {
    scaffoldMvc(LEGACY_MVC);
    writeConfig('', true); writeGameDebugDep();
    const notes = healNativeConfig(root).notes.join(' ');
    expect(notes).toContain('migrated iOS GameDebugPlugin registration off #if DEBUG');
    const mvc = readMvc();
    expect(mvc).not.toContain('#if DEBUG');
    expect(mvc).not.toContain('#endif');
    expect(mvc).toContain('bridge?.registerPluginInstance(gameDebugPlugin)');
    // the stale doc sentence asserting the old guarantee is corrected
    expect(mvc).not.toContain('never ship in a release build');
    // and the surrounding hand-owned text is untouched
    expect(mvc).toContain('import Capacitor');
    expect(mvc).toContain('class MyViewController: CAPBridgeViewController {');
    // second pass migrates nothing further
    const once = readMvc();
    expect(healNativeConfig(root).notes.join(' ')).not.toContain('migrated');
    expect(readMvc()).toBe(once);
  });

  it('toggles both ways without touching anything outside the markers', () => {
    scaffoldMvc(LEGACY_MVC);
    writeConfig('', true); writeGameDebugDep();
    healNativeConfig(root);
    const on = readMvc();
    expect(on).toContain('registerPluginInstance');

    writeConfig('', false);
    healNativeConfig(root);
    const off = readMvc();
    expect(off).not.toContain('registerPluginInstance');
    expect(off).toContain('modoki:game-debug-end'); // markers survive, so it can come back

    writeConfig('', true);
    healNativeConfig(root);
    expect(readMvc()).toBe(on);
  });

  it('preserves hand-added code in the same file (games/ota-test shape)', () => {
    scaffoldMvc(LEGACY_MVC.replace(
      '    override func viewDidLoad() {',
      '    override func instanceDescriptor() -> InstanceDescriptor {\n' +
      '        OtaBootHook.run(name: otaShellBundleName)\n' +
      '        return super.instanceDescriptor()\n' +
      '    }\n\n' +
      '    override func viewDidLoad() {',
    ).replace('    }\n}\n', '        let otaPlugin = ModokiOtaPlugin()\n        bridge?.registerPluginInstance(otaPlugin)\n    }\n}\n'));
    writeConfig('', false); writeGameDebugDep();
    healNativeConfig(root);
    const mvc = readMvc();
    expect(mvc).toContain('OtaBootHook.run(name: otaShellBundleName)');
    expect(mvc).toContain('bridge?.registerPluginInstance(otaPlugin)'); // OTA plugin still registered
    expect(mvc).not.toContain('GameDebugPlugin()'); // only the game-debug one went
  });

  it('notes — rather than silently skips — a file with neither markers nor the legacy block', () => {
    scaffoldMvc('import UIKit\nclass MyViewController: CAPBridgeViewController {}\n');
    writeConfig('', true); writeGameDebugDep();
    const notes = healNativeConfig(root).notes.join(' ');
    // The flag genuinely does not apply here, so the note is the ONLY signal — a silent
    // skip would be the same class of failure #112 exists to remove.
    expect(notes).toContain('no modoki:game-debug markers');
    expect(notes).toContain('build.debugBuild NOT applied');
  });
});

describe('healNativeConfig — archive-time warning (#112 Phase 2)', () => {
  const PBX = ['ios', 'App', 'App.xcodeproj', 'project.pbxproj'];
  const GRADLE = ['android', 'app', 'build.gradle'];
  const readPbx = () => fs.readFileSync(path.join(root, ...PBX), 'utf8');
  const readGradle = () => fs.readFileSync(path.join(root, ...GRADLE), 'utf8');
  function scaffold() {
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App'), { recursive: true });
    fs.writeFileSync(path.join(root, ...PBX), [
      '// !$*UTF8*$!', '{', '\tobjects = {',
      '/* Begin PBXNativeTarget section */',
      '\t\t504EC3031 /* App */ = {', '\t\t\tisa = PBXNativeTarget;', '\t\t\tbuildPhases = (',
      '\t\t\t\t504EC3001 /* Sources */,', '\t\t\t\t504EC3021 /* Resources */,',
      '\t\t\t);', '\t\t\tname = App;', '\t\t};',
      '/* End PBXNativeTarget section */', '',
      '/* Begin PBXSourcesBuildPhase section */',
      '\t\t504EC3001 /* Sources */ = {', '\t\t\tisa = PBXSourcesBuildPhase;', '\t\t};',
      '/* End PBXSourcesBuildPhase section */',
      '\t};', '}', '',
    ].join('\n'));
    fs.mkdirSync(path.join(root, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, ...GRADLE), "apply plugin: 'com.android.application'\n\nandroid {\n}\n");
    writeGameDebugDep();
  }

  it('adds an iOS warning phase gated on ACTION, not CONFIGURATION, when the flag is on', () => {
    scaffold(); writeConfig('', true);
    healNativeConfig(root);
    const pbx = readPbx();
    // No DOUBLE quotes anywhere in the generated name/message: it is embedded in a pbxproj
    // quoted string, inside which it lands in a shell `echo "…"` — three levels of quoting.
    expect(pbx).toContain("Warn: Modoki 'Debug build' is ON");
    expect(pbx).toContain('name = "Warn: Modoki \'Debug build\' is ON";');
    // The load-bearing detail: debugBuild:true + a Release CONFIGURATION is the exact
    // combination #112 makes work, so gating on CONFIGURATION would re-break it.
    expect(pbx).toContain('if [ \\"${ACTION}\\" = \\"install\\" ]');
    expect(pbx).not.toContain('CONFIGURATION');
    // It WARNS — a non-zero exit would be a refusal, which TestFlight rules out.
    expect(pbx).toContain('echo \\"warning: ');
    expect(pbx).not.toContain('exit 1');
    // referenced in buildPhases (once) + defined (once)
    expect((pbx.match(/DD0000000000000000000006/g) || []).length).toBe(2);
    // the message names the setting a human can act on, not the internal constant
    expect(pbx).toContain('Project Settings -> Developer');
    expect(pbx).not.toContain('__MODOKI_DEBUG_BUILD__');
  });

  it('adds a Gradle release-build warning when the flag is on', () => {
    scaffold(); writeConfig('', true);
    healNativeConfig(root);
    const g = readGradle();
    expect(g).toContain('modoki:debug-build-warning-begin');
    expect(g).toContain('gradle.taskGraph.whenReady');
    expect(g).toContain('(assemble|bundle).*Release');
    expect(g).toContain('logger.warn');
    expect(g).not.toContain('throw new'); // warns, never fails the build
    expect(g).toContain("apply plugin: 'com.android.application'"); // original content kept
  });

  it('removes both when the flag goes off, and restores them when it comes back', () => {
    scaffold(); writeConfig('', true);
    healNativeConfig(root);
    const onPbx = readPbx(); const onGradle = readGradle();

    writeConfig('', false);
    healNativeConfig(root);
    expect(readPbx()).not.toContain('Warn: Modoki');
    expect(readPbx()).not.toContain('DD0000000000000000000006'); // reference AND object
    expect(readPbx()).not.toContain('PBXShellScriptBuildPhase'); // emptied section removed
    expect(readGradle()).not.toContain('modoki:debug-build-warning');
    expect(readGradle()).toContain("apply plugin: 'com.android.application'");

    writeConfig('', true);
    healNativeConfig(root);
    expect(readPbx()).toBe(onPbx);
    expect(readGradle()).toBe(onGradle);
  });

  it('is idempotent in both states', () => {
    scaffold(); writeConfig('', true);
    healNativeConfig(root); const on = [readPbx(), readGradle()];
    healNativeConfig(root);
    expect([readPbx(), readGradle()]).toEqual(on);

    writeConfig('', false);
    healNativeConfig(root); const off = [readPbx(), readGradle()];
    healNativeConfig(root);
    expect([readPbx(), readGradle()]).toEqual(off);
  });

  it('RE-DERIVES the phase rather than trusting its presence (a stale message must heal)', () => {
    scaffold(); writeConfig('', true);
    healNativeConfig(root);
    const fresh = readPbx();
    // Simulate a project healed by an OLDER editor whose warning text has since changed.
    // A presence check ("the phase is already there, done") would leave this forever.
    fs.writeFileSync(path.join(root, ...PBX), fresh.replace(/warning: [^\\]*/, 'warning: OLD STALE TEXT'));
    expect(readPbx()).toContain('OLD STALE TEXT');
    healNativeConfig(root);
    expect(readPbx()).not.toContain('OLD STALE TEXT');
    expect(readPbx()).toBe(fresh);
  });

  it('does not open a SECOND PBXShellScriptBuildPhase section next to an existing one', () => {
    scaffold(); writeConfig('', true);
    // Seed a project that already has a shell-script phase (a CocoaPods game, say).
    const seeded = readPbx().replace('/* Begin PBXSourcesBuildPhase section */', [
      '/* Begin PBXShellScriptBuildPhase section */',
      '\t\tAA0000000000000000000001 /* [CP] Embed Pods */ = {',
      '\t\t\tisa = PBXShellScriptBuildPhase;',
      '\t\t};',
      '/* End PBXShellScriptBuildPhase section */',
      '',
      '/* Begin PBXSourcesBuildPhase section */',
    ].join('\n'));
    fs.writeFileSync(path.join(root, ...PBX), seeded);
    healNativeConfig(root);
    const pbx = readPbx();
    expect((pbx.match(/\/\* Begin PBXShellScriptBuildPhase section \*\//g) || []).length).toBe(1);
    expect((pbx.match(/\/\* End PBXShellScriptBuildPhase section \*\//g) || []).length).toBe(1);
    expect(pbx).toContain('Warn: Modoki');
    expect(pbx).toContain('[CP] Embed Pods'); // the existing phase survives
  });
});

describe('healNativeConfig — Android debugBuild meta-data (#112)', () => {
  const MANIFEST = ['android', 'app', 'src', 'main', 'AndroidManifest.xml'];
  const readManifest = () => fs.readFileSync(path.join(root, ...MANIFEST), 'utf8');
  function writeManifest() {
    fs.mkdirSync(path.join(root, 'android', 'app', 'src', 'main'), { recursive: true });
    fs.writeFileSync(path.join(root, ...MANIFEST),
      '<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n\n' +
      '    <application android:label="@string/app_name">\n' +
      '        <activity android:name=".MainActivity" android:exported="true" />\n' +
      '    </application>\n\n' +
      '    <uses-permission android:name="android.permission.INTERNET" />\n</manifest>\n');
  }
  const NAME = 'com.modokiengine.gamedebug.DEBUG_BUILD';

  it('writes the flag as meta-data inside <application>', () => {
    writeManifest(); writeConfig('', true); writeGameDebugDep();
    healNativeConfig(root);
    const m = readManifest();
    expect(m).toContain(`<meta-data android:name="${NAME}" android:value="true" />`);
    expect(m.indexOf(NAME)).toBeLessThan(m.indexOf('</application>'));
    expect(m.indexOf('<application')).toBeLessThan(m.indexOf(NAME));
    expect(m).toContain('<activity android:name=".MainActivity"'); // existing children intact
  });

  it('tracks the flag in both directions and is idempotent', () => {
    writeManifest(); writeConfig('', false); writeGameDebugDep();
    healNativeConfig(root);
    expect(readManifest()).toContain('android:value="false"');
    const once = readManifest();
    healNativeConfig(root);
    expect(readManifest()).toBe(once);

    writeConfig('', true);
    healNativeConfig(root);
    expect(readManifest()).toContain('android:value="true"');
    expect((readManifest().match(new RegExp(NAME, 'g')) || []).length).toBe(1); // rewritten, not duplicated
  });

  it('is skipped for a project without the game-debug dep', () => {
    writeManifest(); writeConfig('', true); // no package.json dep
    healNativeConfig(root);
    expect(readManifest()).not.toContain(NAME);
  });

  it('no-op when the project has no android/ folder', () => {
    writeConfig('', true); writeGameDebugDep();
    expect(() => healNativeConfig(root)).not.toThrow();
  });
});

describe('healNativeConfig — Android game mode (#228)', () => {
  const MANIFEST = ['android', 'app', 'src', 'main', 'AndroidManifest.xml'];
  const GAME_MODE_XML = ['android', 'app', 'src', 'main', 'res', 'xml', 'game_mode_config.xml'];
  const readManifest = () => fs.readFileSync(path.join(root, ...MANIFEST), 'utf8');

  /** Carries `${applicationId}` on purpose — a `$`-bearing manifest is what a string
   *  replacement would corrupt, and Capacitor's real FileProvider block has one. */
  function writeManifest() {
    fs.mkdirSync(path.join(root, 'android', 'app', 'src', 'main'), { recursive: true });
    fs.writeFileSync(path.join(root, ...MANIFEST),
      '<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n\n' +
      '    <application\n        android:allowBackup="true"\n        android:label="@string/app_name">\n' +
      '        <activity android:name=".MainActivity" android:exported="true" />\n' +
      '        <provider android:authorities="${applicationId}.fileprovider" android:exported="false" />\n' +
      '    </application>\n\n' +
      '    <uses-permission android:name="android.permission.INTERNET" />\n</manifest>\n');
  }

  it('declares the app a game — appCategory, the config resource, and the meta-data wiring it', () => {
    writeManifest(); writeConfig('');
    healNativeConfig(root);
    const m = readManifest();
    expect(m).toContain('android:appCategory="game"');
    expect(m).toContain('<meta-data android:name="android.game_mode_config" android:resource="@xml/game_mode_config" />');
    expect(m.indexOf('android.game_mode_config')).toBeLessThan(m.indexOf('</application>'));

    const xml = fs.readFileSync(path.join(root, ...GAME_MODE_XML), 'utf8');
    // Opted OUT: an OS-imposed downscale or fps cap would fight the engine's own quality tiers
    // and corrupt live tier calibration (#227). This is what the file is FOR.
    expect(xml).toContain('android:allowGameDownscaling="false"');
    expect(xml).toContain('android:allowGameFpsOverride="false"');
  });

  it('claims NO game-mode support, because nothing reads GameManager.getGameMode()', () => {
    // Declaring a mode is a promise the app adapts itself when the user selects it. The engine has
    // no GameManager binding, so `true` here would advertise behaviour that does not exist —
    // CLAUDE.md's "an unwired field is a lie with a tooltip", aimed at the OS. Flip one to `true`
    // only in the change that adds the binding AND acts on it; this test is the tripwire for that.
    writeManifest(); writeConfig('');
    healNativeConfig(root);
    const xml = fs.readFileSync(path.join(root, ...GAME_MODE_XML), 'utf8');
    expect(xml).toContain('android:supportsBatteryGameMode="false"');
    expect(xml).toContain('android:supportsPerformanceGameMode="false"');
  });

  it('leaves the rest of the manifest byte-intact, including a ${applicationId} token', () => {
    writeManifest(); writeConfig('');
    healNativeConfig(root);
    const m = readManifest();
    expect(m).toContain('android:authorities="${applicationId}.fileprovider"');
    expect(m).toContain('<activity android:name=".MainActivity"');
    expect(m).toContain('android:allowBackup="true"');
  });

  it('is idempotent — a second heal changes nothing and duplicates nothing', () => {
    writeManifest(); writeConfig('');
    healNativeConfig(root);
    const once = readManifest();
    healNativeConfig(root);
    expect(readManifest()).toBe(once);
    expect((once.match(/android:appCategory=/g) || []).length).toBe(1);
    expect((once.match(/android\.game_mode_config/g) || []).length).toBe(1);
  });

  it('rewrites its own fence rather than appending a second one', () => {
    writeManifest(); writeConfig('');
    healNativeConfig(root);
    // Corrupt the generated block; the fence must be replaced in place.
    const stale = readManifest().replace('@xml/game_mode_config', '@xml/stale_name');
    fs.writeFileSync(path.join(root, ...MANIFEST), stale);
    healNativeConfig(root);
    const m = readManifest();
    expect(m).not.toContain('stale_name');
    expect((m.match(/modoki:game-mode-begin/g) || []).length).toBe(1);
  });

  it('restores the config resource if it is deleted', () => {
    writeManifest(); writeConfig('');
    healNativeConfig(root);
    fs.rmSync(path.join(root, ...GAME_MODE_XML));
    healNativeConfig(root);
    expect(fs.existsSync(path.join(root, ...GAME_MODE_XML))).toBe(true);
  });

  it('applies WITHOUT the game-debug dep — unlike the debugBuild meta-data, this is unconditional', () => {
    writeManifest(); writeConfig(''); // no writeGameDebugDep()
    healNativeConfig(root);
    expect(readManifest()).toContain('android:appCategory="game"');
  });

  it('no-op when the project has no android/ folder', () => {
    writeConfig('');
    expect(() => healNativeConfig(root)).not.toThrow();
    expect(fs.existsSync(path.join(root, ...GAME_MODE_XML))).toBe(false);
  });
});

describe('healNativeConfig — orientation + status bar', () => {
  const PLIST = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>CFBundleName</key>',
    '\t<string>App</string>',
    '\t<key>UISupportedInterfaceOrientations</key>',
    '\t<array>',
    '\t\t<string>UIInterfaceOrientationPortrait</string>',
    '\t\t<string>UIInterfaceOrientationLandscapeLeft</string>',
    '\t\t<string>UIInterfaceOrientationLandscapeRight</string>',
    '\t</array>',
    '\t<key>UIViewControllerBasedStatusBarAppearance</key>',
    '\t<true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  const MANIFEST = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    '    <application>',
    '        <activity',
    '            android:configChanges="orientation|keyboardHidden"',
    '            android:name=".MainActivity"',
    '            android:label="@string/title_activity_main"',
    '            android:exported="true">',
    '        </activity>',
    '    </application>',
    '</manifest>',
    '',
  ].join('\n');

  function writeCapConfig(capacitor: Record<string, unknown>) {
    fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ build: { appleTeamId: '' }, capacitor }));
  }
  function iosPlistPath() { return path.join(root, 'ios', 'App', 'App', 'Info.plist'); }
  function writeIosPlist() {
    fs.mkdirSync(path.join(root, 'ios', 'App', 'App'), { recursive: true });
    fs.writeFileSync(iosPlistPath(), PLIST);
  }
  function manifestPath() { return path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'); }
  function writeManifest() {
    fs.mkdirSync(path.join(root, 'android', 'app', 'src', 'main'), { recursive: true });
    fs.writeFileSync(manifestPath(), MANIFEST);
  }

  // App Store Connect REJECTS an upload whose `~ipad` array has fewer than all four orientations,
  // for any bundle that claims iPad support (`TARGETED_DEVICE_FAMILY = "1,2"`, the Capacitor
  // default). This suite asserted only that the key EXISTED, never what was in it — so every
  // portrait game built an invalid bundle and nothing noticed until a real TestFlight upload was
  // refused (Court, 2026-07-31). The phone array is the game's choice; the iPad array is Apple's.
  it.each(['portrait', 'landscape', 'auto'] as const)(
    'declares all four iPad orientations regardless of the game being %s',
    (orientation) => {
      writeIosPlist();
      writeCapConfig({ orientation, statusBarHidden: false, statusBarStyle: 'default' });
      healNativeConfig(root);
      const out = fs.readFileSync(iosPlistPath(), 'utf8');
      const padArray = out.split('UISupportedInterfaceOrientations~ipad</key>')[1].split('</array>')[0];
      for (const o of ['Portrait', 'PortraitUpsideDown', 'LandscapeLeft', 'LandscapeRight']) {
        expect(padArray, `iPad multitasking requires UIInterfaceOrientation${o}`)
          .toContain(`UIInterfaceOrientation${o}</string>`);
      }
    },
  );

  it('replaces the existing orientation array with portrait-only + adds status-bar keys', () => {
    writeIosPlist();
    writeCapConfig({ orientation: 'portrait', statusBarHidden: true, statusBarStyle: 'light' });
    healNativeConfig(root);
    const out = fs.readFileSync(iosPlistPath(), 'utf8');
    // exactly the portrait entry survives in the phone array
    const phoneArray = out.split('UISupportedInterfaceOrientations</key>')[1].split('</array>')[0];
    expect(phoneArray).toContain('UIInterfaceOrientationPortrait</string>');
    expect(phoneArray).not.toContain('LandscapeLeft');
    expect(out).toContain('<key>UIStatusBarHidden</key>\n\t<true/>');
    expect(out).toContain('<key>UIViewControllerBasedStatusBarAppearance</key>\n\t<false/>');
    expect(out).toContain('UIStatusBarStyleLightContent');
    // ~ipad variant was inserted (portrait → adds upside-down)
    expect(out).toContain('UISupportedInterfaceOrientations~ipad');
  });

  it('landscape sets both landscape orientations and drops portrait', () => {
    writeIosPlist();
    writeCapConfig({ orientation: 'landscape', statusBarHidden: false, statusBarStyle: 'default' });
    healNativeConfig(root);
    const out = fs.readFileSync(iosPlistPath(), 'utf8');
    const phoneArray = out.split('UISupportedInterfaceOrientations</key>')[1].split('</array>')[0];
    expect(phoneArray).toContain('LandscapeLeft');
    expect(phoneArray).toContain('LandscapeRight');
    expect(phoneArray).not.toContain('OrientationPortrait</string>');
    expect(out).toContain('<key>UIStatusBarHidden</key>\n\t<false/>');
  });

  it('is idempotent on the plist (second run identical)', () => {
    writeIosPlist();
    writeCapConfig({ orientation: 'auto', statusBarHidden: false, statusBarStyle: 'default' });
    healNativeConfig(root);
    const once = fs.readFileSync(iosPlistPath(), 'utf8');
    healNativeConfig(root);
    expect(fs.readFileSync(iosPlistPath(), 'utf8')).toBe(once);
  });

  it('sets Android screenOrientation on MainActivity (auto → fullSensor)', () => {
    writeManifest();
    writeCapConfig({ orientation: 'auto' });
    healNativeConfig(root);
    expect(fs.readFileSync(manifestPath(), 'utf8')).toContain('android:screenOrientation="fullSensor"');
  });

  it('replaces an existing Android screenOrientation (portrait)', () => {
    fs.mkdirSync(path.join(root, 'android', 'app', 'src', 'main'), { recursive: true });
    fs.writeFileSync(manifestPath(), MANIFEST.replace('android:name=".MainActivity"', 'android:name=".MainActivity"\n            android:screenOrientation="landscape"'));
    writeCapConfig({ orientation: 'portrait' });
    healNativeConfig(root);
    const out = fs.readFileSync(manifestPath(), 'utf8');
    expect(out).toContain('android:screenOrientation="portrait"');
    expect(out).not.toContain('android:screenOrientation="landscape"');
  });

  // `statusBarHidden` was honoured ONLY on iOS, so every Android game shipped with the clock bar
  // AND the back/home/recents bar drawn over it — the config field's own contract promised an
  // Android fullscreen flag that nothing implemented. Observed on a real device (sling, 2026-08-04).
  describe('Android immersive fullscreen', () => {
    const SCAFFOLD = [
      'package com.example.app;',
      '',
      'import com.getcapacitor.BridgeActivity;',
      '',
      'public class MainActivity extends BridgeActivity {}',
      '',
    ].join('\n');
    function activityPath() {
      return path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'example', 'app', 'MainActivity.java');
    }
    function writeActivity(src = SCAFFOLD) {
      fs.mkdirSync(path.dirname(activityPath()), { recursive: true });
      fs.writeFileSync(activityPath(), src);
    }

    // MEASURED on a Galaxy A23: without this the window frame is [0,59][720,1560] — laid out
    // BENEATH the 52px cutout — and since the bars are hidden nothing draws in that strip, so the
    // window background shows through as a 59px BLACK BAND. `setDecorFitsSystemWindows(false)`
    // does not cover it: that opts out of fitting the system BARS, not the cutout. The same fact
    // is why `env(safe-area-inset-*)` read 0,0,0,0 there — a window that never reaches the cutout
    // has no inset to report — which briefly got recorded as "Android has no insets".
    it('lays the window INTO the display cutout — without it the hidden bars leave a black band', () => {
      writeActivity();
      writeCapConfig({ statusBarHidden: true });
      healNativeConfig(root);
      const out = fs.readFileSync(activityPath(), 'utf8');
      expect(out).toContain('LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES');
      expect(out).toContain('layoutInDisplayCutoutMode');
      // Guarded on P — the constant does not exist below API 28 and the field would throw.
      expect(out).toContain('Build.VERSION.SDK_INT >= Build.VERSION_CODES.P');
      // The imports the block now needs, or it will not compile.
      expect(out).toContain('import android.os.Build;');
      expect(out).toContain('import android.view.WindowManager;');
    });

    it('hides BOTH bars — the nav bar too, not just the status bar', () => {
      writeActivity();
      writeCapConfig({ statusBarHidden: true });
      healNativeConfig(root);
      const out = fs.readFileSync(activityPath(), 'utf8');
      // systemBars() covers status + navigation; a status-bar-only fix would leave the nav bar up.
      expect(out).toContain('WindowInsetsCompat.Type.systemBars()');
      expect(out).toContain('BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE');
      expect(out).toContain('import androidx.core.view.WindowInsetsControllerCompat;');
    });

    // Hiding once in onCreate is not enough: the bars return on every focus regain.
    it('re-applies on focus regain', () => {
      writeActivity();
      writeCapConfig({ statusBarHidden: true });
      healNativeConfig(root);
      const out = fs.readFileSync(activityPath(), 'utf8');
      expect(out).toContain('public void onWindowFocusChanged(boolean hasFocus)');
      expect(out).toContain('if (hasFocus) applyImmersiveMode();');
    });

    it('is idempotent — a second heal is a byte-for-byte no-op', () => {
      writeActivity();
      writeCapConfig({ statusBarHidden: true });
      healNativeConfig(root);
      const once = fs.readFileSync(activityPath(), 'utf8');
      healNativeConfig(root);
      expect(fs.readFileSync(activityPath(), 'utf8')).toBe(once);
      // and the imports were not duplicated by the second pass
      expect(once.match(/import androidx\.core\.view\.WindowCompat;/g)).toHaveLength(1);
    });

    it('removes the block (and its imports) when statusBarHidden goes false', () => {
      writeActivity();
      writeCapConfig({ statusBarHidden: true });
      healNativeConfig(root);
      writeCapConfig({ statusBarHidden: false });
      healNativeConfig(root);
      const out = fs.readFileSync(activityPath(), 'utf8');
      expect(out).not.toContain('applyImmersiveMode');
      expect(out).not.toContain('androidx.core.view.WindowCompat');
      expect(out).toContain('public class MainActivity extends BridgeActivity {}');
    });

    // A game may legitimately own its MainActivity; a regex rewrite must never eat that.
    it('leaves a hand-edited MainActivity ALONE and says so', () => {
      const custom = SCAFFOLD.replace(
        'public class MainActivity extends BridgeActivity {}',
        'public class MainActivity extends BridgeActivity {\n    // my own code\n}',
      );
      writeActivity(custom);
      writeCapConfig({ statusBarHidden: true });
      const { notes } = healNativeConfig(root);
      expect(fs.readFileSync(activityPath(), 'utf8')).toBe(custom);
      expect(notes.join(' ')).toMatch(/SKIPPED/);
    });

    it('does nothing when the project has no android/ folder', () => {
      writeCapConfig({ statusBarHidden: true });
      expect(() => healNativeConfig(root)).not.toThrow();
    });
  });

  // The native floor and the JS bundle floor were independent hardcoded numbers that
  // DISAGREED (pbxproj 15.0 vs a bundle needing 15.4), so a 15.0-15.3 device could install
  // the app and then die on a missing runtime API. One config value now drives both.
  describe('iOS deployment target', () => {
    const PBX = [
      '// !$*UTF8*$!',
      '{ objects = {',
      '  AAA /* Debug */ = { buildSettings = { IPHONEOS_DEPLOYMENT_TARGET = 15.0; }; };',
      '  BBB /* Release */ = { buildSettings = { IPHONEOS_DEPLOYMENT_TARGET = 15.0; }; };',
      '}; }',
      '',
    ].join('\n');
    function pbxPath() { return path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'); }
    function writePbx() {
      fs.mkdirSync(path.dirname(pbxPath()), { recursive: true });
      fs.writeFileSync(pbxPath(), PBX);
    }
    function writeBuildCfg(build: Record<string, unknown>) {
      fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ build, capacitor: {} }));
    }

    it('syncs the deployment target from build.iosMinVersion', () => {
      writePbx();
      writeBuildCfg({ appleTeamId: '', iosMinVersion: '15.4' });
      healNativeConfig(root);
      expect(fs.readFileSync(pbxPath(), 'utf8')).toContain('IPHONEOS_DEPLOYMENT_TARGET = 15.4;');
    });

    // Release is the configuration that actually ships — healing only the first occurrence
    // would leave it on the old floor.
    it('rewrites EVERY build configuration, not just the first', () => {
      writePbx();
      writeBuildCfg({ appleTeamId: '', iosMinVersion: '15.4' });
      healNativeConfig(root);
      const out = fs.readFileSync(pbxPath(), 'utf8');
      expect(out.match(/IPHONEOS_DEPLOYMENT_TARGET = 15\.4;/g)).toHaveLength(2);
      expect(out).not.toContain('15.0');
    });

    it('is idempotent', () => {
      writePbx();
      writeBuildCfg({ appleTeamId: '', iosMinVersion: '15.4' });
      healNativeConfig(root);
      const once = fs.readFileSync(pbxPath(), 'utf8');
      healNativeConfig(root);
      expect(fs.readFileSync(pbxPath(), 'utf8')).toBe(once);
    });

    // Nothing validates numeric config (#39); junk must not become `IPHONEOS_DEPLOYMENT_TARGET = banana;`
    it('leaves the project ALONE on a junk version', () => {
      writePbx();
      writeBuildCfg({ appleTeamId: '', iosMinVersion: 'banana' });
      healNativeConfig(root);
      expect(fs.readFileSync(pbxPath(), 'utf8')).toBe(PBX);
    });

    /** The SECOND iOS floor. `ios/App/CapApp-SPM/Package.swift` declares `platforms: [.iOS(.vNN)]`
     *  independently of the pbxproj, and only the pbxproj was healed — so raising
     *  `build.iosMinVersion` moved one and left the other. Measured after the 15.4 → 16.4 raise:
     *  every pbxproj read 16.4 while SIX of nine Package.swift files still said `.v15`, tracking
     *  who had last run `cap sync` rather than the config. */
    describe('SPM package platform (the second floor)', () => {
      const PKG = [
        '// swift-tools-version: 5.9',
        'import PackageDescription',
        '// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands',
        'let package = Package(',
        '    name: "CapApp-SPM",',
        '    platforms: [.iOS(.v15)],',
        '    products: [',
        '        .library(name: "CapApp-SPM", targets: ["CapApp-SPM"]),',
        '    ],',
        ')',
        '',
      ].join('\n');
      function pkgPath() { return path.join(root, 'ios', 'App', 'CapApp-SPM', 'Package.swift'); }
      function writePkg(text = PKG) {
        fs.mkdirSync(path.dirname(pkgPath()), { recursive: true });
        fs.writeFileSync(pkgPath(), text);
      }

      it('floors the SPM platform to the MAJOR of build.iosMinVersion', () => {
        // SPM's SupportedPlatform enumerates majors, so 16.4 → .v16. Coarser than the pbxproj
        // floor by design, and exactly what Capacitor's own generator emits from the same value.
        writePkg();
        writeBuildCfg({ appleTeamId: '', iosMinVersion: '16.4' });
        healNativeConfig(root);
        expect(fs.readFileSync(pkgPath(), 'utf8')).toContain('platforms: [.iOS(.v16)]');
      });

      it('is idempotent', () => {
        writePkg();
        writeBuildCfg({ appleTeamId: '', iosMinVersion: '16.4' });
        healNativeConfig(root);
        const once = fs.readFileSync(pkgPath(), 'utf8');
        healNativeConfig(root);
        expect(fs.readFileSync(pkgPath(), 'utf8')).toBe(once);
      });

      it('leaves the project ALONE on a junk version', () => {
        writePkg();
        writeBuildCfg({ appleTeamId: '', iosMinVersion: 'banana' });
        healNativeConfig(root);
        expect(fs.readFileSync(pkgPath(), 'utf8')).toBe(PKG);
      });

      it('is a no-op when the project has no iOS target', () => {
        writeBuildCfg({ appleTeamId: '', iosMinVersion: '16.4' });
        expect(() => healNativeConfig(root)).not.toThrow();
        expect(fs.existsSync(pkgPath())).toBe(false);
      });

      // Scoped to the FIRST `platforms:` array — which is the package's own in every Capacitor
      // layout (it sits directly under `name:`). A dependency clause may carry its own platform
      // requirement, and stamping the app's floor onto that would be wrong. Precisely: this
      // relies on the package's `platforms:` preceding any dependency's, not on parsing Swift.
      it('does not touch a later .iOS(...) belonging to a dependency', () => {
        writePkg(PKG.replace(
          '    products: [',
          '    dependencies: [ .package(name: "Other", platforms: [.iOS(.v13)]) ],\n    products: [',
        ));
        writeBuildCfg({ appleTeamId: '', iosMinVersion: '16.4' });
        healNativeConfig(root);
        const out = fs.readFileSync(pkgPath(), 'utf8');
        expect(out).toContain('platforms: [.iOS(.v16)],');   // the app's own floor, healed
        expect(out).toContain('.package(name: "Other", platforms: [.iOS(.v13)])'); // the dep's, untouched
      });
    });
  });

  /** #199 — nothing managed an app's version or build number on either platform, so every
   *  project shipped the scaffolder's hardcoded `versionCode 1`. That only ever mattered once a
   *  project published, and then it mattered a lot: both stores refuse a build number they have
   *  already seen and do it SILENTLY (Play reports "this release is empty"), so the rejection
   *  reads as a broken upload rather than a refused one. */
  describe('app version + build number', () => {
    const GRADLE = [
      'android {',
      '    defaultConfig {',
      '        versionCode 1',
      '        versionName "1.0"',
      '    }',
      '}',
      '',
    ].join('\n');
    // Two build configurations, exactly as a Capacitor pbxproj carries them.
    const PBX = [
      'buildSettings = {',
      '\tCURRENT_PROJECT_VERSION = 1;',
      '\tMARKETING_VERSION = 1.0;',
      '};',
      'buildSettings = {',
      '\tCURRENT_PROJECT_VERSION = 1;',
      '\tMARKETING_VERSION = 1.0;',
      '};',
      '',
    ].join('\n');
    const gradlePath = () => path.join(root, 'android', 'app', 'build.gradle');
    const pbxPath = () => path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    function writeNative(gradle = GRADLE, pbx = PBX) {
      fs.mkdirSync(path.dirname(gradlePath()), { recursive: true });
      fs.writeFileSync(gradlePath(), gradle);
      fs.mkdirSync(path.dirname(pbxPath()), { recursive: true });
      fs.writeFileSync(pbxPath(), pbx);
    }
    function writeAppCfg(app: Record<string, unknown>) {
      fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ app, build: {}, capacitor: {} }));
    }

    it('syncs both platforms from app.version / app.buildNumber', () => {
      writeNative();
      writeAppCfg({ version: '2.3.1', buildNumber: 7 });
      healNativeConfig(root);
      const g = fs.readFileSync(gradlePath(), 'utf8');
      expect(g).toContain('versionCode 7');
      expect(g).toContain('versionName "2.3.1"');
      const x = fs.readFileSync(pbxPath(), 'utf8');
      expect(x).toContain('CURRENT_PROJECT_VERSION = 7;');
      expect(x).toContain('MARKETING_VERSION = 2.3.1;');
    });

    /** A pbxproj carries the keys once per build CONFIGURATION. Healing only the first leaves
     *  Release behind — the configuration that actually ships. Same reasoning as the deployment
     *  target above, which is why both are `replace_all`. */
    it('heals EVERY build configuration, not just the first', () => {
      writeNative();
      writeAppCfg({ version: '2.0', buildNumber: 7 });
      healNativeConfig(root);
      const x = fs.readFileSync(pbxPath(), 'utf8');
      expect(x.match(/CURRENT_PROJECT_VERSION = 7;/g)).toHaveLength(2);
      expect(x.match(/MARKETING_VERSION = 2\.0;/g)).toHaveLength(2);
    });

    it('is idempotent', () => {
      writeNative();
      writeAppCfg({ version: '2.0', buildNumber: 7 });
      healNativeConfig(root);
      const once = fs.readFileSync(gradlePath(), 'utf8') + fs.readFileSync(pbxPath(), 'utf8');
      healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8') + fs.readFileSync(pbxPath(), 'utf8')).toBe(once);
    });

    /** THE load-bearing case. A stale config, a fresh clone, or a forgotten bump would otherwise
     *  walk a published project's build number BACKWARDS — the one direction that is always a
     *  mistake, and the one whose failure is invisible at the store. */
    it('REFUSES to lower a build number, and says so', () => {
      writeNative(GRADLE.replace('versionCode 1', 'versionCode 11'), PBX.replaceAll('CURRENT_PROJECT_VERSION = 1;', 'CURRENT_PROJECT_VERSION = 5;'));
      writeAppCfg({ version: '1.0', buildNumber: 1 });
      const r = healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('versionCode 11');
      expect(fs.readFileSync(pbxPath(), 'utf8')).toContain('CURRENT_PROJECT_VERSION = 5;');
      const notes = r.notes.join(' ');
      expect(notes).toContain('REFUSED to lower Android versionCode 11');
      expect(notes).toContain('REFUSED to lower iOS CURRENT_PROJECT_VERSION 5');
      // Actionable, not just a complaint: it names the number that would work.
      expect(notes).toContain('at least 12');
      expect(notes).toContain('at least 6');
    });

    /** The two platforms' counters drift apart because each store counts its own uploads —
     *  measured on games/iap-test (Android 11, iOS 5). ONE app.buildNumber still serves both: the
     *  stores only require the number to RISE, so the lagging platform takes a one-time jump. */
    it('raises the LAGGING platform without touching the ahead one, when the config passes both', () => {
      writeNative(GRADLE.replace('versionCode 1', 'versionCode 11'), PBX.replaceAll('CURRENT_PROJECT_VERSION = 1;', 'CURRENT_PROJECT_VERSION = 5;'));
      writeAppCfg({ version: '1.0', buildNumber: 11 });
      healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('versionCode 11');
      expect(fs.readFileSync(pbxPath(), 'utf8')).toContain('CURRENT_PROJECT_VERSION = 11;');
    });

    /** A Debug configuration left at 1 must not authorise lowering a Release at 11 — "what is
     *  this project at" is the MAX of the occurrences, not the first one the regex finds. */
    it('compares against the HIGHEST existing value, not the first', () => {
      // First configuration at 1, second at 11 — so a first-match read would see 1 and happily
      // lower the whole file to 4.
      const mixed = PBX.replace(/CURRENT_PROJECT_VERSION = 1;([\s\S]*)CURRENT_PROJECT_VERSION = 1;/, 'CURRENT_PROJECT_VERSION = 1;$1CURRENT_PROJECT_VERSION = 11;');
      expect(mixed, 'fixture must actually hold two different values').toContain('CURRENT_PROJECT_VERSION = 11;');
      expect(mixed).toContain('CURRENT_PROJECT_VERSION = 1;');
      writeNative(GRADLE, mixed);
      writeAppCfg({ version: '1.0', buildNumber: 4 });

      healNativeConfig(root);

      expect(fs.readFileSync(pbxPath(), 'utf8'), 'the 11 must not be lowered to 4').toBe(mixed);
    });

    /** AGP 8 writes `versionCode = 1`. No project uses it YET, but these very build.gradle files
     *  already mix the assignment syntax (`namespace = `, `compileSdk = `), so the next Capacitor
     *  template bump is how it arrives — and a pattern that only matched the Groovy form would
     *  silently no-op, leaving the build number unmanaged again with nothing to show for it. */
    it('heals the AGP-8 `versionCode = 1` form too, preserving the file\'s own separator', () => {
      const agp = [
        'android {',
        '    namespace = "com.x.y"',
        '    defaultConfig {',
        '        versionCode = 1',
        '        versionName = "1.0"',
        '    }',
        '}',
        '',
      ].join('\n');
      writeNative(agp);
      writeAppCfg({ version: '3.1', buildNumber: 8 });
      healNativeConfig(root);
      const g = fs.readFileSync(gradlePath(), 'utf8');
      expect(g).toContain('versionCode = 8');
      expect(g).toContain('versionName = "3.1"');
      // Not rewritten into the other syntax — that would be a gratuitous diff on a file the
      // project owns.
      expect(g).not.toContain('versionCode 8');
    });

    /** A value the pattern cannot READ is not the same as no value. Reporting it is the whole
     *  point: silence here is indistinguishable from "synced", which is how an unmanaged build
     *  number ships. */
    it('reports — and writes nothing — when versionCode is present in an unreadable form', () => {
      const viaVar = GRADLE.replace('versionCode 1', 'versionCode rootProject.ext.buildNo');
      writeNative(viaVar);
      writeAppCfg({ version: '1.0', buildNumber: 8 });
      const r = healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toBe(viaVar);
      expect(r.notes.join(' ')).toContain('versionCode is present but not in a form this heal can read');
    });

    /** THE hole the never-lower guard had. `CURRENT_PROJECT_VERSION = 1.2;` is legal — Apple
     *  compares CFBundleVersion component-wise, so 1.2 > 1 — but it is not an integer to order
     *  against. Skipping it left `current` null, which made the guard's `current !== null` false
     *  and let the write LOWER 1.2 to 1: the exact silent rejection this heal exists to prevent,
     *  produced by the code preventing it. */
    it('refuses to write over a DOTTED build number rather than lowering it', () => {
      const dotted = PBX.replaceAll('CURRENT_PROJECT_VERSION = 1;', 'CURRENT_PROJECT_VERSION = 1.2;');
      writeNative(GRADLE, dotted);
      writeAppCfg({ version: '1.0', buildNumber: 1 });
      const r = healNativeConfig(root);
      expect(fs.readFileSync(pbxPath(), 'utf8'), '1.2 must survive').toContain('CURRENT_PROJECT_VERSION = 1.2;');
      expect(fs.readFileSync(pbxPath(), 'utf8')).not.toContain('CURRENT_PROJECT_VERSION = 1;');
      expect(r.notes.join(' ')).toContain('cannot be ordered against');
    });

    /** …and the same refusal applies when the config number is HIGHER, because "1.2 vs 8" is still
     *  a comparison we cannot make correctly — component-wise ordering is Apple's, not ours. */
    it('refuses a dotted build number even when the config value looks larger', () => {
      const dotted = PBX.replaceAll('CURRENT_PROJECT_VERSION = 1;', 'CURRENT_PROJECT_VERSION = 1.2;');
      writeNative(GRADLE, dotted);
      writeAppCfg({ version: '1.0', buildNumber: 8 });
      healNativeConfig(root);
      expect(fs.readFileSync(pbxPath(), 'utf8')).toContain('CURRENT_PROJECT_VERSION = 1.2;');
    });

    // Nothing validates config types (#39); junk must not become `versionCode banana`.
    it('leaves the project ALONE on junk values', () => {
      writeNative();
      writeAppCfg({ version: 'banana', buildNumber: 'lots' });
      healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toBe(GRADLE);
      expect(fs.readFileSync(pbxPath(), 'utf8')).toBe(PBX);
    });

    it('leaves the project ALONE on a zero / negative build number', () => {
      writeNative();
      writeAppCfg({ version: '1.0', buildNumber: 0 });
      healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toBe(GRADLE);
    });

    /** The defaults are chosen to match what `cap add` scaffolds, so adopting the feature
     *  rewrites NOTHING in the twenty existing projects. A default that differed would churn
     *  every project's native files on the next open — the #18 write-behind-your-back hazard. */
    it('the DEFAULTS are a no-op against a freshly scaffolded project', () => {
      writeNative();
      writeAppCfg({});
      healNativeConfig(root);
      expect(DEFAULT_PROJECT_CONFIG.app.version).toBe('1.0');
      expect(DEFAULT_PROJECT_CONFIG.app.buildNumber).toBe(1);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toBe(GRADLE);
      expect(fs.readFileSync(pbxPath(), 'utf8')).toBe(PBX);
    });
  });

  // The Android sibling of 'iOS deployment target' above — cap add scaffolds minSdkVersion 24
  // and nothing revisits it, so without this heal the floor drifts per-project.
  describe('Android minSdk', () => {
    const GRADLE = [
      'ext {',
      '    minSdkVersion = 24',
      '    compileSdkVersion = 36',
      '}',
      '',
    ].join('\n');
    function gradlePath() { return path.join(root, 'android', 'variables.gradle'); }
    function writeGradle() {
      fs.mkdirSync(path.dirname(gradlePath()), { recursive: true });
      fs.writeFileSync(gradlePath(), GRADLE);
    }
    function writeBuildCfg(build: Record<string, unknown>) {
      fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ build, capacitor: {} }));
    }

    it('syncs minSdkVersion from build.androidMinSdk', () => {
      writeGradle();
      writeBuildCfg({ appleTeamId: '', androidMinSdk: 31 });
      healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('minSdkVersion = 31');
    });

    it('is idempotent', () => {
      writeGradle();
      writeBuildCfg({ appleTeamId: '', androidMinSdk: 31 });
      healNativeConfig(root);
      const once = fs.readFileSync(gradlePath(), 'utf8');
      healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toBe(once);
    });

    // Nothing validates numeric config (#39); junk must not become `minSdkVersion = banana`.
    it('leaves the project ALONE on a junk (non-numeric) value', () => {
      writeGradle();
      writeBuildCfg({ appleTeamId: '', androidMinSdk: 'banana' });
      healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toBe(GRADLE);
    });

    it('leaves the project ALONE on an out-of-range value (0)', () => {
      writeGradle();
      writeBuildCfg({ appleTeamId: '', androidMinSdk: 0 });
      healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toBe(GRADLE);
    });

    it('does nothing when the project has no android/variables.gradle', () => {
      writeBuildCfg({ appleTeamId: '', androidMinSdk: 31 });
      expect(() => healNativeConfig(root)).not.toThrow();
      expect(fs.existsSync(gradlePath())).toBe(false);
    });
  });

  // THE PATH PRODUCTION ACTUALLY TAKES. Every test above hands the heal an explicit floor,
  // but no project on disk sets `iosMinVersion`/`androidMinSdk` at all — all 22 inherit the
  // schema default through `loadProjectConfig`. That makes the default-merge a load-bearing
  // seam with a SILENT failure mode: if the field stopped being merged, the heal would receive
  // `undefined`, fail its own `Number.isInteger` / regex validation, and return "leave the
  // project alone" — indistinguishable from a healthy no-op. Nothing would throw, no test
  // above would fail, and every project would quietly ship the Capacitor-scaffolded floor.
  describe('schema defaults reach the heal (config that sets NO floor)', () => {
    const PBX = [
      '// !$*UTF8*$!',
      '{ objects = {',
      '  AAA /* Debug */ = { buildSettings = { IPHONEOS_DEPLOYMENT_TARGET = 15.0; }; };',
      '}; }',
      '',
    ].join('\n');
    const GRADLE = 'ext {\n    minSdkVersion = 24\n}\n';

    it('applies BOTH floors from the schema when the project config omits them', () => {
      const pbx = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
      const gradle = path.join(root, 'android', 'variables.gradle');
      fs.mkdirSync(path.dirname(pbx), { recursive: true });
      fs.writeFileSync(pbx, PBX);
      fs.mkdirSync(path.dirname(gradle), { recursive: true });
      fs.writeFileSync(gradle, GRADLE);
      // No build.iosMinVersion, no build.androidMinSdk — exactly what every real project ships.
      fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ build: {}, capacitor: {} }));

      healNativeConfig(root);

      expect(fs.readFileSync(pbx, 'utf8')).toContain(`IPHONEOS_DEPLOYMENT_TARGET = ${DEFAULT_PROJECT_CONFIG.build.iosMinVersion};`);
      expect(fs.readFileSync(gradle, 'utf8')).toContain(`minSdkVersion = ${DEFAULT_PROJECT_CONFIG.build.androidMinSdk}`);
      // Assert the scaffolded values are actually GONE, not merely co-present.
      expect(fs.readFileSync(pbx, 'utf8')).not.toContain('15.0');
      expect(fs.readFileSync(gradle, 'utf8')).not.toContain('minSdkVersion = 24');
    });
  });

  /** `app.buildNumberAuto = true` — the owner asked to stop hand-bumping the build
   *  number per store upload. The commit count is derived per heal pass; `app.buildNumber`
   *  stays as a FLOOR, and the never-lower guard keeps its role as the last line of defence. */
  describe('build number source = git commits', () => {
    const GRADLE = [
      'android {',
      '    defaultConfig {',
      '        versionCode 1',
      '        versionName "1.0"',
      '    }',
      '}',
      '',
    ].join('\n');
    const PBX = [
      'buildSettings = {',
      '\tCURRENT_PROJECT_VERSION = 1;',
      '\tMARKETING_VERSION = 1.0;',
      '};',
      '',
    ].join('\n');
    const gradlePath = () => path.join(root, 'android', 'app', 'build.gradle');
    const pbxPath = () => path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    function writeNative(gradle = GRADLE, pbx = PBX) {
      fs.mkdirSync(path.dirname(gradlePath()), { recursive: true });
      fs.writeFileSync(gradlePath(), gradle);
      fs.mkdirSync(path.dirname(pbxPath()), { recursive: true });
      fs.writeFileSync(pbxPath(), pbx);
    }
    function writeCfg(app: Record<string, unknown>) {
      fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ app, build: {}, capacitor: {} }));
    }
    /** A REAL temp git repo with `commits` commits — rev-list --count against it is the
     *  production code path end-to-end, not a mock of git's output shape. `-c commit.gpgsign=false`
     *  because a machine with signing configured globally would otherwise fail every commit
     *  here silently (count 0) and flake the derivation test; each call's status is asserted
     *  so a fixture-setup failure is loud, never a vacuous pass. */
    function gitRepoWithCommits(commits: number) {
      const run = (args: string[]) => {
        const r = spawnSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
        return r;
      };
      run(['init']);
      run(['config', 'user.email', 'test@example.com']);
      run(['config', 'user.name', 'Test']);
      for (let i = 0; i < commits; i++) {
        fs.writeFileSync(path.join(root, `f${i}.txt`), String(i));
        run(['add', `f${i}.txt`]);
        run(['commit', '-m', `c${i}`]);
      }
    }

    it('derives the build number from the commit count', () => {
      writeNative();
      gitRepoWithCommits(7);
      writeCfg({ version: '1.0', buildNumber: 1, buildNumberAuto: true });
      const r = healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('versionCode 7');
      expect(fs.readFileSync(pbxPath(), 'utf8')).toContain('CURRENT_PROJECT_VERSION = 7;');
      expect(r.notes.join(' ')).toContain('derived from git commit count');
    });

    it('keeps app.buildNumber as a FLOOR above the commit count', () => {
      writeNative();
      gitRepoWithCommits(3);
      writeCfg({ version: '1.0', buildNumber: 10, buildNumberAuto: true });
      const r = healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('versionCode 10');
      expect(r.notes.join(' ')).toContain('floor');
    });

    it('the never-lower guard still wins over a derived number', () => {
      // The native project already uploaded at 50; the repo only has 3 commits. Writing 3
      // would be exactly the silent Play rejection this whole heal exists to prevent.
      writeNative(GRADLE.replace('versionCode 1', 'versionCode 50'), PBX.replace('CURRENT_PROJECT_VERSION = 1;', 'CURRENT_PROJECT_VERSION = 50;'));
      gitRepoWithCommits(3);
      writeCfg({ version: '1.0', buildNumber: 1, buildNumberAuto: true });
      const r = healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('versionCode 50');
      expect(r.notes.join(' ')).toContain('REFUSED to lower Android versionCode 50');
    });

    it('falls back to app.buildNumber (with a note) outside a git repo', () => {
      writeNative();
      writeCfg({ version: '1.0', buildNumber: 4, buildNumberAuto: true });
      const r = healNativeConfig(root); // root is a bare tmpdir — no .git anywhere
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('versionCode 4');
      expect(r.notes.join(' ')).toContain('no commit count could be read');
    });

    /** The `floor >= count` boundary. At floor === count the two branches return the SAME
     *  number, so only the note tells them apart — which is why a mutation to `floor > count`
     *  survived the whole suite. Pinned on the note, since that is the only observable. */
    it('at floor === count it reports the FLOOR, not a derived number', () => {
      writeNative();
      gitRepoWithCommits(7);
      writeCfg({ version: '1.0', buildNumber: 7, buildNumberAuto: true });
      const r = healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('versionCode 7');
      expect(r.notes.join(' ')).toContain('floor');
      expect(r.notes.join(' ')).not.toContain('derived from git commit count');
    });

    it('auto OFF (the default) passes the typed value straight through', () => {
      writeNative();
      gitRepoWithCommits(30);
      writeCfg({ version: '1.0', buildNumber: 2 }); // no buildNumberAuto field at all
      const r = healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('versionCode 2');
      expect(r.notes.join(' ')).not.toContain('commit');
    });
  });

  /** App identity heal — appId/appName were WRITE-ONCE at `cap add`: changing Project
   *  Settings afterwards silently changed nothing in any native file (audit, 2026-08-25). */
  describe('app identity (appId/appName) reaches every native file', () => {
    const CAP = JSON.stringify({ appId: 'com.old.id', appName: 'Old Name', webDir: 'dist' }, null, 2) + '\n';
    const GRADLE = [
      'android {',
      '    namespace "com.other.code"', // must NEVER move — renaming strands MainActivity's package
      '    defaultConfig {',
      '        applicationId "com.old.id"',
      '    }',
      '}',
      '',
    ].join('\n');
    const STRINGS = [
      '<?xml version=\'1.0\' encoding=\'utf-8\'?>',
      '<resources>',
      '    <string name="app_name">Old Name</string>',
      '    <string name="title_activity_main">Old Name</string>',
      '    <string name="package_name">com.old.id</string>',
      '    <string name="custom_url_scheme">com.old.id</string>',
      '</resources>',
      '',
    ].join('\n');
    const PBX = [
      'buildSettings = {',
      '\tPRODUCT_BUNDLE_IDENTIFIER = com.old.id;',
      '};',
      'buildSettings = {',
      '\tPRODUCT_BUNDLE_IDENTIFIER = com.old.id;',
      '};',
      '',
    ].join('\n');
    const PLIST = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>CFBundleDisplayName</key>',
      '\t<string>Old Name</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');

    const capPath = () => path.join(root, 'capacitor.config.json');
    const gradlePath = () => path.join(root, 'android', 'app', 'build.gradle');
    const stringsPath = () => path.join(root, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
    const pbxPath = () => path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    const plistPath = () => path.join(root, 'ios', 'App', 'App', 'Info.plist');
    function writeNative() {
      fs.mkdirSync(path.dirname(gradlePath()), { recursive: true });
      fs.writeFileSync(gradlePath(), GRADLE);
      fs.mkdirSync(path.dirname(stringsPath()), { recursive: true });
      fs.writeFileSync(stringsPath(), STRINGS);
      fs.mkdirSync(path.dirname(pbxPath()), { recursive: true });
      fs.writeFileSync(pbxPath(), PBX);
      fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
      fs.writeFileSync(plistPath(), PLIST);
      fs.writeFileSync(capPath(), CAP);
    }
    function writeCfg(app: Record<string, unknown>) {
      fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ app, build: {}, capacitor: {} }));
    }

    it('syncs a changed appId/appName into ALL five files', () => {
      writeNative();
      writeCfg({ appId: 'com.new.id', appName: 'New Name' });
      const r = healNativeConfig(root);
      const all = [capPath(), gradlePath(), stringsPath(), pbxPath()].map((p) => fs.readFileSync(p, 'utf8')).join('\n')
        + fs.readFileSync(plistPath(), 'utf8');
      expect(all).not.toContain('com.old.id');
      expect(all).not.toContain('Old Name');
      expect(all.match(/com\.new\.id/g)!.length).toBeGreaterThanOrEqual(5); // cap cfg, gradle, strings ×2, pbx ×2
      expect(all).toContain('New Name');
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('namespace "com.other.code"'); // untouched
      expect(r.notes.join(' ')).toContain('WARNING: bundle id changed com.old.id -> com.new.id');
    });

    it('is a byte-identical no-op when everything already matches', () => {
      writeNative();
      writeCfg({ appId: 'com.old.id', appName: 'Old Name' });
      healNativeConfig(root);
      const once = [capPath(), gradlePath(), stringsPath(), pbxPath(), plistPath()]
        .map((p) => fs.readFileSync(p, 'utf8')).join('|');
      healNativeConfig(root);
      expect([capPath(), gradlePath(), stringsPath(), pbxPath(), plistPath()]
        .map((p) => fs.readFileSync(p, 'utf8')).join('|')).toBe(once);
      expect(once).toContain('com.old.id'); // sanity: nothing rewrote it anyway
    });

    it('REFUSES an invalid bundle id instead of writing garbage into four files', () => {
      writeNative();
      writeCfg({ appId: 'not valid! id', appName: 'Fine Name' });
      const r = healNativeConfig(root);
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('"com.old.id"');
      expect(r.notes.join(' ')).toContain('REFUSED to sync app.appId');
    });

    it('a name-only change does NOT fire the new-app warning', () => {
      writeNative();
      writeCfg({ appId: 'com.old.id', appName: 'Renamed' });
      const r = healNativeConfig(root);
      expect(fs.readFileSync(plistPath(), 'utf8')).toContain('<string>Renamed</string>');
      expect(r.notes.join(' ')).not.toContain('WARNING');
    });

    /** The rewrite is SCOPED to the old id: an extension target (`com.x.y.widget`) or a
     *  gradle flavour (`com.x.y.free`) deliberately carries a DIFFERENT id in the same file,
     *  and a blind replace-all would rename it to the app's id, breaking its embedding. */
    it('does NOT touch sibling targets/flavour ids that differ from the app id', () => {
      writeNative();
      // An extension target + a flavour id alongside the app's own.
      fs.writeFileSync(pbxPath(), PBX + 'buildSettings = {\n\tPRODUCT_BUNDLE_IDENTIFIER = com.old.id.widget;\n};\n');
      fs.writeFileSync(gradlePath(), GRADLE.replace(
        '    }',
        '    }\n    productFlavors {\n        free {\n            applicationId "com.old.id.free"\n        }\n    }',
      ));
      writeCfg({ appId: 'com.new.id', appName: 'Old Name' });
      const r = healNativeConfig(root);
      const pbx = fs.readFileSync(pbxPath(), 'utf8');
      expect(pbx).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.new.id;');   // app configs moved
      expect(pbx).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.old.id.widget;'); // extension survived
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('applicationId "com.old.id.free"'); // flavour survived
      expect(r.notes.join(' ')).toContain('WARNING: bundle id changed com.old.id -> com.new.id');
    });

    /** Without capacitor.config.json there is NO anchor for which pbxproj/gradle ids are the
     *  APP's (vs an extension's), so the id half must be SKIPPED with a note — never guessed.
     *  The name half needs no anchor and still syncs. */
    it('skips the id rewrite (with a note) when no old-id anchor exists, name still syncs', () => {
      writeNative();
      fs.rmSync(capPath());
      writeCfg({ appId: 'com.new.id', appName: 'Renamed' });
      const r = healNativeConfig(root);
      // gradle + pbxproj carry the app id AND sibling/flavour ids — no anchor, no rewrite.
      const unanchored = fs.readFileSync(gradlePath(), 'utf8') + fs.readFileSync(pbxPath(), 'utf8');
      expect(unanchored).not.toContain('com.new.id');
      expect(unanchored).toContain('com.old.id');
      // strings.xml keys ARE the app id by name — no anchor needed there.
      expect(fs.readFileSync(stringsPath(), 'utf8')).toContain('package_name">com.new.id<');
      expect(fs.readFileSync(plistPath(), 'utf8')).toContain('<string>Renamed</string>');
      expect(r.notes.join(' ')).toContain('cannot determine this project\'s previous bundle id');
      expect(r.notes.join(' ')).not.toContain('WARNING: bundle id changed');
    });

    /** Per-file guard: one unreadable file must not abort the heals AFTER identity through
     *  main()'s outer catch — that skipped orientation/game-mode/crashlytics with a generic
     *  note naming neither the failure nor what it prevented. */
    it('a failing identity file does not abort the rest of the heal pass', () => {
      writeNative();
      // Make ONE file unreadable-as-file (a directory where Info.plist belongs).
      fs.rmSync(plistPath());
      fs.mkdirSync(plistPath());
      writeCfg({ appId: 'com.old.id', appName: 'Renamed' });
      const r = healNativeConfig(root);
      expect(fs.readFileSync(stringsPath(), 'utf8')).toContain('Renamed'); // later files still healed
      expect(r.notes.join(' ')).toContain('Info.plist sync failed');
    });

    /** ⚠️ `app.appName` is a DISPLAY name with no `BUILD_FIELD_RULES` pattern behind it (unlike
     *  `app.appId`, which is charset-restricted) — and it must stay free text, because "Rock &
     *  Roll" is a real app name. So it has to be ESCAPED at these two write sites, and it was
     *  not: the value went into `strings.xml` and `Info.plist` raw. Every case below produced a
     *  structurally broken COMMITTED file from a name the owner typed into Project Settings,
     *  written by a heal that runs on every open/build. */
    describe('appName is escaped, not injected', () => {
      /** Parse as XML the strict way `AAPT2`/`plutil` do — a bare `&` or `<` must FAIL here.
       *  DOMParser reports a parsererror element rather than throwing. */
      function xmlIsWellFormed(text: string): boolean {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        return doc.getElementsByTagName('parsererror').length === 0;
      }

      it('an ampersand does not make strings.xml and Info.plist malformed', () => {
        writeNative();
        writeCfg({ appId: 'com.old.id', appName: 'Rock & Roll' });
        healNativeConfig(root);
        const strings = fs.readFileSync(stringsPath(), 'utf8');
        const plist = fs.readFileSync(plistPath(), 'utf8');
        expect(xmlIsWellFormed(strings), `strings.xml is malformed XML:\n${strings}`).toBe(true);
        expect(xmlIsWellFormed(plist), `Info.plist is malformed XML:\n${plist}`).toBe(true);
        // Escaped on the way in, so it PARSES BACK to exactly what the owner typed.
        expect(new DOMParser().parseFromString(plist, 'application/xml')
          .getElementsByTagName('string')[0].textContent).toBe('Rock & Roll');
        expect(strings).toContain('&amp;');
      });

      /** `$&`, `$1`, `` $` `` and `$'` are SUBSTITUTION DIRECTIVES in a `String.replace`
       *  replacement string. Built with a template literal, a name containing one is injected
       *  rather than inserted — this exact input nested `<string name="app_name">` inside
       *  itself and, in the plist, swallowed the preceding `<key>` line. */
      it('a dollar sequence is inserted literally, not interpreted as a replacement pattern', () => {
        writeNative();
        writeCfg({ appId: 'com.old.id', appName: 'Court $& Co' });
        healNativeConfig(root);
        const strings = fs.readFileSync(stringsPath(), 'utf8');
        const plist = fs.readFileSync(plistPath(), 'utf8');
        expect(xmlIsWellFormed(strings), `strings.xml is malformed XML:\n${strings}`).toBe(true);
        expect(xmlIsWellFormed(plist), `Info.plist is malformed XML:\n${plist}`).toBe(true);
        // The structural tell of the injection: the key line eaten, or the tag duplicated.
        expect(plist).toContain('<key>CFBundleDisplayName</key>');
        expect(strings.match(/<string name="app_name">/g)!.length).toBe(1);
        expect(new DOMParser().parseFromString(plist, 'application/xml')
          .getElementsByTagName('string')[0].textContent).toBe('Court $& Co');
      });

      /** AAPT2-only rule, which plain XML escaping does not cover: an unescaped apostrophe in a
       *  `<string>` resource is a hard build error ("Apostrophe not preceded by \\"). The plist
       *  must NOT get that backslash — it would show up in the displayed name. */
      it('an apostrophe is backslash-escaped for AAPT2 in strings.xml but NOT in the plist', () => {
        writeNative();
        writeCfg({ appId: 'com.old.id', appName: "Cat's Court" });
        healNativeConfig(root);
        expect(fs.readFileSync(stringsPath(), 'utf8')).toContain("Cat\\'s Court");
        expect(fs.readFileSync(plistPath(), 'utf8')).toContain("<string>Cat's Court</string>");
      });

      it('stays idempotent — escaping an already-escaped file rewrites nothing', () => {
        writeNative();
        writeCfg({ appId: 'com.old.id', appName: 'Rock & Roll' });
        healNativeConfig(root);
        const once = [stringsPath(), plistPath()].map((p) => fs.readFileSync(p, 'utf8')).join('|');
        healNativeConfig(root);
        expect([stringsPath(), plistPath()].map((p) => fs.readFileSync(p, 'utf8')).join('|')).toBe(once);
      });
    });

    /** ⚠️ capacitor.config.json is the ANCHOR — `oldId` scopes every gradle/pbxproj rewrite and
     *  is recoverable from nowhere else. It used to be written FIRST, so a native write that
     *  then failed (which `guarded` catches by design, to keep the pass going) advanced the
     *  anchor to the NEW id while those files still held the OLD one. The next pass then matched
     *  nothing and reported no change: permanent, silent divergence. It is committed LAST now,
     *  which makes a partial failure retryable instead. */
    // ⚠️ The fault is a READ-ONLY file, not a directory-in-its-place like the per-file-guard
    // test above uses. Aimed at the pbxproj, that trick never reaches this code: EARLIER heals
    // (DEVELOPMENT_TEAM, crashlytics, game-debug) read the same pbxproj with no per-file guard
    // of their own, so the whole pass aborts through main()'s outer catch with a bare
    // "heal skipped: EISDIR" — measured. A read-only file lets every reader succeed and fails
    // only the WRITE, which is exactly the partial failure this test is about.
    // Skipped on Windows, where a mode bit does not make a file unwritable the same way.
    it.skipIf(process.platform === 'win32')(
      'leaves the anchor on the OLD id when a native write fails, so the next pass retries', () => {
      writeNative();
      fs.chmodSync(pbxPath(), 0o444);
      writeCfg({ appId: 'com.new.id', appName: 'Old Name' });
      const first = healNativeConfig(root);
      expect(first.notes.join(' ')).toContain('pbxproj sync failed');
      expect(
        JSON.parse(fs.readFileSync(capPath(), 'utf8')).appId,
        'the anchor must NOT advance past a failed native write — advancing it strands the ' +
          'files that did not get rewritten, unrecoverably',
      ).toBe('com.old.id');

      // Repair the fault; the retry must now complete, which it could not do from a lost anchor.
      fs.chmodSync(pbxPath(), 0o644);
      healNativeConfig(root);
      expect(fs.readFileSync(pbxPath(), 'utf8')).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.new.id;');
      expect(JSON.parse(fs.readFileSync(capPath(), 'utf8')).appId).toBe('com.new.id');
    });

    /** Coverage hole found by mutation-testing: the gradle branch and the pbxproj branch each
     *  carry their OWN `if (!oldId) noteIdSkipped()`, but `noteIdSkipped` is shared and fires
     *  once — so deleting either branch's guard left the other still emitting the note, and the
     *  suite could not tell whether a given branch's check existed at all.
     *
     *  ⚠️ CONTENT cannot distinguish them, which is why the first attempt at this test failed to
     *  catch the mutation: a branch that fell back to `oldId ?? id` would rewrite the new id TO
     *  the new id — a no-op in the file no matter what is seeded. The note is the only
     *  observable, so each branch is ISOLATED instead: remove the other platform's folder
     *  entirely, and whichever note survives can only have come from the branch under test. */
    /** ⚠️ The anchor gate must express "did the id LAND?", not "did anything throw?".
     *
     *  There are TWO ways the id rewrite does not happen, and only one of them throws. This is
     *  the other: a `capacitor.config.json` that PARSES but carries no `appId` leaves `oldId`
     *  undefined, so gradle/pbxproj skip via `noteIdSkipped()` and return NORMALLY —
     *  `guarded()` reports success. Gating the anchor on exceptions alone committed the new id
     *  anyway, and every later pass then searched gradle for an id the file does not contain,
     *  found nothing, and reported nothing: the divergence is permanent AND silent from pass 2
     *  onward, which is worse than the bug the ordering fix was written for.
     *
     *  Note the two anchor tests below cannot see this — they `rmSync` the cap file, which
     *  leaves `capJson` undefined so `writeCapacitorConfig` returns early and the anchor cannot
     *  advance under any predicate. The file has to be PRESENT and appId-less. */
    it('a cap config that parses but has NO appId does not advance the anchor either', () => {
      writeNative();
      fs.writeFileSync(capPath(), JSON.stringify({ appName: 'Old Name', webDir: 'dist' }, null, 2) + '\n');
      writeCfg({ appId: 'com.new.id', appName: 'Old Name' });

      const first = healNativeConfig(root);
      expect(first.notes.join(' ')).toContain('cannot determine this project\'s previous bundle id');
      expect(fs.readFileSync(gradlePath(), 'utf8'), 'gradle was not rewritten').toContain('applicationId "com.old.id"');
      expect(
        JSON.parse(fs.readFileSync(capPath(), 'utf8')).appId,
        'the anchor must NOT be minted from a rewrite that never happened — doing so makes every '
          + 'later pass search for an id the native files do not contain, silently',
      ).toBeUndefined();

      // Pass 2 must still SAY something rather than going quiet on a broken project.
      const second = healNativeConfig(root);
      expect(
        second.notes.join(' '),
        'the second pass must keep reporting the problem, not fall silent',
      ).toContain('cannot determine this project\'s previous bundle id');
    });

    it('the GRADLE branch refuses to guess an anchor on its own (iOS absent)', () => {
      writeNative();
      fs.rmSync(capPath());                                 // no anchor
      fs.rmSync(path.join(root, 'ios'), { recursive: true }); // pbxproj branch cannot emit
      writeCfg({ appId: 'com.new.id', appName: 'Old Name' });
      const r = healNativeConfig(root);
      expect(r.notes.join(' ')).toContain('cannot determine this project\'s previous bundle id');
      expect(fs.readFileSync(gradlePath(), 'utf8')).toContain('applicationId "com.old.id"');
    });

    it('the PBXPROJ branch refuses to guess an anchor on its own (Android absent)', () => {
      writeNative();
      fs.rmSync(capPath());                                     // no anchor
      fs.rmSync(path.join(root, 'android'), { recursive: true }); // gradle branch cannot emit
      writeCfg({ appId: 'com.new.id', appName: 'Old Name' });
      const r = healNativeConfig(root);
      expect(r.notes.join(' ')).toContain('cannot determine this project\'s previous bundle id');
      expect(fs.readFileSync(pbxPath(), 'utf8')).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.old.id;');
    });
  });
});
