/** healNativeConfig — heal-on-open native config (android/local.properties +
 *  iOS DEVELOPMENT_TEAM). Exercised against real temp project dirs. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  return `// !$*UTF8*$!\n{${body}\n}\n`;
}

function writePbxproj(content: string) {
  const dir = path.join(root, 'ios', 'App', 'App.xcodeproj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.pbxproj'), content);
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
  it('inserts DEVELOPMENT_TEAM into every block that lacks it', () => {
    writePbxproj(pbxproj());
    writeConfig('ABCDE12345');
    healNativeConfig(root);
    const out = readPbxproj();
    const count = (out.match(/DEVELOPMENT_TEAM = ABCDE12345;/g) || []).length;
    expect(count).toBe(2); // Debug + Release
    // Inserted right after PRODUCT_NAME.
    expect(out).toMatch(/PRODUCT_NAME = "\$\(TARGET_NAME\)";\n\s*DEVELOPMENT_TEAM = ABCDE12345;/);
  });

  it('corrects a stale team value without duplicating', () => {
    writePbxproj(pbxproj({ team: 'OLDTEAM123' }));
    writeConfig('ABCDE12345');
    healNativeConfig(root);
    const out = readPbxproj();
    expect(out).not.toContain('OLDTEAM123');
    expect((out.match(/DEVELOPMENT_TEAM = ABCDE12345;/g) || []).length).toBe(2);
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

  it('does NOT flatten a separate target\'s team (D2)', () => {
    // App target has no team (heal inserts), a second target carries its own.
    writePbxproj(pbxproj({ ext: { team: 'EXTTEAM123' } }));
    writeConfig('ABCDE12345');
    healNativeConfig(root);
    const out = readPbxproj();
    expect((out.match(/DEVELOPMENT_TEAM = ABCDE12345;/g) || []).length).toBe(2); // App Debug+Release only
    expect((out.match(/DEVELOPMENT_TEAM = EXTTEAM123;/g) || []).length).toBe(2); // extension untouched
  });

  it('corrects the empty-quoted DEVELOPMENT_TEAM = ""; form (D2)', () => {
    writePbxproj(pbxproj({ team: '""' }));
    writeConfig('ABCDE12345');
    healNativeConfig(root);
    const out = readPbxproj();
    expect(out).not.toContain('DEVELOPMENT_TEAM = "";');
    expect((out.match(/DEVELOPMENT_TEAM = ABCDE12345;/g) || []).length).toBe(2);
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
});
