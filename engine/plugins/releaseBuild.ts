/** Release build paths — Android upload-signed AAB, iOS archive + export (#370).
 *
 *  Until this existed the native pipeline was **dev-install-only on both platforms**: Android ran
 *  `assembleDebug` + `adb install`, iOS ran `xcodebuild -configuration Debug` + a device install,
 *  and no project set a `signingConfig`. Nothing shippable had ever come out of it.
 *
 *  ## Why a `variant`, and not two more `BUILD_PLATFORMS` values
 *
 *  A release build differs from a debug one in exactly two places — the step list, and whether a
 *  target DEVICE is required. Everything else the `/api/build` handler does (preflight, native
 *  scaffold, icon generation, `cap sync`, the Capacitor dep heal, the version/build-number heal,
 *  the Team ID discovery) is identical and is written as `platform === 'ios' | 'android'` in a
 *  dozen places. Adding `'ios-release'`/`'android-release'` to the platform union would fork every
 *  one of those, and each fork is a chance to leave the release path out of a check that the debug
 *  path gets — which is the wrong direction for the build that actually ships.
 *
 *  ## The two traps this file exists to make impossible
 *
 *  1. **An unsigned release artifact.** Gradle happily builds a release AAB with no signing config
 *     and reports success; Play then rejects it at UPLOAD time ("signed in debug mode"), long after
 *     the build looked fine. So a release Android build REFUSES when the upload key is not
 *     configured, naming what to set — see {@link keystoreRefusal}.
 *  2. **A version number Xcode silently rewrites.** `manageAppVersionAndBuildNumber` defaults to
 *     TRUE in `-exportArchive`, which lets Xcode bump `CFBundleVersion` on its own — overwriting
 *     the value `resolveBuildNumber` just healed in from `app.buildNumber` (#199) and breaking the
 *     "one place decides the build number" contract. {@link renderExportOptionsPlist} pins it off.
 *
 *  Everything here is PURE (string in, string out) so the whole decision surface is testable
 *  without a keystore, an Apple account, or a phone — see
 *  `engine/tests/plugins/releaseBuild.test.ts`. The wiring lives in `vite-asset-scanner.ts`.
 */

import type { BuildStep } from './buildStepShell';

/** The `/api/build?variant=` values. `debug` is the historical behaviour and the DEFAULT — an
 *  omitted `variant` must keep meaning exactly what it meant before this existed, or every caller
 *  that predates it (the Build menu's device rows, `modoki_build`, the e2e specs) silently starts
 *  producing store artifacts. */
export const BUILD_VARIANTS = ['debug', 'release'] as const;
export type BuildVariant = typeof BUILD_VARIANTS[number];

/** Parse the `variant` query param. An ABSENT param is `debug` (see {@link BUILD_VARIANTS}); an
 *  unrecognised one is an error rather than a fallback, for #40's reason — a typo'd `variant=relase`
 *  must never quietly produce the other kind of build. */
export function parseBuildVariant(raw: string | null | undefined):
  | { ok: true; variant: BuildVariant }
  | { ok: false; message: string } {
  if (raw == null || raw === '') return { ok: true, variant: 'debug' };
  if ((BUILD_VARIANTS as readonly string[]).includes(raw)) return { ok: true, variant: raw as BuildVariant };
  return { ok: false, message: `variant must be ${BUILD_VARIANTS.join(' or ')} (omit it for debug)` };
}

/** The Android upload key, as stored in the gitignored `project.user.json` (`user.keystore`). */
export interface KeystoreConfig {
  storeFile: string;
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
}

// `IOS_EXPORT_METHODS` lives in project-config.ts with the other config unions (WEB_DEPLOY_MODES,
// PLAYABLE_NETWORKS) so the coercion in `mergeProjectConfig` can reach it — re-exported here
// because this module is where the value is CONSUMED.
export { IOS_EXPORT_METHODS, type IosExportMethod } from '../project-config';
import type { IosExportMethod } from '../project-config';

