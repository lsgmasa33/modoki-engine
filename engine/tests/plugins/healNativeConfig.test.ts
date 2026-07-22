/** healNativeConfig — heal-on-open native config (android/local.properties +
 *  iOS DEVELOPMENT_TEAM). Exercised against real temp project dirs. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { healNativeConfig, androidSdkDirValue } from '../../plugins/healNativeConfig';

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

function writeConfig(teamId: string) {
  fs.writeFileSync(
    path.join(root, 'project.config.json'),
    JSON.stringify({ build: { appleTeamId: teamId } }),
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
    fs.writeFileSync(lp, 'sdk.dir=C:\\Users\\shois\\AppData\\Roaming\\modoki-app\\toolchain\\android-sdk\n');
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
    expect(androidSdkDirValue('C:\\Users\\shois\\AppData\\Roaming\\modoki-app\\toolchain\\android-sdk'))
      .toBe('C:/Users/shois/AppData/Roaming/modoki-app/toolchain/android-sdk');
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
    writeConfig('KQ6FQ2BS8H');
    healNativeConfig(root);
    const out = readPbxproj();
    const count = (out.match(/DEVELOPMENT_TEAM = KQ6FQ2BS8H;/g) || []).length;
    expect(count).toBe(2); // Debug + Release
    // Inserted right after PRODUCT_NAME.
    expect(out).toMatch(/PRODUCT_NAME = "\$\(TARGET_NAME\)";\n\s*DEVELOPMENT_TEAM = KQ6FQ2BS8H;/);
  });

  it('corrects a stale team value without duplicating', () => {
    writePbxproj(pbxproj({ team: 'OLDTEAM123' }));
    writeConfig('KQ6FQ2BS8H');
    healNativeConfig(root);
    const out = readPbxproj();
    expect(out).not.toContain('OLDTEAM123');
    expect((out.match(/DEVELOPMENT_TEAM = KQ6FQ2BS8H;/g) || []).length).toBe(2);
  });

  it('is idempotent — a second pass changes nothing', () => {
    writePbxproj(pbxproj());
    writeConfig('KQ6FQ2BS8H');
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
    writeConfig('KQ6FQ2BS8H');
    healNativeConfig(root);
    const out = readPbxproj();
    expect((out.match(/DEVELOPMENT_TEAM = KQ6FQ2BS8H;/g) || []).length).toBe(2); // App Debug+Release only
    expect((out.match(/DEVELOPMENT_TEAM = EXTTEAM123;/g) || []).length).toBe(2); // extension untouched
  });

  it('corrects the empty-quoted DEVELOPMENT_TEAM = ""; form (D2)', () => {
    writePbxproj(pbxproj({ team: '""' }));
    writeConfig('KQ6FQ2BS8H');
    healNativeConfig(root);
    const out = readPbxproj();
    expect(out).not.toContain('DEVELOPMENT_TEAM = "";');
    expect((out.match(/DEVELOPMENT_TEAM = KQ6FQ2BS8H;/g) || []).length).toBe(2);
  });

  it('bails safely when the App target config list is absent (no flatten)', () => {
    // A pbxproj with build configs but no "PBXNativeTarget \"App\"" list.
    const noList = `// !$*UTF8*$!\n{${cfgBlock(U.appDebug, 'Debug', 'SOMETEAM01')}\n}\n`;
    writePbxproj(noList);
    writeConfig('KQ6FQ2BS8H');
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

  it('adds the Release Info.plist-strip build phase (Task 4)', () => {
    scaffoldIos(); writeConfig(''); writeGameDebugDep(); writeEngineGameDebugSwift();
    healNativeConfig(root);
    const pbx = readPbx();
    expect(pbx).toContain('PBXShellScriptBuildPhase');
    expect(pbx).toContain('Strip debug-only Info.plist keys (Release)');
    expect(pbx).toContain('PlistBuddy -c \\"Delete :NSBonjourServices\\"');
    // referenced in the App target buildPhases (once) + defined (once) = 2 mentions of the UUID
    expect((pbx.match(/DD0000000000000000000005/g) || []).length).toBe(2);
    // gated on Release
    expect(pbx).toContain('if [ \\"${CONFIGURATION}\\" = \\"Release\\" ]');
  });

  it('Release-strip phase is idempotent', () => {
    scaffoldIos(); writeConfig(''); writeGameDebugDep(); writeEngineGameDebugSwift();
    healNativeConfig(root);
    const once = readPbx();
    healNativeConfig(root);
    expect((readPbx().match(/Strip debug-only Info\.plist keys/g) || []).length)
      .toBe((once.match(/Strip debug-only Info\.plist keys/g) || []).length);
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
});
