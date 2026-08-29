/** Heal-on-open for a project's native config — the machine-local / derivable
 *  bits that a fresh `cap add` (or a fresh clone/worktree) leaves missing, so
 *  opening a project that owns native folders "just works" without a manual
 *  checklist. Deterministic + idempotent; only writes when something is missing
 *  or detectably wrong, never clobbering hand edits.
 *
 *  Heals:
 *   - android/local.properties  → sdk.dir (gitignored, machine-specific). Without
 *     it Gradle fails "SDK location not found".
 *   - iOS DEVELOPMENT_TEAM       → from project.config.json build.appleTeamId
 *     (a fresh `cap add ios` sets none → device builds can't auto-sign).
 *
 *  NOT healed here: capacitor.config.json (committed, rarely drifts) and the
 *  `cap add` scaffold itself (a heavy, deliberate one-time action — see the
 *  "Add Native Target" Build action). User-supplied secrets (Firebase configs)
 *  are detected + surfaced, not synthesized. */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadProjectConfig } from './load-project-config';
import { detect as detectTool } from '../toolchain';
import type { ProjectConfig } from '../project-config';

export interface HealResult {
  /** Human-readable notes on what was healed (for the console / status). */
  notes: string[];
}

/** The GameDebugPlugin registration inside MyViewController.viewDidLoad, fenced by
 *  marker comments so the heal can rewrite exactly its own code and never touch a
 *  hand edit around it (games/ota-test extends the same file with an OTA boot hook).
 *  Generated from `build.debugBuild` — see {@link healIosGameDebugRegistration}. */
const GD_REG_BEGIN = '        // modoki:game-debug-begin — generated from project.config.json (build.debugBuild)';
const GD_REG_END = '        // modoki:game-debug-end';

/** The ON form: register the plugin, so its TCP server is reachable from JS. */
const GD_REG_ON = [
  GD_REG_BEGIN,
  '        let gameDebugPlugin = GameDebugPlugin()',
  '        bridge?.registerPluginInstance(gameDebugPlugin)',
  '        print("[MyViewController] GameDebugPlugin registered: \\(gameDebugPlugin)")',
  GD_REG_END,
].join('\n');

/** The OFF form: markers kept (so re-enabling finds its anchor) with no registration.
 *  Unregistered means JS can never call `startServer`, so the TCP server never binds
 *  and `handleEval` is unreachable — the class is still linked into the binary (its
 *  pbxproj file-ref is unconditional), it simply has no way in. */
const GD_REG_OFF = [
  GD_REG_BEGIN,
  '        // build.debugBuild is OFF — GameDebugPlugin is deliberately NOT registered, so',
  '        // Capacitor exposes no way to reach its TCP server or handleEval. Turn it on in',
  '        // Project Settings → Developer ("Debug build") and reopen the project.',
  GD_REG_END,
].join('\n');

/** The pre-#112 registration block: gated on `#if DEBUG` (the XCODE CONFIGURATION)
 *  rather than on the project flag. Matched so the heal can migrate an existing
 *  project's file to the fenced form exactly once. Anchored on `GameDebugPlugin()`
 *  so it can never swallow an unrelated `#if DEBUG` a game has added. */
const LEGACY_GD_REG_RE = /[ \t]*#if DEBUG\r?\n[\s\S]*?GameDebugPlugin\(\)[\s\S]*?[ \t]*#endif[ \t]*\r?\n/;

/** The stale doc sentence that asserted the OLD guarantee ("never ship in a release
 *  build"), which stops being true once the gate is the project flag. Replaced in place
 *  so an existing project's generated file stops claiming it. */
const STALE_DEBUG_ONLY_DOC = /^\/\/\/ DEBUG-only: the TCP debug server \+ Bonjour never ship in a release build\.$/m;
const FRESH_DEBUG_ONLY_DOC = [
  '/// The registration below is GENERATED from `project.config.json` `build.debugBuild`,',
  "/// NOT from the Xcode configuration — so a Release-configuration build CAN carry the",
  '/// bridge when the flag is on (debugging an optimized build / a TestFlight QA build).',
].join('\n');

/** The custom bridge VC that keeps GameDebugPlugin alive. A fresh `cap add ios`
 *  scaffolds no such file — SPM static linking strips a plugin class with no
 *  external SDK dependency, so Capacitor never sees it ("GameDebug plugin is not
 *  implemented on ios"). Compiling the plugin straight into the App target (via a
 *  pbxproj file-ref) + registering the instance here keeps it discoverable.
 *  The registration itself is gated on `build.debugBuild`, not on `#if DEBUG`. */
const myViewControllerSwift = (debugBuild: boolean) => `import UIKit
import Capacitor

/// Custom bridge VC so we can register plugins that SPM won't auto-discover.
///
/// \`GameDebugPlugin\` (capacitor-game-debug) is compiled straight into the App
/// target via a project-relative pbxproj file reference — NOT via SPM — because the
/// SPM static linker strips a plugin class that has no external SDK dependency, so
/// Capacitor never sees it ("GameDebug plugin is not implemented on ios"). Manually
/// registering the instance here keeps the class alive and wires it into the bridge.
${FRESH_DEBUG_ONLY_DOC}
class MyViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
${debugBuild ? GD_REG_ON : GD_REG_OFF}
    }
}
`;

/** Fixed synthetic pbxproj UUIDs for the game-debug wiring. They're clearly not
 *  Xcode-minted (all-zero body) so they never collide with the template's, and
 *  reusing them keeps the heal idempotent + the diff stable. */
const GD_UUID = {
  mvcFileRef: 'DD0000000000000000000001',
  mvcBuildFile: 'DD0000000000000000000002',
  pluginFileRef: 'DD0000000000000000000003',
  pluginBuildFile: 'DD0000000000000000000004',
  /** RETIRED (#112) — the Release Info.plist-strip phase. Kept reserved rather than
   *  recycled: `healIosRemoveReleaseStripPhase` deletes the phase by NAME, and a
   *  project that has not been reopened since still carries this UUID. */
  stripPhase: 'DD0000000000000000000005',
  /** The archive-time "Debug build is ON" warning phase (#112 Phase 2). */
  archiveWarnPhase: 'DD0000000000000000000006',
  /** The Crashlytics dSYM upload phase (#279). The value matches the UUID Court's pbxproj was
   *  hand-edited with in #275, so healing that project REPLACES its phase rather than adding a
   *  second one beside it. */
  dsymUploadPhase: 'DD0000000000000000000007',
} as const;

/** RETIRED (#112) — the Release Info.plist-strip build phase. It deleted the two
 *  debug-only Local Network keys from the BUILT Info.plist whenever
 *  `CONFIGURATION == Release`, which made the Xcode configuration a second, competing
 *  answer to "is this a debug build?": with `debugBuild: true` and a Release
 *  configuration the bridge shipped but its plist keys were stripped, so it could not
 *  reach the LAN and nothing said why.
 *
 *  The keys are now a pure function of `build.debugBuild`, written into the SOURCE
 *  plist by {@link healIosLocalNetwork} in both directions — so a build-time script
 *  that re-derives them from the configuration is exactly the duplicate source of
 *  truth #112 removes. This matcher exists only to DELETE the phase from a project
 *  that still carries it; it can go once every native project has been reopened. */
const LEGACY_STRIP_PHASE_NAME = 'Strip debug-only Info.plist keys';

/** The archive-time warning phase name — also the matcher used to add/remove it.
 *  ⚠️ NO DOUBLE QUOTES in this or {@link ARCHIVE_WARN_TEXT}: both are embedded inside
 *  pbxproj quoted strings, and the inner one lands inside a shell `echo "…"` inside
 *  that — three levels of quoting, where an unescaped `"` silently corrupts the
 *  project file. Single quotes read the same to a human and cannot bite. */
const ARCHIVE_WARN_PHASE_NAME = "Warn: Modoki 'Debug build' is ON";

/** The one-line message both platforms print. Names the SETTING a human can act on,
 *  never the internal constant, and does not claim to have prevented anything. */
const ARCHIVE_WARN_TEXT =
  "Modoki: this build has 'Debug build' ON (Project Settings -> Developer). " +
  'It ships the debug bridge, which can eval arbitrary JS on the device. ' +
  'That is expected for a TestFlight/QA build - turn it OFF for a store release.';

/** The archive-time warning build phase (#112 Phase 2). Present only while the flag is
 *  ON; `healIosArchiveWarning` removes it when the flag goes off, so its mere presence
 *  is itself a signal.
 *
 *  ⚠️ Gated on `ACTION == install` (archive/export), NOT on `CONFIGURATION == Release`.
 *  `debugBuild:true` + a Release configuration is the exact combination #112 exists to
 *  make WORK — debugging an optimized build — so a CONFIGURATION gate would re-break it
 *  in a new place.
 *
 *  ⚠️ And it is a WARNING, not a failure. TestFlight builds here run with the flag on,
 *  and a TestFlight archive is bit-identical to a store archive (same `xcodebuild
 *  archive`, same `method: app-store-connect` export — release-to-store is a button in
 *  App Store Connect afterwards). There is no build-time signal to refuse on that would
 *  not also block the workflow in daily use. See
 *  docs/debug-tools-mcp.md § "Native Debug Bridge" (the "Debug vs Release" note). */
const ARCHIVE_WARN_PHASE_BLOCK = [
  '/* Begin PBXShellScriptBuildPhase section */',
  `\t\t${GD_UUID.archiveWarnPhase} /* ${ARCHIVE_WARN_PHASE_NAME} */ = {`,
  '\t\t\tisa = PBXShellScriptBuildPhase;',
  '\t\t\tbuildActionMask = 2147483647;',
  // Runs every build by design (gated internally on ACTION). The pbxproj form of
  // unchecking "Based on dependency analysis" — silences Xcode's "will be run during
  // every build because it does not specify any outputs" warning.
  '\t\t\talwaysOutOfDate = 1;',
  '\t\t\tfiles = (',
  '\t\t\t);',
  '\t\t\tinputPaths = (',
  '\t\t\t);',
  `\t\t\tname = "${ARCHIVE_WARN_PHASE_NAME}";`,
  '\t\t\toutputPaths = (',
  '\t\t\t);',
  '\t\t\trunOnlyForDeploymentPostprocessing = 0;',
  '\t\t\tshellPath = /bin/sh;',
  // `warning:` on stdout is what puts it in Xcode's Issue navigator, not just the log.
  `\t\t\tshellScript = "if [ \\"$\{ACTION}\\" = \\"install\\" ]; then\\n  echo \\"warning: ${ARCHIVE_WARN_TEXT}\\"\\nfi\\n";`,
  '\t\t};',
  '/* End PBXShellScriptBuildPhase section */',
  '',
].join('\n');

/** Name of the Crashlytics dSYM upload phase (#279) — matches the hand-edited phase #275 put in
 *  Court's pbxproj, which is what lets the heal replace it in place. */
const DSYM_PHASE_NAME = 'Upload Crashlytics dSYMs';

/** The dSYM upload phase, as pbxproj text.
 *
 *  Apple's `run` script ships INSIDE the firebase-ios-sdk SPM checkout, under the derived-data
 *  SourcePackages dir — hence the `${BUILD_DIR%/Build/*}` trim. A Capacitor project using
 *  CocoaPods has a Pods copy, so both are tried before giving up.
 *
 *  It narrates every skip. A dSYM upload that quietly does nothing is indistinguishable from one
 *  that worked until the day somebody reads a crash report and finds raw addresses — which is
 *  exactly what happened here: this phase existed in Court for weeks, exited early on every build,
 *  and the console accumulated 8 unprocessed crashes (#279). */
const DSYM_PHASE_BLOCK = [
  '/* Begin PBXShellScriptBuildPhase section */',
  `\t\t${GD_UUID.dsymUploadPhase} /* ${DSYM_PHASE_NAME} */ = {`,
  '\t\t\tisa = PBXShellScriptBuildPhase;',
  '\t\t\tbuildActionMask = 2147483647;',
  '\t\t\talwaysOutOfDate = 1;',
  '\t\t\tfiles = (',
  '\t\t\t);',
  '\t\t\tinputPaths = (',
  '\t\t\t\t"${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Resources/DWARF/${TARGET_NAME}",',
  '\t\t\t\t"$(SRCROOT)/$(BUILT_PRODUCTS_DIR)/$(INFOPLIST_PATH)",',
  '\t\t\t);',
  `\t\t\tname = "${DSYM_PHASE_NAME}";`,
  '\t\t\toutputPaths = (',
  '\t\t\t);',
  '\t\t\trunOnlyForDeploymentPostprocessing = 0;',
  '\t\t\tshellPath = /bin/sh;',
  '\t\t\tshellScript = "set -e\\n'
    + '# Crashlytics symbol upload (#275, generalized in #279). Without it an iOS crash report comes\\n'
    + '# back as raw addresses, which is the difference between a report and a puzzle.\\n'
    + 'RUN=\\"${BUILD_DIR%/Build/*}/SourcePackages/checkouts/firebase-ios-sdk/Crashlytics/run\\"\\n'
    + '[ -f \\"$RUN\\" ] || RUN=\\"${SRCROOT}/Pods/FirebaseCrashlytics/run\\"\\n'
    + 'if [ ! -f \\"$RUN\\" ]; then\\n'
    + '  echo \\"warning: Crashlytics dSYM upload SKIPPED - no run script found. Run \'npx cap sync ios\' and let Xcode resolve packages, or crash reports will not be symbolicated.\\"\\n'
    + '  exit 0\\n'
    + 'fi\\n'
    + '# Modoki sets dwarf-with-dsym in EVERY configuration (#279), Debug included, because Debug is\\n'
    + '# where the crash probes run. So a skip here is a defect in either configuration now, not the\\n'
    + '# expected Debug behaviour it used to be.\\n'
    + 'if [ \\"${DEBUG_INFORMATION_FORMAT}\\" != \\"dwarf-with-dsym\\" ]; then\\n'
    + '  echo \\"warning: Crashlytics dSYM upload skipped - DEBUG_INFORMATION_FORMAT is \'${DEBUG_INFORMATION_FORMAT}\', so no dSYM exists. Reopen the project so healNativeConfig can fix it.\\"\\n'
    + '  exit 0\\n'
    + 'fi\\n'
    + '\\"$RUN\\"\\n";',
  '\t\t};',
  '/* End PBXShellScriptBuildPhase section */',
  '',
].join('\n');


/** The Gradle sibling of the iOS archive warning, fenced so the heal owns only its own
 *  lines in the hand-editable `android/app/build.gradle`. Warns when the task graph
 *  contains a release assemble/bundle for `:app:` — Play's internal-testing track is
 *  the Android TestFlight, so this is a warning for the same reason. */
const ANDROID_WARN_BEGIN = '// modoki:debug-build-warning-begin — generated from project.config.json (build.debugBuild)';
const ANDROID_WARN_END = '// modoki:debug-build-warning-end';
const ANDROID_WARN_BLOCK = [
  ANDROID_WARN_BEGIN,
  'gradle.taskGraph.whenReady { graph ->',
  '    def shipping = graph.allTasks.any {',
  "        it.path.startsWith(':app:') && it.name ==~ /(assemble|bundle).*Release/",
  '    }',
  '    if (shipping) {',
  `        logger.warn("${ARCHIVE_WARN_TEXT}")`,
  '    }',
  '}',
  ANDROID_WARN_END,
].join('\n');

/** ── Android release signing (#370) ────────────────────────────────────────────────────────────
 *
 *  Until this block existed, NO project in the repo set a `signingConfig`, so a release build was
 *  signed in debug mode and Play rejected it at upload — after the build had reported success.
 *
 *  **Why it is APPENDED rather than inserted into `android { }`.** Re-opening the `android`
 *  extension later in the same script is legal Groovy-DSL and merges into the existing config
 *  (`signingConfigs`/`buildTypes` are NamedDomainObjectContainers, so naming `release` creates or
 *  configures it). Appending a fenced block therefore needs no anchor inside a file every project
 *  hand-edits — the same reason {@link ANDROID_WARN_BLOCK} appends. An inserter that had to find
 *  `buildTypes {` would bail on any project that had moved it, which is the failure mode a heal
 *  can least afford.
 *
 *  **Why it is inert without the properties file.** A fresh clone, another machine or CI has no
 *  upload key, and failing Gradle CONFIGURATION there would break `assembleDebug` for every clone
 *  that never signs anything — which is most of them. So the whole block is behind
 *  `if (file.exists())`, and a machine without a key keeps building debug exactly as before. The
 *  release path's own `keystoreRefusal` (./releaseBuild.ts) is what turns "no key" into a loud, actionable
 *  refusal, and it fires before Gradle is ever invoked. */
const ANDROID_SIGNING_BEGIN = '// modoki:release-signing-begin — generated; the key comes from project.user.json (user.keystore)';
const ANDROID_SIGNING_END = '// modoki:release-signing-end';
const ANDROID_SIGNING_BLOCK = [
  ANDROID_SIGNING_BEGIN,
  '// keystore.properties is GENERATED (and gitignored) by the release build from the per-machine',
  '// project.user.json. Nothing secret is in THIS file, so it stays committed and portable.',
  "def modokiKeystoreFile = rootProject.file('keystore.properties')",
  'if (modokiKeystoreFile.exists()) {',
  '    def modokiKeystore = new Properties()',
  '    // withReader(UTF-8), NOT withInputStream: Properties.load(InputStream) decodes ISO-8859-1',
  '    // by contract, while the generator writes UTF-8. A non-ASCII password — or a keystore path',
  '    // under a non-ASCII directory — round-trips as mojibake and Gradle then reports "Keystore',
  '    // was tampered with, or password was incorrect", which points at the key, not the encoding.',
  "    modokiKeystoreFile.withReader('UTF-8') { modokiKeystore.load(it) }",
  '    android {',
  '        signingConfigs {',
  '            release {',
  "                storeFile file(modokiKeystore['storeFile'])",
  "                storePassword modokiKeystore['storePassword']",
  "                keyAlias modokiKeystore['keyAlias']",
  "                keyPassword modokiKeystore['keyPassword']",
  '            }',
  '        }',
  '        buildTypes {',
  '            release {',
  '                // Without this a release bundle is signed in DEBUG mode, and Play rejects it',
  '                // with "You uploaded an APK or Android App Bundle that was signed in debug',
  '                // mode" — a failure that only appears at upload time.',
  '                signingConfig signingConfigs.release',
  '            }',
  '        }',
  '    }',
  '}',
  ANDROID_SIGNING_END,
].join('\n');