/** Why a release Android build must not start, or null when it may.
 *
 *  Checked BEFORE gradle runs, because the failure it prevents is not a build failure: an
 *  unconfigured signing block produces a release AAB that builds clean, installs nowhere useful,
 *  and is refused by Play at upload. `exists` is injected (rather than calling `fs` here) to keep
 *  this pure — the caller passes `fs.existsSync`.
 *
 *  The message names `project.user.json` explicitly. That file is GITIGNORED and per-machine, and
 *  the sibling iOS refusal learned the hard way that naming the committed file instead sends the
 *  reader to edit something that cannot hold the value. */
export function keystoreRefusal(
  ks: KeystoreConfig,
  exists: (p: string) => boolean,
  userConfigPath: string,
): string | null {
  const storeFile = ks.storeFile.trim();
  const missing: string[] = [];
  if (!storeFile) missing.push('storeFile');
  if (!ks.storePassword) missing.push('storePassword');
  if (!ks.keyAlias.trim()) missing.push('keyAlias');
  if (!ks.keyPassword) missing.push('keyPassword');
  if (missing.length) {
    return `No Android upload key configured — ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty in ` +
      `${userConfigPath} (user.keystore). A release AAB MUST be signed with the upload key Play knows: ` +
      'an unsigned or debug-signed bundle builds fine and is then rejected at upload. ' +
      'Set it in Project Settings → Build → Android release signing, or create a key with ' +
      '`keytool -genkeypair -v -keystore ~/.modoki/keystores/<appId>-upload.jks -alias upload ' +
      '-keyalg RSA -keysize 2048 -validity 10000`. ' +
      '⚠️ The upload key is ONE key across every machine — copy the .jks to a second machine, ' +
      'never generate a second one, or Play refuses the upload.';
  }
  if (!exists(storeFile)) {
    return `Android upload keystore not found at ${storeFile} (user.keystore.storeFile in ${userConfigPath}). ` +
      'If this machine is a fresh clone, copy the SAME .jks across rather than generating a new one — ' +
      'Play matches the AAB against the key the app was enrolled with and rejects any other.';
  }
  return null;
}

/** Render `android/keystore.properties` — the file the Gradle signing block reads.
 *
 *  Regenerated from `project.user.json` before every release build rather than hand-maintained, so
 *  there is ONE place the upload key is configured. The file itself is gitignored (the `.gitignore`
 *  sweep in this change uncommented the `*.jks`/`*.keystore` lines every project's Android
 *  `.gitignore` template ships COMMENTED OUT, and added this filename).
 *
 *  ## Escaping — what `java.util.Properties` does to a VALUE
 *
 *  Three rules, and each one has bitten something:
 *   - `\` starts an escape, so a Windows path (`C:\keys\up.jks`) or a backslash in a password
 *     arrives with the backslashes eaten. Doubled here.
 *   - A literal newline/CR/tab would split or truncate the entry. Escaped.
 *   - **Whitespace between the separator and the value is SKIPPED** — `Properties.load0` tests
 *     `' ' | '\t' | '\f'` — so a password that legitimately begins with a space or form feed is
 *     silently read back without it — and the failure surfaces as
 *     "password was incorrect" against a value that looks right in the file. The leading run is
 *     escaped character-by-character to survive. (A TRAILING space needs no escape and is kept.)
 *
 *  `=`, `:`, `#` and `!` need no escaping in a value position — they are only special in a KEY, and
 *  every key here is a fixed ASCII literal.
 *
 *  ⚠️ The file is written UTF-8, so the Gradle side MUST read it with `withReader('UTF-8')` —
 *  `Properties.load(InputStream)` decodes ISO-8859-1 by contract and would mangle any non-ASCII
 *  password or path. Those two decisions are one contract; see `ANDROID_SIGNING_BLOCK` in
 *  ./healNativeConfig.ts. */
