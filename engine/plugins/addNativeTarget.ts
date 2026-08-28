/** "Add Native Target" — make a flat game project Capacitor-ready (deps +
 *  capacitor.config.json), run `npx cap add`, and flag user-supplied configs the
 *  editor can't synthesize (Firebase).
 *
 *  The deterministic in-process edits are the pure helpers below; `scaffoldNativeTarget`
 *  is the orchestration around them (deps → install → web build → cap add → heal).
 *  Kept here (engine/plugins) so both are transport-agnostic and unit-testable.
 *
 *  ── WHY THE ORCHESTRATION MOVED HERE ─────────────────────────────────────────────────
 *  It used to live inside `vite-asset-scanner.ts`, reachable ONLY through the editor's
 *  `/api/add-native-target` + `/api/build` SSE routes — which act on whatever project the
 *  editor has OPEN. Scaffolding N projects therefore meant opening N projects in the editor,
 *  and a terminal had no way in at all. The obvious workaround — a script that re-runs the
 *  five steps itself — is the #159 mistake in a new costume: a SECOND implementation of a
 *  sequence that must not diverge from the one that ships. So the sequence moved next to the
 *  helpers it calls, the scanner imports it, and `engine/scripts/add-native-targets.mjs`
 *  drives the SAME function from the CLI. One implementation, two transports. */

import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../project-config';
import { vendorEnginePlugins, writeVendorMarker } from './vendorPlugins';
import { healNativeConfig } from './healNativeConfig';

export type NativePlatform = 'ios' | 'android';

/** A directory looks like a Modoki project iff it exists and carries one of the
 *  recognizable markers. Guards the scaffold from writing package.json + tarballs
 *  into an arbitrary/mistyped path (a flat game may have no package.json yet, so
 *  project.config.json / game.ts also count). (D8) */
export function isPlausibleProjectDir(projectRoot: string): boolean {
  try {
    if (!fs.statSync(projectRoot).isDirectory()) return false;
  } catch {
    return false;
  }
  return ['project.config.json', 'game.ts', 'package.json', 'capacitor.config.json']
    .some((m) => fs.existsSync(path.join(projectRoot, m)));
}

/** The @capacitor/<platform> package a target needs. */
function platformPkg(platform: NativePlatform): string {
  return platform === 'ios' ? '@capacitor/ios' : '@capacitor/android';
}

/** Read the editor's own @capacitor/core version range so a scaffolded game
 *  pins the SAME Capacitor major (mixing majors breaks the native bridge).
 *  Falls back to a sane default if not found. */
function capacitorRange(editorRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(editorRoot, 'package.json'), 'utf8'));
    const v = pkg.dependencies?.['@capacitor/core'] || pkg.devDependencies?.['@capacitor/core'];
    if (typeof v === 'string' && v) return v;
  } catch { /* fall through */ }
  return '^8.3.0';
}

/** Read a SPECIFIC @capacitor/* dep's version range from the editor's own package.json —
 *  the engine-runtime plugins (app/keyboard/preferences) are versioned independently of
 *  @capacitor/core, so pin each to what the editor actually bundles: the JS proxy the web
 *  build inlines (from the editor's node_modules) must match the native plugin `cap sync`
 *  registers. Falls back to the core range (same Capacitor major) if the editor doesn't
 *  pin it explicitly. */
function capDepRange(editorRoot: string, name: string, coreRange: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(editorRoot, 'package.json'), 'utf8'));
    const v = pkg.dependencies?.[name] || pkg.devDependencies?.[name];
    if (typeof v === 'string' && v) return v;
  } catch { /* fall through */ }
  return coreRange;
}

/** Capacitor plugins the ENGINE RUNTIME calls on every platform, so every native target must
 *  carry them. Not opt-in — an engine contract, which is why they sit beside `@capacitor/core`
 *  in the always-added set:
 *   - `@capacitor/preferences` → PlayerPrefs (`runtime/storage/backends.ts`)
 *   - `@capacitor/app`         → App.tsx lifecycle / back-button
 *   - `@capacitor/keyboard`    → `useKeyboardShift`
 *   - `@capacitor/splash-screen` → App.tsx's `SplashScreen.hide()` once the game can be shown
 *     (docs/ota-updates.md Phase 3b). Its call is try/caught, so this one heals in lazily.
 *
 *  Omit one and the failure is SILENT until launch: the web build inlines the plugin's JS proxy
 *  from the EDITOR's node_modules, so the build succeeds, but `cap sync` runs in the project dir
 *  and registers no native impl → `"<Plugin>" plugin is not implemented on <platform>` at
 *  runtime. Pinned to the editor's OWN versions so the inlined proxy matches the registered
 *  native plugin.
 *
 *  EXPORTED so the guard test asserts against this list rather than a copy of it
 *  (`engine/tests/architecture/nativeProjectDeps.test.ts`). Four committed projects had drifted
 *  off it — including a PUBLISHED demo, whose snapshot therefore shipped a `package.json` that
 *  dies at launch for anyone building it without the Modoki editor in the loop. A second copy of
 *  the list in the guard would have been free to drift the same way. */