/** Does this project depend on the game-debug bridge? Gates every game-debug
 *  heal (Info.plist keys, iOS pbxproj wiring, Release strip) so a project that
 *  doesn't use it stays untouched. */
function usesGameDebug(projectRoot: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    return !!(pkg.dependencies?.['capacitor-game-debug'] || pkg.devDependencies?.['capacitor-game-debug']);
  } catch {
    return false;
  }
}

/** Locate the engine's GameDebugPlugin.swift by walking up from the project. The
 *  iOS wiring references it by a repo-relative pbxproj path, so this only resolves
 *  for a game developed INSIDE the modoki monorepo (games/<id>). A standalone user
 *  game (DMG, no sibling engine/) returns undefined → the wiring is skipped, which
 *  is correct: it couldn't reference the in-repo plugin anyway. */
function findEngineGameDebugSwift(projectRoot: string): string | undefined {
  const rel = 'engine/packages/capacitor-game-debug/ios/Sources/GameDebugPlugin/GameDebugPlugin.swift';
  let dir = path.resolve(projectRoot);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Resolve the GameDebugPlugin.swift to compile into the App. PREFERS the game's
 *  OWN vendored copy in node_modules — self-contained, so the pbxproj file
 *  reference resolves for a STANDALONE game (built via the DMG editor / copied out
 *  of the repo), not just an in-repo games/<id>. vendorPlugins + ensureProjectDeps
 *  populate node_modules/capacitor-game-debug on open, and the Swift is compiled
 *  into the app binary at build time, so node_modules only needs to exist then.
 *  Falls back to the in-repo engine copy for a monorepo game not yet `npm install`ed.
 *
 *  The OLD behaviour (repo-only) is exactly why a standalone iOS build failed with
 *  `"GameDebug" plugin is not implemented on ios`: no sibling engine/ → wiring
 *  skipped → the native plugin class never compiled in. */
function findGameDebugSwift(projectRoot: string): string | undefined {
  const vendored = path.join(projectRoot, 'node_modules', 'capacitor-game-debug', 'ios', 'Sources', 'GameDebugPlugin', 'GameDebugPlugin.swift');
  if (fs.existsSync(vendored)) return vendored;
  return findEngineGameDebugSwift(projectRoot);
}

/** Best-effort Android SDK location — via the shared toolchain's SINGLE candidate list
 *  (env vars → well-known dirs, validated by platform-tools). Replaces this file's former
 *  private probe, which could disagree with vite-asset-scanner's build-time probe. */
function detectAndroidSdk(): string | undefined {
  return detectTool('android-sdk').path;
}

/** The `sdk.dir=` value for local.properties. That's a Java .properties file where BACKSLASH is an
 *  ESCAPE character, so a raw Windows path (`C:\Users\…\toolchain\android-sdk`) mangles — `\t` →
 *  TAB, `\U`/`\A`/`\R` → the backslash is dropped — and Gradle dies with "The filename, directory
 *  name, or volume label syntax is incorrect". Gradle accepts forward slashes on Windows (what
 *  Android Studio itself writes), so normalize. No-op on POSIX. */
export function androidSdkDirValue(sdk: string): string {
  return sdk.replace(/\\/g, '/');
}

/** Write android/local.properties with sdk.dir if the project has an android/ folder and the file
 *  is missing OR its sdk.dir is backslash-corrupted. Returns a note if it wrote one. */
function healAndroidLocalProperties(projectRoot: string): string | undefined {
  const androidDir = path.join(projectRoot, 'android');
  if (!fs.existsSync(androidDir)) return undefined;
  const lp = path.join(androidDir, 'local.properties');
  if (fs.existsSync(lp)) {
    // Preserve an existing file (may hold a user's custom sdk.dir), EXCEPT repair the known
    // corruption: a raw BACKSLASH in sdk.dir mangles a Java .properties file (\t → TAB, \U/\A
    // dropped) → Gradle "The filename, directory name, or volume label syntax is incorrect".
    // Editor builds ≤0.2.8 wrote native Windows paths, so a project first built by one keeps a
    // broken file that a plain "skip if present" would NEVER fix — heal must repair it in place.
    if (!/^\s*sdk\.dir\s*=.*\\/m.test(fs.readFileSync(lp, 'utf8'))) return undefined; // clean → leave it
  }
  const sdk = detectAndroidSdk();
  if (!sdk) return 'android/local.properties missing and no Android SDK found (set ANDROID_HOME)';
  const sdkDir = androidSdkDirValue(sdk);
  fs.writeFileSync(lp, `sdk.dir=${sdkDir}\n`);
  return `wrote android/local.properties (sdk.dir=${sdkDir})`;
}

/** Collect the build-configuration UUIDs that belong to the App PBXNativeTarget,
 *  by reading the `buildConfigurations = ( … )` list of the XCConfigurationList
 *  whose comment names PBXNativeTarget "App". Scoping to these is what keeps the
 *  heal from clobbering a SEPARATE target's team (app extension / widget / watch),
 *  which a global rewrite would flatten. (D2) */
function appBuildConfigUUIDs(lines: string[]): Set<string> {
  const uuids = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    // Match the list DEFINITION (`… */ = {`) only, not the `buildConfigurationList
    // = <uuid> …;` reference inside PBXNativeTarget (whose forward scan could land
    // on a different target's list).
    if (!/Build configuration list for PBXNativeTarget "App" \*\/ = \{/.test(lines[i])) continue;
    let j = i;
    while (j < lines.length && !/buildConfigurations = \(/.test(lines[j])) j++;
    for (j = j + 1; j < lines.length && !/\);/.test(lines[j]); j++) {
      const m = lines[j].match(/([0-9A-Fa-f]{24})/);
      if (m) uuids.add(m[1]);
    }
  }
  return uuids;
}

/** The gitignored file that actually carries the Team ID, and the tracked one-liner that pulls it
 *  in. Both live in `ios/`, beside Capacitor's own `debug.xcconfig`. */
const IOS_LOCAL_XCCONFIG = 'modoki.local.xcconfig';
/** `#include?` — Xcode's OPTIONAL include. A missing file is not an error, which is the whole
 *  reason this shape works for a gitignored target: a fresh clone parses the xcconfig fine and
 *  simply has no team. Measured (`xcodebuild -showBuildSettings`, 3d-test, 2026-08-18): with the
 *  file absent, exit 0, zero warnings, `CAPACITOR_DEBUG` still resolves, `DEVELOPMENT_TEAM` absent. */
const IOS_XCCONFIG_INCLUDE = `#include? "${IOS_LOCAL_XCCONFIG}"`;

/** Put the Apple Team ID where git cannot reach it — a gitignored `ios/modoki.local.xcconfig`,
 *  pulled in by an optional `#include?` in the TRACKED `ios/debug.xcconfig`, with the value
 *  STRIPPED from the tracked pbxproj.
 *
 *  This closes the last hole in #172. That change moved five owner-private `build.*` values out of
 *  the committed `project.config.json`, but the Team ID has a second home the overlay could not
 *  reach: this function used to WRITE it into `ios/App/App.xcodeproj/project.pbxproj`, which is
 *  tracked. So the value went straight back into git on every project open and every iOS build, and
 *  `privateBuildFields.test.ts` could not see it (it reads project configs, not pbxproj). Four such
 *  lines sat committed in two publishable demos, green on every gate, until #228's close-out.
 *
 *  **Why an xcconfig rather than build-time injection.** `xcodebuild DEVELOPMENT_TEAM=…` would
 *  cover Modoki's own build route and nothing else — CLAUDE.md's iPhone-8 recipe deliberately hands
 *  off to Xcode for a manual ⌘R, and that build would be unsigned. The xcconfig is read by every
 *  consumer of the project: our CLI, the editor's Build route, and Xcode itself.
 *
 *  **Precedence is why the pbxproj line must GO, not be blanked.** A setting in a target's
 *  `buildSettings` beats its `baseConfigurationReference` xcconfig, so leaving
 *  `DEVELOPMENT_TEAM = "";` behind would shadow the include with an empty string and break signing
 *  in a way that looks exactly like a missing team. Removal is the fix, not a blank.
 *
 *  **No new wiring was needed**: every Capacitor project already points BOTH the Debug and Release
 *  configs' `baseConfigurationReference` at `ios/debug.xcconfig` (verified across all 20 projects
 *  here), so this appends one line to a file Xcode already reads.
 *
 *  ⚠️ **CocoaPods would break this.** `pod install` reassigns `baseConfigurationReference` to the
 *  Pods xcconfig, orphaning our include and silently dropping the team. No project here has a
 *  Podfile today (checked). A project that gains CocoaPods adapters must `#include?` this file from
 *  the Pods xcconfig instead — see docs/native-and-sdks.md.
 *
 *  Scoped to the App target ONLY, as before. No-op without `ios/`; the strip runs only when there
 *  is a `teamId` to move, so a project relying on a still-committed value is never left with
 *  nothing. */
function healIosDevelopmentTeam(projectRoot: string, teamId: string): string | undefined {
  if (!teamId) return undefined;
  const iosDir = path.join(projectRoot, 'ios');
  const pbx = path.join(iosDir, 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(pbx)) return undefined;
  const notes: string[] = [];

  // 1. The gitignored value file.
  const local = path.join(iosDir, IOS_LOCAL_XCCONFIG);
  const wantLocal = `// Generated by Modoki (healNativeConfig) from build.appleTeamId.\n`
    + `// GITIGNORED — never commit. Set it in this project's project.user.json.\n`
    + `DEVELOPMENT_TEAM = ${teamId}\n`;
  if (!fs.existsSync(local) || fs.readFileSync(local, 'utf8') !== wantLocal) {
    fs.writeFileSync(local, wantLocal);
    notes.push(`wrote ios/${IOS_LOCAL_XCCONFIG}`);
  }

  // 2a. DEBUG — Capacitor already points both Debug configs at `debug.xcconfig`, so one optional
  //     include there is all Debug needs. Appending (rather than owning the file) keeps
  //     `CAPACITOR_DEBUG = true` and anything else Capacitor puts there intact.
  const dbg = path.join(iosDir, 'debug.xcconfig');
  if (fs.existsSync(dbg)) {
    const orig = fs.readFileSync(dbg, 'utf8');
    if (!orig.includes(IOS_XCCONFIG_INCLUDE)) {
      fs.writeFileSync(dbg, `${orig.replace(/\s*$/, '')}\n\n${IOS_XCCONFIG_INCLUDE}\n`);
      notes.push('wired debug.xcconfig');
    }
  }

  // 2b. RELEASE — and this is the half that is easy to miss. Capacitor attaches
  //     `debug.xcconfig` to the DEBUG configurations ONLY; the Release configs have no
  //     `baseConfigurationReference` at all, so a Debug-only include leaves the configuration that
  //     actually SHIPS with no team. Caught by `xcodebuild -showBuildSettings -configuration
  //     Release` after a Debug-only version measured green — do not "simplify" this back.
  //
  //     Release cannot simply reuse `debug.xcconfig`: that would leak `CAPACITOR_DEBUG = true` into
  //     release builds. So we own a tracked wrapper that carries NO value, only the same optional
  //     include, and attach it to every Release config lacking a base configuration.
  const wrapper = path.join(iosDir, 'modoki.xcconfig');
  const wantWrapper = `// Generated by Modoki (healNativeConfig). Tracked, and carries NO value.\n`
    + `// Exists because Capacitor wires debug.xcconfig to the Debug configs only, leaving Release\n`
    + `// with no base configuration — so this is what gets the Team ID into a shipping build.\n`
    + `${IOS_XCCONFIG_INCLUDE}\n`;
  if (!fs.existsSync(wrapper) || fs.readFileSync(wrapper, 'utf8') !== wantWrapper) {
    fs.writeFileSync(wrapper, wantWrapper);
    notes.push('wrote ios/modoki.xcconfig');
  }

  // 3. Strip the value out of the tracked pbxproj (see the precedence note above), and attach the
  //    Release wrapper.
  const pbxBefore = fs.readFileSync(pbx, 'utf8');
  let lines = pbxBefore.split('\n');
  const appCfg = appBuildConfigUUIDs(lines);
  if (appCfg.size === 0) return notes.length ? `iOS team → ${IOS_LOCAL_XCCONFIG} (${notes.join(', ')})` : undefined;

  // A fixed id rather than a random one so the heal is idempotent and the diff is stable. Verified
  // free across every pbxproj in the repo; pbxproj ids are project-scoped, so a constant is safe.
  const WRAPPER_UUID = 'D0D0D0D0D0D0D0D0D0D0D0D0';
  if (!lines.some((l) => l.includes(WRAPPER_UUID))) {
    let text = lines.join('\n');
    const fileRefRe = /^\t\t[0-9A-Fa-f]{24} \/\* debug\.xcconfig \*\/ = \{isa = PBXFileReference;.*$/m;
    const groupRe = /^(\t+)[0-9A-Fa-f]{24} \/\* debug\.xcconfig \*\/,$/m;
    const fr = text.match(fileRefRe);
    const gr = text.match(groupRe);
    if (fr && gr) {
      text = text.replace(fileRefRe, (m) => `${m}\n\t\t${WRAPPER_UUID} /* modoki.xcconfig */ = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; name = modoki.xcconfig; path = ../modoki.xcconfig; sourceTree = SOURCE_ROOT; };`);
      text = text.replace(groupRe, (m, indent: string) => `${m}\n${indent}${WRAPPER_UUID} /* modoki.xcconfig */,`);
      // Only a Release block that has NO base configuration — never displace an existing one
      // (that is how a CocoaPods project would be broken).
      text = text.replace(
        /(\/\* Release \*\/ = \{\n(\t+)isa = XCBuildConfiguration;\n)(?!\t+baseConfigurationReference)/g,
        (_m, head: string, indent: string) => `${head}${indent}baseConfigurationReference = ${WRAPPER_UUID} /* modoki.xcconfig */;\n`,
      );
      lines = text.split('\n');
      // Claim it only if it is really there — the note used to be pushed unconditionally.
      if (text.includes(WRAPPER_UUID)) notes.push('attached modoki.xcconfig to the Release configs');
    }
  }

  const teamLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(\s*)([0-9A-Fa-f]{24}) \/\* .* \*\/ = \{/);
    if (!head || !appCfg.has(head[2])) continue;
    let end = i;
    while (end < lines.length && !/^\s*\};/.test(lines[end])) end++;
    let isBuildCfg = false;
    const found: number[] = [];
    for (let j = i; j <= end; j++) {
      if (/isa = XCBuildConfiguration/.test(lines[j])) isBuildCfg = true;
      if (/^\s*DEVELOPMENT_TEAM = [^;]*;\s*$/.test(lines[j])) found.push(j);
    }
    if (isBuildCfg) teamLines.push(...found);
  }
  // ⚠️ NEVER STRIP UNLESS BOTH CONFIGURATIONS ARE ACTUALLY WIRED.
  //
  // The strip destroys the only remaining copy of the Team ID in the project, so it is only safe
  // once something else supplies it. Every wiring step above can legitimately decline: the Debug
  // include needs `ios/debug.xcconfig` to exist, and the Release attach needs that file's
  // PBXFileReference + group membership to be present (it refuses to invent references into a
  // project shape it does not recognise). Both hold for all 20 projects here, but a Capacitor
  // template change or a hand-trimmed project would make one false — and the old code stripped
  // anyway, leaving a project with no team in ANY configuration and no committed value to fall
  // back on. Signing then fails with Xcode's cryptic "requires a development team".
  //
  // Requiring BOTH is deliberate rather than either-or: wiring only Debug is precisely the bug
  // that shipped once already (Release, the configuration that ships, silently unsigned).
  const debugWired = fs.existsSync(dbg) && fs.readFileSync(dbg, 'utf8').includes(IOS_XCCONFIG_INCLUDE);
  const releaseWired = lines.some((l) => l.includes(WRAPPER_UUID));
  if (!debugWired || !releaseWired) {
    // Persist whatever attaching DID succeed — it is safe on its own — then stop short of the strip.
    const attachedOnly = lines.join('\n');
    if (attachedOnly !== pbxBefore) fs.writeFileSync(pbx, attachedOnly);
    notes.push(`left the pbxproj team in place — ${!debugWired ? 'Debug' : 'Release'} is not wired to the xcconfig`);
    return `iOS team → ios/${IOS_LOCAL_XCCONFIG} (${notes.join(', ')})`;
  }

  // Bottom-up so a splice never shifts a not-yet-removed index.
  for (const idx of teamLines.sort((a, b) => b - a)) lines.splice(idx, 1);
  if (teamLines.length) notes.push(`removed ${teamLines.length} DEVELOPMENT_TEAM line(s) from the tracked pbxproj`);

  // ⚠️ ONE write, gated on the TEXT changing — not on the strip having found something.
  //
  // This was gated on `teamLines.length` and it silently discarded the Release attachment on every
  // project whose pbxproj had already been stripped by an earlier run: the edit was computed, the
  // note claimed success, and the file was never written. It survived because the one project
  // spot-checked had been reverted and so still had lines to strip. Measured by
  // `xcodebuild -showBuildSettings -configuration Release` across four projects — 1 worked, 3
  // reported no team while the heal reported success. Keep the write keyed on content.
  const after = lines.join('\n');
  if (after !== pbxBefore) fs.writeFileSync(pbx, after);

  if (notes.length === 0) return undefined;
  return `iOS team → ios/${IOS_LOCAL_XCCONFIG} (${notes.join(', ')})`;
}

/** Sync the iOS Info.plist's Local Network keys to `build.debugBuild` — BOTH ways.
 *
 *  Since iOS 14, an app that publishes/browses Bonjour needs
 *  `NSLocalNetworkUsageDescription` + `NSBonjourServices` or iOS SILENTLY drops the
 *  outgoing mDNS (the service "publishes" but never reaches the LAN), so the
 *  game-debug MCP can't discover the device — the exact regression a fresh
 *  `cap add ios` reintroduces (it scaffolds an Info.plist without them).
 *
 *  #112: the REMOVAL half is the new part. These keys used to be added
 *  unconditionally and stripped from the built plist by a `CONFIGURATION == Release`
 *  build phase, which is why `debugBuild: true` + a Release configuration produced a
 *  bridge with no Local Network permission. Keying both directions on the flag makes
 *  the source plist itself the answer, and lets the strip phase be deleted. */
function healIosLocalNetwork(projectRoot: string, debugBuild: boolean): string | undefined {
  const plist = path.join(projectRoot, 'ios', 'App', 'App', 'Info.plist');
  if (!fs.existsSync(plist)) return undefined;
  const text = fs.readFileSync(plist, 'utf8');
  const present = text.includes('NSBonjourServices');

  if (!debugBuild) {
    if (!present) return undefined;
    const stripped = removePlistKey(removePlistKey(text, 'NSLocalNetworkUsageDescription'), 'NSBonjourServices');
    if (stripped === text) return undefined;
    fs.writeFileSync(plist, stripped);
    return 'removed iOS Local Network + Bonjour keys from Info.plist (build.debugBuild is off)';
  }

  if (present) return undefined;
  const idx = text.lastIndexOf('</dict>');
  if (idx === -1) return undefined; // malformed plist — bail safely
  const block =
    '\t<key>NSLocalNetworkUsageDescription</key>\n' +
    '\t<string>Used for game debugging — connects to development tools on your Mac</string>\n' +
    '\t<key>NSBonjourServices</key>\n' +
    '\t<array>\n' +
    '\t\t<string>_game-debug._tcp</string>\n' +
    '\t</array>\n';
  fs.writeFileSync(plist, text.slice(0, idx) + block + text.slice(idx));
  return 'added iOS Local Network + Bonjour keys to Info.plist (game-debug discovery)';
}

/** Sync the GameDebugPlugin registration in the generated MyViewController.swift to
 *  `build.debugBuild` (#112).
 *
 *  This is the iOS half of "one flag decides". The registration used to be fenced by
 *  `#if DEBUG` — the XCODE CONFIGURATION — so `debugBuild: true` + a Release
 *  configuration shipped the JS bridge with no native plugin behind it: a debug build
 *  that could not debug, with nothing explaining why.
 *
 *  Edits only between the `modoki:game-debug-{begin,end}` markers, migrating a
 *  pre-#112 `#if DEBUG` block to them exactly once. A file carrying NEITHER (someone
 *  took ownership of it) is left alone WITH A NOTE rather than rewritten — but note
 *  that also means the flag silently doesn't apply there, so the note is the only
 *  signal. `games/ota-test` is why this is fenced and not whole-file generated: it
 *  hand-extends the same file with the OTA boot hook. */
function healIosGameDebugRegistration(projectRoot: string, debugBuild: boolean): string | undefined {
  const mvc = path.join(projectRoot, 'ios', 'App', 'App', 'MyViewController.swift');
  if (!fs.existsSync(mvc)) return undefined;
  const orig = fs.readFileSync(mvc, 'utf8');
  const want = debugBuild ? GD_REG_ON : GD_REG_OFF;

  let text = orig;
  let migrated = false;
  const fenceRe = new RegExp(`[ \\t]*${escapeRe(GD_REG_BEGIN.trim())}[\\s\\S]*?${escapeRe(GD_REG_END.trim())}`);
  if (fenceRe.test(text)) {
    text = text.replace(fenceRe, want);
  } else if (LEGACY_GD_REG_RE.test(text)) {
    text = text.replace(LEGACY_GD_REG_RE, want + '\n');
    migrated = true;
  } else {
    return `MyViewController.swift has no modoki:game-debug markers — build.debugBuild NOT applied to the iOS plugin registration (hand-owned file?)`;
  }

  // The doc comment asserted the old guarantee; correct it in the same pass.
  if (STALE_DEBUG_ONLY_DOC.test(text)) text = text.replace(STALE_DEBUG_ONLY_DOC, FRESH_DEBUG_ONLY_DOC);

  if (text === orig) return undefined;
  fs.writeFileSync(mvc, text);
  return `${migrated ? 'migrated iOS GameDebugPlugin registration off #if DEBUG; ' : ''}` +
    `synced iOS GameDebugPlugin registration = ${debugBuild ? 'ON' : 'OFF'} (from build.debugBuild)`;
}

/** Delete the retired `CONFIGURATION == Release` Info.plist-strip build phase from a
 *  project that still carries it (#112) — both its `buildPhases` reference and its
 *  `PBXShellScriptBuildPhase` object. See {@link LEGACY_STRIP_PHASE_NAME} for why it
 *  is retired. Idempotent: a project without it is a no-op. */
function healIosRemoveReleaseStripPhase(projectRoot: string): string | undefined {
  const pbxPath = path.join(projectRoot, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(pbxPath)) return undefined;
  const orig = fs.readFileSync(pbxPath, 'utf8');
  if (!orig.includes(LEGACY_STRIP_PHASE_NAME)) return undefined;

  const lines = orig.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The one-line `buildPhases` reference.
    if (/^\s*[0-9A-Fa-f]{24} \/\* Strip debug-only Info\.plist keys[^*]*\*\/,\s*$/.test(line)) continue;
    // The object definition — skip through its closing `};`.
    if (/^\s*[0-9A-Fa-f]{24} \/\* Strip debug-only Info\.plist keys[^*]*\*\/ = \{\s*$/.test(line)) {
      while (i < lines.length && !/^\s*\};\s*$/.test(lines[i])) i++;
      continue;
    }
    out.push(line);
  }
  let text = out.join('\n');
  // Drop a now-empty PBXShellScriptBuildPhase section (the phase was its only member).
  text = text.replace(/\/\* Begin PBXShellScriptBuildPhase section \*\/\n\/\* End PBXShellScriptBuildPhase section \*\/\n\n?/, '');
  if (text === orig) return undefined;
  fs.writeFileSync(pbxPath, text);
  return 'removed the retired Release Info.plist-strip build phase (build.debugBuild now decides — #112)';
}