export function renderKeystoreProperties(ks: KeystoreConfig): string {
  // A single left-to-right scan rather than chained `replaceAll`s: the leading-space rule depends
  // on position, and layering a positional regex on top of already-escaped output is how you end up
  // re-escaping a `\t` you just produced.
  const esc = (v: string) => {
    let out = '';
    let leading = true; // still inside the run of spaces Properties would swallow
    for (const ch of v) {
      switch (ch) {
        case '\\': out += '\\\\'; leading = false; break;
        case '\n': out += '\\n'; leading = false; break;
        case '\r': out += '\\r'; leading = false; break;
        // A TAB is emitted as the `\t` ESCAPE, which Properties keeps even in leading position —
        // the skip applies to raw whitespace, before escapes are resolved. So it needs no
        // positional special case; a raw leading SPACE does.
        case '\t': out += '\\t'; leading = false; break;
        // ' ' and '\f' are the two RAW characters Properties.load0 skips at value start (alongside
        // tab, which the '\t' escape above already survives). The form feed was missed on the first
        // pass and found by round-tripping through a real JVM — not by reasoning about the table.
        case ' ': out += leading ? '\\ ' : ' '; break;
        case '\f': out += leading ? '\\\f' : '\f'; break;
        default: out += ch; leading = false; break;
      }
    }
    return out;
  };
  return [
    '# GENERATED by the Modoki release build from project.user.json (user.keystore) — do not edit.',
    '# Gitignored: it holds the upload key passwords. Regenerated on every release build.',
    `storeFile=${esc(ks.storeFile.trim())}`,
    `storePassword=${esc(ks.storePassword)}`,
    `keyAlias=${esc(ks.keyAlias.trim())}`,
    `keyPassword=${esc(ks.keyPassword)}`,
    '',
  ].join('\n');
}

/** Render the `-exportOptionsPlist` file for `xcodebuild -exportArchive`.
 *
 *  ⚠️ This file contains the Apple Team ID, which is a `PRIVATE_BUILD_FIELDS` value (see
 *  ../project-config.ts) — so it
 *  is written under `ios/App/build/`, which every project's `ios/.gitignore` already ignores. Do
 *  not move it somewhere tracked: `verify:publish` is the backstop, not the defence. */