export const ENGINE_REQUIRED_CAP_PLUGINS = [
  '@capacitor/app',
  // The engine's haptics subsystem (runtime/haptics/) imports this unconditionally, so a native
  // project without it dies the moment a game plays a moment. Required rather than opt-in for
  // exactly the reason @capacitor/preferences is: the import is static, so "the game does not use
  // haptics" is not a state the bundle can be in.
  '@capacitor/haptics',
  '@capacitor/keyboard',
  '@capacitor/preferences',
  '@capacitor/splash-screen',
] as const;

export interface ScaffoldResult {
  changed: boolean;
  notes: string[];
}

/** Ensure the project's package.json carries the Capacitor deps a native target
 *  needs: @capacitor/core, @capacitor/cli, @capacitor/<platform>, plus the
 *  engine debug bridge (capacitor-game-debug — vendored to a copy later by
 *  vendorEnginePlugins, which rewrites this spec). Only adds what's missing;
 *  never downgrades an existing pin. Returns whether it wrote the file. */
export function ensureCapacitorDeps(projectRoot: string, platform: NativePlatform, editorRoot: string): ScaffoldResult {
  // Refuse to synthesize package.json + tarballs in a non-project directory (a
  // mistyped path / stale recents entry). (D8)
  if (!isPlausibleProjectDir(projectRoot)) {
    throw new Error(`refusing to scaffold native target: ${projectRoot} doesn't look like a Modoki project (no project.config.json / game.ts / package.json / capacitor.config.json)`);
  }
  const pkgPath = path.join(projectRoot, 'package.json');
  const notesPre: string[] = [];
  // A flat game may have no package.json yet (it runs purely off the editor's
  // shared runtime). Native needs one — create the minimal workspace-root shape
  // the other games use (its OWN npm root; shared engine deps are host-provided).
  let raw: string;
  if (fs.existsSync(pkgPath)) {
    raw = fs.readFileSync(pkgPath, 'utf8');
  } else {
    const seed = {
      name: `@modoki-game/${path.basename(projectRoot)}`,
      version: '0.0.0',
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
      dependencies: {},
    };
    raw = JSON.stringify(seed, null, 2) + '\n';
    notesPre.push('created package.json');
  }
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
  pkg.dependencies ??= {};
  const range = capacitorRange(editorRoot);
  const notes: string[] = [...notesPre];

  const want: Record<string, string> = {
    '@capacitor/core': range,
    '@capacitor/cli': range,
    [platformPkg(platform)]: range,
    ...Object.fromEntries(ENGINE_REQUIRED_CAP_PLUGINS.map((n) => [n, capDepRange(editorRoot, n, range)])),
    // capacitor-game-debug gets a placeholder spec; vendorEnginePlugins rewrites it
    // to file:plugins/<name>-<ver>.tgz (a copy) before install.
    'capacitor-game-debug': '*',
  };
  let changed = false;
  for (const [name, spec] of Object.entries(want)) {
    if (!(name in pkg.dependencies)) {
      pkg.dependencies[name] = spec;
      changed = true;
      notes.push(`added dependency ${name}`);
    }
  }
  if (changed) {
    // Keep dependencies sorted for a stable diff.
    pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
  }
  return { changed, notes };
}

/** Ensure <project>/capacitor.config.json exists, derived from project.config.json
 *  (appId/appName). Mirrors the static config 3d-test/alien-animal use. Never
 *  clobbers an existing config. Returns whether it created the file. */