/** Add (flag on) or remove (flag off) the iOS archive-time warning build phase —
 *  #112 Phase 2. See {@link ARCHIVE_WARN_PHASE_BLOCK} for why it warns rather than
 *  refuses, and why it keys on `ACTION` rather than `CONFIGURATION`. Idempotent. */
function healIosArchiveWarning(projectRoot: string, debugBuild: boolean): string | undefined {
  const pbxPath = path.join(projectRoot, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(pbxPath)) return undefined;
  const orig = fs.readFileSync(pbxPath, 'utf8');

  // Always strip first, then re-add from the CURRENT constants. A presence check ("it's
  // already there, done") would pin whatever text the project was healed with, so editing
  // ARCHIVE_WARN_TEXT later would leave every existing project on the old message — the
  // generated-content-goes-stale failure this whole issue is about. Re-deriving is still
  // idempotent: identical output means `text === orig` and nothing is written.
  const stripped = removeArchiveWarnPhase(orig);
  const text = debugBuild ? insertArchiveWarnPhase(stripped) : stripped;
  if (text === undefined || text === orig) return undefined;
  fs.writeFileSync(pbxPath, text);
  return debugBuild
    ? "synced the archive-time 'Debug build is ON' warning build phase (#112)"
    : "removed the archive-time 'Debug build is ON' warning (build.debugBuild is off)";
}

/** Drop the warning phase's `buildPhases` reference AND its object, plus the
 *  `PBXShellScriptBuildPhase` section if that emptied it. Pure. */
function removeArchiveWarnPhase(pbx: string): string {
  if (!pbx.includes(ARCHIVE_WARN_PHASE_NAME)) return pbx;
  const lines = pbx.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(ARCHIVE_WARN_PHASE_NAME)) { out.push(lines[i]); continue; }
    if (/,\s*$/.test(lines[i])) continue;                       // the buildPhases reference
    if (/= \{\s*$/.test(lines[i])) {                            // the object — skip to its `};`
      while (i < lines.length && !/^\s*\};\s*$/.test(lines[i])) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n').replace(
    /\/\* Begin PBXShellScriptBuildPhase section \*\/\n\/\* End PBXShellScriptBuildPhase section \*\/\n\n?/, '');
}

/** Add the warning phase's reference + object. Returns undefined (bail, no partial
 *  edit) when either anchor is missing. Pure. */
function insertArchiveWarnPhase(pbx: string): string | undefined {
  const lines = pbx.split('\n');
  const resIdx = lines.findIndex((l) => /^\s*[0-9A-Fa-f]{6,} \/\* Resources \*\/,$/.test(l));
  if (resIdx < 0) return undefined; // can't find the App target's buildPhases list
  lines.splice(resIdx + 1, 0, `\t\t\t\t${GD_UUID.archiveWarnPhase} /* ${ARCHIVE_WARN_PHASE_NAME} */,`);
  const text = lines.join('\n');

  // Merge into an EXISTING PBXShellScriptBuildPhase section (a CocoaPods game has one)
  // rather than opening a second — two sections of the same name is not valid pbxproj.
  const sectionOpen = '/* Begin PBXShellScriptBuildPhase section */';
  if (text.includes(sectionOpen)) {
    return text.replace(sectionOpen,
      sectionOpen + '\n' + ARCHIVE_WARN_PHASE_BLOCK.split('\n').slice(1, -2).join('\n'));
  }
  const anchor = '/* Begin PBXSourcesBuildPhase section */';
  if (!text.includes(anchor)) return undefined;
  return text.replace(anchor, ARCHIVE_WARN_PHASE_BLOCK + '\n' + anchor);
}


/** Does this project report to Crashlytics? Gate for {@link healIosCrashlyticsDsyms} — the dSYM
 *  phase is meaningless without it, and adding one to every project would put a confusing
 *  "no run script found" warning in builds that never wanted symbol upload. */
function usesCrashlytics(projectRoot: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as
      { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Boolean(deps['@capacitor-firebase/crashlytics']);
  } catch {
    return false;
  }
}

/** Make iOS crash reports SYMBOLICATED (#279) — two halves that only work together.
 *
 *  1. `DEBUG_INFORMATION_FORMAT = dwarf-with-dsym` in EVERY configuration, Debug included.
 *  2. The `Upload Crashlytics dSYMs` build phase, generalized out of Court's hand-edited pbxproj
 *     (#275) so any Crashlytics project gets it.
 *
 *  **Why Debug too, when Xcode's default is plain `dwarf` there.** Debug is where the crash probes
 *  run (#278) and where every device build we test with comes from. Court had the phase for weeks
 *  and it exited early on every single build — correctly, by its own rule — so the console
 *  accumulated 8 crashes it could not process. A symbolication pipeline that is only armed in the
 *  configuration nobody debugs with is not a pipeline. The cost is `dsymutil` on the app binary
 *  per build, which is small next to the frameworks that already produce dSYMs.
 *
 *  Strip-then-reinsert, like the archive warning: a presence check would pin whatever script text
 *  the project was first healed with, so editing {@link DSYM_PHASE_BLOCK} later would leave every
 *  existing project on the old one. Re-deriving is still idempotent — identical output means
 *  nothing is written. */
function healIosCrashlyticsDsyms(projectRoot: string): string | undefined {
  if (!usesCrashlytics(projectRoot)) return undefined;
  const pbxPath = path.join(projectRoot, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(pbxPath)) return undefined;
  const orig = fs.readFileSync(pbxPath, 'utf8');

  // `dwarf` may be absent entirely (Xcode omits the key and defaults to it), so set it on every
  // XCBuildConfiguration rather than only rewriting the ones that spell it out.
  let text = setDsymFormatEverywhere(orig);
  const inserted = insertDsymPhase(removeDsymPhase(text));
  if (inserted === undefined) return undefined; // anchor missing — bail without a partial edit
  text = inserted;

  if (text === orig) return undefined;
  fs.writeFileSync(pbxPath, text);
  return 'synced the Crashlytics dSYM upload phase + dwarf-with-dsym in every configuration (#279)';
}

/** Force `DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"` in every build configuration — rewriting
 *  the ones that name it, and ADDING it to the ones that leave it to Xcode's default (which is
 *  `dwarf` for Debug, i.e. no dSYM at all). Pure. */
function setDsymFormatEverywhere(pbx: string): string {
  const want = 'DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";';
  return insertMissingDsymFormat(pbx.replace(/DEBUG_INFORMATION_FORMAT = [^;]+;/g, want), want);
}

/** Add the key to any `buildSettings` dict that lacks it. Split out so the regex walk is readable:
 *  it scans dict-by-dict rather than globally, because "does this config already have the key" is
 *  a per-dict question and a global `includes` would answer for the whole file. Pure. */
function insertMissingDsymFormat(pbx: string, want: string): string {
  const lines = pbx.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const open = /^(\t+)buildSettings = \{$/.exec(lines[i]);
    if (!open) continue;
    // Find this dict's extent to decide whether the key is already inside it.
    let depth = 1;
    let j = i + 1;
    let has = false;
    for (; j < lines.length && depth > 0; j++) {
      if (/\{\s*$/.test(lines[j])) depth++;
      if (/^\s*\};?\s*$/.test(lines[j])) depth--;
      if (depth > 0 && lines[j].includes('DEBUG_INFORMATION_FORMAT')) has = true;
    }
    if (!has) out.push(`${open[1]}\t${want}`);
  }
  return out.join('\n');
}

/** Drop the dSYM phase's `buildPhases` reference AND its object. Mirrors
 *  {@link removeArchiveWarnPhase}; see its comment for the line shapes. Pure. */
function removeDsymPhase(pbx: string): string {
  if (!pbx.includes(DSYM_PHASE_NAME)) return pbx;
  const lines = pbx.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(DSYM_PHASE_NAME)) { out.push(lines[i]); continue; }
    if (/,\s*$/.test(lines[i])) continue;
    if (/= \{\s*$/.test(lines[i])) {
      while (i < lines.length && !/^\s*\};\s*$/.test(lines[i])) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n').replace(
    /\/\* Begin PBXShellScriptBuildPhase section \*\/\n\/\* End PBXShellScriptBuildPhase section \*\/\n\n?/, '');
}

/** Add the dSYM phase's reference + object. LAST in `buildPhases` — it needs the dSYM the build
 *  just produced. Returns undefined (bail, no partial edit) when the anchor is missing. Pure. */
function insertDsymPhase(pbx: string): string | undefined {
  const lines = pbx.split('\n');
  const resIdx = lines.findIndex((l) => /^\s*[0-9A-Fa-f]{6,} \/\* Resources \*\/,$/.test(l));
  if (resIdx < 0) return undefined;
  // After Resources, skip any phases already listed (e.g. the archive warning) so this one is last.
  let at = resIdx + 1;
  while (at < lines.length && /^\s*[0-9A-Fa-f]{6,} \/\* .* \*\/,$/.test(lines[at])) at++;
  lines.splice(at, 0, `\t\t\t\t${GD_UUID.dsymUploadPhase} /* ${DSYM_PHASE_NAME} */,`);
  const text = lines.join('\n');

  // ⚠️ Insert at the END of an existing section, where {@link insertArchiveWarnPhase} inserts at
  // the START — and that asymmetry is the fix for a measured defect, not an accident. Both used to
  // splice in right after the section-open line, so each put ITSELF first and shoved the other to
  // second: on every project open the two phase objects swapped places, each heal rewrote the
  // pbxproj, and each returned a "synced …" note for work that netted to nothing. Measured on
  // games/court 2026-08-20 — two writes of equal length and opposite content, with the file
  // identical before and after the pass. Deterministic slots (warning first, dSYM last) make both
  // heals fixed points on an already-correct file, so a note now means a real change.
  const sectionOpen = '/* Begin PBXShellScriptBuildPhase section */';
  const sectionEnd = '/* End PBXShellScriptBuildPhase section */';
  if (text.includes(sectionOpen) && text.includes(sectionEnd)) {
    return text.replace(sectionEnd,
      DSYM_PHASE_BLOCK.split('\n').slice(1, -2).join('\n') + '\n' + sectionEnd);
  }
  const anchor = '/* Begin PBXSourcesBuildPhase section */';
  if (!text.includes(anchor)) return undefined;
  return text.replace(anchor, DSYM_PHASE_BLOCK + '\n' + anchor);
}

/** Crashlytics Gradle plugin version (#282, generalized out of Court's hand-edited
 *  `android/build.gradle`, #275). Needed for the mapping.txt / NDK symbol upload that makes a
 *  native or minified stack readable — without it the SDK still reports, but the frames come
 *  back obfuscated on any build with minifyEnabled on. */
const CRASHLYTICS_GRADLE_PLUGIN_VERSION = '3.0.3';

/** FALLBACK Crashlytics NDK artifact version (#282, generalized out of Court's hand-edited
 *  `android/app/build.gradle`, #279) — used only when the project does not expose
 *  `firebaseCrashlyticsVersion`.
 *
 *  ⚠️ **The emitted line PREFERS the project's own resolved version, and that is deliberate.**
 *  `firebase-crashlytics-ndk` and the `firebase-crashlytics` artifact `@capacitor-firebase/crashlytics`
 *  pulls in are a MATCHED PAIR: a mismatch is a RUNTIME failure — silently absent NDK crash
 *  reporting — not a resolution error, so nothing in a build log would catch it. Court's hand
 *  edit read `rootProject.ext.firebaseCrashlyticsVersion` for exactly that reason, so the
 *  generated block keeps the expression rather than freezing a number that drifts the moment the
 *  plugin bumps. This constant is the no-property fallback only, and matches the plugin's current
 *  default. */
const CRASHLYTICS_NDK_VERSION = '20.0.3';

/** The NDK dependency's version expression — the project's own `firebaseCrashlyticsVersion` when
 *  it has one, else {@link CRASHLYTICS_NDK_VERSION}. See that constant for why this is an
 *  expression and not a literal. */
const CRASHLYTICS_NDK_VERSION_EXPR =
  `\${project.hasProperty('firebaseCrashlyticsVersion') ? rootProject.ext.firebaseCrashlyticsVersion : '${CRASHLYTICS_NDK_VERSION}'}`;