export function renderExportOptionsPlist(o: { teamId: string; method: IosExportMethod }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<!-- GENERATED by the Modoki release build — do not edit; regenerated every run. -->
\t<key>method</key>
\t<string>${o.method}</string>
\t<key>teamID</key>
\t<string>${o.teamId}</string>
\t<key>destination</key>
\t<string>export</string>
\t<key>signingStyle</key>
\t<string>automatic</string>
\t<key>uploadSymbols</key>
\t<true/>
\t<!-- OFF deliberately. The default is TRUE, which lets Xcode rewrite CFBundleVersion during
\t     export — silently overwriting the value the version heal just wrote from app.buildNumber
\t     (#199), so the number you set in Project Settings is not the number that ships. -->
\t<key>manageAppVersionAndBuildNumber</key>
\t<false/>
</dict>
</plist>
`;
}

/** Where a release build's artifacts land, relative to the project root. Named once so the build
 *  step, the "reveal" step and the success message cannot drift apart. */
export const ANDROID_AAB_PATH = 'android/app/build/outputs/bundle/release/app-release.aab';
export const ANDROID_RELEASE_APK_PATH = 'android/app/build/outputs/apk/release/app-release.apk';
export const IOS_ARCHIVE_PATH = 'ios/App/build/App.xcarchive';
export const IOS_EXPORT_DIR = 'ios/App/build/ipa';
export const IOS_EXPORT_OPTIONS_PATH = 'ios/App/build/exportOptions.plist';

/** The Android release step list: sign-configured gradle → AAB **and** release APK → reveal.
 *
 *  Both artifacts, deliberately. The AAB is what Play takes; the release-signed APK is the only way
 *  to `adb install` and TEST the thing that ships — and for #370's sibling #360 that is not
 *  optional, because Google Sign-In matches on the signing certificate and a debug build cannot
 *  exercise the release cert at all. One gradle invocation builds both.
 *
 *  `--no-daemon` for the same reason as the debug leg (a lingering daemon locks the provisioned
 *  JDK's files on Windows). */
export function androidReleaseSteps(o: {
  androidCwd: string;
  buildCwd: string;
  env: Record<string, string>;
  ota: boolean;
}): BuildStep[] {
  const clean = o.ota ? 'clean ' : '';
  const outputs = 'android/app/build/outputs';
  return [
    {
      label: 'Building signed AAB + release APK...',
      cmd: `android/gradlew -p android ${clean}bundleRelease assembleRelease --no-daemon`,
      winCmd: `android\\gradlew.bat -p android ${clean}bundleRelease assembleRelease --no-daemon`,
      env: o.env,
      cwd: o.androidCwd,
    },
    {
      label: 'Revealing release artifacts...',
      cmd: `open ${JSON.stringify(outputs)}`,
      winCmd: `start "" "${outputs}"`,
      cwd: o.androidCwd,
    },
  ];
}

/** The iOS release step list: archive → export → reveal. No device is involved at any point, which
 *  is why the caller must skip the `iosDeviceId` requirement for this variant — a release build
 *  targets `generic/platform=iOS`, and demanding a plugged-in phone to produce an App Store IPA
 *  would be a refusal with no cause.
 *
 *  `-allowProvisioningUpdates` on BOTH commands: the export re-signs, so it needs the distribution
 *  profile just as much as the archive does, and without the flag it fails with a profile error
 *  that reads like a code problem. */
export function iosReleaseSteps(o: {
  iosCwd: string;
  iosXcodeTarget: string;
}): BuildStep[] {
  return [
    {
      // Clear BOTH outputs first. `-exportArchive` refuses to overwrite, and an archive directory
      // left by a previous run is a real hazard on a path where the whole product is "the newest
      // file in this folder": a failed export after a successful archive would otherwise leave the
      // PREVIOUS run's .ipa sitting there, looking like the artifact of the run that just finished.
      // Both paths are inside `ios/App/build/`, which is gitignored and holds nothing else of ours.
      label: 'Clearing previous archive/export...',
      cmd: `rm -rf ${JSON.stringify(IOS_ARCHIVE_PATH)} ${JSON.stringify(IOS_EXPORT_DIR)}`,
      cwd: o.iosCwd,
    },
    {
      label: 'Archiving (Release)...',
      cmd: `xcodebuild ${o.iosXcodeTarget} -scheme App -configuration Release ` +
        `-destination 'generic/platform=iOS' -archivePath ${JSON.stringify(IOS_ARCHIVE_PATH)} ` +
        '-allowProvisioningUpdates archive',
      cwd: o.iosCwd,
    },
    {
      label: 'Exporting .ipa...',
      cmd: `xcodebuild -exportArchive -archivePath ${JSON.stringify(IOS_ARCHIVE_PATH)} ` +
        `-exportOptionsPlist ${JSON.stringify(IOS_EXPORT_OPTIONS_PATH)} ` +
        `-exportPath ${JSON.stringify(IOS_EXPORT_DIR)} -allowProvisioningUpdates`,
      cwd: o.iosCwd,
    },
    {
      label: 'Revealing .ipa...',
      cmd: `open ${JSON.stringify(IOS_EXPORT_DIR)}`,
      cwd: o.iosCwd,
    },
  ];
}

/** The warning a release build prints when `build.debugBuild` is ON.
 *
 *  WARN, not refuse — the same call #112 made for the archive-time build phases, and for the same
 *  reason: a deliberate debug-instrumented release (a profiling build handed to a tester) is a real
 *  thing to want, and refusing it would leave no way to make one. Returns null when the flag is off.
 *
 *  It is worth saying loudly, though: `debugBuild` ships the event journal, the in-game debug menu
 *  and the debug bridge — which includes `device_eval`, i.e. arbitrary JS execution on the device —
 *  into a build headed for a store. */
export function debugBuildReleaseWarning(debugBuild: boolean): string | null {
  if (!debugBuild) return null;
  return '⚠️  build.debugBuild is ON for a RELEASE build. This ships the event journal, the in-game ' +
    'debug menu and the debug bridge — including device_eval (arbitrary JS on the device) — inside ' +
    'the artifact. Turn it off in Project Settings → Build before uploading to a store, unless this ' +
    'is deliberately an instrumented tester build.';
}