export function ensureCapacitorConfig(projectRoot: string, cfg: ProjectConfig): ScaffoldResult {
  const file = path.join(projectRoot, 'capacitor.config.json');
  if (fs.existsSync(file)) return { changed: false, notes: [] };
  const config = {
    appId: cfg.app.appId,
    appName: cfg.app.appName,
    webDir: cfg.capacitor.webDir,
    ios: { preferredContentMode: cfg.capacitor.iosContentMode },
    android: { allowMixedContent: cfg.capacitor.allowMixedContent },
    server: { androidScheme: cfg.capacitor.androidScheme },
    // launchAutoHide:false — the native splash stays up until App.tsx explicitly
    // calls SplashScreen.hide() once the game has actually rendered a frame,
    // instead of Capacitor's own fixed 3s timer racing the real load time
    // (docs/ota-updates.md, Phase 3b). Existing projects created before this field
    // existed keep the default timer — this only applies to a FRESH
    // capacitor.config.json (this function never clobbers an existing one).
    // androidScaleType CENTER_CROP — the plugin's default is FIT_XY, which STRETCHES the splash
    // to the screen and preserves no aspect at all. With an authored splash (#396) that visibly
    // distorts the artwork and the composited title: on a 1080x2340 phone the 960x1600
    // `port-xxhdpi` bucket is scaled x1.125 horizontally against x1.4625 vertically — the wordmark
    // renders ~30% taller relative to its width than it was drawn. CENTER_CROP is also what the
    // crop-safe geometry in `scripts/splashLayout.mjs` assumes, and iOS already does it
    // (`scaleAspectFill`), so this makes the two platforms agree.
    plugins: {
      Keyboard: { resize: cfg.capacitor.keyboardResize },
      SplashScreen: { launchAutoHide: false, androidScaleType: 'CENTER_CROP' },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return { changed: true, notes: [`created capacitor.config.json (${cfg.app.appId} / "${cfg.app.appName}")`] };
}

/** Warn about user-supplied native configs the editor can't synthesize. If the
 *  project depends on Firebase plugins but the platform's config file is absent,
 *  the app will crash on launch (FirebaseApp.configure throws). Returns
 *  human-readable warnings (empty = nothing missing / no Firebase). */
export function detectMissingFirebase(projectRoot: string, platform: NativePlatform): string[] {
  let deps: Record<string, string>;
  try {
    deps = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).dependencies ?? {};
  } catch { return []; }
  const usesFirebase = Object.keys(deps).some((d) => d.startsWith('@capacitor-firebase/'));
  if (!usesFirebase) return [];

  const warnings: string[] = [];
  if (platform === 'ios') {
    const plist = path.join(projectRoot, 'ios', 'App', 'App', 'GoogleService-Info.plist');
    if (!fs.existsSync(plist)) {
      warnings.push(
        'This project uses Firebase but ios/App/App/GoogleService-Info.plist is missing — ' +
        'download it from the Firebase console for this bundle id and add it to the App target, ' +
        'or the app will crash on launch (com.firebase.core).',
      );
    }
  } else {
    const gsj = path.join(projectRoot, 'android', 'app', 'google-services.json');
    if (!fs.existsSync(gsj)) {
      warnings.push(
        'This project uses Firebase but android/app/google-services.json is missing — ' +
        'download it from the Firebase console for this applicationId and add it.',
      );
    }
  }
  return warnings;
}

/** Scaffold one native target end-to-end: deps + capacitor.config.json + vendored engine
 *  plugins (in-process), then install → web build → `npx cap add` → heal native config.
 *
 *  `runShell(label, cmd, cwd)` is the CALLER's spawn wrapper — each transport owns its own,
 *  wired to its own abort/disconnect handling and output streaming (the editor streams over
 *  SSE; the CLI inherits stdio). A false return throws. Returns the missing-Firebase warnings
 *  the caller should surface; the editor's build path PAUSES on a non-empty list so the user
 *  can supply the config before the build runs against it.
 *
 *  Step 3 builds the web assets because `cap add` requires `webDir` to exist — it is not an
 *  optimisation and cannot be skipped for a project that has never been built. */
export async function scaffoldNativeTarget(opts: {
  projectRoot: string;
  platform: NativePlatform;
  /** The ENGINE root the web build runs from (the monorepo root), not the project. */
  buildCwd: string;
  cfg: ProjectConfig;
  send: (msg: string) => void;
  runShell: (label: string, cmd: string, cwd: string) => Promise<boolean>;
}): Promise<{ warnings: string[] }> {
  const { projectRoot, platform, buildCwd, cfg, send, runShell } = opts;
  // 1. In-process scaffold: deps + capacitor.config.json + vendor plugins.
  for (const n of ensureCapacitorDeps(projectRoot, platform, buildCwd).notes) send(n);
  for (const n of ensureCapacitorConfig(projectRoot, cfg).notes) send(n);
  const v = vendorEnginePlugins(projectRoot, buildCwd);
  if (v.vendored.length) send(`vendored engine plugin(s): ${v.vendored.join(', ')}`);
  // 2. Install (project) — needs the cap CLI + plugin copies present.
  if (!(await runShell('npm install', 'npm install', projectRoot))) throw new Error('npm install failed');
  writeVendorMarker(projectRoot, v.expectedVendor); // record installed tarballs (D3)
  // 3. Web build → <project>/dist (cap add needs webDir to exist).
  if (!(await runShell('Building web assets', 'node engine/scripts/build-web.mjs --target native', buildCwd))) throw new Error('web build failed');
  // 4. cap add (project) — generates the native project with the capacitor.config identity baked in.
  if (!(await runShell(`cap add ${platform}`, `npx cap add ${platform}`, projectRoot))) throw new Error(`cap add ${platform} failed`);
  // 5. Heal native config (local.properties / DEVELOPMENT_TEAM) + flag missing Firebase.
  for (const n of healNativeConfig(projectRoot).notes) send(n);
  return { warnings: detectMissingFirebase(projectRoot, platform) };
}