const CRASHLYTICS_CLASSPATH_BEGIN = '// modoki:crashlytics-classpath-begin (#282)';
const CRASHLYTICS_CLASSPATH_END = '// modoki:crashlytics-classpath-end';
const CRASHLYTICS_NDK_BEGIN = '// modoki:crashlytics-ndk-begin (#282)';
const CRASHLYTICS_NDK_END = '// modoki:crashlytics-ndk-end';
const CRASHLYTICS_APPLY_BEGIN = '// modoki:crashlytics-apply-begin (#282)';
const CRASHLYTICS_APPLY_END = '// modoki:crashlytics-apply-end';

/** Normalize a file's line endings for editing, and put them back on the way out.
 *
 *  Every gradle edit below is written as LF-only text — fences, anchors, inserted blocks. Handed a
 *  CRLF file those edits produce a MIXED-ending file that differs from its input, so the heal
 *  rewrites it, and rewrites it again on the next pass: measured drift of one extra blank line per
 *  run before it settled, with the inserted block left bare-LF inside a CRLF file. `.gitattributes`
 *  pins `*.gradle text eol=lf`, so this needs a non-git write path to happen at all — but this repo
 *  has a documented history of Windows-only EOL bugs (docs/windows.md) and the guard is one regex.
 *  Edit in LF, restore whatever the file had. */
function eolSafe(orig: string): { lf: string; restore: (edited: string) => string } {
  const crlf = orig.includes('\r\n');
  return {
    lf: crlf ? orig.replace(/\r\n/g, '\n') : orig,
    restore: (edited: string) => (crlf ? edited.replace(/\n/g, '\r\n') : edited),
  };
}

/** Add the Crashlytics Gradle plugin classpath to `android/build.gradle`'s
 *  `buildscript { dependencies { … } }` block — generalized out of Court's hand edit (#275).
 *  Anchored after the `com.google.gms:google-services` classpath when present (Crashlytics rides
 *  the same `google-services.json`), otherwise after the AGP classpath every project has.
 *  Strip-then-reinsert, like {@link healIosCrashlyticsDsyms} — see its doc comment for why a
 *  presence check is the wrong shape here too: a version bump to the constant above must reach
 *  every project that already has the block, not just fresh ones. Also migrates a pre-existing
 *  HAND-EDITED (unmarked) classpath line — any pinned version — to the fenced form, so a
 *  hand-edited project (Court, 3d-test) ends up with exactly one copy. */
function healAndroidCrashlyticsClasspath(projectRoot: string): string | undefined {
  const gradle = path.join(projectRoot, 'android', 'build.gradle');
  if (!fs.existsSync(gradle)) return undefined;
  const raw = fs.readFileSync(gradle, 'utf8');
  const { lf: orig, restore } = eolSafe(raw);

  const fenceRe = new RegExp(`\\n*[ \\t]*${escapeRe(CRASHLYTICS_CLASSPATH_BEGIN)}[\\s\\S]*?${escapeRe(CRASHLYTICS_CLASSPATH_END)}\\n?`);
  let text = orig.replace(fenceRe, '\n');
  text = text.replace(/^[ \t]*classpath[^\n]*firebase-crashlytics-gradle[^\n]*\r?\n?/gm, '');

  const gmsAnchor = /^([ \t]*classpath\s+['"]com\.google\.gms:google-services:[^'"]*['"])[ \t]*(?:\/\/[^\n]*)?$/m;
  const agpAnchor = /^([ \t]*classpath\s+['"]com\.android\.tools\.build:gradle:[^'"]*['"])[ \t]*(?:\/\/[^\n]*)?$/m;
  const block = `        ${CRASHLYTICS_CLASSPATH_BEGIN}\n`
    + `        classpath 'com.google.firebase:firebase-crashlytics-gradle:${CRASHLYTICS_GRADLE_PLUGIN_VERSION}'\n`
    + `        ${CRASHLYTICS_CLASSPATH_END}`;
  if (gmsAnchor.test(text)) text = text.replace(gmsAnchor, `$1\n${block}`);
  else if (agpAnchor.test(text)) text = text.replace(agpAnchor, `$1\n${block}`);
  else return undefined; // neither anchor found — bail without a partial edit

  if (text === orig) return undefined;
  fs.writeFileSync(gradle, restore(text));
  return 'Gradle plugin classpath';
}

/** Add the Crashlytics NDK artifact to `android/app/build.gradle`'s top-level
 *  `dependencies { … }` block — generalized out of Court's hand edit (#279); see
 *  {@link CRASHLYTICS_NDK_VERSION}'s comment for why the version is pinned. Inserted immediately
 *  after the `dependencies {` line — Gradle does not care about order. Strip-then-reinsert +
 *  hand-edit migration, like its sibling above. */
