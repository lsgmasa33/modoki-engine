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
 *  docs/debug-tools-mcp.md § "Debug vs Release". */
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

/** Ensure the App target's build configs in the iOS pbxproj have
 *  DEVELOPMENT_TEAM=<teamId>. Inserts it after PRODUCT_NAME where missing and
 *  corrects ANY existing value (including the empty `DEVELOPMENT_TEAM = "";`
 *  form a fresh `cap add` leaves). Scoped to the App target ONLY — other targets'
 *  teams are left untouched. No-op when appleTeamId is empty or no ios/. */
function healIosDevelopmentTeam(projectRoot: string, teamId: string): string | undefined {
  if (!teamId) return undefined;
  const pbx = path.join(projectRoot, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(pbx)) return undefined;
  const lines = fs.readFileSync(pbx, 'utf8').split('\n');

  const appCfg = appBuildConfigUUIDs(lines);
  if (appCfg.size === 0) return undefined; // can't identify the App target — bail safely

  // Locate the App target's XCBuildConfiguration blocks; record where to correct
  // or insert. Apply bottom-up so splices don't shift not-yet-processed indices.
  interface Block { teamLine: number; productLine: number; openLine: number; indent: string }
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(\s*)([0-9A-Fa-f]{24}) \/\* .* \*\/ = \{/);
    if (!head || !appCfg.has(head[2])) continue;
    let end = i;
    while (end < lines.length && !/^\s*\};/.test(lines[end])) end++;
    let isBuildCfg = false, teamLine = -1, productLine = -1, indent = head[1] + '\t';
    for (let j = i; j <= end; j++) {
      if (/isa = XCBuildConfiguration/.test(lines[j])) isBuildCfg = true;
      if (teamLine === -1 && /DEVELOPMENT_TEAM = /.test(lines[j])) teamLine = j;
      const pm = lines[j].match(/^(\s*)PRODUCT_NAME = /);
      if (pm && productLine === -1) { productLine = j; indent = pm[1]; }
    }
    if (isBuildCfg) blocks.push({ teamLine, productLine, openLine: i, indent });
  }

  let changed = false;
  for (let k = blocks.length - 1; k >= 0; k--) {
    const b = blocks[k];
    if (b.teamLine >= 0) {
      // Correct ANY value form (KQ…; / ""; / stale team) — scoped to this line.
      const fixed = lines[b.teamLine].replace(/DEVELOPMENT_TEAM = [^;]*;/, `DEVELOPMENT_TEAM = ${teamId};`);
      if (fixed !== lines[b.teamLine]) { lines[b.teamLine] = fixed; changed = true; }
    } else {
      const at = b.productLine >= 0 ? b.productLine : b.openLine;
      lines.splice(at + 1, 0, `${b.indent}DEVELOPMENT_TEAM = ${teamId};`);
      changed = true;
    }
  }

  if (!changed) return undefined;
  fs.writeFileSync(pbx, lines.join('\n'));
  return `synced iOS DEVELOPMENT_TEAM = ${teamId} (App target)`;
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

/** The generated `<meta-data>` that carries `build.debugBuild` into the Android app,
 *  fenced by XML comments so the heal rewrites only its own element. */
const ANDROID_DEBUG_META_BEGIN = '        <!-- modoki:debug-build-begin — generated from project.config.json (build.debugBuild) -->';
const ANDROID_DEBUG_META_END = '        <!-- modoki:debug-build-end -->';
/** Must match `GameDebugPlugin.META_DEBUG_BUILD`. */
const ANDROID_DEBUG_META_NAME = 'com.modokiengine.gamedebug.DEBUG_BUILD';

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

/** The generated immersive-mode block in MainActivity.java. Fenced by marker comments so the
 *  heal can find, replace, or remove exactly its own code and never touch a hand edit. */
const IMMERSIVE_BEGIN = '    // modoki:immersive-begin — generated from project.config.json (capacitor.statusBarHidden)';
const IMMERSIVE_END = '    // modoki:immersive-end';
const IMMERSIVE_IMPORTS = [
  'import android.os.Bundle;',
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
    // Orientation + status bar → native Info.plist / AndroidManifest.
    const io = healIosOrientationStatusBar(projectRoot, cfg.capacitor);
    if (io) notes.push(io);
    const ao = healAndroidOrientation(projectRoot, cfg.capacitor);
    if (ao) notes.push(ao);
    const af = healAndroidFullscreen(projectRoot, cfg.capacitor);
    if (af) notes.push(af);
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
      const s = healIosRemoveReleaseStripPhase(projectRoot);
      if (s) notes.push(s);
      const am = healAndroidDebugBuildMetaData(projectRoot, debugBuild);
      if (am) notes.push(am);
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
