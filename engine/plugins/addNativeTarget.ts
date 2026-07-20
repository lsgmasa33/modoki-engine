/** Pure helpers for the "Add Native Target" editor action — make a flat game
 *  project Capacitor-ready (deps + capacitor.config.json) before `npx cap add`,
 *  and flag user-supplied configs the editor can't synthesize (Firebase).
 *
 *  The orchestration (npm install → web build → cap add → heal) lives in the
 *  Vite middleware's /api/add-native-target SSE handler; these helpers are the
 *  in-process, deterministic edits it runs first. Kept here (engine/plugins) so
 *  they're transport-agnostic and unit-testable. */

import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../project-config';

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

  // capacitor-game-debug gets a placeholder spec; vendorEnginePlugins rewrites it
  // to file:plugins/<name>-<ver>.tgz (a copy) before install.
  const want: Record<string, string> = {
    '@capacitor/core': range,
    '@capacitor/cli': range,
    [platformPkg(platform)]: range,
    // Engine-RUNTIME native plugins: the shipped game shell/runtime calls these on EVERY
    // platform, so a native target that omits them ships a JS proxy with no native impl and
    // throws `"<Plugin>" plugin is not implemented on <platform>` at LAUNCH. PlayerPrefs
    // (runtime/storage/backends.ts) → @capacitor/preferences; App.tsx (lifecycle/back-button)
    // → @capacitor/app; useKeyboardShift → @capacitor/keyboard. These are an engine contract,
    // not opt-in — so they belong in the always-added set beside @capacitor/core. Pinned to
    // the editor's OWN versions so the inlined JS proxy matches the registered native plugin.
    '@capacitor/app': capDepRange(editorRoot, '@capacitor/app', range),
    '@capacitor/keyboard': capDepRange(editorRoot, '@capacitor/keyboard', range),
    '@capacitor/preferences': capDepRange(editorRoot, '@capacitor/preferences', range),
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
    plugins: { Keyboard: { resize: cfg.capacitor.keyboardResize } },
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return { changed: true, notes: [`created capacitor.config.json (${cfg.app.appId} / "${cfg.app.appName}")`] };
}

/** Warn about user-supplied native configs the editor can't synthesize. If the
 *  project depends on Firebase plugins but the platform's config file is absent,
 *  the app will crash on launch (FirebaseApp.configure throws). Returns
 *  human-readable warnings (empty = nothing missing / no Firebase). */
export function detectMissingFirebase(projectRoot: string, platform: NativePlatform): string[] {
  let deps: Record<string, string> = {};
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