function healAndroidCrashlyticsNdk(projectRoot: string): string | undefined {
  const gradle = path.join(projectRoot, 'android', 'app', 'build.gradle');
  if (!fs.existsSync(gradle)) return undefined;
  const raw = fs.readFileSync(gradle, 'utf8');
  const { lf: orig, restore } = eolSafe(raw);

  const fenceRe = new RegExp(`\\n*[ \\t]*${escapeRe(CRASHLYTICS_NDK_BEGIN)}[\\s\\S]*?${escapeRe(CRASHLYTICS_NDK_END)}\\n?`);
  let text = orig.replace(fenceRe, '\n');
  text = text.replace(/^[ \t]*implementation[^\n]*firebase-crashlytics-ndk[^\n]*\r?\n?/gm, '');

  // Only a trailing COMMENT is tolerated here, never arbitrary text: `dependencies { impl 'x' }`
  // is a one-line block, and inserting "after" it would put the artifact OUTSIDE the block.
  const anchor = /^(dependencies \{)[ \t]*(?:\/\/[^\n]*)?$/m;
  if (!anchor.test(text)) return undefined;
  const block = `    ${CRASHLYTICS_NDK_BEGIN}\n`
    + `    implementation "com.google.firebase:firebase-crashlytics-ndk:${CRASHLYTICS_NDK_VERSION_EXPR}"\n`
    + `    ${CRASHLYTICS_NDK_END}`;
  text = text.replace(anchor, `$1\n${block}`);

  if (text === orig) return undefined;
  fs.writeFileSync(gradle, restore(text));
  return 'NDK artifact';
}

/** Add `apply plugin: 'com.google.firebase.crashlytics'` inside the SAME `servicesJSON` guard as
 *  `com.google.gms.google-services` — generalized out of Court's hand edit (#275/#279).
 *  ⚠️ Placement is load-bearing: Crashlytics rides the same `google-services.json` as
 *  google-services, and applying it OUTSIDE the guard fails the build for a project that has none.
 *  If the guard is absent (no `com.google.gms.google-services` apply-plugin line to anchor on),
 *  this edit is skipped — never invented — while its two siblings above still run. */
function healAndroidCrashlyticsApplyPlugin(projectRoot: string): string | undefined {
  const gradle = path.join(projectRoot, 'android', 'app', 'build.gradle');
  if (!fs.existsSync(gradle)) return undefined;
  const raw = fs.readFileSync(gradle, 'utf8');
  const { lf: orig, restore } = eolSafe(raw);

  const fenceRe = new RegExp(`\\n*[ \\t]*${escapeRe(CRASHLYTICS_APPLY_BEGIN)}[\\s\\S]*?${escapeRe(CRASHLYTICS_APPLY_END)}\\n?`);
  let text = orig.replace(fenceRe, '\n');
  text = text.replace(/^[ \t]*apply plugin:\s*['"]com\.google\.firebase\.crashlytics['"][ \t]*\r?\n?/gm, '');

  const anchor = /^([ \t]*apply plugin:\s*['"]com\.google\.gms\.google-services['"])[ \t]*(?:\/\/[^\n]*)?$/m;
  if (!anchor.test(text)) return undefined; // guard absent — don't invent it, just skip this edit
  const block = `        ${CRASHLYTICS_APPLY_BEGIN}\n`
    + `        apply plugin: 'com.google.firebase.crashlytics'\n`
    + `        ${CRASHLYTICS_APPLY_END}`;
  text = text.replace(anchor, `$1\n${block}`);

  if (text === orig) return undefined;
  fs.writeFileSync(gradle, restore(text));
  return 'apply plugin';
}

/** Generalizes Court's hand-edited Android Crashlytics gradle wiring (#275, #279) the way
 *  {@link healIosCrashlyticsDsyms} generalizes the iOS symbol-upload phase — any project
 *  depending on `@capacitor-firebase/crashlytics` gets it automatically. Same gate
 *  ({@link usesCrashlytics}), same strip-then-reinsert reasoning, three fenced edits across two
 *  files: the Gradle-plugin classpath, the NDK artifact, and the apply-plugin line (skipped, not
 *  invented, when its guard is absent). */
function healAndroidCrashlytics(projectRoot: string): string | undefined {
  if (!usesCrashlytics(projectRoot)) return undefined;
  // Each sub-heal returns its own label, or undefined when it changed nothing. Taking the label
  // from the return value rather than repeating it here keeps the two from drifting apart.
  const changed = [
    healAndroidCrashlyticsClasspath(projectRoot),
    healAndroidCrashlyticsNdk(projectRoot),
    healAndroidCrashlyticsApplyPlugin(projectRoot),
  ].filter((c): c is string => c !== undefined);

  // ⚠️ SAY SO when the load-bearing step is missing, instead of reporting the other two as a
  // success. Without `apply plugin: 'com.google.firebase.crashlytics'` the classpath and the NDK
  // artifact do nothing — no mapping upload, no native symbolication — and that is precisely the
  // half-wired shape #282 exists to end (3d-test carried a classpath with no NDK artifact for
  // weeks and looked configured). The apply step is skipped only when there is no
  // `com.google.gms.google-services` apply to anchor on, which also means the project has no
  // Firebase config at all; silence there reads as "done".
  const appGradle = path.join(projectRoot, 'android', 'app', 'build.gradle');
  if (changed.length > 0 && fs.existsSync(appGradle)
      && !fs.readFileSync(appGradle, 'utf8').includes("apply plugin: 'com.google.firebase.crashlytics'")) {
    changed.push('⚠️ apply-plugin NOT wired — no `com.google.gms.google-services` apply to anchor on,'
      + ' so Crashlytics symbol upload is inert');
  }
  if (changed.length === 0) return undefined;
  return `synced Android Crashlytics gradle wiring — ${changed.join(', ')} (#282)`;
}

/** The Gradle sibling of {@link healIosArchiveWarning}. Appends (flag on) or removes
 *  (flag off) a fenced `taskGraph.whenReady` warning in `android/app/build.gradle`. */
function healAndroidArchiveWarning(projectRoot: string, debugBuild: boolean): string | undefined {
  const gradle = path.join(projectRoot, 'android', 'app', 'build.gradle');
  if (!fs.existsSync(gradle)) return undefined;
  const orig = fs.readFileSync(gradle, 'utf8');
  const fenceRe = new RegExp(`\\n*${escapeRe(ANDROID_WARN_BEGIN)}[\\s\\S]*?${escapeRe(ANDROID_WARN_END)}\\n?`);

  let text: string;
  if (fenceRe.test(orig)) {
    text = debugBuild ? orig.replace(fenceRe, '\n\n' + ANDROID_WARN_BLOCK + '\n') : orig.replace(fenceRe, '\n');
  } else {
    if (!debugBuild) return undefined;
    text = orig.replace(/\n*$/, '\n') + '\n' + ANDROID_WARN_BLOCK + '\n';
  }
  if (text === orig) return undefined;
  fs.writeFileSync(gradle, text);
  return `${debugBuild ? 'added' : 'removed'} the Gradle release-build "Debug build is ON" warning (#112)`;
}

/** Keep {@link ANDROID_SIGNING_BLOCK} in sync in `android/app/build.gradle` (#370).
 *
 *  Always re-derived from the current constant rather than presence-checked, for the reason
 *  {@link healIosArchiveWarning} spells out: a "it's already there, done" check pins whatever text
 *  the project was healed with, so editing the block later would leave every existing project on
 *  the old version. Re-deriving stays idempotent — identical output means nothing is written.
 *
 *  ⚠️ **Skips a project that already configures `signingConfigs` by hand**, outside our fence.
 *  `games/iap-test` is exactly that (#196 wired its Play upload key before this engine path
 *  existed), and healing over it would give the file two `signingConfigs.release` definitions —
 *  the second silently winning. A hand-written config that already reads the same
 *  `keystore.properties` needs nothing from us; one that reads something else is a deliberate
 *  choice this heal has no business overriding. */
function healAndroidReleaseSigning(projectRoot: string): string | undefined {
  const gradle = path.join(projectRoot, 'android', 'app', 'build.gradle');
  if (!fs.existsSync(gradle)) return undefined;
  const orig = fs.readFileSync(gradle, 'utf8');
  // CRLF-safe, like the Crashlytics heals next door: this block is LF-joined, and appending it
  // straight onto a CRLF gradle file inserts bare-LF lines into a CRLF file. Normalize, edit,
  // restore. (The CRLF guard in healNativeConfig.test.ts caught exactly this.)
  const { lf, restore } = eolSafe(orig);
  const fenceRe = new RegExp(`\\n*${escapeRe(ANDROID_SIGNING_BEGIN)}[\\s\\S]*?${escapeRe(ANDROID_SIGNING_END)}\\n?`);
  const hasFence = fenceRe.test(lf);

  // A hand-written signingConfigs OUTSIDE our fence owns this project — leave it alone.
  //
  // Comments are stripped before the test, in both directions. A `signingConfigs {` sitting inside
  // a `/* … */` block or behind a `//` would otherwise read as a real hand-written config, and the
  // project would silently never get release signing — producing `app-release-unsigned.apk` while
  // the build's success message points at the signed path. (The inverse, a real config the regex
  // fails to see, appends a second `signingConfigs.release` that quietly wins over the author's.)
  const codeOnly = lf
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  if (!hasFence && /(^|\n)\s*signingConfigs\s*\{/.test(codeOnly)) return undefined;

  const text = hasFence
    ? lf.replace(fenceRe, '\n\n' + ANDROID_SIGNING_BLOCK + '\n')
    : lf.replace(/\n*$/, '\n') + '\n' + ANDROID_SIGNING_BLOCK + '\n';
  if (text === lf) return undefined;
  fs.writeFileSync(gradle, restore(text));
  return `${hasFence ? 'synced' : 'added'} the Gradle release signing config (#370)`;
}

/** The keystore-ignore block every `android/.gitignore` must carry (#370). */
const ANDROID_GITIGNORE_KEYSTORE_BLOCK = [
  '# Keystore files',
  '# UNCOMMENTED deliberately (#370). The Android template ships these commented out, which means a',
  '# keystore dropped in this folder is COMMITTED by default — into a repo whose snapshot is published',
  '# publicly. An upload key in git is a signing-identity compromise, not a tidiness problem.',
  '# The real key for this project lives OUTSIDE the repo (~/.modoki/keystores/); these lines are',
  '# defence in depth for anyone who later puts one here by habit.',
  '*.jks',
  '*.keystore',
  '',
  '# Signing config — absolute paths + passwords for the upload key. NEVER committed.',
  '# app/build.gradle reads it if present and silently skips release signing if absent, so a fresh',
  '# clone still builds debug without it.',
  'keystore.properties',
].join('\n');

/** Uncomment the keystore-ignore lines in `android/.gitignore`, and add `keystore.properties` (#370).
 *
 *  **Why this is a HEAL and not a one-time sweep.** The file is generated by `cap add`, from
 *  Capacitor's copy of the upstream Android template — which ships `#*.jks` / `#*.keystore`
 *  COMMENTED OUT. So fixing the 21 existing projects by hand fixes exactly those 21: the very next
 *  `Add Android Target…` writes the unsafe version again, and the failure is silent until someone
 *  drops a `.jks` in that folder and `git add` sweeps a signing identity into a repo whose snapshot
 *  is published publicly. A heal is the only thing that holds.
 *
 *  Idempotent: no-op once the uncommented lines and `keystore.properties` are all present. Matches
 *  the commented block loosely (by the `#*.jks` line) because the surrounding comment wording has
 *  varied across template versions, and anchoring on the exact sentence is how a heal quietly stops
 *  firing after an upstream reword. */
function healAndroidGitignoreKeystore(projectRoot: string): string | undefined {
  const file = path.join(projectRoot, 'android', '.gitignore');
  if (!fs.existsSync(file)) return undefined;
  const orig = fs.readFileSync(file, 'utf8');
  const { lf, restore } = eolSafe(orig);

  // Already right — the common case on every open after the first. Compared against the canonical
  // block (not "are the three entries present somewhere"), so a project healed by an OLDER engine
  // picks up an edited block instead of being pinned to the text it first got.
  //
  // ⚠️ Modulo the ISSUE NUMBER in the block's first comment. `games/iap-test` carries this same
  // block referencing #196, because it wired its Play upload key before the engine had a release
  // path at all — and that provenance is worth more than uniformity. Comparing literally made the
  // heal treat that file as unhealed, and the converge pass below then appended a SECOND copy of
  // the block while orphaning the #196 comment lines. Normalising the number means a correct file
  // is recognised whichever issue introduced it.
  const unIssue = (t: string) => t.replace(/\(#\d+\)/g, '(#N)');
  if (unIssue(lf).includes(unIssue(ANDROID_GITIGNORE_KEYSTORE_BLOCK))) return undefined;

  // CONVERGE, don't patch. Earlier versions branched on the file's shape — pristine template vs.
  // everything else — and a file where somebody had hand-uncommented only `*.jks` matched neither
  // branch's assumptions, so it took the append path and grew a SECOND `*.jks`, a second
  // "# Keystore files" header and an orphan `#*.keystore`, on every single project open. Stripping
  // every keystore-related line first means a half-edited file, a pristine one and an
  // already-healed one all reduce to the same input, and the block goes back where the old one was.
  const lines = lf.split('\n');
  // Every line the canonical block itself contains counts as ours to replace — derived FROM the
  // constant rather than re-listed, so editing the block cannot leave this predicate behind
  // stripping the previous wording. Issue numbers normalised for the iap-test reason above.
  const blockLines = new Set(
    ANDROID_GITIGNORE_KEYSTORE_BLOCK.split('\n').map((l) => unIssue(l.trim())).filter(Boolean),
  );
  const isKeystoreLine = (l: string) => {
    const t = l.trim();
    return /^#?\*\.(jks|keystore)$/.test(t)
      || /^#?keystore\.properties$/.test(t)
      || /^# Uncomment the following lines? if you do not want to check your keystore files? in\.?$/.test(t)
      || blockLines.has(unIssue(t));
  };
  let anchor = -1;
  const kept: string[] = [];
  for (const l of lines) {
    if (isKeystoreLine(l)) { if (anchor === -1) anchor = kept.length; continue; }
    kept.push(l);
  }
  // No keystore section anywhere → append at the end.
  if (anchor === -1) anchor = kept.length;
  // Collapse a blank line the strip may have stranded next to the insertion point, so repeated
  // heals cannot accrete empty lines.
  while (anchor > 0 && kept[anchor - 1].trim() === '' && kept[anchor]?.trim() === '') kept.splice(anchor, 1);
  const block = ANDROID_GITIGNORE_KEYSTORE_BLOCK.split('\n');
  const out = [...kept.slice(0, anchor), ...block, ...kept.slice(anchor)];
  // Squeeze blank lines ONLY around the block we just inserted, never file-wide: a project's
  // .gitignore may legitimately use several blank lines to group sections, and rewriting those is
  // an edit in a region this heal has no business in — the #18 write-behind-your-back hazard, done
  // to ourselves. Bounded to the inserted span plus one line either side.
  const lo = Math.max(0, anchor - 1);
  const hi = Math.min(out.length, anchor + block.length + 1);
  const squeezed = [
    ...out.slice(0, lo),
    ...out.slice(lo, hi).join('\n').replace(/\n{3,}/g, '\n\n').split('\n'),
    ...out.slice(hi),
  ];
  const text = squeezed.join('\n').replace(/\n*$/, '\n');
  if (text === lf) return undefined;
  fs.writeFileSync(file, restore(text));
  return 'uncommented the keystore ignores + added keystore.properties in android/.gitignore (#370)';
}

/** Remove a top-level Info.plist key AND its value element. Inverse of
 *  {@link setPlistKey}; no-op when the key is absent. */
function removePlistKey(text: string, key: string): string {
  const re = new RegExp(
    `[ \\t]*<key>${key}</key>[ \\t]*\\r?\\n` +
    `[ \\t]*(?:<array>[\\s\\S]*?</array>|<dict>[\\s\\S]*?</dict>|<[A-Za-z]+\\s*/>|<[A-Za-z]+>[\\s\\S]*?</[A-Za-z]+>)[ \\t]*\\r?\\n`,
  );
  return text.replace(re, '');
}

/** Wire the iOS App target so Capacitor discovers GameDebugPlugin (Task 3). A
 *  fresh `cap add ios` doesn't compile the plugin in — SPM strips the class — so
 *  we (1) drop a MyViewController.swift that registers the instance in DEBUG,
 *  (2) point the storyboard's bridge VC at it, and (3) add pbxproj references that
 *  compile MyViewController.swift + the engine's GameDebugPlugin.swift into the App
 *  target. Idempotent (skips whatever's already present); only for a project that
 *  depends on capacitor-game-debug AND lives inside the modoki repo. Bails without
 *  writing if any pbxproj anchor is missing (never leaves a partial edit). */
/** Point a scene-based iOS app's `SceneDelegate` at `MyViewController`, not the base
 *  `CAPBridgeViewController` (#368).
 *
 *  A `SceneDelegate` that builds its window in code OVERRIDES `Main.storyboard`, whose
 *  `customClass="MyViewController"` is otherwise what gets our `registerPluginInstance` call to
 *  run. With the base VC there, `MyViewController` is never instantiated, `GameDebugPlugin` is
 *  never registered, and the iOS debug bridge is silently dead — the game renders perfectly and
 *  only the JS console says `"GameDebug" plugin is not implemented on ios`, which reaches no
 *  device log. From the host it looks exactly like "the app is not running" (ECONNREFUSED :9095).
 *
 *  ⚠️ This heal exists because the OTHER heals hid the bug. `healIosGameDebugWiring` writes a
 *  correct `MyViewController.swift` and a correct pbxproj reference, so every artifact this file
 *  owns looked right in 9 projects whose SceneDelegate bypassed all of it. Capacitor's own iOS
 *  template is where the file comes from (nothing in this repo writes one), so we cannot fix it
 *  upstream — we can only heal what it generated. */
function healIosSceneDelegateBridgeVC(projectRoot: string): string | undefined {
  const sd = path.join(projectRoot, 'ios', 'App', 'App', 'SceneDelegate.swift');
  if (!fs.existsSync(sd)) return undefined;   // storyboard path — the VC comes from Main.storyboard
  if (!fs.existsSync(path.join(projectRoot, 'ios', 'App', 'App', 'MyViewController.swift'))) return undefined;

  // ⚠️ On disk is NOT enough — the class must be COMPILED INTO THE TARGET, or repointing here
  // turns a recoverable failure into an unrecoverable one: today's symptom is a silently dead
  // debug bridge (the app builds, runs and renders); naming a type Swift cannot see makes the
  // App target fail to COMPILE. Never trade a dead bridge for a dead build.
  //
  // `healIosGameDebugWiring` normally guarantees the Sources entry and runs before this — but it
  // has early returns (no pbxproj, and notably no resolvable plugin source), so "the file exists"
  // and "the file is in the build" are different questions. Ask the one that matters. When this
  // bails, the guard test still fails the gate on the committed state, so the bug stays visible
  // rather than becoming silent again.
  const pbxPath = path.join(projectRoot, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(pbxPath)) return undefined;
  if (!/MyViewController\.swift in Sources/.test(fs.readFileSync(pbxPath, 'utf8'))) {
    // SPEAK, don't return undefined. The other bails above are genuine "nothing to do"; this one
    // is "something is wrong and I am refusing to act", and staying silent is what lets #368
    // recur invisibly. The guard test is NOT the safety net here — it reads `git ls-files`, so it
    // covers tracked in-repo projects only, and the project that lands in this branch is exactly
    // the one it cannot see: a game scaffolded or copied OUT of the repo, or an Xcode 16
    // `PBXFileSystemSynchronizedRootGroup` project, which has no Sources phase entries at all for
    // `healIosGameDebugWiring`'s anchors to find.
    return '⚠️ SceneDelegate.swift still builds CAPBridgeViewController, and MyViewController.swift '
      + 'is not in the App target\'s Sources phase — repointing it would break the BUILD, so this was '
      + 'left alone. The iOS debug bridge stays dead until the pbxproj is wired (#368).';
  }
  const orig = fs.readFileSync(sd, 'utf8');
  // GLOBAL: a delegate with two assignments (an `if #available` fork, say) must have BOTH
  // repointed. A non-global replace rewrites the first, returns the success note, and leaves the
  // other branch with a dead bridge — a half-fix that reports as a whole one, and that the guard
  // test then fails on forever with nothing to auto-repair it.
  const re = /(rootViewController\s*=\s*)CAPBridgeViewController(\s*\()/g;
  if (!re.test(orig)) return undefined;
  // No `re.lastIndex` reset needed: `String.prototype.replace` with a global regex resets it
  // itself, and `re` is function-local so nothing carries between calls.
  try {
    fs.writeFileSync(sd, orig.replace(re, '$1MyViewController$2'));
  } catch (e) {
    // Never throw from here: this runs mid-chain on project OPEN, and an uncaught write error
    // aborts every heal AFTER it (the Android debug-build metadata among them) while reporting
    // only the write failure. A read-only file should cost this one heal, not the rest.
    return `⚠️ could not repoint SceneDelegate.swift (${(e as Error).message}) — the iOS debug bridge stays dead until it is fixed by hand (#368)`;
  }
  return 'SceneDelegate.swift: rootViewController CAPBridgeViewController → MyViewController (else GameDebugPlugin never registers — #368)';
}

function healIosGameDebugWiring(projectRoot: string, debugBuild: boolean): string | undefined {
  if (!usesGameDebug(projectRoot)) return undefined;
  const iosApp = path.join(projectRoot, 'ios', 'App');
  const pbxPath = path.join(iosApp, 'App.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(pbxPath)) return undefined;
  const swiftSrc = findGameDebugSwift(projectRoot);
  if (!swiftSrc) return undefined; // plugin source not found (no node_modules copy, not in a repo)

  const notes: string[] = [];

  // 1. MyViewController.swift (registers the plugin) — write if missing.
  const mvcPath = path.join(iosApp, 'App', 'MyViewController.swift');
  if (!fs.existsSync(mvcPath)) {
    fs.writeFileSync(mvcPath, myViewControllerSwift(debugBuild));
    notes.push('wrote ios MyViewController.swift');
  }

  // 2. Storyboard — point the bridge VC at MyViewController (from CAPBridgeViewController).
  const sbPath = path.join(iosApp, 'App', 'Base.lproj', 'Main.storyboard');
  if (fs.existsSync(sbPath)) {
    const sb = fs.readFileSync(sbPath, 'utf8');
    const fixed = sb.replace(
      /customClass="CAPBridgeViewController" customModule="Capacitor"/,
      'customClass="MyViewController" customModule="App"',
    );
    if (fixed !== sb) {
      fs.writeFileSync(sbPath, fixed);
      notes.push('pointed Main.storyboard bridge VC at MyViewController');
    }
  }

  // 3. pbxproj — compile MyViewController.swift + GameDebugPlugin.swift into App.
  let pbx = fs.readFileSync(pbxPath, 'utf8');

  // Repoint an ALREADY-wired plugin reference to the game-local node_modules copy —
  // the portable, self-contained source. NO game (in-repo or standalone) should
  // reference the repo via `../../../../engine/…`: that path escapes the game folder
  // and breaks the moment it's built standalone (copied out / DMG), silently dropping
  // the plugin ("GameDebug plugin is not implemented on ios"). Only ever rewrites
  // TOWARD the node_modules copy, and only when that copy exists — so a pre-install
  // heal never flips a correct path back to a repo path (no churn).
  {
    const vendored = path.join(projectRoot, 'node_modules', 'capacitor-game-debug', 'ios', 'Sources', 'GameDebugPlugin', 'GameDebugPlugin.swift');
    if (fs.existsSync(vendored)) {
      // POSIX separators: this string is written into the .pbxproj (an Xcode file that
      // demands forward slashes). On Windows path.relative yields backslashes, which
      // Xcode can't resolve when the project is later built on macOS (iOS is mac-only) —
      // the plugin silently drops ("GameDebug not implemented on ios").
      const wantRel = path.relative(iosApp, vendored).replace(/\\/g, '/');
      if (/name = GameDebugPlugin\.swift; path = "/.test(pbx) && !pbx.includes(`path = "${wantRel}"`)) {
        pbx = pbx.replace(/(name = GameDebugPlugin\.swift; path = ")[^"]*(";)/, (_m, pre, post) => `${pre}${wantRel}${post}`);
        fs.writeFileSync(pbxPath, pbx);
        notes.push(`repointed GameDebugPlugin.swift → ${wantRel} (portable)`);
      }
    }
  }

  if (!pbx.includes('MyViewController.swift')) {
    // pbxproj path is relative to the .xcodeproj's SRCROOT (ios/App), sourceTree SOURCE_ROOT.
    // POSIX separators — the .pbxproj is an Xcode file (forward slashes only); path.relative
    // yields backslashes on Windows, which break the build when opened on macOS.
    const pluginRel = path.relative(iosApp, swiftSrc).replace(/\\/g, '/');
    const lines = pbx.split('\n');

    // Anchor every insert on AppDelegate.swift — present in every Capacitor app.
    const inserts: Array<{ match: RegExp; add: string[] }> = [
      { // PBXBuildFile section
        match: /\/\* AppDelegate\.swift in Sources \*\/ = \{isa = PBXBuildFile;/,
        add: [
          `\t\t${GD_UUID.mvcBuildFile} /* MyViewController.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${GD_UUID.mvcFileRef} /* MyViewController.swift */; };`,
          `\t\t${GD_UUID.pluginBuildFile} /* GameDebugPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${GD_UUID.pluginFileRef} /* GameDebugPlugin.swift */; };`,
        ],
      },
      { // PBXFileReference section
        match: /\/\* AppDelegate\.swift \*\/ = \{isa = PBXFileReference;/,
        add: [
          `\t\t${GD_UUID.mvcFileRef} /* MyViewController.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = MyViewController.swift; sourceTree = "<group>"; };`,
          `\t\t${GD_UUID.pluginFileRef} /* GameDebugPlugin.swift */ = {isa = PBXFileReference; includeInIndex = 1; lastKnownFileType = sourcecode.swift; name = GameDebugPlugin.swift; path = "${pluginRel}"; sourceTree = SOURCE_ROOT; };`,
        ],
      },
      { // App PBXGroup children (the group child ref — no "in Sources")
        match: /\/\* AppDelegate\.swift \*\/,$/,
        add: [
          `\t\t\t\t${GD_UUID.mvcFileRef} /* MyViewController.swift */,`,
          `\t\t\t\t${GD_UUID.pluginFileRef} /* GameDebugPlugin.swift */,`,
        ],
      },
      { // PBXSourcesBuildPhase files
        match: /\/\* AppDelegate\.swift in Sources \*\/,$/,
        add: [
          `\t\t\t\t${GD_UUID.mvcBuildFile} /* MyViewController.swift in Sources */,`,
          `\t\t\t\t${GD_UUID.pluginBuildFile} /* GameDebugPlugin.swift in Sources */,`,
        ],
      },
    ];

    // Resolve every anchor FIRST — if any is missing, bail without writing.
    const at = inserts.map((ins) => lines.findIndex((l) => ins.match.test(l)));
    if (at.every((i) => i >= 0)) {
      // Splice bottom-up so earlier indices stay valid.
      const ordered = inserts.map((ins, k) => ({ idx: at[k], add: ins.add }))
        .sort((a, b) => b.idx - a.idx);
      for (const o of ordered) lines.splice(o.idx + 1, 0, ...o.add);
      fs.writeFileSync(pbxPath, lines.join('\n'));
      notes.push('wired GameDebugPlugin into the iOS App target (pbxproj)');
    }
  }

  return notes.length ? notes.join('; ') : undefined;
}

/** Replace (or insert before the root `</dict>`) a top-level Info.plist key's
 *  value. `valueXml` is the raw value element (e.g. `<true/>` or an `<array>…`).
 *  Idempotent: re-running with the same value is a no-op-equivalent rewrite. */
function setPlistKey(text: string, key: string, valueXml: string): string {
  const keyTag = `<key>${key}</key>`;
  const i = text.indexOf(keyTag);
  if (i !== -1) {
    const after = i + keyTag.length;
    const rest = text.slice(after);
    // The value is the next XML element after the key: an array/dict/string, a
    // self-closing bool (<true/>), or a simple <integer>…</integer> etc.
    const m = rest.match(/^\s*(<array>[\s\S]*?<\/array>|<dict>[\s\S]*?<\/dict>|<[A-Za-z]+\s*\/>|<[A-Za-z]+>[\s\S]*?<\/[A-Za-z]+>)/);
    if (m) return text.slice(0, after) + '\n\t' + valueXml + rest.slice(m[0].length);
  }
  const idx = text.lastIndexOf('</dict>');
  if (idx === -1) return text;
  return text.slice(0, idx) + `\t${keyTag}\n\t${valueXml}\n` + text.slice(idx);
}

const ORIENT_STRINGS: Record<string, string[]> = {
  portrait: ['UIInterfaceOrientationPortrait'],
  landscape: ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  auto: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
};

/** Patch the iOS Info.plist to match capacitor orientation + status-bar settings:
 *  UISupportedInterfaceOrientations (+~ipad), UIStatusBarHidden,
 *  UIViewControllerBasedStatusBarAppearance (false so the plist keys apply), and
 *  UIStatusBarStyle. Idempotent. No-op when there's no ios/. */
function healIosOrientationStatusBar(projectRoot: string, cap: ProjectConfig['capacitor']): string | undefined {
  const plist = path.join(projectRoot, 'ios', 'App', 'App', 'Info.plist');
  if (!fs.existsSync(plist)) return undefined;
  let text = fs.readFileSync(plist, 'utf8');
  const orig = text;
  const toArray = (vals: string[]) => '<array>\n' + vals.map((v) => `\t\t<string>${v}</string>`).join('\n') + '\n\t</array>';
  const phone = ORIENT_STRINGS[cap.orientation] ?? ORIENT_STRINGS.auto;
  // ⚠️ THE IPAD KEY IS NOT THE PHONE KEY PLUS UPSIDE-DOWN. App Store Connect REJECTS a bundle that
  // claims iPad support (`TARGETED_DEVICE_FAMILY = "1,2"`, the Capacitor default) while declaring
  // fewer than all four orientations under `~ipad` — iPad multitasking requires every one of them:
  //
  //   "The UIInterfaceOrientationPortrait,UIInterfaceOrientationPortraitUpsideDown orientations
  //    were provided ... but you need to include all of the [four] orientations to support iPad
  //    multitasking."
  //
  // This bit a real TestFlight upload (Court, 2026-07-31). It was invisible until then because the
  // only game that had ever shipped was `auto`, which happens to emit all four; EVERY portrait game
  // was building an invalid bundle. `UIRequiresFullScreen` used to exempt an app from this and Apple
  // has retired it, so the two honest choices are "declare all four on iPad" or "do not ship on
  // iPad" (`TARGETED_DEVICE_FAMILY = 1`) — and a build pipeline should default to the one that
  // UPLOADS, since the other is a product decision nobody made by accident.
  //
  // A portrait game therefore stays portrait-only on iPhone and becomes rotatable on iPad. That is
  // Apple's rule, not a preference: the game has to survive landscape there. Court does because its
  // Canvas2D `scaleMode: 'contain'` letterboxes instead of cropping.
  const ALL_IOS_ORIENTATIONS = [
    'UIInterfaceOrientationPortrait',
    'UIInterfaceOrientationPortraitUpsideDown',
    'UIInterfaceOrientationLandscapeLeft',
    'UIInterfaceOrientationLandscapeRight',
  ];
  const pad = ALL_IOS_ORIENTATIONS;
  text = setPlistKey(text, 'UISupportedInterfaceOrientations', toArray(phone));
  text = setPlistKey(text, 'UISupportedInterfaceOrientations~ipad', toArray(pad));
  text = setPlistKey(text, 'UIStatusBarHidden', cap.statusBarHidden ? '<true/>' : '<false/>');
  // false = the app honors the Info.plist UIStatusBarHidden/UIStatusBarStyle keys
  // instead of per-view-controller code.
  text = setPlistKey(text, 'UIViewControllerBasedStatusBarAppearance', '<false/>');
  const styleMap: Record<string, string> = { default: 'UIStatusBarStyleDefault', light: 'UIStatusBarStyleLightContent', dark: 'UIStatusBarStyleDarkContent' };
  text = setPlistKey(text, 'UIStatusBarStyle', `<string>${styleMap[cap.statusBarStyle] ?? styleMap.default}</string>`);
  if (text === orig) return undefined;
  fs.writeFileSync(plist, text);
  return `synced iOS orientation (${cap.orientation}) + status bar to Info.plist`;
}

/** Patch the Android MainActivity's android:screenOrientation to match the
 *  configured orientation (auto → fullSensor). Idempotent. No-op without android/. */
function healAndroidOrientation(projectRoot: string, cap: ProjectConfig['capacitor']): string | undefined {
  const manifest = path.join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!fs.existsSync(manifest)) return undefined;
  const text = fs.readFileSync(manifest, 'utf8');
  const value = cap.orientation === 'portrait' ? 'portrait' : cap.orientation === 'landscape' ? 'landscape' : 'fullSensor';
  // Find the MainActivity <activity …> opening tag and set/replace the attribute.
  const tagRe = /<activity\b[^>]*android:name="\.MainActivity"[^>]*>/;
  const m = text.match(tagRe);
  if (!m) return undefined;
  let tag = m[0];
  if (/android:screenOrientation="[^"]*"/.test(tag)) {
    tag = tag.replace(/android:screenOrientation="[^"]*"/, `android:screenOrientation="${value}"`);
  } else {
    // Insert right after the android:name attribute.
    tag = tag.replace(/(android:name="\.MainActivity")/, `$1\n            android:screenOrientation="${value}"`);
  }
  if (tag === m[0]) return undefined;
  fs.writeFileSync(manifest, text.replace(tagRe, tag));
  return `synced Android screenOrientation=${value} (AndroidManifest)`;
}

/** The generated `<meta-data>` pointing Android's GameManager at our game-mode config,
 *  fenced like the debug-build block so the heal rewrites only its own element. */
const ANDROID_GAME_MODE_META_BEGIN = '        <!-- modoki:game-mode-begin — generated by healNativeConfig -->';
const ANDROID_GAME_MODE_META_END = '        <!-- modoki:game-mode-end -->';

/** `res/xml/game_mode_config.xml`. Written verbatim; the heal rewrites it whenever it drifts.
 *
 *  **`supports*GameMode` is `false` because we do not read the mode.** Declaring support is a
 *  promise that the app calls `GameManager.getGameMode()` and adapts itself; the engine has no
 *  binding for it at all (grep: every `GameManager` hit in `runtime/` is Modoki's own manager
 *  registry). Claiming it would be CLAUDE.md's "an unwired field is a lie with a tooltip", aimed at
 *  the OS instead of the Inspector — and the plausible cost is real: a user selecting Battery game
 *  mode gets an app that advertised it would economise and then does nothing. Both flipped from
 *  `true` during the #228 close-out review. **Flip one to `true` only in the same change that adds
 *  the `getGameMode()` binding and makes the engine act on it.**
 *
 *  The two interventions are opted OUT of, and they are what this file is actually FOR. They are
 *  Android's backward-compat handling for games that do not manage their own quality, and this
 *  engine does: `allowGameDownscaling` lets the OS drop our render resolution and
 *  `allowGameFpsOverride` lets it cap our frame rate, both behind the engine's back. An OS-imposed
 *  fps cap would also corrupt live tier calibration (#227), which reads measured frame times to
 *  decide a device's tier — it would demote a device for a slowdown the OS itself imposed. */
const ANDROID_GAME_MODE_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by Modoki (healNativeConfig). Do not hand-edit. -->
<game-mode-config
    xmlns:android="http://schemas.android.com/apk/res/android"
    android:supportsBatteryGameMode="false"
    android:supportsPerformanceGameMode="false"
    android:allowGameDownscaling="false"
    android:allowGameFpsOverride="false" />
`;

/** Declare the app a GAME to the platform — `android:appCategory="game"` on `<application>`
 *  plus a `game_mode_config.xml` resource wired by `<meta-data>` (#228).
 *
 *  Every Modoki output is a game, so this is unconditional rather than a config knob.
 *
 *  ⚠️ **This is NOT a scheduling fix, and was measured not to be one.** It was added while chasing
 *  #228 (frame-critical threads pinned to the LITTLE cluster) on the theory that the OEM
 *  game-performance path is keyed on the app being RECOGNISED as a game — no Modoki project
 *  declared either key, and `dumpsys game` reported an empty GameManagerService, so that path had
 *  never been engaged. Declaring it DID register the app (the dump now lists the package), and
 *  moved thread placement **not at all**: A/B/A on a Galaxy A23, 30 samples per arm, RenderThread
 *  on a big core 3/30 → 4/30 → 4/30, every other frame thread ~0/30, cpu7 median 985 MHz of 2203
 *  in all three arms. Do not re-run that experiment; do not cite this heal as a perf win.
 *
 *  It stays because the two intervention opt-outs below are worth having on their own, and because
 *  correct app metadata is correct regardless.
 *
 *  Both keys degrade silently on older platforms: `appCategory` is API 26+ and the game-mode
 *  config is API 33+; an older device ignores an attribute it does not know.
 *
 *  Idempotent. No-op without `android/`. */
function healAndroidGameMode(projectRoot: string): string | undefined {
  const main = path.join(projectRoot, 'android', 'app', 'src', 'main');
  const manifest = path.join(main, 'AndroidManifest.xml');
  if (!fs.existsSync(manifest)) return undefined;
  const changed: string[] = [];

  const xmlDir = path.join(main, 'res', 'xml');
  const xmlFile = path.join(xmlDir, 'game_mode_config.xml');
  const existingXml = fs.existsSync(xmlFile) ? fs.readFileSync(xmlFile, 'utf8') : undefined;
  if (existingXml !== ANDROID_GAME_MODE_CONFIG_XML) {
    fs.mkdirSync(xmlDir, { recursive: true });
    fs.writeFileSync(xmlFile, ANDROID_GAME_MODE_CONFIG_XML);
    changed.push('res/xml/game_mode_config.xml');
  }

  const orig = fs.readFileSync(manifest, 'utf8');
  let text = orig;
  const appTagRe = /<application\b[^>]*>/;
  const m = text.match(appTagRe);
  if (m) {
    // `() => tag` rather than a string: a replacement string would eat `$&`/`$1` sequences,
    // and this manifest legitimately carries `${applicationId}` elsewhere.
    const tag = /android:appCategory="[^"]*"/.test(m[0])
      ? m[0].replace(/android:appCategory="[^"]*"/, 'android:appCategory="game"')
      : m[0].replace(/<application\b/, '<application\n        android:appCategory="game"');
    text = text.replace(appTagRe, () => tag);

    const block = [
      ANDROID_GAME_MODE_META_BEGIN,
      '        <meta-data android:name="android.game_mode_config" android:resource="@xml/game_mode_config" />',
      ANDROID_GAME_MODE_META_END,
    ].join('\n');
    const fenceRe = new RegExp(`[ \\t]*${escapeRe(ANDROID_GAME_MODE_META_BEGIN.trim())}[\\s\\S]*?${escapeRe(ANDROID_GAME_MODE_META_END.trim())}`);
    if (fenceRe.test(text)) {
      text = text.replace(fenceRe, () => block);
    } else {
      const close = text.lastIndexOf('</application>');
      if (close !== -1) {
        const lineStart = text.lastIndexOf('\n', close) + 1;
        text = text.slice(0, lineStart) + block + '\n' + text.slice(lineStart);
      }
    }
  }
  if (text !== orig) {
    fs.writeFileSync(manifest, text);
    changed.push('AndroidManifest');
  }
  if (changed.length === 0) return undefined;
  return `synced Android game mode: appCategory=game + game_mode_config (${changed.join(', ')})`;
}

/** The generated `<meta-data>` that carries `build.debugBuild` into the Android app,
 *  fenced by XML comments so the heal rewrites only its own element. */
const ANDROID_DEBUG_META_BEGIN = '        <!-- modoki:debug-build-begin — generated from project.config.json (build.debugBuild) -->';
const ANDROID_DEBUG_META_END = '        <!-- modoki:debug-build-end -->';
/** Must match `GameDebugPlugin.META_DEBUG_BUILD`. */
const ANDROID_DEBUG_META_NAME = 'com.modokiengine.gamedebug.DEBUG_BUILD';

/** iOS Info.plist mirror of {@link ANDROID_DEBUG_META_NAME}. Read by
 *  `GameDebugPlugin.swift`'s `isDebugBuildEnabled()` (#278). */
const IOS_DEBUG_BUILD_PLIST_KEY = 'ModokiDebugBuild';

/** Sync `build.debugBuild` into the Android app as an AndroidManifest `<meta-data>`
 *  the game-debug plugin reads (#112).
 *
 *  Android's gate used to be `ApplicationInfo.FLAG_DEBUGGABLE` — the APK's own debuggable
 *  flag, i.e. the Gradle build type. Same defect as iOS's `#if DEBUG`: a `debugBuild:true`
 *  project assembled as a release variant shipped the JS bridge with a native plugin that
 *  refuses to start, and said only "Debug bridge disabled in release builds".
 *
 *  Why meta-data and not `BuildConfig`: the plugin is a LIBRARY module, so it cannot
 *  reference the app module's generated `BuildConfig` class by name. Manifest meta-data is
 *  the standard way an app hands a value to a library, and this file is already healed
 *  (orientation, fullscreen). Absent meta-data reads as FALSE in the plugin — fail closed,
 *  so a project that has not been reopened since this change loses the bridge rather than
 *  silently keeping it. */
function healAndroidDebugBuildMetaData(projectRoot: string, debugBuild: boolean): string | undefined {
  const manifest = path.join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!fs.existsSync(manifest)) return undefined;
  const orig = fs.readFileSync(manifest, 'utf8');
  const block = [
    ANDROID_DEBUG_META_BEGIN,
    `        <meta-data android:name="${ANDROID_DEBUG_META_NAME}" android:value="${debugBuild}" />`,
    ANDROID_DEBUG_META_END,
  ].join('\n');

  const fenceRe = new RegExp(`[ \\t]*${escapeRe(ANDROID_DEBUG_META_BEGIN.trim())}[\\s\\S]*?${escapeRe(ANDROID_DEBUG_META_END.trim())}`);
  let text: string;
  if (fenceRe.test(orig)) {
    text = orig.replace(fenceRe, block);
  } else {
    // Insert as the last child of <application>.
    const close = orig.lastIndexOf('</application>');
    if (close === -1) return undefined; // not a Capacitor manifest — bail safely
    const lineStart = orig.lastIndexOf('\n', close) + 1;
    text = orig.slice(0, lineStart) + block + '\n' + orig.slice(lineStart);
  }
  if (text === orig) return undefined;
  fs.writeFileSync(manifest, text);
  return `synced Android ${ANDROID_DEBUG_META_NAME}=${debugBuild} (from build.debugBuild)`;
}

/** Sync the iOS Info.plist's `ModokiDebugBuild` flag from `build.debugBuild` — the iOS MIRROR of
 *  {@link healAndroidDebugBuildMetaData}, and the gate the plugin's fault triggers read (#278).
 *
 *  Until this existed, `GameDebugPlugin.swift` checked NOTHING: Android refuses every plugin
 *  method unless its manifest meta-data is on, while iOS kept the bridge out of shipped games only
 *  because JS never called `startServer`. That asymmetry was harmless for a server nobody starts
 *  and is not harmless for `triggerFault`, which kills the app on demand — a release binary must
 *  not carry a reachable way to do that.
 *
 *  Written BOTH ways (true and false), like the Local Network keys and unlike a
 *  write-once flag: a project that turns `debugBuild` off must lose the capability on the next
 *  heal, not keep it because the key was already there.
 *
 *  The KEY NAME is the contract with `GameDebugPlugin.debugBuildPlistKey` — keep them in sync. */
function healIosDebugBuildInfoPlist(projectRoot: string, debugBuild: boolean): string | undefined {
  const plist = path.join(projectRoot, 'ios', 'App', 'App', 'Info.plist');
  if (!fs.existsSync(plist)) return undefined;
  const orig = fs.readFileSync(plist, 'utf8');
  const text = setPlistKey(orig, IOS_DEBUG_BUILD_PLIST_KEY, debugBuild ? '<true/>' : '<false/>');
  if (text === orig) return undefined;
  fs.writeFileSync(plist, text);
  return `synced iOS ${IOS_DEBUG_BUILD_PLIST_KEY}=${debugBuild} (from build.debugBuild)`;
}

/** Sync the iOS deployment target from `build.iosMinVersion`.
 *
 *  This is the NATIVE half of the same floor the JS bundle is built against (vite.config.ts
 *  `build.target`). They were two independent hardcoded numbers and they disagreed: every
 *  project's pbxproj said `IPHONEOS_DEPLOYMENT_TARGET = 15.0` while the bundle required 15.4,
 *  so the App Store would happily offer the game to a 15.0–15.3 device — which installs it,
 *  boots, and dies on `structuredClone`/`Array.at`/`Object.hasOwn`. Driving both from one
 *  config value is what stops that reappearing.
 *
 *  Rewrites EVERY occurrence (`replace_all`): a Capacitor pbxproj carries the key once per
 *  build configuration, and healing only the first leaves Release on the old floor — the
 *  configuration that actually ships. */
function healIosDeploymentTarget(projectRoot: string, minVersion: string): string | undefined {
  if (!/^\d+(\.\d+)?$/.test(minVersion)) return undefined; // junk config → leave the project alone
  const pbx = path.join(projectRoot, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(pbx)) return undefined;
  const orig = fs.readFileSync(pbx, 'utf8');
  const text = orig.replace(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${minVersion};`);
  if (text === orig) return undefined;
  fs.writeFileSync(pbx, text);
  return `synced iOS deployment target = ${minVersion} (from build.iosMinVersion)`;
}

/** Sync the SPM package's iOS floor — the SECOND native deployment floor, and the one nothing
 *  healed until now.
 *
 *  `ios/App/CapApp-SPM/Package.swift` declares `platforms: [.iOS(.vNN)]` independently of the
 *  pbxproj's `IPHONEOS_DEPLOYMENT_TARGET`. {@link healIosDeploymentTarget} rewrote only the
 *  latter, so raising `build.iosMinVersion` moved one floor and left the other — exactly the
 *  per-project drift that config value exists to prevent, reintroduced one file over. Measured
 *  after the 15.4 → 16.4 raise (2026-08-04): every project's pbxproj read 16.4 while SIX of nine
 *  `Package.swift` files still said `.v15`. Only the three that happened to get a later
 *  `cap sync` had moved, which is the tell — the floor was tracking *who ran what*, not config.
 *
 *  **Coarser than the pbxproj floor, deliberately.** SPM's `SupportedPlatform` enumerates MAJOR
 *  versions (`.v16`), so 16.4 floors to `.v16` and the package permits 16.0–16.3 while the app
 *  requires 16.4. That is harmless (a package minimum below the app's target always builds) and
 *  it is exactly what Capacitor's own generator emits from the same pbxproj value — so this heal
 *  AGREES with `cap sync` rather than fighting it, which matters for a file whose header reads
 *  "DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands". We rewrite it for the same
 *  reason we rewrite the equally Capacitor-generated pbxproj: regeneration is occasional and
 *  manual, and the floor must not wait for it.
 *
 *  Scoped to the FIRST `platforms:` array rather than replacing `.iOS(.vNN)` file-wide — a
 *  dependency clause could legitimately carry its own platform requirement, and stamping the app's
 *  floor onto that would be wrong. This relies on the package's own `platforms:` preceding any
 *  dependency's (it sits directly under `name:` in every Capacitor-generated layout), not on
 *  parsing Swift — a deliberate trade, since the alternative is a Swift parser for one integer. */
function healIosSpmPlatform(projectRoot: string, minVersion: string): string | undefined {
  if (!/^\d+(\.\d+)?$/.test(minVersion)) return undefined; // junk config → leave the project alone
  const major = parseInt(minVersion, 10);
  if (!Number.isInteger(major) || major <= 0) return undefined;
  const pkg = path.join(projectRoot, 'ios', 'App', 'CapApp-SPM', 'Package.swift');
  if (!fs.existsSync(pkg)) return undefined;
  const orig = fs.readFileSync(pkg, 'utf8');
  const text = orig.replace(
    /(platforms:\s*\[)([^\]]*)\]/,
    (_m, head: string, body: string) => head + body.replace(/\.iOS\(\.v\d+(?:_\d+)?\)/g, `.iOS(.v${major})`) + ']',
  );
  if (text === orig) return undefined;
  fs.writeFileSync(pkg, text);
  return `synced iOS SPM platform = .v${major} (from build.iosMinVersion ${minVersion})`;
}

/** Sync the Android minSdkVersion from `build.androidMinSdk` — the Android sibling of
 *  {@link healIosDeploymentTarget}.
 *
 *  `cap add` scaffolds `android/variables.gradle` with `minSdkVersion = 24` and nothing
 *  ever revisits it, so without this heal every newly-scaffolded project silently ships
 *  API 24 and the floor drifts per-project — exactly the class of drift `iosMinVersion`
 *  was introduced to close on iOS.
 *
 *  Rewrites EVERY occurrence (`replace_all`): mirrors the pbxproj reasoning — heal every
 *  match rather than just the first, so a duplicated/aliased assignment can't be left on
 *  the old floor. */
function healAndroidMinSdk(projectRoot: string, minSdk: number): string | undefined {
  if (!Number.isInteger(minSdk) || minSdk < 21 || minSdk > 99) return undefined; // junk config → leave the project alone
  const gradle = path.join(projectRoot, 'android', 'variables.gradle');
  if (!fs.existsSync(gradle)) return undefined;
  const orig = fs.readFileSync(gradle, 'utf8');
  const text = orig.replace(/minSdkVersion\s*=\s*\d+/g, `minSdkVersion = ${minSdk}`);
  if (text === orig) return undefined;
  fs.writeFileSync(gradle, text);
  return `synced Android minSdkVersion = ${minSdk} (from build.androidMinSdk)`;
}

/** A marketing version is free-form but must not be junk we paste into a gradle string or a
 *  pbxproj literal. Dotted digits only — what both stores accept and what every scaffold writes. */
function isMarketingVersion(v: unknown): v is string {
  return typeof v === 'string' && /^\d+(\.\d+)*$/.test(v) && v.length <= 32;
}

/** A build number is the monotonic integer both stores dedupe by. */
function isBuildNumber(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) > 0 && (n as number) < 2_100_000_000;
}

/** What a native file currently says about its build number — the input to the never-lower
 *  decision below. Three cases, and the third is the one that matters: a value we cannot ORDER
 *  against is not the same as no value, and treating it as "no value" would let the write proceed
 *  unguarded. */
type ExistingBuild =
  | { kind: 'none' }                       // the key is not in this file — nothing to protect
  | { kind: 'ok'; max: number }            // every occurrence is a plain integer
  | { kind: 'unreadable'; why: string };   // present, but not comparable

/** Read the build number a native file currently carries.
 *
 *  Returns the MAX of the occurrences, not the first: a pbxproj carries the key once per build
 *  configuration and a gradle file could carry it per flavour, so "what is this project at" is the
 *  highest of them — reading the first would let a Debug-only 1 authorise lowering a Release 11.
 *
 *  ⚠️ **`unreadable` is load-bearing, not defensive tidiness.** Two shapes reach it, and both
 *  silently defeated the never-lower guard before it existed:
 *   - a **dotted** value. `CURRENT_PROJECT_VERSION = 1.2;` is legal (Apple compares CFBundleVersion
 *     component-wise, so 1.2 > 1), but it is not an integer to compare. Skipping it left `current`
 *     null, the guard's `current !== null` false, and the write LOWERED 1.2 to 1 — the exact
 *     rejection this whole heal exists to prevent, produced by the code preventing it.
 *   - a value the regex cannot see at all, which is how this breaks NEXT: AGP 8 writes
 *     `versionCode = 1`, and these very build.gradle files already mix that assignment syntax
 *     (`namespace = `, `compileSdk = `). The patterns below accept both forms now, but the point
 *     of this branch is that a THIRD form arriving later is reported rather than silently
 *     unmanaged. */
function readExistingBuild(text: string, re: RegExp, key: string): ExistingBuild {
  let best: number | null = null;
  let dotted = false;
  let found = false;
  for (const m of text.matchAll(re)) {
    found = true;
    const raw = m[m.length - 1];
    if (!/^\d+$/.test(raw)) { dotted = true; continue; }
    const n = parseInt(raw, 10);
    if (best === null || n > best) best = n;
  }
  if (dotted) {
    return { kind: 'unreadable', why: `${key} is not a plain integer here, so it cannot be ordered against` };
  }
  if (!found) {
    // The key is in the file but in a shape the pattern does not match (a variable reference, or a
    // syntax we have not met). Saying so beats writing nothing and reporting nothing.
    return text.includes(key)
      ? { kind: 'unreadable', why: `${key} is present but not in a form this heal can read` }
      : { kind: 'none' };
  }
  return { kind: 'ok', max: best! };
}

/** The never-lower decision, shared so both platforms cannot drift apart. Returns whether to write
 *  and, when not, the note explaining it — a refusal the owner never sees is a refusal that reads
 *  as "the number I typed is the number that ships". */
function decideBuildWrite(
  existing: ExistingBuild,
  buildNumber: number,
  label: string,
  store: string,
): { write: boolean; note?: string } {
  if (existing.kind === 'unreadable') {
    return { write: false, note: `left ${label} alone: ${existing.why}. Set it by hand, or normalise it to a plain integer so app.buildNumber can manage it.` };
  }
  if (existing.kind === 'ok' && existing.max > buildNumber) {
    return {
      write: false,
      note:
        `REFUSED to lower ${label} ${existing.max} -> ${buildNumber}: ${store} rejects a build ` +
        `number it has already seen, and does it silently. Raise app.buildNumber to at least ` +
        `${existing.max + 1} before the next upload.`,
    };
  }
  return { write: true };
}

/** Resolve the effective build number this heal pass writes to the native files.
 *
 *  With `app.buildNumberAuto` FALSE, `app.buildNumber` passes straight through. TRUE — the
 *  "Auto" checkbox — the typed value is IGNORED and the number is derived from
 *  `git rev-list --count HEAD` of the project's repo, keeping the typed value as a FLOOR —
 *  so a store-forced jump still wins without turning auto off, and both stores keep seeing one
 *  number that only moves up (the never-lower guard below stays the last line of defence either
 *  way). A project copied out of its repo has no git; that falls back to the config value with
 *  a note rather than failing the whole heal. */
export function resolveBuildNumber(projectRoot: string, cfg: ProjectConfig): { value: number; note?: string } {
  if (!cfg.app.buildNumberAuto) return { value: cfg.app.buildNumber };
  const floor = cfg.app.buildNumber;
  let count: number | null = null;
  try {
    const r = spawnSync('git', ['-C', projectRoot, 'rev-list', '--count', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (r.status === 0 && r.stdout) {
      const n = parseInt(String(r.stdout).trim(), 10);
      if (Number.isInteger(n) && n >= 0) count = n;
    }
  } catch {
    // fall through to the fallback below
  }
  if (count === null) {
    return {
      value: floor,
      note: 'build number source is git commits, but no commit count could be read (not a git repo, or git failed) — using app.buildNumber',
    };
  }
  // The floor wins when the owner typed a jump past the count (or the count is somehow lower).
  if (floor >= count) {
    return { value: floor, note: `build number ${floor} = app.buildNumber floor (git reports ${count} commits)` };
  }
  return { value: count, note: `build number ${count} derived from git commit count` };
}

/** The bundle id a config may legally contribute to native files — same shape rule as
 *  {@link validateBuildConfig}'s BUILD_FIELD_RULES. An invalid id is REFUSED here (with a note)
 *  rather than written everywhere: garbage in a pbxproj breaks the build in four files at once,
 *  and the settings save already validates the field on its own path. */
function usableIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return /^[A-Za-z0-9._-]+$/.test(v) ? v : undefined;
}

/** Escape a value for XML CHARACTER DATA (`<string>here</string>`, `<key>` bodies).
 *
 *  ⚠️ Unlike {@link usableIdentity}'s bundle id, `app.appName` is a DISPLAY name and must stay
 *  free text — "Rock & Roll" is a legitimate app name, and restricting the charset to make the
 *  writes below safe would be fixing the wrong end. It has no `BUILD_FIELD_RULES` pattern behind
 *  it either, so it arrives here exactly as typed. Unescaped, a single `&` makes `strings.xml`
 *  fatally malformed (AAPT2: "not well-formed (invalid token)") and `Info.plist` unparseable —
 *  from a value the owner typed into Project Settings, written by a heal that runs on every
 *  open/build, into two COMMITTED files. */
function xmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape a value for an Android `<string>` resource — XML escaping PLUS the AAPT2-specific
 *  rules plain XML does not have. An unescaped apostrophe is a hard build error ("Apostrophe not
 *  preceded by \\"), and a leading `@` or `?` would be read as a resource reference rather than
 *  as text. "Cat's Court" is the case that makes this not hypothetical. */
function androidResText(value: string): string {
  const escaped = xmlText(value).replace(/(["'\\])/g, '\\$1');
  return /^[@?]/.test(escaped) ? `\\${escaped}` : escaped;
}

/** Replace with a LITERAL string — never a replacement PATTERN.
 *
 *  ⚠️ Why a replacer FUNCTION rather than `text.replace(re, `$1${v}$2`)`: in a replacement
 *  string `$&`, `$1`, `` $` `` and `$'` are substitution directives, so a value containing one is
 *  INJECTED rather than inserted. An app name of "Court $& Co" turned `<string name="app_name">`
 *  into a nested duplicate of itself and, in `Info.plist`, swallowed the preceding `<key>` line
 *  outright — structural corruption of a committed file from a plausible display name. A
 *  function replacer has no such syntax. */
function replaceAllIfMatches(text: string, re: RegExp, value: string): { text: string; changed: boolean } {
  const next = text.replace(re, (_m, open: string, close: string) => `${open}${value}${close}`);
  return { text: next, changed: next !== text };
}

/** Sync `app.appId` / `app.appName` into every native file that carries them.
 *
 *  These were WRITE-ONCE before this heal existed: `cap add` baked them into the pbxproj,
 *  build.gradle, strings.xml, Info.plist and capacitor.config.json at scaffold time, and
 *  `ensureCapacitorConfig` deliberately never clobbers an existing file — so changing Project
 *  Settings afterwards changed NOTHING anywhere (the audit that added this, 2026-08-25).
 *
 *  ⚠️ **A changed appId is a NEW app to both stores** — previously uploaded builds and installed
 *  updates no longer connect to it. That trade-off belongs to the owner, so the heal performs it
 *  but says so loudly every time it rewrites an id. A name change is cosmetic and only noted.
 *
 *  Per-file, diff-before-write (a matching file is left byte-identical):
 *   - capacitor.config.json   → `appId` / `appName`
 *   - android/app/build.gradle → `applicationId "…"` (NOT `namespace` — that is the code
 *     package and renaming it strands MainActivity's package path)
 *   - android strings.xml      → `package_name` + `custom_url_scheme` (id),
 *     `app_name` + `title_activity_main` (name); AndroidManifest labels reference these
 *   - iOS pbxproj              → `PRODUCT_BUNDLE_IDENTIFIER` (every build configuration);
 *     Info.plist's CFBundleIdentifier reads it via `$(PRODUCT_BUNDLE_IDENTIFIER)`
 *   - iOS Info.plist           → `CFBundleDisplayName` (name) */
export function healAppIdentity(projectRoot: string, appId: unknown, appName: unknown): string[] {
  const notes: string[] = [];
  const id = usableIdentity(appId);
  const name = typeof appName === 'string' && appName.trim() ? appName.trim() : undefined;
  if (appId != null && id === undefined) notes.push(`REFUSED to sync app.appId ${JSON.stringify(appId)}: not a valid bundle id (letters, digits, dots, dashes, underscores only).`);
  if (!id && !name) return notes;

  /** The app's PREVIOUS bundle id — the anchor that keeps the rewrite scoped. The pbxproj may
   *  legitimately carry OTHER targets' ids (`com.x.y.widget` for an extension) and a gradle
   *  file may carry flavour ids (`com.x.y.free`); replacing every occurrence would silently
   *  rename those to the app's id and break their embedding. Only values equal to the old id
   *  move. Sourced from capacitor.config.json — the same file `cap add` baked the native
   *  ids FROM — so when it is unreadable there is no safe anchor and the id half is SKIPPED
   *  with a note rather than guessed. */
  let oldId: string | undefined;
  let idChangedFrom: string | undefined;
  let idSkipNoted = false;

  /** Per-file guard: one unreadable/unwritable file must not abort the heals AFTER identity
   *  (orientation, game-mode, crashlytics…) the way a throw through main()'s outer catch
   *  would — partial state plus a generic "heal skipped" note hid both the failure and what
   *  it prevented. Each file reports its own failure; the pass continues. */
  const guarded = (label: string, fn: () => void): boolean => {
    try {
      fn();
      return true;
    } catch (e) {
      notes.push(`${label} sync failed (${e instanceof Error ? e.message : String(e)}) — remaining identity files were still attempted`);
      return false;
    }
  };

  /** Set when an ID-BEARING native file (gradle / pbxproj) failed to sync. Gates the anchor —
   *  see the capacitor.config.json banner below. `appName` is unaffected: it anchors nothing, so
   *  a failed name write costs only that file and is retried on its own next pass. */
  let idWriteFailed = false;

  // capacitor.config.json — parsed + rewritten as JSON so any shape survives; this file IS
  // machine-generated (ensureCapacitorConfig writes JSON.stringify(…, null, 2)), so comparing
  // SERIALIZED forms is fair: only a real field change produces a diff.
  //
  // ⚠️ READ HERE, WRITTEN LAST — the two halves are deliberately split around the native files.
  // This file is the ANCHOR: `oldId` is what scopes every rewrite below, and it is recoverable
  // from nowhere else. Writing the new id here FIRST (as this did) means a gradle or pbxproj
  // write that then fails — which `guarded` catches by design, so the pass continues — leaves the
  // anchor on the NEW id while those files still hold the OLD one. The next pass reads the new
  // id, its scoped regex matches nothing, and it reports no change: the divergence is permanent
  // and SILENT, and the per-file guard that made the failure survivable is exactly what made it
  // unrecoverable. Committing the anchor last, and only when the id-bearing writes SUCCEEDED,
  // makes a partial failure retryable instead.
  const capPath = path.join(projectRoot, 'capacitor.config.json');
  let capJson: Record<string, unknown> | undefined;
  guarded('capacitor.config.json', () => {
    if (!fs.existsSync(capPath)) return;
    try {
      const json = JSON.parse(fs.readFileSync(capPath, 'utf8')) as Record<string, unknown>;
      if (typeof json.appId === 'string' && json.appId) oldId = json.appId;
      capJson = json;
    } catch {
      notes.push('capacitor.config.json exists but does not parse — identity not synced there');
    }
  });

  /** Commit the anchor. Called only after every native file has had its turn — see the banner
   *  above for why the ordering is load-bearing rather than incidental. */
  const writeCapacitorConfig = (): void => {
    guarded('capacitor.config.json', () => {
      const json = capJson;
      if (!json) return;
      const before = JSON.stringify(json, null, 2) + '\n';
      if (id && json.appId !== id && idWriteFailed) {
        notes.push(
          'capacitor.config.json appId left at the OLD id because an id-bearing native file '
          + 'failed to sync — it is the anchor those rewrites are scoped to, so advancing it now '
          + 'would strand them permanently. Fix the failure above; the next open/build retries.',
        );
      } else if (id && json.appId !== id) {
        if (typeof json.appId === 'string' && json.appId) idChangedFrom = json.appId;
        json.appId = id;
      }
      if (name && json.appName !== name) json.appName = name;
      const out = JSON.stringify(json, null, 2) + '\n';
      if (out !== before) {
        fs.writeFileSync(capPath, out);
        notes.push('synced capacitor.config.json identity');
      }
    });
  };

  /** Scoped id replacement for gradle/pbxproj. Returns whether anything moved. */
  const replaceScoped = (text: string, re: RegExp, to: string): { text: string; changed: boolean } => {
    const next = text.replace(re, to);
    return { text: next, changed: next !== text };
  };
  /** Emit once, not per file, when the old id could not be anchored. */
  const noteIdSkipped = (): void => {
    // ⚠️ This ALSO blocks the anchor, and that is the point — the invariant the anchor gate has
    // to express is "did the id LAND?", not "did anything throw?". Reaching here is the second,
    // NON-throwing way for the id rewrite to not happen: with no `oldId` there is nothing to
    // scope on, so gradle/pbxproj are skipped and `guarded()` still returns true. Gating the
    // anchor on exceptions alone let that case commit the new id anyway, which is exactly the
    // permanent silent divergence this whole ordering exists to prevent, reached through the
    // other door. Concretely: a capacitor.config.json that PARSES but carries no `appId` leaves
    // gradle on the old id, advances the anchor to the new one, and every later pass then
    // searches for an id the file does not contain, finds nothing, and reports NOTHING.
    idWriteFailed = true;
    if (idSkipNoted) return;
    idSkipNoted = true;
    notes.push('cannot determine this project\'s previous bundle id (capacitor.config.json missing or unreadable) — applicationId/PRODUCT_BUNDLE_IDENTIFIER NOT rewritten; fix or restore capacitor.config.json first');
  };

  // Android half.
  const gradle = path.join(projectRoot, 'android', 'app', 'build.gradle');
  if (!guarded('build.gradle', () => {
    if (!fs.existsSync(gradle)) return;
    const orig = fs.readFileSync(gradle, 'utf8');
    let text = orig;
    if (id) {
      if (!oldId) noteIdSkipped();
      else {
        const r = replaceScoped(text, new RegExp(`applicationId\\s+"${oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'), `applicationId "${id}"`);
        if (r.changed) {
          text = r.text;
          idChangedFrom = idChangedFrom ?? oldId;
          notes.push('synced applicationId (build.gradle)');
        }
      }
    }
    if (text !== orig) fs.writeFileSync(gradle, text);
  })) idWriteFailed = true;
  const strings = path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  guarded('strings.xml', () => {
    if (!fs.existsSync(strings)) return;
    const orig = fs.readFileSync(strings, 'utf8');
    let text = orig;
    // Every write below goes through `replaceAllIfMatches` (a literal replacer, never a
    // replacement PATTERN) and an escaper. The id needs neither in principle — `usableIdentity`
    // already bars `$`, `&` and `<` — but routing it the same way makes the safe path the ONLY
    // path here, rather than a property of one field a later edit could forget.
    if (id) {
      // package_name / custom_url_scheme ARE the app id by definition — no scoping needed.
      text = replaceAllIfMatches(text, /(<string name="package_name">)[^<]*(<\/string>)/g, androidResText(id)).text;
      text = replaceAllIfMatches(text, /(<string name="custom_url_scheme">)[^<]*(<\/string>)/g, androidResText(id)).text;
    }
    if (name) {
      text = replaceAllIfMatches(text, /(<string name="app_name">)[^<]*(<\/string>)/g, androidResText(name)).text;
      text = replaceAllIfMatches(text, /(<string name="title_activity_main">)[^<]*(<\/string>)/g, androidResText(name)).text;
    }
    if (text !== orig) {
      fs.writeFileSync(strings, text);
      notes.push('synced strings.xml identity (app_name/package_name)');
    }
  });

  // iOS half.
  const pbx = path.join(projectRoot, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!guarded('pbxproj', () => {
    if (!fs.existsSync(pbx)) return;
    const orig = fs.readFileSync(pbx, 'utf8');
    if (id) {
      if (!oldId) noteIdSkipped();
      else {
        const esc = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const r = replaceScoped(orig, new RegExp(`PRODUCT_BUNDLE_IDENTIFIER = ${esc};`, 'g'), `PRODUCT_BUNDLE_IDENTIFIER = ${id};`);
        if (r.changed) {
          fs.writeFileSync(pbx, r.text);
          idChangedFrom = idChangedFrom ?? oldId;
          notes.push('synced PRODUCT_BUNDLE_IDENTIFIER (pbxproj)');
        }
      }
    }
  })) idWriteFailed = true;
  const plist = path.join(projectRoot, 'ios', 'App', 'App', 'Info.plist');
  guarded('Info.plist', () => {
    if (!fs.existsSync(plist) || !name) return;
    const orig = fs.readFileSync(plist, 'utf8');
    const { text, changed } = replaceAllIfMatches(
      orig,
      /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/g,
      // Plain XML here, NOT `androidResText` — a plist has no AAPT2 apostrophe rule, and
      // backslash-escaping an apostrophe would put the backslash in the displayed name.
      xmlText(name),
    );
    if (changed) {
      fs.writeFileSync(plist, text);
      notes.push('synced CFBundleDisplayName (Info.plist)');
    }
  });

  // The anchor, committed only now that every native file has had its turn.
  writeCapacitorConfig();

  if (idChangedFrom) {
    notes.push(
      `WARNING: bundle id changed ${idChangedFrom} -> ${id} — to both stores this is a NEW app; ` +
      'previously uploaded builds and installed updates no longer connect to it.',
    );
  }
  return notes;
}

/** Sync the Android marketing version + build number from `app.version` / `app.buildNumber`.
 *
 *  ⚠️ **`versionCode` is never LOWERED.** Play refuses a `versionCode` it has already seen and
 *  does so SILENTLY — the bundle never attaches and the release page reports three errors that
 *  all mean "this release is empty", none of which mention versions (#199). So a config value
 *  BELOW what the project already carries is the single most expensive thing this heal could
 *  write, and it is exactly what a stale config, a fresh clone, or a forgotten bump produces.
 *  The refusal is reported rather than swallowed: the owner has to see that the number they
 *  edited is not the number that will ship.
 *
 *  `versionName` has no such rule — it is a display string with no ordering requirement, so it
 *  is synced in both directions.
 *
 *  Rewrites EVERY occurrence, mirroring healAndroidMinSdk/healIosDeploymentTarget: a flavoured
 *  gradle file can carry the keys more than once and healing only the first leaves the shipping
 *  variant behind. */
function healAndroidVersion(projectRoot: string, version: unknown, buildNumber: unknown): string | undefined {
  const gradle = path.join(projectRoot, 'android', 'app', 'build.gradle');
  if (!fs.existsSync(gradle)) return undefined;
  const orig = fs.readFileSync(gradle, 'utf8');
  let text = orig;
  const notes: string[] = [];

  // Both the Groovy (`versionCode 1`) and the AGP-8 assignment (`versionCode = 1`) forms, with the
  // file's OWN separator preserved on write — these build.gradle files already mix the two
  // (`namespace = `, `compileSdk = `), so normalising one to the other would be a gratuitous diff.
  if (isMarketingVersion(version)) {
    text = text.replace(/(versionName)(\s*=\s*|\s+)"[^"]*"/g, (_m, k: string, sep: string) => `${k}${sep}"${version}"`);
  }

  if (isBuildNumber(buildNumber)) {
    const decision = decideBuildWrite(
      readExistingBuild(text, /versionCode(?:\s*=\s*|\s+)([0-9.]+)/g, 'versionCode'),
      buildNumber, 'Android versionCode', 'Play',
    );
    if (decision.note) notes.push(decision.note);
    if (decision.write) {
      text = text.replace(/(versionCode)(\s*=\s*|\s+)[0-9.]+/g, (_m, k: string, sep: string) => `${k}${sep}${buildNumber}`);
    }
  }

  if (text !== orig) {
    fs.writeFileSync(gradle, text);
    notes.unshift(`synced Android versionName/versionCode (from app.version/app.buildNumber)`);
  }
  return notes.length > 0 ? notes.join(' — ') : undefined;
}

/** The iOS half — `MARKETING_VERSION` (read by Info.plist as `CFBundleShortVersionString` through
 *  `$(MARKETING_VERSION)`) and `CURRENT_PROJECT_VERSION` (`CFBundleVersion`). Same never-lower
 *  rule as {@link healAndroidVersion}: App Store Connect refuses a duplicate `CFBundleVersion`
 *  with an equally indirect message.
 *
 *  ⚠️ The two platforms' counters drift APART in practice — `games/iap-test` measured Android 11
 *  against iOS 5 (2026-08-20), because each store counts its own uploads. One `app.buildNumber`
 *  still serves both: the stores only require the number to RISE, so the lagging platform takes a
 *  one-time jump to catch up and both stay valid from then on. That jump is why the never-lower
 *  guard is per-platform rather than computed once. */
function healIosVersion(projectRoot: string, version: unknown, buildNumber: unknown): string | undefined {
  const pbx = path.join(projectRoot, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(pbx)) return undefined;
  const orig = fs.readFileSync(pbx, 'utf8');
  let text = orig;
  const notes: string[] = [];

  if (isMarketingVersion(version)) {
    text = text.replace(/MARKETING_VERSION = [0-9.]+;/g, `MARKETING_VERSION = ${version};`);
  }

  if (isBuildNumber(buildNumber)) {
    const decision = decideBuildWrite(
      readExistingBuild(text, /CURRENT_PROJECT_VERSION = ([0-9.]+);/g, 'CURRENT_PROJECT_VERSION'),
      buildNumber, 'iOS CURRENT_PROJECT_VERSION', 'App Store Connect',
    );
    if (decision.note) notes.push(decision.note);
    if (decision.write) {
      text = text.replace(/CURRENT_PROJECT_VERSION = [0-9.]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`);
    }
  }

  if (text !== orig) {
    fs.writeFileSync(pbx, text);
    notes.unshift(`synced iOS MARKETING_VERSION/CURRENT_PROJECT_VERSION (from app.version/app.buildNumber)`);
  }
  return notes.length > 0 ? notes.join(' — ') : undefined;
}

/** The generated immersive-mode block in MainActivity.java. Fenced by marker comments so the
 *  heal can find, replace, or remove exactly its own code and never touch a hand edit. */
const IMMERSIVE_BEGIN = '    // modoki:immersive-begin — generated from project.config.json (capacitor.statusBarHidden)';
const IMMERSIVE_END = '    // modoki:immersive-end';
const IMMERSIVE_IMPORTS = [
  'import android.os.Build;',
  'import android.os.Bundle;',
  'import android.view.WindowManager;',
  'import androidx.core.view.WindowCompat;',
  'import androidx.core.view.WindowInsetsCompat;',
  'import androidx.core.view.WindowInsetsControllerCompat;',
];
const IMMERSIVE_BODY = [
  IMMERSIVE_BEGIN,
  '    @Override',
  '    public void onCreate(Bundle savedInstanceState) {',
  '        super.onCreate(savedInstanceState);',
  '        applyImmersiveMode();',
  '    }',
  '',
  '    // The bars re-appear whenever the window loses and regains focus (notification shade, a',
  '    // permission dialog, task switch), so hiding once in onCreate is NOT enough — re-apply.',
  '    @Override',
  '    public void onWindowFocusChanged(boolean hasFocus) {',
  '        super.onWindowFocusChanged(hasFocus);',
  '        if (hasFocus) applyImmersiveMode();',
  '    }',
  '',
  '    private void applyImmersiveMode() {',
  '        // Lay the window out INTO the display cutout. `setDecorFitsSystemWindows(false)`',
  '        // below only opts out of fitting the system BARS — without this the window is',
  '        // still placed beneath the cutout, and because the bars are hidden nothing draws',
  '        // there: the window background shows through as a black band (measured 59px on a',
  '        // Galaxy A23). It is also what makes `env(safe-area-inset-*)` report anything at',
  '        // all — a window that never reaches the cutout has no inset to tell CSS about.',
  '        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {',
  '            WindowManager.LayoutParams lp = getWindow().getAttributes();',
  '            lp.layoutInDisplayCutoutMode =',
  '                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;',
  '            getWindow().setAttributes(lp);',
  '        }',
  '        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);',
  '        WindowInsetsControllerCompat c =',
  '            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());',
  '        if (c != null) {',
  '            c.hide(WindowInsetsCompat.Type.systemBars());',
  '            c.setSystemBarsBehavior(',
  '                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);',
  '        }',
  '    }',
  IMMERSIVE_END,
].join('\n');

/** Locate the generated `MainActivity.java` (its package dir mirrors the appId, so glob for it). */
function findMainActivity(projectRoot: string): string | undefined {
  const javaRoot = path.join(projectRoot, 'android', 'app', 'src', 'main', 'java');
  if (!fs.existsSync(javaRoot)) return undefined;
  const stack = [javaRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'MainActivity.java') return p;
    }
  }
  return undefined;
}

/** Hide BOTH Android system bars (status + navigation) when `capacitor.statusBarHidden` is set.
 *
 *  Why this exists: `statusBarHidden` was honoured ONLY on iOS (Info.plist UIStatusBarHidden) even
 *  though the config field's own contract promises an Android fullscreen flag too — so every
 *  Android game shipped with the clock bar and the back/home/recents bar on top of it, silently.
 *
 *  Why BOTH bars, under a flag named for the status bar: on iOS `statusBarHidden` already means
 *  "the OS chrome is gone, the game owns the screen" — there is no second bar to leave behind.
 *  Hiding only Android's status bar would honour the field's letter and miss its intent, leaving
 *  the navigation bar occupying the bottom of a portrait game.
 *
 *  Why Java and not a theme: `android:windowFullscreen` hides the status bar only; the navigation
 *  bar needs WindowInsetsController. Idempotent — the block is marker-fenced, so re-running
 *  replaces it exactly, and turning the flag off removes it. A MainActivity that has been hand-
 *  edited (a non-empty class body with no marker) is left ALONE and reported, never clobbered. */
function healAndroidFullscreen(projectRoot: string, cap: ProjectConfig['capacitor']): string | undefined {
  const file = findMainActivity(projectRoot);
  if (!file) return undefined;
  const orig = fs.readFileSync(file, 'utf8');
  const hasBlock = orig.includes(IMMERSIVE_BEGIN);
  let text = orig;

  if (!cap.statusBarHidden) {
    if (!hasBlock) return undefined;
    // Remove our block + the imports it needed, restoring the empty-body scaffold.
    text = text.replace(new RegExp(`\\n?${escapeRe(IMMERSIVE_BEGIN)}[\\s\\S]*?${escapeRe(IMMERSIVE_END)}\\n?`), '\n');
    for (const imp of IMMERSIVE_IMPORTS) text = text.replace(`${imp}\n`, '');
    text = text.replace(/\{\s*\n\s*\}/, '{}');
    if (text === orig) return undefined;
    fs.writeFileSync(file, text);
    return 'removed Android immersive fullscreen (statusBarHidden=false)';
  }

  if (hasBlock) {
    // Refresh in place — keeps a stale generated block in sync with this engine version.
    text = text.replace(new RegExp(`${escapeRe(IMMERSIVE_BEGIN)}[\\s\\S]*?${escapeRe(IMMERSIVE_END)}`), IMMERSIVE_BODY);
  } else {
    // Only inject into the untouched Capacitor scaffold (`class MainActivity ... {}`), so a game
    // that has added its own onCreate is never silently rewritten.
    const emptyBody = /(class\s+MainActivity\s+extends\s+BridgeActivity\s*)\{\s*\}/;
    if (!emptyBody.test(text)) {
      return 'Android immersive fullscreen SKIPPED — MainActivity.java has custom code; add the immersive block by hand';
    }
    text = text.replace(emptyBody, `$1{\n${IMMERSIVE_BODY}\n}`);
  }
  // Ensure imports (idempotent), inserted after the BridgeActivity import. REVERSED, because
  // each insert goes directly after that same anchor line — walking the list forwards would
  // emit it backwards. Order is cosmetic to javac, but generated code that doesn't match its
  // own declared list reads like a bug the next time someone diffs it.
  for (const imp of [...IMMERSIVE_IMPORTS].reverse()) {
    if (!text.includes(imp)) text = text.replace(/(import com\.getcapacitor\.BridgeActivity;\n)/, `$1${imp}\n`);
  }
  if (text === orig) return undefined;
  fs.writeFileSync(file, text);
  return 'synced Android immersive fullscreen (status + navigation bars hidden)';
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Run the native-config heal for a project. Safe to call on every open. */
export function healNativeConfig(projectRoot: string): HealResult {
  const notes: string[] = [];
  try {
    const cfg = loadProjectConfig(projectRoot);
    const a = healAndroidLocalProperties(projectRoot);
    if (a) notes.push(a);
    const i = healIosDevelopmentTeam(projectRoot, cfg.build.appleTeamId);
    if (i) notes.push(i);
    // BOTH iOS deployment floors from the one config value — the pbxproj target and the SPM
    // package's `platforms:`. Healing only the first is what let them drift apart.
    const dt = healIosDeploymentTarget(projectRoot, cfg.build.iosMinVersion);
    if (dt) notes.push(dt);
    const sp = healIosSpmPlatform(projectRoot, cfg.build.iosMinVersion);
    if (sp) notes.push(sp);
    const ams = healAndroidMinSdk(projectRoot, cfg.build.androidMinSdk);
    if (ams) notes.push(ams);
    // App version + build number → both platforms' native version fields (#199). Nothing
    // managed these before, so every project shipped the scaffolder's hardcoded 1 — and a
    // duplicate build number is refused SILENTLY by both stores. `buildNumberAuto` decides
    // whether the number comes from the typed field or the repo's commit count.
    const bn = resolveBuildNumber(projectRoot, cfg);
    if (bn.note) notes.push(bn.note);
    const av = healAndroidVersion(projectRoot, cfg.app.version, bn.value);
    if (av) notes.push(av);
    const iv = healIosVersion(projectRoot, cfg.app.version, bn.value);
    if (iv) notes.push(iv);
    // App identity → EVERY native file that carries it. Write-once at `cap add` before this:
    // changing Project Settings afterwards silently changed nothing anywhere.
    for (const n of healAppIdentity(projectRoot, cfg.app.appId, cfg.app.appName)) notes.push(n);
    // Orientation + status bar → native Info.plist / AndroidManifest.
    const io = healIosOrientationStatusBar(projectRoot, cfg.capacitor);
    if (io) notes.push(io);
    const ao = healAndroidOrientation(projectRoot, cfg.capacitor);
    if (ao) notes.push(ao);
    const af = healAndroidFullscreen(projectRoot, cfg.capacitor);
    if (af) notes.push(af);
    // Declare the app a game to the platform (#228) — unconditional, every Modoki output is one.
    const agm = healAndroidGameMode(projectRoot);
    if (agm) notes.push(agm);
    // Symbolication (#279). Deliberately OUTSIDE the usesGameDebug block below and independent of
    // build.debugBuild: whether crash reports are readable has nothing to do with the debug bridge,
    // and a Release build needs it more, not less. It gates itself on Crashlytics being installed.
    const ds = healIosCrashlyticsDsyms(projectRoot);
    if (ds) notes.push(ds);
    // Android half of the same concern (#282) — likewise independent of build.debugBuild.
    const dsa = healAndroidCrashlytics(projectRoot);
    if (dsa) notes.push(dsa);
    // Release signing (#370) — unconditional, and deliberately NOT gated on this machine having an
    // upload key. The block is inert without `android/keystore.properties`, so healing it in
    // everywhere means the gradle side is already correct the first time anyone configures a key,
    // rather than needing a second project-open to appear.
    const rs = healAndroidReleaseSigning(projectRoot);
    if (rs) notes.push(rs);
    const gi = healAndroidGitignoreKeystore(projectRoot);
    if (gi) notes.push(gi);
    // game-debug heals — only for a project that depends on the bridge. Every one of
    // these keys on build.debugBuild and NOTHING else (#112): the Xcode/Gradle
    // configuration means optimization + symbols, never "is this a debug build".
    if (usesGameDebug(projectRoot)) {
      const debugBuild = cfg.build.debugBuild === true;
      const n = healIosLocalNetwork(projectRoot, debugBuild);
      if (n) notes.push(n);
      const w = healIosGameDebugWiring(projectRoot, debugBuild);
      if (w) notes.push(w);
      // AFTER the wiring — it may have just scaffolded MyViewController.swift.
      const r = healIosGameDebugRegistration(projectRoot, debugBuild);
      if (r) notes.push(r);
      // AFTER the wiring too: it may have just scaffolded the MyViewController this points at.
      const sd = healIosSceneDelegateBridgeVC(projectRoot);
      if (sd) notes.push(sd);
      const s = healIosRemoveReleaseStripPhase(projectRoot);
      if (s) notes.push(s);
      const am = healAndroidDebugBuildMetaData(projectRoot, debugBuild);
      if (am) notes.push(am);
      const ip = healIosDebugBuildInfoPlist(projectRoot, debugBuild);
      if (ip) notes.push(ip);
      // Phase 2 — a WARNING, never a refusal (TestFlight ships with the flag on).
      const iw = healIosArchiveWarning(projectRoot, debugBuild);
      if (iw) notes.push(iw);
      const aw = healAndroidArchiveWarning(projectRoot, debugBuild);
      if (aw) notes.push(aw);
    }
  } catch (e) {
    notes.push(`native-config heal skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { notes };
}
