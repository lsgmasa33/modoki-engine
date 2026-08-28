/** Release build decisions (#370) — the pure half.
 *
 *  Everything a release build decides BEFORE it spends minutes on gradle/xcodebuild lives in
 *  `plugins/releaseBuild.ts` as a pure function, precisely so it can be tested without a keystore,
 *  an Apple account or a phone. The failures these guard are all of the same shape: they do not
 *  fail the build. An unsigned AAB builds clean and is refused by Play at upload; a `method`
 *  Xcode does not know fails with a message that reads like a signing problem; an export that lets
 *  Xcode manage the build number ships a different number than the one you set. Every one of them
 *  is discovered late, by someone else.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseBuildVariant, keystoreRefusal, renderKeystoreProperties, renderExportOptionsPlist,
  androidReleaseSteps, iosReleaseSteps, debugBuildReleaseWarning,
  BUILD_VARIANTS, IOS_EXPORT_METHODS,
  ANDROID_AAB_PATH, ANDROID_RELEASE_APK_PATH, IOS_ARCHIVE_PATH, IOS_EXPORT_DIR, IOS_EXPORT_OPTIONS_PATH,
} from '../../plugins/releaseBuild';
import { DEFAULT_PROJECT_USER_CONFIG, DEFAULT_PROJECT_CONFIG } from '../../project-config';

const KS = {
  storeFile: '/keys/com.example.app-upload.jks',
  storePassword: 'store-pw',
  keyAlias: 'upload',
  keyPassword: 'key-pw',
};
const always = () => true;
const never = () => false;

describe('parseBuildVariant', () => {
  it('an ABSENT variant is debug — every pre-#370 caller must keep its old meaning', () => {
    // The Build menu's device rows, `modoki_build`, and the e2e specs all send no `variant`. If
    // that ever resolved to anything but `debug`, they would silently start producing store
    // artifacts (and, on Android, start REFUSING for want of an upload key).
    expect(parseBuildVariant(null)).toEqual({ ok: true, variant: 'debug' });
    expect(parseBuildVariant(undefined)).toEqual({ ok: true, variant: 'debug' });
    expect(parseBuildVariant('')).toEqual({ ok: true, variant: 'debug' });
  });

  it('accepts each declared variant', () => {
    for (const v of BUILD_VARIANTS) expect(parseBuildVariant(v)).toEqual({ ok: true, variant: v });
  });

  it('REFUSES an unrecognised variant rather than falling back (#40)', () => {
    // The distinguishing case: a typo must not resolve to the OTHER kind of build. `relase` is one
    // keystroke from `release` and the two builds do entirely different things.
    const r = parseBuildVariant('relase');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain('debug or release');
  });
});

describe('keystoreRefusal — the unsigned-AAB trap', () => {
  it('passes a fully configured key whose file exists', () => {
    expect(keystoreRefusal(KS, always, 'project.user.json')).toBeNull();
  });

  it('refuses the DEFAULT (all-empty) user config, naming every missing field', () => {
    const msg = keystoreRefusal(DEFAULT_PROJECT_USER_CONFIG.keystore, always, 'games/x/project.user.json');
    expect(msg).toBeTruthy();
    for (const field of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword']) {
      expect(msg).toContain(field);
    }
  });

  it('refuses each field individually — a partially filled key is not a configured one', () => {
    // Perturb ONE field at a time: a check that only ever saw all-empty vs all-set would pass
    // just as happily if the function looked at storeFile alone.
    for (const field of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'] as const) {
      const msg = keystoreRefusal({ ...KS, [field]: '' }, always, 'project.user.json');
      expect(msg, `${field} empty must refuse`).toBeTruthy();
      expect(msg).toContain(field);
    }
  });

  it('treats a whitespace-only storeFile/keyAlias as empty', () => {
    expect(keystoreRefusal({ ...KS, storeFile: '   ' }, always, 'p.json')).toContain('storeFile');
    expect(keystoreRefusal({ ...KS, keyAlias: '\t' }, always, 'p.json')).toContain('keyAlias');
  });

  it('refuses a configured key whose FILE is missing, and says to copy rather than regenerate', () => {
    // The second-machine case, and the one that costs the most to get wrong: generating a fresh
    // key here produces an AAB Play rejects, and the app can never be updated from that key.
    const msg = keystoreRefusal(KS, never, 'project.user.json');
    expect(msg).toContain(KS.storeFile);
    expect(msg).toMatch(/copy the SAME/i);
  });

  it('names the GITIGNORED per-machine file, never the committed one', () => {
    // The sibling iOS refusal shipped naming project.config.json and sent readers to edit a file
    // that structurally cannot hold the value.
    const msg = keystoreRefusal(DEFAULT_PROJECT_USER_CONFIG.keystore, always, 'games/court/project.user.json');
    expect(msg).toContain('games/court/project.user.json');
    expect(msg).not.toContain('project.config.json');
  });
});

describe('renderKeystoreProperties', () => {
  it('emits the four keys java.util.Properties needs', () => {
    const out = renderKeystoreProperties(KS);
    expect(out).toContain(`storeFile=${KS.storeFile}`);
    expect(out).toContain('storePassword=store-pw');
    expect(out).toContain('keyAlias=upload');
    expect(out).toContain('keyPassword=key-pw');
  });

  it('DOUBLES backslashes — a Windows path or password would corrupt on load otherwise', () => {
    // `Properties.load` reads `\` as an escape, so `C:\keys\up.jks` arrives as `C:keysup.jks` and
    // Gradle fails with a file-not-found naming a path nobody typed.
    const out = renderKeystoreProperties({ ...KS, storeFile: 'C:\\keys\\up.jks', storePassword: 'a\\b' });
    expect(out).toContain('storeFile=C:\\\\keys\\\\up.jks');
    expect(out).toContain('storePassword=a\\\\b');
  });

  it('trims the path and alias but NOT the passwords', () => {
    // A trailing space in a password is a legal password; silently trimming it would produce a
    // "wrong password" failure the user cannot see the cause of.
    const out = renderKeystoreProperties({ storeFile: ' /k.jks ', storePassword: 'pw ', keyAlias: ' up ', keyPassword: 'pw' });
    expect(out).toContain('storeFile=/k.jks\n');
    expect(out).toContain('keyAlias=up\n');
    expect(out).toContain('storePassword=pw \n');
  });

  it('ESCAPES a leading space in a password — Properties would swallow it', () => {
    // Found by review. `Properties.load` skips whitespace between the separator and the value, so
    // `keyPassword= pw` is read back as `pw` and Gradle reports "password was incorrect" against a
    // line that looks correct in the file. The earlier version of this test asserted the RENDERED
    // string (`keyPassword= pw`) and called it correct — it was measuring the layer above the bug.
    const out = renderKeystoreProperties({ ...KS, keyPassword: ' pw', storePassword: '  two' });
    expect(out).toContain('keyPassword=\\ pw\n');
    expect(out).toContain('storePassword=\\ \\ two\n');
  });

  it('escapes a leading TAB as \\t, which needs no positional handling', () => {
    // The `\t` ESCAPE survives in leading position — Properties skips RAW whitespace, before
    // escapes are resolved — so a tab needs the ordinary rule, not the leading-space one.
    expect(renderKeystoreProperties({ ...KS, keyPassword: '\tpw' })).toContain('keyPassword=\\tpw\n');
  });

  it('leaves a space in the MIDDLE or at the END of a value alone', () => {
    // The distinguishing case for the leading-space rule: escaping every space would be wrong and
    // would still round-trip, so a test that only checked "the value survives" could not see it.
    const out = renderKeystoreProperties({ ...KS, storePassword: 'a b ' });
    expect(out).toContain('storePassword=a b \n');
  });

  it('passes = : # ! through a VALUE unescaped — they are only special in a KEY', () => {
    const out = renderKeystoreProperties({ ...KS, storePassword: 'a=b:c#d!e' });
    expect(out).toContain('storePassword=a=b:c#d!e\n');
  });

  it('leaves non-ASCII intact — the Gradle side reads UTF-8', () => {
    // Paired with `withReader('UTF-8')` in ANDROID_SIGNING_BLOCK. `Properties.load(InputStream)`
    // decodes ISO-8859-1 by contract, which turned any non-ASCII password (or a keystore under a
    // path like /Users/…/デスクトップ/) into mojibake and a "Keystore was tampered with" failure
    // that points at the key rather than the encoding.
    const out = renderKeystoreProperties({ ...KS, storeFile: '/Users/x/デスクトップ/up.jks', storePassword: 'pä55' });
    expect(out).toContain('storeFile=/Users/x/デスクトップ/up.jks\n');
    expect(out).toContain('storePassword=pä55\n');
  });

  it('says it is generated, so nobody hand-edits a file the next build overwrites', () => {
    expect(renderKeystoreProperties(KS)).toMatch(/GENERATED/);
  });
});

describe('renderExportOptionsPlist', () => {
  it('carries the method and team through', () => {
    // ⚠️ A PLACEHOLDER, never the real Apiary id. engine/tests/** ships in the OSS snapshot, so a
    // real Team ID here is a leak `verify:publish` aborts on — and only the HUB runs that gate, so
    // it surfaces at merge time on someone else's branch. Same scar as the device-id one.
    const out = renderExportOptionsPlist({ teamId: 'ABCDE12345', method: 'app-store-connect' });
    expect(out).toContain('<key>method</key>\n\t<string>app-store-connect</string>');
    expect(out).toContain('<key>teamID</key>\n\t<string>ABCDE12345</string>');
  });

  it('pins manageAppVersionAndBuildNumber OFF', () => {
    // Xcode's default is TRUE, which lets the export rewrite CFBundleVersion — overwriting the
    // number the version heal just wrote from app.buildNumber (#199). The build then reports
    // success and ships a build number the project never chose.
    const out = renderExportOptionsPlist({ teamId: 'X', method: 'app-store-connect' });
    expect(out).toContain('<key>manageAppVersionAndBuildNumber</key>\n\t<false/>');
  });

  it('is well-formed plist for EVERY declared method', () => {
    for (const method of IOS_EXPORT_METHODS) {
      const out = renderExportOptionsPlist({ teamId: 'ABCDE12345', method });
      expect(out.startsWith('<?xml version="1.0"')).toBe(true);
      expect(out).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
      expect(out.trimEnd().endsWith('</plist>')).toBe(true);
      expect(out).toContain(`<string>${method}</string>`);
    }
  });

  it('the project default is the shipping method', () => {
    // A project whose first release build quietly produced an ad-hoc .ipa would look successful
    // and be refused by App Store Connect.
    expect(DEFAULT_PROJECT_CONFIG.build.iosExportMethod).toBe('app-store-connect');
    expect(IOS_EXPORT_METHODS).toContain(DEFAULT_PROJECT_CONFIG.build.iosExportMethod);
  });
});

describe('androidReleaseSteps', () => {
  const steps = androidReleaseSteps({ androidCwd: '/p', buildCwd: '/r', env: { JAVA_HOME: '/jdk' }, ota: false });

  it('builds the AAB *and* a release-signed APK in one gradle run', () => {
    // The APK is not redundant: it is the only way to `adb install` and actually TEST the release
    // signing certificate, which #360's Google Sign-In matches on. A debug build cannot.
    expect(steps[0].cmd).toContain('bundleRelease');
    expect(steps[0].cmd).toContain('assembleRelease');
    expect(steps[0].cmd?.match(/gradlew/g)?.length).toBe(1);
  });

  it('never runs a debug task', () => {
    for (const s of steps) expect(s.cmd).not.toMatch(/assembleDebug|installDebug/);
  });

  it('installs nothing and touches no device', () => {
    // The whole point of the variant. An `adb` here would resurrect the device coupling the
    // release path exists to shed — and would fail on a machine with no phone attached.
    for (const s of steps) expect(s.cmd).not.toMatch(/\badb\b|devicectl|go-ios/);
  });

  it('carries JAVA_HOME through and stays --no-daemon (Windows file locks)', () => {
    expect(steps[0].env).toEqual({ JAVA_HOME: '/jdk' });
    expect(steps[0].cmd).toContain('--no-daemon');
    expect(steps[0].winCmd).toContain('--no-daemon');
  });

  it('has a Windows command for every step that has a POSIX one', () => {
    // `gradlew` vs `gradlew.bat` and `open` vs `start` — a missing winCmd is a step that runs the
    // POSIX string on cmd.exe and fails with a shell error that names nothing useful.
    for (const s of steps) expect(s.winCmd, `${s.label} needs a winCmd`).toBeTruthy();
  });

  it('cleans first only for an OTA project (the asset-merge staleness gotcha)', () => {
    expect(steps[0].cmd).not.toContain('clean');
    const ota = androidReleaseSteps({ androidCwd: '/p', buildCwd: '/r', env: {}, ota: true });
    expect(ota[0].cmd).toContain('clean');
  });
});

describe('iosReleaseSteps', () => {
  const steps = iosReleaseSteps({ iosCwd: '/p', iosXcodeTarget: '-project ios/App/App.xcodeproj' });

  it('CLEARS the previous archive + export before archiving', () => {
    // Nothing else does. `-exportArchive` refuses a non-empty exportPath, and a failed export after
    // a successful archive would otherwise leave the PREVIOUS run's .ipa in place — looking exactly
    // like the artifact of the run that just finished. Both paths are inside the gitignored
    // ios/App/build/, so the rm cannot reach anything tracked.
    expect(steps[0].cmd).toMatch(/^rm -rf /);
    expect(steps[0].cmd).toContain(JSON.stringify(IOS_ARCHIVE_PATH));
    expect(steps[0].cmd).toContain(JSON.stringify(IOS_EXPORT_DIR));
    for (const p of [IOS_ARCHIVE_PATH, IOS_EXPORT_DIR]) expect(p.startsWith('ios/App/build/')).toBe(true);
  });

  it('archives Release for a generic device, then exports', () => {
    expect(steps[1].cmd).toContain('-configuration Release');
    expect(steps[1].cmd).toContain("-destination 'generic/platform=iOS'");
    expect(steps[1].cmd).toMatch(/\barchive\b/);
    expect(steps[2].cmd).toContain('-exportArchive');
  });

  it('never builds Debug, and never targets a specific device id', () => {
    // `-destination 'id=…'` is the debug path. A release archive that pinned a UDID would refuse
    // to run without that exact phone plugged in.
    for (const s of steps) {
      expect(s.cmd).not.toContain('-configuration Debug');
      expect(s.cmd).not.toMatch(/-destination 'id=/);
    }
  });

  it('passes -allowProvisioningUpdates to BOTH commands', () => {
    // The export re-signs, so it needs the distribution profile as much as the archive does —
    // without the flag it fails with a profile error that reads like a code problem.
    expect(steps[1].cmd).toContain('-allowProvisioningUpdates');
    expect(steps[2].cmd).toContain('-allowProvisioningUpdates');
  });

  it('the export reads the archive the archive step WROTE, and the options file we generate', () => {
    // Two paths that must agree across two commands — the exact thing named constants exist for.
    expect(steps[1].cmd).toContain(JSON.stringify(IOS_ARCHIVE_PATH));
    expect(steps[2].cmd).toContain(JSON.stringify(IOS_ARCHIVE_PATH));
    expect(steps[2].cmd).toContain(JSON.stringify(IOS_EXPORT_OPTIONS_PATH));
    expect(steps[2].cmd).toContain(JSON.stringify(IOS_EXPORT_DIR));
  });

  it('honours an xcworkspace target (a CocoaPods project) unchanged', () => {
    const ws = iosReleaseSteps({ iosCwd: '/p', iosXcodeTarget: '-workspace ios/App/App.xcworkspace' });
    expect(ws[1].cmd).toContain('-workspace ios/App/App.xcworkspace');
  });
});

describe('artifact paths', () => {
  it('the generated iOS files live under a path ios/.gitignore already covers', () => {
    // Both carry private values — the Apple Team ID is a PRIVATE_BUILD_FIELDS value. Every
    // project's ios/.gitignore ignores `App/build`, so anything under ios/App/build/ is safe;
    // moving either of these out of that directory would make the next build stage a leak.
    expect(IOS_EXPORT_OPTIONS_PATH.startsWith('ios/App/build/')).toBe(true);
    expect(IOS_ARCHIVE_PATH.startsWith('ios/App/build/')).toBe(true);
    expect(IOS_EXPORT_DIR.startsWith('ios/App/build/')).toBe(true);
  });

  it('the Android artifacts are the real Gradle output paths', () => {
    expect(ANDROID_AAB_PATH).toBe('android/app/build/outputs/bundle/release/app-release.aab');
    expect(ANDROID_RELEASE_APK_PATH).toBe('android/app/build/outputs/apk/release/app-release.apk');
  });
});

describe('debugBuildReleaseWarning', () => {
  it('is silent when the flag is off', () => {
    expect(debugBuildReleaseWarning(false)).toBeNull();
  });

  it('warns — and names device_eval — when the flag is on', () => {
    // WARN, not refuse: #112's owner decision, because a deliberately instrumented tester build is
    // a real thing to want. But it must say what is actually being shipped.
    const w = debugBuildReleaseWarning(true);
    expect(w).toBeTruthy();
    expect(w).toContain('device_eval');
  });
});

describe('renderKeystoreProperties — ROUND-TRIP through a real JVM', () => {
  // ⚠️ Every other test in this file asserts the RENDERED STRING — i.e. the author's model of what
  // `java.util.Properties` does. That cannot tell "the model is correct" from "the output matches
  // the model", and it is exactly how the leading-space bug and then the leading-form-feed bug both
  // survived a green suite. This test parses the generated file with the real parser Gradle uses.
  //
  // SKIPPED without a JDK — the escape table is a Java fact, and a machine with no Java cannot
  // verify it. A skip is reported as a skip, never as a pass (the repo's `test:native` rule).
  const javaHome = process.env.JAVA_HOME;
  const javaBin = javaHome ? path.join(javaHome, 'bin', 'java') : 'java';
  const haveJava = (() => {
    try { return spawnSync(javaBin, ['-version'], { encoding: 'utf8' }).status === 0; } catch { return false; }
  })();

  const roundTrip = (ks: Parameters<typeof renderKeystoreProperties>[0]): Record<string, string> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-props-'));
    try {
      // UTF-8 + withReader, mirroring ANDROID_SIGNING_BLOCK exactly. Reading it any other way here
      // would test a contract the generated Gradle does not use.
      fs.writeFileSync(path.join(dir, 'k.properties'), renderKeystoreProperties(ks), 'utf8');
      const src = path.join(dir, 'RT.java');
      fs.writeFileSync(src, `
import java.io.*; import java.nio.charset.StandardCharsets; import java.util.*;
public class RT { public static void main(String[] a) throws Exception {
  Properties p = new Properties();
  try (Reader r = new InputStreamReader(new FileInputStream(a[0]), StandardCharsets.UTF_8)) { p.load(r); }
  StringBuilder sb = new StringBuilder();
  for (String k : new String[]{"storeFile","storePassword","keyAlias","keyPassword"}) {
    for (char c : p.getProperty(k, "").toCharArray()) sb.append((int) c).append(',');
    sb.append('\\n');
  }
  System.out.print(sb);
} }`);
      const r = spawnSync(javaBin, [src, path.join(dir, 'k.properties')], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`java failed: ${r.stderr}`);
      // Codepoints, not text — so a swallowed leading space or a mojibake'd character is visible
      // rather than eyeballed.
      const [sf, sp, ka, kp] = r.stdout.split('\n');
      const dec = (line: string) => String.fromCharCode(...line.split(',').filter(Boolean).map(Number));
      return { storeFile: dec(sf), storePassword: dec(sp), keyAlias: dec(ka), keyPassword: dec(kp) };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  it.runIf(haveJava)('every value survives byte-exact, including the ones that bit us', () => {
    const cases = [
      { name: 'plain', v: 'simple-pw' },
      { name: 'leading space', v: ' pw' },
      { name: 'two leading spaces', v: '  pw' },
      { name: 'leading tab', v: '\tpw' },
      { name: 'leading form feed', v: '\fpw' },
      { name: 'tab then space', v: '\t pw' },
      { name: 'all spaces', v: '   ' },
      { name: 'trailing space', v: 'pw ' },
      { name: 'backslash', v: 'a\\b' },
      { name: 'leading backslash', v: '\\pw' },
      { name: 'separators in a value', v: 'a=b:c#d!e' },
      { name: 'non-ASCII', v: 'pä55—ワード' },
    ];
    for (const { name, v } of cases) {
      const out = roundTrip({ storeFile: '/k.jks', storePassword: v, keyAlias: 'upload', keyPassword: v });
      expect(out.storePassword, `storePassword: ${name}`).toBe(v);
      expect(out.keyPassword, `keyPassword: ${name}`).toBe(v);
    }
  });

  it.runIf(haveJava)('a non-ASCII keystore PATH survives — the UTF-8 half of the contract', () => {
    // The reason ANDROID_SIGNING_BLOCK uses withReader('UTF-8'): Properties.load(InputStream)
    // decodes ISO-8859-1, so this path came back mojibake and Gradle reported a missing file.
    const p = '/Users/x/デスクトップ/com.example-upload.jks';
    expect(roundTrip({ storeFile: p, storePassword: 'x', keyAlias: 'upload', keyPassword: 'x' }).storeFile).toBe(p);
  });

  it('reports honestly when there is no JDK to verify against', () => {
    // A guard that silently vanishes is worse than one that is absent — this makes the skip visible
    // in the run rather than leaving 2 tests quietly missing.
    if (!haveJava) console.warn('[releaseBuild] JVM round-trip SKIPPED — no java on PATH/JAVA_HOME');
    expect(typeof haveJava).toBe('boolean');
  });
});
