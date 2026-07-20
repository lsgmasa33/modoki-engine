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

/** The custom bridge VC that keeps GameDebugPlugin alive. A fresh `cap add ios`
 *  scaffolds no such file — SPM static linking strips a plugin class with no
 *  external SDK dependency, so Capacitor never sees it ("GameDebug plugin is not
 *  implemented on ios"). Compiling the plugin straight into the App target (via a
 *  pbxproj file-ref) + registering the instance here keeps it discoverable.
 *  DEBUG-only: the TCP debug server + Bonjour never ship in a release build. */
const MY_VIEW_CONTROLLER_SWIFT = `import UIKit
import Capacitor

/// Custom bridge VC so we can register plugins that SPM won't auto-discover.
///
/// \`GameDebugPlugin\` (capacitor-game-debug) is compiled straight into the App
/// target via a project-relative pbxproj file reference — NOT via SPM — because the
/// SPM static linker strips a plugin class that has no external SDK dependency, so
/// Capacitor never sees it ("GameDebug plugin is not implemented on ios"). Manually
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

/** Fixed synthetic pbxproj UUIDs for the game-debug wiring. They're clearly not
 *  Xcode-minted (all-zero body) so they never collide with the template's, and
 *  reusing them keeps the heal idempotent + the diff stable. */
const GD_UUID = {
  mvcFileRef: 'DD0000000000000000000001',
  mvcBuildFile: 'DD0000000000000000000002',
  pluginFileRef: 'DD0000000000000000000003',
  pluginBuildFile: 'DD0000000000000000000004',
  stripPhase: 'DD0000000000000000000005',
} as const;

/** The Release Info.plist-strip build phase (Task 4). Runs last so the processed
 *  Info.plist exists, gates on CONFIGURATION=Release, and deletes the two
 *  debug-only Local Network keys the heal adds (see healIosLocalNetwork). Debug
 *  builds keep them; App Store builds ship without a Local Network prompt. */
const RELEASE_STRIP_PHASE_BLOCK = [
  '/* Begin PBXShellScriptBuildPhase section */',
  `\t\t${GD_UUID.stripPhase} /* Strip debug-only Info.plist keys (Release) */ = {`,
  '\t\t\tisa = PBXShellScriptBuildPhase;',
  '\t\t\tbuildActionMask = 2147483647;',
  // Runs every build by design (gated internally on CONFIGURATION). This is the
  // pbxproj form of unchecking "Based on dependency analysis" — silences Xcode's
  // "will be run during every build because it does not specify any outputs" warning.
  '\t\t\talwaysOutOfDate = 1;',
  '\t\t\tfiles = (',
  '\t\t\t);',
  '\t\t\tinputPaths = (',
  '\t\t\t);',
  '\t\t\tname = "Strip debug-only Info.plist keys (Release)";',
  '\t\t\toutputPaths = (',
  '\t\t\t);',
  '\t\t\trunOnlyForDeploymentPostprocessing = 0;',
  '\t\t\tshellPath = /bin/sh;',
  '\t\t\tshellScript = "if [ \\"${CONFIGURATION}\\" = \\"Release\\" ]; then\\n  PLIST=\\"${TARGET_BUILD_DIR}/${INFOPLIST_PATH}\\"\\n  /usr/libexec/PlistBuddy -c \\"Delete :NSLocalNetworkUsageDescription\\" \\"$PLIST\\" || true\\n  /usr/libexec/PlistBuddy -c \\"Delete :NSBonjourServices\\" \\"$PLIST\\" || true\\n  echo \\"Stripped debug-only Local Network keys for Release build\\"\\nfi\\n";',
  '\t\t};',
  '/* End PBXShellScriptBuildPhase section */',
  '',
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

/** Ensure the iOS Info.plist declares Local Network usage + the game-debug Bonjour
 *  service. Since iOS 14, an app that publishes/browses Bonjour needs
 *  `NSLocalNetworkUsageDescription` + `NSBonjourServices` or iOS SILENTLY drops the
 *  outgoing mDNS (the service "publishes" but never reaches the LAN), so the
 *  game-debug MCP can't discover the device — the exact regression a fresh
 *  `cap add ios` reintroduces (it scaffolds an Info.plist without them). Idempotent:
 *  inserts before the root `</dict>` only when absent; never clobbers. */
function healIosLocalNetwork(projectRoot: string): string | undefined {
  const plist = path.join(projectRoot, 'ios', 'App', 'App', 'Info.plist');
  if (!fs.existsSync(plist)) return undefined;
  const text = fs.readFileSync(plist, 'utf8');
  if (text.includes('NSBonjourServices')) return undefined; // already present
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

/** Wire the iOS App target so Capacitor discovers GameDebugPlugin (Task 3). A
 *  fresh `cap add ios` doesn't compile the plugin in — SPM strips the class — so
 *  we (1) drop a MyViewController.swift that registers the instance in DEBUG,
 *  (2) point the storyboard's bridge VC at it, and (3) add pbxproj references that
 *  compile MyViewController.swift + the engine's GameDebugPlugin.swift into the App
 *  target. Idempotent (skips whatever's already present); only for a project that
 *  depends on capacitor-game-debug AND lives inside the modoki repo. Bails without
 *  writing if any pbxproj anchor is missing (never leaves a partial edit). */
function healIosGameDebugWiring(projectRoot: string): string | undefined {
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
    fs.writeFileSync(mvcPath, MY_VIEW_CONTROLLER_SWIFT);
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

/** Add a Release-only build phase that strips the debug-only Local Network keys
 *  from the built Info.plist (Task 4). The GameDebugPlugin is already #if DEBUG
 *  gated, but healIosLocalNetwork adds the plist keys unconditionally — this keeps
 *  them out of App Store builds. Idempotent; scoped to a game-debug project. */
function healIosReleaseStripDebugKeys(projectRoot: string): string | undefined {
  if (!usesGameDebug(projectRoot)) return undefined;
  const pbxPath = path.join(projectRoot, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(pbxPath)) return undefined;
  let text = fs.readFileSync(pbxPath, 'utf8');
  if (text.includes('Strip debug-only Info.plist keys')) return undefined; // already present

  // The phase must be referenced in the App target's buildPhases AND defined as an
  // object. Add the reference after the Resources phase (runs last), then the block.
  const refLine = `\t\t\t\t${GD_UUID.stripPhase} /* Strip debug-only Info.plist keys (Release) */,`;
  const lines = text.split('\n');
  const resIdx = lines.findIndex((l) => /^\s*[0-9A-Fa-f]{6,} \/\* Resources \*\/,$/.test(l));
  if (resIdx < 0) return undefined; // can't find the buildPhases list — bail
  lines.splice(resIdx + 1, 0, refLine);
  text = lines.join('\n');

  // Define the phase object as its own section, before the Sources phase section.
  const anchor = '/* Begin PBXSourcesBuildPhase section */';
  if (!text.includes(anchor)) return undefined;
  text = text.replace(anchor, RELEASE_STRIP_PHASE_BLOCK + '\n' + anchor);

  fs.writeFileSync(pbxPath, text);
  return 'added Release Info.plist-strip build phase (debug-only Local Network keys)';
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
  // iPad additionally allows upside-down for portrait/auto (Apple convention).
  const pad = cap.orientation === 'landscape' ? phone : [...phone, 'UIInterfaceOrientationPortraitUpsideDown'];
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

/** Run the native-config heal for a project. Safe to call on every open. */
export function healNativeConfig(projectRoot: string): HealResult {
  const notes: string[] = [];
  try {
    const cfg = loadProjectConfig(projectRoot);
    const a = healAndroidLocalProperties(projectRoot);
    if (a) notes.push(a);
    const i = healIosDevelopmentTeam(projectRoot, cfg.build.appleTeamId);
    if (i) notes.push(i);
    // Orientation + status bar → native Info.plist / AndroidManifest.
    const io = healIosOrientationStatusBar(projectRoot, cfg.capacitor);
    if (io) notes.push(io);
    const ao = healAndroidOrientation(projectRoot, cfg.capacitor);
    if (ao) notes.push(ao);
    // game-debug heals — only for a project that depends on the bridge.
    if (usesGameDebug(projectRoot)) {
      const n = healIosLocalNetwork(projectRoot);
      if (n) notes.push(n);
      const w = healIosGameDebugWiring(projectRoot);
      if (w) notes.push(w);
      const s = healIosReleaseStripDebugKeys(projectRoot);
      if (s) notes.push(s);
    }
  } catch (e) {
    notes.push(`native-config heal skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { notes };
}
