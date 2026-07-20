/**
 * Electron main process (ELECTRON_PLAN Phase 2). Hosts the real editor backend
 * (HTTP on 127.0.0.1) and bridges the renderer to it:
 *
 *   - M  (fs/exec)   — served directly by the router in main, over the asset
 *                      backend (roots/manifest/watcher).
 *   - M→R (live ECS) — `requestRenderer` forwards an op to the editor renderer
 *                      over IPC and awaits its reply (replaces the Vite HMR
 *                      `requestBrowser`). Backs /api/scene-state.
 *   - R→M (schema)   — the renderer pushes its trait schema over IPC; cached
 *                      here so validate/mutate can type-check.
 *   - hot-reload     — the chokidar watcher notifies the renderer over IPC when
 *                      an active scene/prefab changes (or the manifest rebuilds).
 *
 * The renderer loads its shell + the open project's code/assets from a main-owned
 * Vite server (HMR live) in BOTH dev and packaged ("run Vite in prod", C4c-3b);
 * only the backend (/api) is main-hosted. Opening a project re-roots that server.
 */

import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { initFileLog, getLogFilePath, logToFile } from './fileLog';
import { resolveUserDataDir, resolveToolchainDir, shouldOverrideUserData, adoptLegacyToolchain, multiProfileKey } from './userDataDir';

// The app version, bundled from the root package.json at build time (the single source
// of truth — see build-electron.mjs). Prefer this over `app.getVersion()` for DISPLAY:
// in the dev editor Electron is launched with a bare main.cjs (no app package.json), so
// `app.getVersion()` returns ELECTRON's version (e.g. 42.4.0). `__APP_VERSION__` is
// correct in dev AND packaged; the `typeof` guard falls back if the define is ever absent.
declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : app.getVersion();

// ══ userData MUST be decided FIRST — before ANY app.getPath('userData') ══
// Electron RESOLVES AND CACHES userData on its first read, so whoever reads first wins.
// This is not theoretical: `initFileLog()` below reads it, and when it was added (today,
// ff364b47 "Windows editor crash on open") it silently moved the SHIPPED editor's whole
// profile — the pre-existing `app.setName('Modoki Editor')` sat 240 lines further down and
// became a no-op, so userData fell back to the package.json name (`modoki-app`) and the
// 1.2GB toolchain, prefs, and caches relocated with it. A Jul-16 build (no initFileLog)
// still writes to `Modoki Editor`; every build after it writes to `modoki-app`. Nothing
// failed, nothing logged — the dir just moved.
//
// So: setPath (which OVERRIDES the resolved entry, unlike setName) and do it HERE, above
// the first reader, not merely "before ready". Adding any userData read above this line
// re-breaks it silently. See userDataDir.ts.
//
// REPO_ROOT is inlined rather than reused from below because DEV keys its profile off the
// CLONE PATH and this must run before that declaration. (Same expression; see there.)
// …but NEVER override an explicit `--user-data-dir`: that switch exists to isolate a
// profile, and clobbering it is the same class of bug in reverse. (The CSP smoke launches
// the packaged app with one.)
if (shouldOverrideUserData(process.argv)) {
  app.setPath('userData', resolveUserDataDir({
    appData: app.getPath('appData'),
    isPackaged: app.isPackaged,
    repoRoot: app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked')
      : path.resolve(__dirname, '..', '..', '..'),
    // §14.4: several editors run inside ONE clone under MODOKI_MULTI and would otherwise
    // share this clone's profile → LevelDB single-writer fight. Give each its own
    // sub-profile keyed on the project it opened (stable across relaunch, distinct between
    // co-running editors). Only under MULTI, so the normal single-editor case is unchanged.
    subKey: process.env.MODOKI_MULTI ? multiProfileKey(process.env.MODOKI_PROJECT) : null,
  }));
}

// Adopt a pre-existing toolchain instead of re-fetching ~1.2GB. Pinning the toolchain dir
// moved where we LOOK, not the data — without this the shipped editor silently re-downloads
// JDK (336M) + Android SDK (527M) + Node + Ruby, and Android/iOS builds FAIL until it lands.
// MUST precede any provisioning: ensureNodeProvisioned() creates <toolchain>/node, and the
// adopt is a no-op once the target exists — so a late adopt would silently lose the SDKs.
// Best-effort; a failure just means provisioning re-fetches.
try {
  const from = adoptLegacyToolchain(app.getPath('appData'), fs);
  if (from) console.log(`[modoki-electron] adopted existing toolchain from ${from}`);
} catch { /* never block startup on a migration */ }

// Tee console → a per-app log file BEFORE anything logs, so a packaged app (no
// attached terminal on macOS Finder-launch OR any Windows GUI launch) leaves a
// diagnosable trail instead of failing silently. Best-effort; never throws.
initFileLog();
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createAssetBackend, type ElectronAssetBackend } from './assetBackend';
import { npmSpawnSpec, ensureNode, PINNED_NODE } from '../toolchain';
import { startBackendServer, type BackendServerHandle, type HostRoutes } from './backendServer';
import type { LiveReloadKind } from '../plugins/vite-asset-scanner';
import { captureViewport, tap, drag, hover, scroll, pressKey, typeText, focusElement, captureGesture } from './rendererOps';
import { createInputRoutes } from './inputRoutes';
import { getSsrLoadModule, closeSsrLoader } from './ssrLoader';
import { buildProdCsp, PROD_CSP_ORIGINS } from './csp';
import { startDevServer, stopDevServer, findFreePort } from './devServer';
import { showSplash, setSplashStatus, closeSplash } from './splash';
import { pickProjectFolder, pickNewProjectFolder, addRecentProject, getRecentProjects, migrateLegacyRecents, setRecentsScope, chooseInitialProject, projectFolderKind, installAppMenu, type RendererMenuSpec } from './projects';
import { scaffoldProject } from './newProject';
import { resolveCdpConfig, readCdpEnabled, writeCdpEnabled, probeCdp, newCdpNonce, buildRendererUrl, readCdpPortMemo, writeCdpPortMemo, cdpMemoVerdict, type CdpProbe } from './cdp';
import { portCandidates, readLastPort, writeLastPort, parseBackendPort } from './backendPort';
import { buildMcpServerEntry, buildChromeDevtoolsEntry, mergeMcpConfig, isMcpStale, mcpChromePort, isMcpTokenForeign, ensureMcpGitignored, detectClaudeCli, atomicWriteFileSync, healMcpPort, resolveMcpTarget, mcpHasModoki, mcpBackendRaw, gitTrackedState, ensureProjectClaudeMd } from './connectClaude';
import { ensureToken } from './instanceToken';
import { vendorEnginePlugins, writeVendorMarker, type VendorResult } from '../plugins/vendorPlugins';
import { healNativeConfig } from '../plugins/healNativeConfig';
import { setupAutoUpdate, checkForUpdatesInteractive, isUpdateInstalling } from './autoUpdate';
import { registerReimportHandler } from '../plugins/reimport-registry';
import { textureReimportHandler } from '../plugins/reimport-texture';
import { modelReimportHandler } from '../plugins/reimport-model';
import { audioReimportHandler } from '../plugins/reimport-audio';
import { fontReimportHandler } from '../plugins/reimport-font';
import { environmentReimportHandler } from '../plugins/reimport-environment';
import type { BackendContext } from '../plugins/backend/editorBackendRouter';
import type { SceneSchema } from '../packages/modoki/src/runtime/scene/sceneValidation';
import { ENGINE_VERSION } from '../packages/modoki/src/runtime/version';

/**
 * Find the enclosing git repo/worktree root for a project path by walking up
 * until a `.git` entry is found (a dir for a normal clone, a file for a worktree).
 * Returns null if none is found (e.g. a non-git external project).
 */
const repoRootOf = (start: string): string | null => {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
};

/**
 * Window title shows the build version + open project —
 * "Modoki Editor 0.2.17 — <repo> / <project>". The version (APP_VERSION, bundled from
 * the root package.json — NOT app.getVersion(), which returns Electron's own version in
 * the dev editor) makes it unmistakable WHICH build is running — critical when an
 * auto-update / stale install could silently swap the app underneath
 * you. The repo/worktree folder is prepended so windows from different worktrees
 * (e.g. modoki vs modoki-ai) are distinguishable; falls back to just the project
 * folder when there's no enclosing repo or it IS the project root.
 */
/** The project's display name for the CLAUDE.md primer — project.config.json's
 *  `app.appName` when set to something real, else the folder name. Best-effort: a missing
 *  or malformed config just falls back, never throws into Connect. */
function projectDisplayName(root: string): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8')) as { app?: { appName?: unknown } };
    const name = cfg.app?.appName;
    if (typeof name === 'string' && name.trim() && !name.includes('__')) return name.trim();
  } catch { /* fall back */ }
  return path.basename(root);
}

const titleFor = (root: string) => {
  const project = path.basename(root);
  const repo = repoRootOf(root);
  const repoName = repo ? path.basename(repo) : null;
  const v = `Modoki Editor ${APP_VERSION}`;
  return repoName && repoName !== project
    ? `${v} — ${repoName} / ${project}`
    : `${v} — ${project}`;
};

let nodeProvisioned = false;
/** Provision a pinned Node so project installs run on it, not a user-installed npm. Active in a
 *  packaged app (the whole point) and, for dogfooding, in dev when MODOKI_PROVISION_NODE=1. Runs at
 *  most once. Best-effort: on failure (e.g. offline first-run) it logs and leaves MODOKI_NODE unset,
 *  so npmSpawnSpec falls back to system npm — the editor never hard-fails on provisioning. */
async function ensureNodeProvisioned(): Promise<void> {
  if (nodeProvisioned) return;
  nodeProvisioned = true;
  const wanted = app.isPackaged || process.env.MODOKI_PROVISION_NODE === '1';
  if (!wanted || (process.env.MODOKI_NODE && process.env.MODOKI_NPM_CLI)) return;
  try {
    // Same machine-level home as the env var set in whenReady — a userData-based fallback
    // here would quietly provision a SECOND Node into whichever profile ran first.
    const dir = path.join(process.env.MODOKI_TOOLCHAIN_DIR ?? resolveToolchainDir(app.getPath('appData')), 'node');
    const { nodeBin, npmCli } = await ensureNode(dir);
    process.env.MODOKI_NODE = nodeBin;
    process.env.MODOKI_NPM_CLI = npmCli;
    // Put the PROVISIONED Node's bin dir FIRST on PATH. Two reasons:
    //  1. gltf-transform / gltfpack are `#!/usr/bin/env node` scripts — detecting AND running them
    //     needs `node` resolvable on PATH. A Finder-launched macOS GUI app gets a minimal PATH
    //     (/usr/bin:/bin:…) with no Homebrew/nvm Node, so their `--version` probe silently failed →
    //     the Build Support dialog showed a just-installed glTF-Transform as "not found".
    //  2. Prepending OURS means a shebang resolves to the editor's own Node, never a system Node —
    //     the packaged editor stays self-contained (no fall-back to whatever `node` is on the box).
    // Inherited by the Vite child (spawned later) so its reimport/build steps resolve Node too.
    const sep = process.platform === 'win32' ? ';' : ':';
    const nodeDir = path.dirname(nodeBin);
    const parts = (process.env.PATH ?? '').split(sep);
    if (!parts.includes(nodeDir)) process.env.PATH = `${nodeDir}${sep}${process.env.PATH ?? ''}`;
    console.log(`[modoki-electron] provisioned Node ${PINNED_NODE.version} → ${nodeBin} (on PATH)`);
  } catch (e) {
    console.warn(`[modoki-electron] Node provisioning failed (falling back to system npm): ${e instanceof Error ? e.message : e}`);
  }
}

/** Run `npm install` in cwd, streaming output to the console. Resolves on exit 0,
 *  rejects otherwise. npm is resolved via the shared toolchain (npmSpawnSpec) so the
 *  source is swappable in one place — a later phase points it at a downloaded Node's
 *  npm so the packaged editor never needs a user-installed npm. */
function runNpm(cwd: string, args: string[]): Promise<number> {
  const spec = npmSpawnSpec();
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.prefixArgs, ...args], {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: spec.shell,
      env: spec.env,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Install a project's deps. Prefer `npm ci` when the lockfile is authoritative
 *  (it exists AND vendoring did NOT rewrite package.json this open): ci is a clean
 *  install that ENFORCES lockfile integrity — so a committed plugin tarball whose
 *  bytes drift from the lockfile fails loudly instead of silently rewriting the
 *  lock. Fall back to `npm install` when there's no lockfile, when vendoring
 *  changed package.json (the lock must regenerate), or when `npm ci` fails on
 *  lockfile drift. (D1) */
async function installProjectDeps(cwd: string, opts: { preferCi: boolean }): Promise<void> {
  const hasLock = fs.existsSync(path.join(cwd, 'package-lock.json'));
  if (opts.preferCi && hasLock) {
    if ((await runNpm(cwd, ['ci'])) === 0) return;
    console.warn('[modoki-electron] npm ci failed (lockfile drift?) — falling back to npm install');
  }
  const code = await runNpm(cwd, ['install']);
  if (code !== 0) throw new Error(`npm install exited with code ${code}`);
}

/**
 * Auto-install a project's dependencies on open (in-repo OR external project) so
 * "Open Project" just works. The repo's root install only links in-repo game
 * workspaces (bootstrap-game-deps.mjs); a project opened from OUTSIDE the repo —
 * or an in-repo game that was never installed — needs its own `npm install` to
 * create node_modules + workspace symlinks (e.g. @<game>/app-services), otherwise
 * Vite 500s on the unresolved import.
 *
 * Skips when: the project has no package.json, it's the editor repo itself (its
 * deps are already managed), it has nothing to install (no deps/workspaces), or
 * node_modules already exists (cheap heuristic — avoids reinstalling every open).
 */
/** Heal a project's native config on open — idempotent, dep-INDEPENDENT: writes a
 *  machine-local android/local.properties, syncs iOS DEVELOPMENT_TEAM from
 *  project.config.json, adds the game-debug Local Network keys, wires the debug
 *  bridge into the iOS App target (MyViewController + pbxproj + storyboard), and
 *  adds the Release Info.plist-strip phase — so a fresh clone/worktree builds +
 *  debugs without a manual checklist.
 *
 *  Called EXPLICITLY on every open (launch AND Open Project), BEFORE ensureProjectDeps
 *  — NOT buried inside it. That guarantees three things the old placement didn't:
 *  it runs even for a flat game with native folders but no package.json (which made
 *  ensureProjectDeps early-return before heal); it can't silently stop if the
 *  dep-install logic is refactored; and it ALWAYS logs (a "nothing to do" line
 *  included) so heal-on-open is observable. */
function healProjectOnOpen(projectRoot: string): void {
  if (path.resolve(projectRoot) === REPO_ROOT) return; // the editor's own tree, not a game
  try {
    const { notes } = healNativeConfig(projectRoot);
    if (notes.length) for (const n of notes) console.log(`[modoki-electron] heal: ${n}`);
    else console.log(`[modoki-electron] heal: ${path.basename(projectRoot)} native config already up to date`);
  } catch (e) {
    console.warn(`[modoki-electron] native-config heal failed (continuing): ${e instanceof Error ? e.message : e}`);
  }
}

async function ensureProjectDeps(projectRoot: string): Promise<void> {
  if (path.resolve(projectRoot) === REPO_ROOT) return; // the editor's own tree
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return; // not an npm project

  let pkg: { dependencies?: object; devDependencies?: object; workspaces?: unknown };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return; // unreadable — let Vite surface the real error
  }
  if (!pkg.dependencies && !pkg.devDependencies && !pkg.workspaces) return; // nothing to install

  // Provision Node BEFORE any npm use: vendorEnginePlugins can `npm pack`/`npm run build`, and the
  // install below runs npm — both go through npmSpawnSpec, which needs the provisioned Node on a
  // machine with no system npm. Idempotent (a second call is a cheap stat), so the first open of a
  // project-with-deps pays the one-time download and every later open is instant.
  await ensureNodeProvisioned(); // packaged: download a pinned Node so npm needs no user toolchain

  // Heal-on-open: vendor engine-provided Capacitor plugins (capacitor-game-debug,
  // …) into the project as COPIES — pack a tarball from the editor's OWN engine
  // and point the dep at it (no symlink; dmg-safe). This may rewrite package.json
  // (migrating off the old file:../../engine dir-symlink) and/or regenerate the
  // gitignored tarball, in which case node_modules must be (re)built.
  let needsInstall = !fs.existsSync(path.join(projectRoot, 'node_modules'));
  let vendorResult: VendorResult | null = null;
  try {
    vendorResult = vendorEnginePlugins(projectRoot, REPO_ROOT);
    if (vendorResult.vendored.length) console.log(`[modoki-electron] vendored engine plugin(s): ${vendorResult.vendored.join(', ')}`);
    needsInstall = needsInstall || vendorResult.needsInstall;
  } catch (e) {
    console.warn(`[modoki-electron] plugin vendoring failed (continuing): ${e instanceof Error ? e.message : e}`);
  }

  if (!needsInstall) return; // node_modules present and engine-plugin copies current

  console.log(`[modoki-electron] installing dependencies for ${projectRoot} …`);
  // ci is safe (clean + integrity-checked) only when vendoring didn't just rewrite
  // package.json; otherwise the lockfile is behind and we must `npm install`. (D1)
  await installProjectDeps(projectRoot, { preferCi: !(vendorResult?.changed) });
  // Record which tarball each plugin was installed from, so the next open can
  // detect a stale extraction (D3).
  if (vendorResult) writeVendorMarker(projectRoot, vendorResult.expectedVendor);
  console.log(`[modoki-electron] dependencies installed for ${projectRoot}`);
}

// The Vite dev-server origin the renderer loads from. Resolved at startup:
// MODOKI_DEV_URL pins it explicitly; otherwise main picks a free port PREFERRING
// 5173 (findFreePort) so a SECOND editor can launch on another port instead of
// hard-failing on the --strictPort clash. Mutable because the free-port pick
// happens after module load, before any consumer (createWindow/backend) runs.
let DEV_URL = process.env.MODOKI_DEV_URL || 'http://127.0.0.1:5173';
// Prod mode: a packaged app, or MODOKI_PROD=1 to test the packaged path against
// a `vite build` dist without the Vite dev server. In prod the renderer shell +
// project assets + /api all load from main's own HTTP server (one origin); in
// dev the shell loads from Vite (HMR) and only the backend is main-hosted.
const PROD = app.isPackaged || process.env.MODOKI_PROD === '1';

// Repo root (the npm/vite root) — owns the Vite dev-server process (dev AND
// packaged, per C4c-3b "run Vite in prod") and resolves engine source + node_modules.
//   • dev: engine/electron/dist/main.cjs → three levels up = the repo.
//   • packaged: electron-builder asarUnpack's engine/** + node_modules/** into
//     <Resources>/app.asar.unpacked (a REAL dir). __dirname would resolve to
//     …/app.asar/… (inside the archive — Vite can't read/exec there), so point at
//     the unpacked tree instead. See electron-builder.yml.
const REPO_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked')
  : path.resolve(__dirname, '..', '..', '..');

// CDP (renderer remote-debugging) for "Connect Claude Code". Chromium requires the
// switch BEFORE app.ready, so decide it here at module load. Packaged: ON BY DEFAULT
// (agent-first editor) — readCdpEnabled is on unless the user explicitly opted OUT in
// the AI panel; MODOKI_CDP_PORT can also force it. The switch is startup-only, so
// "default on" lands at LAUNCH (the packaged app auto-reopens your last project, so
// this is effectively "on whenever you're in a project"). Dev: the launcher passes the
// CLI arg, so we only report the port. See cdp.ts. Read by the status/connect handlers (C2).
const CDP = resolveCdpConfig({
  isPackaged: app.isPackaged,
  // userData is set just above, so this reads the RIGHT dir (valid before ready).
  prefEnabled: app.isPackaged ? readCdpEnabled(app.getPath('userData')) : false,
  // Sticky ladder (§12.2 item 5): last launch's port + whether it bound ours, so a 9222
  // collision advances instead of dead-ending. Packaged only (dev's port is launcher-pinned).
  memo: app.isPackaged ? readCdpPortMemo(app.getPath('userData')) : null,
});
if (CDP.openSwitch) {
  app.commandLine.appendSwitch('remote-debugging-port', String(CDP.port));
  logToFile('info', `[cdp] renderer remote-debugging enabled on 127.0.0.1:${CDP.port}`);
}
// A per-launch nonce baked into the renderer URL (`?cdpNonce=<uuid>#/editor`) so probeCdp
// can prove a CDP endpoint is OUR process, not a sibling editor / stray Chrome tab (§12.2).
// Minted once per process; loadURL uses it and cdpStatus() matches it.
const CDP_NONCE = newCdpNonce();

// Scope the recent-projects history to THIS editor instance so a packaged DMG never
// inherits a dev clone's last project (the cross-branch skew that white-screened the
// editor when a work-ai build auto-opened main's project). Identity = the install .app
// path (packaged, stable across in-place upgrades) or the repo root (dev clone). The
// toolchain stays machine-shared and layout stays per-project — only recents are scoped.
function editorIdentity(): string {
  if (!app.isPackaged) return REPO_ROOT;
  const exe = app.getPath('exe');
  const i = exe.indexOf('.app/');
  return i >= 0 ? exe.slice(0, i + 4) : exe; // the .app bundle path
}
setRecentsScope(editorIdentity());

/** The backend's real port, filled in once it binds. Read by `/api/identity`, whose whole
 *  job is to let a client confirm it is talking to the editor it meant to. */
let resolvedBackendPort = 0;

/** Current branch, read straight from `.git/HEAD` — no child process, no gitdir walking
 *  beyond the common case. Purely informational (the identity banner); `null` for a
 *  detached HEAD, a packaged app, or a non-repo. */
function gitBranch(root: string): string | null {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : null;
  } catch { return null; }
}
/**
 * Resolve which project to open on launch (auto-open last project):
 *   1. MODOKI_PROJECT — HARD override (env). CI / build scripts / an explicit
 *      `MODOKI_PROJECT=games/x` set this and MUST get exactly it.
 *   2. The most recently opened project — so the editor reopens where you left
 *      off, regardless of how it was launched. getRecentProjects() drops paths
 *      that no longer exist. This is why launch-editor.sh's project arg is a SOFT
 *      default (MODOKI_PROJECT_DEFAULT), not MODOKI_PROJECT: it seeds the first
 *      launch but never overrides the remembered project on later launches.
 *   3. MODOKI_PROJECT_DEFAULT — launcher's soft seed (used only when there's no
 *      usable recent, e.g. the very first run).
 *   4. Last resort, no memory + no seed:
 *        - Dev (not packaged): the repo's default flat game (games/3d-test). One
 *          project = one game (#29), so the repo root itself is no longer a
 *          runnable game — open a real project so the editor has a game to host.
 *        - Packaged: there is no bundled repo to open, so prompt for a project
 *          folder. Cancelling returns null → the caller quits (no project, no
 *          editor to host).
 * Runs inside whenReady (needs app.getPath for the recents file).
 */
async function resolveInitialProject(): Promise<string | null> {
  const choice = chooseInitialProject({
    envProject: process.env.MODOKI_PROJECT,
    envDefault: process.env.MODOKI_PROJECT_DEFAULT,
    recents: getRecentProjects(),
    repoRoot: REPO_ROOT,
    packaged: app.isPackaged,
    devFallback: path.join(REPO_ROOT, 'games', '3d-test'),
  });
  if (choice.kind === 'path') return choice.path;

  // First-run pick (packaged, no recents): the user has NO project to reopen, so the
  // chosen folder is a NEW project destination — an empty folder gets scaffolded into
  // a runnable game (== File → New Project) instead of opening a fileless, broken
  // project. An existing project folder is opened as-is; a non-empty non-project
  // folder is rejected (scaffolding would clobber it) and we re-prompt.
  for (;;) {
    const dir = await pickNewProjectFolder(null);
    if (!dir) return null; // cancelled → caller quits (no project to host)
    const kind = projectFolderKind(dir);
    if (kind === 'project') return dir;
    if (kind === 'occupied') {
      await dialog.showMessageBox({
        type: 'error',
        title: 'New Project',
        message: 'That folder can’t be used for a new project.',
        detail: `${dir}\n\nis not empty and isn’t an existing Modoki project. Choose an EMPTY folder for a new game, or an existing project folder to open.`,
        buttons: ['Choose Again'],
      });
      continue;
    }
    try {
      scaffoldProject(dir, { name: path.basename(dir), templateDir: path.join(REPO_ROOT, 'engine', 'templates', 'starter') });
      pendingOpenProjectSettings = true; // fill identity/build info after mount (matches New Project)
      return dir;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error('[modoki-electron] first-run scaffold failed:', detail);
      await dialog.showMessageBox({
        type: 'error', title: 'New Project', message: 'Could not create the project.',
        detail, buttons: ['Choose Again'],
      });
    }
  }
}

// ── Mutable workspace state: the open project's root + its asset backend.
//    "Open Project" swaps both (see setProject); the BackendContext reads them
//    live via getters/closures so the running HTTP server picks up the change.
//    root is set in whenReady via resolveInitialProject(). ──
const state: { root: string; backend: ElectronAssetBackend } = {
  root: '',
  backend: undefined as unknown as ElectronAssetBackend, // set in whenReady
};

let mainWindow: BrowserWindow | null = null;
let backendHandle: BackendServerHandle | null = null;

// ── R→M: the renderer's pushed trait schema (undefined ⇒ ref-only validation). ──
let cachedSchema: SceneSchema | undefined;

// ── M→R: pending requestRenderer() calls keyed by a monotonic id. ──
const pendingRenderer = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
let nextRequestId = 1;

/** Reject + clear every in-flight requestRenderer call (on window close or a
 *  project reload that swaps the renderer out from under them). Without this they
 *  only resolve via their timeout and leak the timer until then (P1-4). */
function failPendingRenderer(reason: string): void {
  for (const { reject, timer } of pendingRenderer.values()) {
    clearTimeout(timer);
    reject(new Error(reason));
  }
  pendingRenderer.clear();
}

/** Forward an op to the editor renderer over IPC and await its reply. The
 *  renderer-side dispatcher is agentBridge.handleOp (same as the HMR path). */
function requestRenderer(op: string, params: unknown, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.webContents.isDestroyed()) {
      reject(new Error('no editor renderer window'));
      return;
    }
    const id = nextRequestId++;
    const timer = setTimeout(() => {
      pendingRenderer.delete(id);
      reject(new Error('timed out waiting for the renderer — is the editor window open?'));
    }, timeoutMs);
    pendingRenderer.set(id, { resolve, reject, timer });
    mainWindow.webContents.send('modoki:bridge-request', { id, op, params });
  });
}

/** Poll the dev server until it answers, so launch order doesn't matter. */
function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let retry: NodeJS.Timeout | null = null;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (retry) clearTimeout(retry);
      if (err) reject(err); else resolve();
    };
    const tryOnce = () => {
      const req = http.get(url, (res) => { res.resume(); finish(); });
      req.on('error', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) finish(new Error(`dev server not reachable at ${url}`));
        else retry = setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

// The editor window is created HIDDEN and revealed only once the renderer has actually
// mounted (its `menu-structure` IPC push — see the bridge-send handler), so the splash
// hands off directly to a painted editor instead of flashing a black window during the
// post-loadURL React mount. A timeout fallback reveals it anyway if that signal never
// arrives, so a renderer that doesn't push can't leave the window hidden behind a stuck
// splash. Idempotent + reset per createWindow (macOS activate re-create).
let mainWindowRevealed = false;
function revealMainWindow(): void {
  if (mainWindowRevealed) return;
  mainWindowRevealed = true;
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); } catch { /* best-effort */ }
  closeSplash();
}

async function createWindow(backendBase: string) {
  mainWindowRevealed = false;
  // The editor ALWAYS loads its shell — and the open project's game code + assets —
  // from the main-owned Vite server (dev AND packaged: "run Vite in prod", C4c-3b).
  // This makes packaged == dev (one origin, one module graph, dedupe keeps the
  // ECS/three singletons single), so opening a project just re-roots that server
  // (setProject), with no separate static-dist shell or host-globals dedup needed.
  // The editor → backend client is pointed cross-origin at main's /api server.
  const pageOrigin = DEV_URL;
  const clientBase = backendBase;
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#1e1e1e',
    // Packaged: created HIDDEN — revealMainWindow() shows it once the editor has mounted
    // (or a timeout), so the splash hands off to a painted editor with no black window in
    // between. Dev has no splash (and MCP/tests expect an immediate window), so show now.
    show: !app.isPackaged,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Don't throttle rAF/timers when the window is occluded or backgrounded. The
      // editor's scene load + prefab instantiation are driven by the frame loop, so
      // throttling stalls scene loading (entities never spawn) when the editor
      // isn't foreground — including headless/MCP verification runs.
      backgroundThrottling: false,
      // OS-level renderer sandbox (default since Electron 20 with nodeIntegration
      // off, but set explicitly so it can't silently regress). The preload only
      // touches `electron` + process.argv, both available to a sandboxed preload.
      sandbox: true,
      // Hand the backend base to preload via argv (available before page load).
      additionalArguments: [`--modoki-backend-base=${clientBase}`],
    },
  });
  mainWindow = win;

  // Persist the RENDERER's console (log/warn/error) to main.log too — otherwise a
  // browser-side error (e.g. a failed module load) is invisible in the file the user
  // sends, since fileLog only tees the MAIN process. Handles both the classic
  // (event, level, message, line, sourceId) signature and Electron's newer single
  // details object. Best-effort; never throws into the event loop.
  win.webContents.on('console-message', (...args: unknown[]) => {
    try {
      const a0 = args[0] as { message?: string; level?: unknown; lineNumber?: number; sourceId?: string } | undefined;
      const lv = ['debug', 'info', 'warning', 'error'];
      let level: string, message: string, source: string, line: number;
      if (a0 && typeof a0.message === 'string') { // newer: single details object
        level = typeof a0.level === 'string' ? a0.level : lv[a0.level as number] ?? 'info';
        message = a0.message; source = a0.sourceId ?? ''; line = a0.lineNumber ?? 0;
      } else { // classic positional args
        const n = args[1];
        level = typeof n === 'string' ? n : lv[n as number] ?? 'info';
        message = String(args[2] ?? ''); line = Number(args[3] ?? 0); source = String(args[4] ?? '');
      }
      const where = source ? ` (${source}:${line})` : '';
      logToFile(`renderer:${level}`, `${message}${where}`);
    } catch { /* best-effort */ }
  });

  win.on('closed', () => {
    mainWindow = null;
    // Reject + clear any in-flight M→R requests so they don't hang to timeout
    // and leak their timers (P1-4 / P3-3).
    failPendingRenderer('editor window closed');
  });

  // ── Renderer hardening (P1-1). The renderer runs untrusted game + scene-asset
  //    code and may load remote http(s) refs; without these, a hostile page (a
  //    redirect, an <a target=_blank>, window.open) could navigate the editor
  //    window — or spawn a child — to an attacker origin that still holds the
  //    preload bridge (an IPC handle to a filesystem/exec backend). ──
  const allowedOrigin = new URL(pageOrigin).origin;
  win.webContents.on('will-navigate', (e, url) => {
    let target: string;
    try { target = new URL(url).origin; } catch { target = ''; }
    if (target !== allowedOrigin) {
      e.preventDefault();
      console.warn(`[modoki-electron] blocked in-window navigation to ${url}`);
    }
  });
  // External links open in the user's browser, never a privileged Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Defense-in-depth CSP — packaged only (PROD). The editor is served by a Vite
  // dev server (HMR ⇒ inline scripts + eval), so the CSP must permit that: it's a
  // RELAXED, loopback-scoped policy, not the locked-down one a static-dist shell
  // could use. It still bounds origins to loopback (the Vite shell + the cross-
  // origin /api backend) + https/data/blob (allowed asset refs, wasm, transcoder
  // workers), so a remote/injected origin can't be reached. In dev no CSP is set
  // (the developer's own trusted machine). Navigation + window-open hardening
  // above is the primary protection in both.
  //
  // `script-src`/`worker-src` include `https:` so an on-device-LLM game (chess,
  // llm-test) can load MediaPipe's GenAI wasm loader `<script>` + inference worker
  // from its CDN (jsdelivr) — the ONLY external-script need in the tree (the KTX2
  // transcoder self-hosts libktx to avoid its CDN). This does NOT weaken the posture:
  // `script-src` already carries `'unsafe-inline' 'unsafe-eval'`, so arbitrary code
  // is already permitted; the bound that matters is loopback+https, matching the
  // `https:` already granted to img/media/connect. Without it the CDN `<script>` is
  // blocked → "Resource load error: genai_wasm_internal.js" and the game never loads.
  if (PROD) {
    const csp = buildProdCsp(PROD_CSP_ORIGINS);
    win.webContents.session.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      });
    });
  }
  // Own the window title (show the open project) — don't let the page's <title>
  // override it.
  win.setTitle(titleFor(state.root));
  win.on('page-title-updated', (e) => e.preventDefault());

  await waitForServer(pageOrigin).catch((e) => console.error('[modoki-electron]', e.message));
  // The nonce placement (QUERY before the hash) is load-bearing and lives in buildRendererUrl
  // so it's pinned by one test — a fragment-placed nonce would silently kill probeCdp. §12.2.
  await win.loadURL(buildRendererUrl(pageOrigin, CDP_NONCE));
  // Fallback reveal: if the editor never pushes its menu-structure (the real mount
  // signal), don't leave the window hidden behind the splash forever. The common path
  // reveals a few seconds earlier, on that IPC.
  setTimeout(revealMainWindow, 15000);
  if (process.env.MODOKI_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

/** Broadcast watcher events to the renderer over IPC. Shared by every project's
 *  asset backend (recreated on Open Project). */
const onManifestUpdated = (manifest: unknown) => mainWindow?.webContents.send('modoki:bridge-manifest-updated', manifest);
const onSceneChanged = (urlPath: string, kind: LiveReloadKind) => mainWindow?.webContents.send('modoki:bridge-scene-changed', { urlPath, kind });

/** Open a different project: stop the old watcher, rebind the asset backend +
 *  SSR loader to the new root, remember it, and reload the renderer so its
 *  panels re-fetch from main's now-rebound backend. */
/** C6 — this editor's token for the OPEN project (docs/connect-claude-code.md §10). The
 *  SINGLE source of truth: the backend gate, `/api/identity`, Connect, heal, and the
 *  staleness check all read THIS, so they can never disagree about which token is current.
 *  Refreshed at exactly the two places `state.root` is assigned — eagerly, so the gate is
 *  never racing a first request, and never does fs work on the request path. Minting for a
 *  project that never connects is harmless (one unused uuid) and buys the property that
 *  `null` means "this install has no token", not "we haven't looked yet". */
let instanceToken: string | null = null;
function refreshInstanceToken(): void {
  try {
    instanceToken = state.root ? ensureToken(app.getPath('userData'), state.root) : null;
  } catch (e) {
    // An unwritable userData must not break the editor — it just means no token gate.
    console.warn('[modoki-electron] could not mint an instance token:', e instanceof Error ? e.message : e);
    instanceToken = null;
  }
}

/** When true, the next renderer mount (after a reload) is asked to open the
 *  Project Settings dialog. Set by setProject({openSettingsAfter}) at the moment
 *  of reload (not earlier) so the OLD renderer can't consume it first. */
let pendingOpenProjectSettings = false;

/** The OBSERVED CDP state — never the pref alone. `cdpEnabled` only means "we asked
 *  Chromium for the port"; it can fail to bind silently, or the port can belong to a
 *  DIFFERENT editor (see probeCdp). Everything user- or agent-facing must key off this,
 *  so we never again report a green CDP that is really someone else's renderer.
 *  Short TTL: the panel polls ~2.5s and identity is hit per MCP process, so one probe
 *  serves them all without hammering the endpoint. */
interface CdpStatus extends CdpProbe { enabled: boolean; port: number | null }
let _cdpProbe: { at: number; result: CdpProbe } | null = null;
const CDP_PROBE_TTL_MS = 3_000;
/** One-shot guard: re-heal once the renderer has mounted (see the menu-structure hook). */
let healedAfterMount = false;
/** Last ours-verdict written to the CDP memo — so we persist only on a CHANGE, not every poll. */
let _cdpMemoWrittenOurs: boolean | null = null;
async function cdpStatus(): Promise<CdpStatus> {
  if (!CDP.enabled) return { enabled: false, port: null, reachable: false, ours: false };
  const now = Date.now();
  if (!_cdpProbe || now - _cdpProbe.at > CDP_PROBE_TTL_MS) {
    _cdpProbe = { at: now, result: await probeCdp(CDP.port, CDP_NONCE) };
    rememberCdpPort(_cdpProbe.result);
  }
  return { enabled: true, port: CDP.port, ..._cdpProbe.result };
}

/** Sticky CDP (§12.2 item 5): persist whether THIS launch's port bound ours, so the next
 *  launch sticks on success or advances past a collision. Only AFTER the renderer has
 *  mounted (a pre-window probe is always not-ours and would wrongly trigger an advance), only
 *  packaged (dev's port is launcher-pinned), and only on a change (not every 2.5s poll).
 *  cdpMemoVerdict keeps a TRANSIENT probe timeout from advancing off a good port. */
function rememberCdpPort(probe: CdpProbe): void {
  if (!app.isPackaged || !healedAfterMount || !CDP.enabled) return;
  const verdict = cdpMemoVerdict(probe);
  if (verdict === null || _cdpMemoWrittenOurs === verdict) return;
  _cdpMemoWrittenOurs = verdict;
  writeCdpPortMemo(app.getPath('userData'), { port: CDP.port, ours: verdict });
}

/** Auto-heal the open project's `.mcp.json` when the editor's backend port changed under
 *  it (C5, docs/connect-claude-code.md §9), then tell the user to restart Claude Code —
 *  the MCP bakes MODOKI_BACKEND at spawn, so a healed port only takes effect on a
 *  `claude` restart. No-ops unless the project already has OUR modoki server with a stale
 *  port, so a never-connected project is never touched. Rare, thanks to the sticky port. */
async function healConnectedMcp(): Promise<void> {
  if (!resolvedBackendPort || !state.root) return;
  try {
    // Only re-point chrome-devtools at a VERIFIED-ours endpoint; null ⇒ heal leaves the
    // existing entry alone rather than aiming it at another editor's renderer.
    const cdp = await cdpStatus();
    // Heal the config claude actually LOADS: for an in-repo game that's the repo root's,
    // not the game folder's (C9, §13). resolveMcpTarget never CREATES one, and heal
    // no-ops unless the file already carries our modoki server.
    const r = healMcpPort({
      mcpPath: resolveMcpTarget(state.root).mcpPath,
      backendPort: resolvedBackendPort,
      cdpPort: cdp.ours ? cdp.port : null,
      token: instanceToken,
    });
    if (r.reason === 'unparseable') {
      // We correctly refuse to overwrite it — but the user's claude can't read it either,
      // and nothing else in the app would ever say so.
      console.warn(`[modoki-electron] ${r.mcpPath} is not valid JSON — Claude Code cannot use it (not overwriting). Fix it, or use AI → Connect Claude Code to rewrite.`);
      return;
    }
    if (r.reason === 'tracked') {
      // Refused BY DESIGN: an unattended write must not dirty a version-controlled file
      // (C9b). Not a dialog — the user didn't ask for anything, and the AI panel already
      // reports the config as stale with a Reconnect button, which is the explicit action.
      console.log(`[modoki-electron] ${r.mcpPath} is tracked by git — not rewriting it unattended (port ${r.oldPort} → ${resolvedBackendPort}). Use AI → Connect Claude Code, or set MODOKI_BACKEND in your shell.`);
      return;
    }
    if (!r.healed) return;
    const changed = r.changed ?? [];
    console.log(`[modoki-electron] ${r.mcpPath} healed (${changed.join(', ')}): backend port ${r.oldPort} → ${r.newPort}`);
    // Say what ACTUALLY changed — a token-only heal (a reset userData) has nothing to do
    // with the port, and "the editor's port changed" would just be wrong.
    const portChanged = changed.includes('backend');
    // Name the directory of the file we ACTUALLY healed, not the project root. C9 made
    // these differ: for an in-repo game the config lives at the repo root, which is where
    // `claude` runs — telling that developer to restart it in `games/3d-test`, a folder
    // they've never had a session in, talks them out of the one action this dialog exists
    // to prompt.
    const claudeDir = r.mcpPath ? path.dirname(r.mcpPath) : state.root;
    const box = {
      type: 'info' as const,
      title: 'Claude Code connection updated',
      message: portChanged
        ? 'The editor’s port changed — restart Claude Code to reconnect.'
        : 'This project’s Claude Code connection was repaired — restart Claude Code.',
      detail: `${r.mcpPath} now matches this editor${portChanged ? ` (port ${r.newPort})` : ''}.\n\nIf you have “claude” running in ${claudeDir}, quit and restart it so it picks up the change.`,
      buttons: ['OK'],
    };
    void (mainWindow ? dialog.showMessageBox(mainWindow, box) : dialog.showMessageBox(box));
  } catch (e) {
    // Best-effort: a heal failure must never block opening a project.
    console.warn('[modoki-electron] .mcp.json heal failed:', e instanceof Error ? e.message : e);
  }
}

async function setProject(newRoot: string, opts?: { openSettingsAfter?: boolean }): Promise<void> {
  await state.backend.stop().catch(() => {});
  state.root = newRoot;
  refreshInstanceToken(); // the token is per-project — a new root means a new expected token
  state.backend = createAssetBackend({ projectRoot: newRoot, onManifestUpdated, onSceneChanged });
  state.backend.start();
  await closeSsrLoader(); // recreated lazily against the new root
  // The renderer loads its shell, the project's game CODE, and its ASSETS from the
  // Vite server, rooted at MODOKI_PROJECT at startup. main owns that process
  // (devServer.ts) in BOTH dev and packaged, so re-root it by restarting it at the
  // new project — otherwise the renderer keeps pulling everything project-specific
  // from the OLD root (the split-brain: "Unknown asset guid" / blank scenes /
  // failed saves). This is the same path for dev and packaged ("run Vite in prod").
  if (process.env.MODOKI_NO_DEV_SERVER !== '1') {
    try {
      // First open of a project may need its deps installed (external project, or
      // an in-repo game never installed). Show progress in the title — npm install
      // can take several seconds and the window is already visible.
      mainWindow?.setTitle(`Modoki Editor ${APP_VERSION} — installing ${path.basename(newRoot)}…`);
      healProjectOnOpen(newRoot);
      if (app.isPackaged) await ensureNodeProvisioned(); // Core before Vite spawn (see whenReady)
      await ensureProjectDeps(newRoot);
      await startDevServer({ repoRoot: REPO_ROOT, projectRoot: newRoot, url: DEV_URL });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error('[modoki-electron] open project failed:', detail);
      mainWindow?.setTitle(titleFor(state.root));
      const opts = {
        type: 'error' as const,
        title: 'Open Project failed',
        message: 'Could not prepare the new project (dependency install or Vite server).',
        detail: `${detail}\n\nThe editor may be in an inconsistent state — relaunch:\n  scripts/launch-editor.sh "${newRoot}"`,
        buttons: ['OK'],
      };
      if (mainWindow) await dialog.showMessageBox(mainWindow, opts); else await dialog.showMessageBox(opts);
      return;
    }
  }
  addRecentProject(newRoot);
  rebuildMenu();
  mainWindow?.setTitle(titleFor(newRoot));
  void healConnectedMcp(); // the newly-opened project may carry a stale baked port (C5)
  // Reject in-flight M→R requests before the reload tears down their frame, so
  // they fail fast instead of hanging to timeout against a reloading webContents.
  failPendingRenderer('project changed — renderer reloading');
  // Arm the one-shot just before reload — the next menu-structure push (from the
  // freshly-mounted renderer) opens Project Settings. Set here, not earlier, so a
  // late menu push from the OLD renderer can't consume it first.
  if (opts?.openSettingsAfter) pendingOpenProjectSettings = true;
  // reloadIgnoringCache (NOT reload): a soft reload can re-serve the PREVIOUS
  // project's HTTP-cached assets — most visibly `/assets.manifest.json` (new
  // GUIDs never register → textures fail) and dev texture variants, which carry
  // no cache-bust. Bypassing the cache here makes a project switch fetch the new
  // project's manifest + assets fresh, matching what a manual hard reload does.
  mainWindow?.webContents.reloadIgnoringCache();
  console.log(`[modoki-electron] opened project: ${newRoot}`);
}

// Latest editor menu structure pushed by the renderer (R→M). The OS menu carries
// the editor's own actions; before the first push it's a native-only File menu.
let rendererMenuSpec: RendererMenuSpec | undefined;

function rebuildMenu(): void {
  installAppMenu({
    currentRoot: state.root,
    onNewProject: async () => {
      const dir = await pickNewProjectFolder(mainWindow);
      if (!dir) return;
      try {
        scaffoldProject(dir, { name: path.basename(dir), templateDir: path.join(REPO_ROOT, 'engine', 'templates', 'starter') });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.error('[modoki-electron] new project failed:', detail);
        const errOpts = { type: 'error' as const, title: 'New Project failed', message: 'Could not create the project.', detail, buttons: ['OK'] };
        if (mainWindow) await dialog.showMessageBox(mainWindow, errOpts); else await dialog.showMessageBox(errOpts);
        return;
      }
      // Open it, then show Project Settings so the user can fill in identity/build info.
      await setProject(dir, { openSettingsAfter: true });
    },
    onOpenProject: async () => {
      const chosen = await pickProjectFolder(mainWindow);
      if (chosen && chosen !== state.root) await setProject(chosen);
    },
    onOpenRecent: (root) => { if (root !== state.root) void setProject(root); },
    rendererMenus: rendererMenuSpec,
    // Relay an OS-menu click to the renderer, which dispatches the editor action.
    onMenuAction: (id) => mainWindow?.webContents.send('modoki:bridge-menu-action', id),
    onCheckForUpdates: () => checkForUpdatesInteractive(),
    onAbout: () => showAboutDialog(),
  });
}

// Custom, cross-platform "About Modoki" window — a small branded, frameless dark
// panel (matching the navy app icon) rather than a plain OS message box. Shows the
// icon, name + ™, engine/runtime versions, copyright, and a link to the site.
// The icon is sourced from the editor favicon (which ships inside the packaged
// engine tree) so it renders in dev AND packaged; build/icon.png is the dev
// fallback. Reuses a single window (focuses it if already open).
let aboutWindow: BrowserWindow | null = null;

function showAboutDialog(): void {
  if (aboutWindow && !aboutWindow.isDestroyed()) { aboutWindow.focus(); return; }

  const iconFile = [
    path.join(REPO_ROOT, 'engine', 'packages', 'modoki', 'src', 'runtime', 'assets', 'favicon.png'),
    path.join(REPO_ROOT, 'build', 'icon.png'),
    process.resourcesPath ? path.join(process.resourcesPath, 'icon.png') : '',
  ].find((p) => { try { return !!p && fs.existsSync(p); } catch { return false; } });
  let iconSrc = '';
  try {
    if (iconFile) iconSrc = nativeImage.createFromPath(iconFile).resize({ width: 128, height: 128 }).toDataURL();
  } catch { /* no icon — the window still renders */ }

  const year = new Date().getFullYear();
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { color-scheme: dark; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { height:100%; }
  body {
    -webkit-app-region: drag; user-select:none; cursor:default; overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background: radial-gradient(120% 90% at 50% 0%, #24243d 0%, #1a1a2e 46%, #10101a 100%);
    color:#f2ead9; height:100vh; padding:44px 34px 26px;
    display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;
  }
  .close {
    -webkit-app-region:no-drag; position:fixed; top:12px; right:14px;
    width:26px; height:26px; border:none; border-radius:7px; cursor:pointer;
    background:rgba(255,255,255,.06); color:#b8b0c4; font-size:14px; line-height:1;
    transition:background .15s ease,color .15s ease;
  }
  .close:hover { background:rgba(255,255,255,.13); color:#fff; }
  .icon { width:104px; height:104px; border-radius:24px; margin-bottom:22px;
    box-shadow:0 18px 46px -12px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.04); }
  .name { font-size:23px; font-weight:800; letter-spacing:-.02em;
    background:linear-gradient(135deg,#c9b6ff,#7fe6f0);
    -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
  .tagline { margin-top:7px; font-size:13px; color:#a79fb6; }
  .ver { margin-top:22px; font-family:ui-monospace,Menlo,Consolas,monospace;
    font-size:12px; color:#8b84a0; line-height:1.75; }
  .divider { width:64px; height:1px; background:rgba(255,255,255,.09); margin:22px 0 15px; }
  .copy { font-size:11.5px; color:#726b84; }
  .link { -webkit-app-region:no-drag; display:inline-block; margin-top:13px;
    font-size:12.5px; color:#b7a7f5; text-decoration:none; }
  .link:hover { color:#d6ccff; text-decoration:underline; }
</style></head><body>
  <button class="close" title="Close" onclick="window.close()">&#10005;</button>
  ${iconSrc ? `<img class="icon" src="${iconSrc}" alt="Modoki" />` : ''}
  <div class="name">Modoki&trade; Editor</div>
  <div class="tagline">AI-native 2D/3D game engine</div>
  <div class="ver">Engine ${ENGINE_VERSION}<br>Electron ${process.versions.electron} &middot; Chromium ${process.versions.chrome}</div>
  <div class="divider"></div>
  <div class="copy">&copy; ${year} Modoki. All Rights Reserved.</div>
  <a class="link" href="https://modoki-engine.com" target="_blank" rel="noreferrer">modoki-engine.com</a>
  <script>document.addEventListener('keydown', function(e){ if (e.key === 'Escape') window.close(); });</script>
</body></html>`;

  aboutWindow = new BrowserWindow({
    width: 380, height: 468, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, frame: false, show: false, backgroundColor: '#1a1a2e',
    parent: mainWindow ?? undefined, title: 'About Modoki',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  aboutWindow.setMenuBarVisibility(false);
  void aboutWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  aboutWindow.once('ready-to-show', () => aboutWindow?.show());
  // External links open in the user's browser, never navigate this window.
  aboutWindow.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  aboutWindow.webContents.on('will-navigate', (e, url) => { e.preventDefault(); void shell.openExternal(url); });
  // Escape closes — handled in MAIN so it works even if renderer JS is ever blocked.
  aboutWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') aboutWindow?.close();
  });
  aboutWindow.on('closed', () => { aboutWindow = null; });
}

app.whenReady().then(async () => {
  // About is a custom cross-platform dialog (showAboutDialog) wired via the app
  // menu — no native about panel (setAboutPanelOptions) is used anymore.
  // Dev: show the Modoki icon in the Dock (packaged builds get it from the bundle).
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    try { app.dock.setIcon(path.join(REPO_ROOT, 'build', 'icon.png')); } catch { /* best-effort */ }
  }

  // Packaged: prefer bundled native CLIs (extraResources/bin) over PATH. No-op
  // until the binaries are bundled (beforePack + signing pass) — each resolver
  // falls back gracefully. We bundle only the tools with no download path that the
  // core/common pipeline needs: toktx (KTX texture encode) + msdf-atlas-gen (font
  // atlas bake). ffmpeg/ffprobe are NOT here — they're downloaded on-demand into
  // the userData toolchain (install('ffmpeg')), resolved lazily by audio-convert.
  if (app.isPackaged) {
    const resolveBundled = (envVar: string, name: string) => {
      if (process.env[envVar]) return;
      // Windows executables carry `.exe` (toktx.exe); its sibling ktx.dll is staged
      // beside it so the OS DLL search (same dir as the .exe) resolves it.
      const exe = process.platform === 'win32' ? `${name}.exe` : name;
      const p = path.join(process.resourcesPath, 'bin', exe);
      if (fs.existsSync(p)) process.env[envVar] = p;
    };
    resolveBundled('MODOKI_TOKTX', 'toktx');
    resolveBundled('MODOKI_MSDF_ATLAS_GEN', 'msdf-atlas-gen');
  }

  // Cross-process toolchain parity: the /api/build pipeline runs `npm run build` / `cap sync` in
  // the spawned VITE process, which is spawned BEFORE main provisions Node (project-open), so it
  // can't inherit main's MODOKI_NODE. Instead, share the toolchain DIR (a static path known now)
  // + a "should provision" flag; main AND the build handler each ensureNode() into it idempotently,
  // so build steps run on the provisioned Node too. Both are inherited by the Vite child.
  // MACHINE-level, deliberately OUTSIDE userData (userDataDir.ts): a JDK is a JDK.
  // projects.ts already claimed "the toolchain is machine-shared" — hanging it off userData
  // made that false, giving each flavour its own copy (npm-tools was duplicated across dev
  // and packaged). Pinning it also means scoping userData costs no re-download.
  process.env.MODOKI_TOOLCHAIN_DIR ??= resolveToolchainDir(app.getPath('appData'));
  if (app.isPackaged) process.env.MODOKI_PROVISION_NODE = '1';

  // Register the per-type reimport handlers (the Vite plugin does this in
  // configResolved; main must do it itself so /api/reimport has handlers).
  registerReimportHandler('texture', textureReimportHandler);
  registerReimportHandler('model', modelReimportHandler);
  registerReimportHandler('audio', audioReimportHandler);
  registerReimportHandler('font', fontReimportHandler);
  registerReimportHandler('environment', environmentReimportHandler);

  // ── Resolve + remember the project to open (auto-open last on next launch). ──
  // Fold any legacy dev recents (…/Electron/) into the shared file first, so the
  // "most recent" lookup below sees the full pre-migration history.
  migrateLegacyRecents();
  const initialRoot = await resolveInitialProject();
  if (!initialRoot) { app.quit(); return; } // packaged first-launch picker cancelled
  state.root = initialRoot;
  refreshInstanceToken(); // before the backend binds, so the token gate is never unarmed
  addRecentProject(initialRoot);

  // ── Asset backend for the initial project. ──
  state.backend = createAssetBackend({ projectRoot: state.root, onManifestUpdated, onSceneChanged });
  state.backend.start();
  rebuildMenu();

  // ── BackendContext: M handlers via the (mutable) asset backend; M→R via
  //    requestRenderer; R→M via cachedSchema. Reads state.root/state.backend
  //    live so "Open Project" rebinds the running HTTP server without a restart.
  //    ssrLoadModule is backed by a lazy bare Vite SSR server (Phase 3). ──
  const ctx: BackendContext = {
    get projectRoot() { return state.root; },
    editorRoot: REPO_ROOT, // serve the editor's own Basis transcoder to flat projects
    resolveAssetPath: (p) => state.backend.resolveAssetPath(p),
    absToAssetUrl: (p) => state.backend.absToAssetUrl(p),
    firstRootDir: () => state.backend.firstRootDir(),
    getManifest: () => state.backend.getManifest(),
    rebuildManifest: () => state.backend.rebuildManifest(),
    computeUnused: () => state.backend.computeUnused(),
    requestBrowser: requestRenderer,
    getSchema: () => cachedSchema,
    markEditorWrite: (p, h) => state.backend.markEditorWrite(p, h),
    ssrLoadModule: (url) => getSsrLoadModule(state.root, REPO_ROOT).then((load) => load(url)),
    // main has no Vite module graph, and a project_settings write reaches THIS Electron backend
    // while the CHILD VITE serves the renderer and caches the virtual:modoki-project-config module.
    // Forward a cross-process invalidate to that Vite so the edit takes effect on the next renderer
    // reload (re-audit finding 4). Module-only — the route calls the Vite's own invalidateModule,
    // NOT a page reload (an earlier watch-based attempt reloaded the page, discarding unsaved work
    // and breaking the packaged smoke). Fire-and-forget: the disk write already succeeded; if the
    // child Vite is down the config self-heals on relaunch.
    invalidateProjectConfig: () => {
      fetch(`${DEV_URL}/api/invalidate-project-config`, { method: 'POST' }).catch(() => { /* Vite unreachable — self-heals on relaunch */ });
    },
  };

  // ── Trusted-input routes. `ops` binds each primitive to the live window lazily —
  //    `mainWindow` is reassigned across Open Project, and the hostRoutes guard below
  //    has already proved it non-null by the time any of these run. ──
  const inputRoutes = createInputRoutes({
    ops: {
      tap: (x, y, o) => tap(mainWindow!, x, y, o),
      drag: (from, to, o) => drag(mainWindow!, from, to, o),
      hover: (x, y, m) => hover(mainWindow!, x, y, m),
      scroll: (x, y, dx, dy) => scroll(mainWindow!, x, y, dx, dy),
      pressKey: (key, m) => pressKey(mainWindow!, key, m),
      typeText: (text, o) => typeText(mainWindow!, text, o),
      focusElement: (selector) => focusElement(mainWindow!, selector),
    },
    requestRenderer,
  });

  // ── Renderer-bound host routes (capture/input) — only main can serve them
  //    (they touch the live window). Tried before the shared router. ──
  const hostRoutes: HostRoutes = async ({ method, urlPath, query, body, tokenCheck }) => {
    // ── GET /api/identity — WHICH editor is this? Answered before the mainWindow guard
    //    (an identity check must work even while the window is starting or gone).
    //
    //    Two clones of this repo run side by side on one machine, each with its own
    //    editor on its own port. An MCP client pointed at the WRONG port drives the
    //    OTHER clone's editor: every call succeeds, nothing the agent expects changes,
    //    and there is no signal anywhere. That happened for a whole session. This route
    //    is how a client can tell, in one request, whose editor it is talking to. ──
    if (urlPath === '/api/identity' && method === 'GET') {
      // The OTHER two ports live here too, so an agent can self-serve the escape hatches
      // CLAUDE.md documents (raw CDP for render-on-demand / stale-frame / WGSL bugs; Vite
      // for module/asset serving) instead of guessing 9222 — and so a dead chrome-devtools
      // is DIAGNOSABLE rather than silent. Deliberately fields on identity, not a 66th
      // tool: identity is already the "what am I actually talking to?" call.
      const cdp = await cdpStatus();
      return { kind: 'json', body: {
        repoRoot: REPO_ROOT,
        projectRoot: state.root,
        backendPort: resolvedBackendPort,
        pid: process.pid,
        branch: gitBranch(REPO_ROOT),
        packaged: app.isPackaged,
        vitePort: Number(new URL(DEV_URL).port) || null,
        // cdpPort means "a CDP endpoint that is OURS" — null when the pref is on but the
        // port didn't bind or belongs to another editor. cdpReachable/cdpOurs tell the
        // full story (enabled + reachable + !ours ⇒ something else holds the port).
        cdpEnabled: cdp.enabled,
        cdpPort: cdp.ours ? cdp.port : null,
        cdpReachable: cdp.reachable,
        cdpOurs: cdp.ours,
        // C6: identity is the ONE route the token gate exempts (403ing the diagnostic would
        // hide the reason for the 403), so it reports the verdict instead. 'mismatch' ⇒ this
        // client's config names another editor and every other call is being refused.
        tokenCheck,
      } };
    }
    if (!mainWindow) return null;
    if (urlPath === '/api/capture-viewport' && (method === 'GET' || method === 'POST')) {
      const opts = (body ?? {}) as { maxSide?: number; quality?: number };
      const result = await captureViewport(mainWindow, opts);
      return { kind: 'json', body: result };
    }
    // ── Trusted input (`/api/input/*`), incl. selector-aware aiming. Extracted so the
    //    resolve-then-dispatch ordering is unit-testable. ──
    const inputResult = await inputRoutes({ method, urlPath, query, body, tokenCheck });
    if (inputResult) return inputResult;
    // ── Phase G: input-feel capture — trusted drag while sampling an entity's
    // Transform per frame, so an agent can tune feel against a numeric trajectory. ──
    if (urlPath === '/api/capture-gesture' && method === 'POST') {
      const { from, to, steps, sampleEntityId, sampleGuid } = (body ?? {}) as { from?: { x: number; y: number }; to?: { x: number; y: number }; steps?: number; sampleEntityId?: number; sampleGuid?: string };
      if (!from || !to || (typeof sampleEntityId !== 'number' && !sampleGuid)) {
        return { kind: 'json', status: 400, body: { error: 'from, to {x,y} and sampleEntityId OR sampleGuid are required' } };
      }
      // Prefer the GUID (stable across hot-reloads) — resolve it via a where query each
      // sample; fall back to the numeric id. (For general non-drag sampling use modoki_watch.)
      const sampleParams = sampleGuid
        ? { where: `EntityAttributes.guid=${sampleGuid}`, trait: 'Transform' }
        : { id: sampleEntityId, trait: 'Transform' };
      // Prove the sample target RESOLVES before dragging. It used to return {ok:true} with a
      // trajectory of empty samples for a guid that matched nothing — so a typo, or a guid
      // from a previous scene / a stale get_scene_state, read as "the drag produced no
      // motion" (a real gameplay finding) rather than "you sampled a phantom". The whole
      // point of this tool is tuning feel against a numeric trajectory. (C7)
      const probe = (await requestRenderer('scene-state', sampleParams)) as { entityCount?: number } | null;
      if (!probe?.entityCount) {
        return { kind: 'json', status: 404, body: { error: `sample target ${sampleGuid ? `guid '${sampleGuid}'` : `id ${sampleEntityId}`} matched no entity in the live world — nothing to sample, so the trajectory would be empty. Re-read it with get_scene_state (guids are stable; ids are reassigned on every scene reload).` } };
      }
      // capture_gesture measures the trajectory the drag PRODUCES — which only happens while the sim
      // runs. A Stopped/Paused game returns ok:true with a flat trajectory that reads exactly like a
      // real "the object didn't track the drag" finding. Guard it symmetrically with the phantom-guid
      // probe above. (No editor to ask ⇒ proceed, same as the mutate route.) (F13)
      const playProbe = (await requestRenderer('editor-state', {})) as { playState?: string } | null;
      if (playProbe && playProbe.playState !== 'playing') {
        return { kind: 'json', status: 409, body: { error: `game is ${playProbe.playState ?? 'not playing'} — press Play first (modoki_play_control play). capture_gesture samples the motion the drag causes; a stopped game produces a flat, misleading trajectory.` } };
      }
      const result = await captureGesture(mainWindow, {
        from, to, steps,
        sample: () => requestRenderer('scene-state', sampleParams),
      });
      return { kind: 'json', body: { ok: true, ...result } };
    }
    return null;
  };

  // Resolve a free Vite-server port (PREFERRING the conventional/explicit one)
  // unless MODOKI_DEV_URL pins the origin. This is what lets a SECOND editor launch
  // on another port instead of the Vite spawn hard-failing on --strictPort. Done
  // before the backend starts because the backend proxies /api/build to DEV_URL.
  if (!process.env.MODOKI_DEV_URL) {
    const vitePort = await findFreePort(Number(new URL(DEV_URL).port) || 5173);
    DEV_URL = `http://127.0.0.1:${vitePort}`;
  }

  // Backend port: an EXPLICIT MODOKI_BACKEND_PORT is a stable MCP-target contract —
  // if it's taken, FAIL LOUD rather than drift to an ephemeral port the MCP client
  // can't find (E6).
  //
  // Without it, the port is STICKY (C5, docs/connect-claude-code.md §9): it's the MCP
  // target baked into the user's .mcp.json, and Claude Code can only pick up a change by
  // RESTARTING — so prefer the port we bound LAST, then 5179, then a deterministic scan.
  // (The old `findFreePort(5179, fallback)` jumped straight to a RANDOM ephemeral port
  // when 5179 was taken, so every launch drew a new port and silently staled .mcp.json.)
  // An ephemeral port is now the last resort, only if every candidate is taken.
  // An env var that is SET but unparseable must not silently fall through to the ladder:
  // `pinnedBackend` (presence) and the port validity have to agree, or a typo'd
  // MODOKI_BACKEND_PORT=5181x would quietly bind 5179 — another clone's editor port —
  // and every later MCP call would drive the wrong editor. Fail loud instead.
  const rawPin = process.env.MODOKI_BACKEND_PORT;
  const pinned = parseBackendPort(rawPin);
  if (rawPin != null && rawPin.trim() !== '' && pinned == null) {
    console.error(`[modoki-electron] MODOKI_BACKEND_PORT=${JSON.stringify(rawPin)} is not a valid port (expected an integer 1-65535) — refusing to drift to another port (the MCP target must stay stable). Fix or unset it.`);
    app.exit(1);
    return;
  }
  const pinnedBackend = pinned != null;
  const candidates = portCandidates({
    pinned,
    lastPort: pinnedBackend ? null : readLastPort(app.getPath('userData')),
  });

  // Bind by ACTUALLY LISTENING on each candidate — never probe-then-rebind. A
  // probe (bind+close) followed by a separate real bind leaves a TOCTOU window in which
  // another editor can steal the port; the real bind would then reject, and with no
  // handler that surfaced as an unhandled rejection = no backend, no window, no error
  // (silent launch failure). The deterministic ladder makes concurrent launches walk the
  // SAME sequence, so that race is likely, not theoretical. Letting the real listen be
  // the probe means a lost race is just an EADDRINUSE we retry on the next candidate.
  //
  // No appDistDir: the editor shell is served by the Vite server (below), not a static
  // dist. main's HTTP server is /api + assets only. viteOrigin lets it proxy the
  // /api/build SSE to the Vite server (which owns the build pipeline).
  const bindOpts = { hostRoutes, viteOrigin: DEV_URL, getExpectedToken: () => instanceToken };
  let bindErr: unknown = null;
  for (const candidate of candidates) {
    try {
      backendHandle = await startBackendServer(ctx, { ...bindOpts, port: candidate });
      break;
    } catch (e) {
      bindErr = e;
      // Only a port CLASH is retryable — EACCES/EPERM etc. mean something is wrong that
      // trying nine more ports would only hide.
      if ((e as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') break;
    }
  }
  if (!backendHandle && !pinnedBackend && (bindErr as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
    // Every preferred port is taken (several editors up) — take any free port rather than
    // failing to launch. This is the case that stales .mcp.json; healConnectedMcp() below
    // rewrites it and tells the user to restart Claude.
    try {
      backendHandle = await startBackendServer(ctx, { ...bindOpts, port: 0 });
      console.warn(`[modoki-electron] preferred ports (${candidates.join(', ')}) all taken — using ephemeral ${backendHandle.port}`);
    } catch (e) { bindErr = e; }
  }
  if (!backendHandle) {
    const why = bindErr instanceof Error ? bindErr.message : String(bindErr);
    const msg = pinnedBackend
      ? `MODOKI_BACKEND_PORT=${pinned} is already in use — refusing to drift (the MCP target must stay stable). Free that port or unset MODOKI_BACKEND_PORT.`
      : `Could not start the local backend on any port.\n\n${why}`;
    console.error(`[modoki-electron] ${msg}`);
    dialog.showErrorBox('Modoki Editor', msg); // fail LOUD — a windowless live process is worse
    app.exit(1);
    return;
  }
  resolvedBackendPort = backendHandle.port; // the port that actually bound — what /api/identity reports
  const backendBase = `http://127.0.0.1:${backendHandle.port}`;
  console.log(`[modoki-electron] backend listening on ${backendBase}${PROD ? ' (packaged)' : ''}`);
  // Remember it so the NEXT launch prefers the same port and the user's baked
  // .mcp.json keeps working without a Claude restart (C5). Pinned ports aren't
  // remembered — the env is already the source of truth for those.
  if (!pinnedBackend) writeLastPort(app.getPath('userData'), backendHandle.port);
  // If this launch DID land on a different port than the open project's .mcp.json bakes,
  // rewrite it now and tell the user to restart Claude (C5).
  void healConnectedMcp();

  // ── IPC from the renderer: schema push (R→M) + request replies (M→R). ──
  ipcMain.on('modoki:bridge-send', (e, msg: { event: string; data: unknown }) => {
    // Trust only the editor window's top frame (P1-2). A navigated or child frame
    // must not be able to poison the cached schema or forge a request reply.
    if (!mainWindow || e.senderFrame !== mainWindow.webContents.mainFrame) return;
    if (msg.event === 'schema') {
      cachedSchema = msg.data as SceneSchema;
    } else if (msg.event === 'menu-structure') {
      // Editor pushed its menu structure → rebuild the OS menu so its actions
      // (and dynamic labels/enabled state) show natively.
      rendererMenuSpec = msg.data as RendererMenuSpec;
      rebuildMenu();
      // This push == the editor renderer has mounted (painted, not just page-loaded):
      // hand off from the splash to the now-ready window (no black gap).
      revealMainWindow();
      // …and it's the FIRST moment probeCdp can work: at startup the heal runs before the
      // window exists, so there is no page target on DEV_URL and CDP always reads
      // not-ours — which made the chrome-devtools re-point branch dead on the only
      // unattended path. Re-run once here, with the stale probe dropped. One-shot: this
      // event fires on every menu rebuild.
      if (!healedAfterMount) {
        healedAfterMount = true;
        _cdpProbe = null; // don't reuse the pre-window "not ours" result
        void healConnectedMcp();
      }
      // A freshly-created project (New Project) asks to open Project Settings once
      // the renderer has mounted — this push is that mount signal.
      if (pendingOpenProjectSettings) {
        pendingOpenProjectSettings = false;
        mainWindow.webContents.send('modoki:bridge-open-project-settings');
      }
    } else if (msg.event === 'response') {
      const { id, result, error } = msg.data as { id: number; result?: unknown; error?: string };
      const p = pendingRenderer.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      pendingRenderer.delete(id);
      if (error) p.reject(new Error(error)); else p.resolve(result);
    }
  });

  // ── "Connect Claude Code" (docs/connect-claude-code.md): write a machine-correct
  //    .mcp.json into the open project + report connection status to the AI panel.
  //    Only the main process knows the live backend/CDP ports + the on-disk MCP path,
  //    so these facts can't come from anywhere else. Same top-frame trust guard as the
  //    bridge above (set-cdp-enabled RELAUNCHES the app — must not be forgeable). ──
  const fromMainFrame = (e: Electron.IpcMainInvokeEvent): boolean =>
    !!mainWindow && e.senderFrame === mainWindow.webContents.mainFrame;
  const probeReachable = async (url: string): Promise<boolean> => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      return r.status < 500;
    } catch { return false; }
  };

  ipcMain.handle('modoki:connect-claude-status', async (e) => {
    if (!fromMainFrame(e)) return null;
    const backendPort = resolvedBackendPort || null;
    const vitePort = Number(new URL(DEV_URL).port) || null;
    // The config claude will actually load — for an in-repo game that's an ANCESTOR's
    // (C9, §13). Reporting `<projectRoot>/.mcp.json` here would name a file we neither
    // wrote nor read: §12.2's doctrine is that the panel shows OBSERVED state.
    const target = resolveMcpTarget(state.root);
    const mcpPath = target.mcpPath;
    const mcpText = target.exists ? fs.readFileSync(mcpPath, 'utf8') : null;
    // OBSERVED, not intended: the pref alone once painted CDP green while the port
    // belonged to a sibling clone's editor.
    const cdp = await cdpStatus();
    const cdpPort = cdp.ours ? cdp.port : null;
    return {
      projectRoot: state.root,
      mcpPath,
      // Where to run `claude`. Derived here (node `path`) rather than in the renderer, so
      // the panel never has to reimplement dirname for win32 vs posix.
      mcpDir: path.dirname(mcpPath),
      // 'ancestor' ⇒ the effective config lives ABOVE the project (an in-repo game whose
      // repo root is where `claude` runs). The panel says which file it means.
      mcpLocation: target.location,
      // Other .mcp.json files claude would ALSO merge. Non-empty ⇒ which editor a `modoki`
      // call reaches depends on the cwd the user launches `claude` in.
      mcpShadowing: target.shadowing,
      backendPort,
      vitePort,
      cdpPort,
      cdpEnabled: CDP.enabled,
      cdpReachable: cdp.reachable,
      cdpOurs: cdp.ours,
      cdpForeignPageUrl: cdp.reachable && !cdp.ours ? cdp.pageUrl : undefined,
      cdpConfiguredPort: CDP.enabled ? CDP.port : null,
      isPackaged: app.isPackaged,
      backendReachable: !!backendPort,
      viteReachable: await probeReachable(DEV_URL),
      claude: detectClaudeCli(),
      mcpWritten: mcpText != null,
      // `mcpWritten` only means a FILE exists — it can be corrupt, or a config that isn't
      // ours. Without this the panel reported "Connected" for a .mcp.json Claude can't
      // even parse. `mcpOurs` = it actually carries our modoki server.
      //
      // Judged on the server's PRESENCE, not on a parseable port: Claude Code expands
      // `${VAR:-default}` in .mcp.json, and this repo's own committed config uses it, so a
      // port-based test called a working config "not usable" (C9b).
      mcpOurs: mcpHasModoki(mcpText),
      // The RAW backend string, so the panel can distinguish "baked to a literal port"
      // from "defers to your shell's MODOKI_BACKEND" — states with different fixes.
      mcpBackendRaw: mcpBackendRaw(mcpText),
      // Version-controlled ⇒ the unattended heal refuses it, and Connect warns before
      // dirtying the user's tree.
      mcpTracked: gitTrackedState(mcpPath) === 'tracked',
      // The config's OWN chrome-devtools port, read unconditionally. A `.mcp.json` written
      // before the CDP verification existed (or while another editor held the port) can
      // still aim Claude at a FOREIGN renderer — the original bug, displaced from the
      // status row into the file. We deliberately don't delete the user's entry, so the
      // panel must make it visible instead of reporting a clean "Connected".
      mcpChromePort: mcpChromePort(mcpText),
      mcpCdpForeign: mcpChromePort(mcpText) != null && cdpPort == null,
      // Stale = the .mcp.json no longer matches the live editor (backend port drifted, or
      // CDP got enabled but chrome-devtools isn't wired yet) → the panel offers Reconnect.
      mcpStale: isMcpStale({ mcpText, backendPort, cdpEnabled: CDP.enabled, cdpPort, token: instanceToken }),
      // C6: the config names a DIFFERENT editor/project — its calls are being 403'd. Distinct
      // from a drifted PORT (which heal fixes silently); surfaced so the panel can say so.
      mcpTokenForeign: isMcpTokenForeign(mcpText, instanceToken),
    };
  });

  ipcMain.handle('modoki:connect-claude', async (e) => {
    if (!fromMainFrame(e)) return { ok: false, error: 'untrusted frame' };
    try {
      const projectRoot = state.root;
      const backendUrl = `http://127.0.0.1:${resolvedBackendPort}`;
      const modoki = buildMcpServerEntry(REPO_ROOT, app.isPackaged);
      // Write chrome-devtools ONLY against a CDP endpoint we VERIFIED is ours. Baking a
      // --browser-url we haven't checked is worse than omitting it: if another editor
      // holds the port, Claude attaches to THAT renderer and every call silently succeeds
      // against the wrong project. Omitted ⇒ the agent simply has no CDP (an honest gap).
      const cdp = await cdpStatus();
      const chromeDevtools = cdp.ours && cdp.port != null ? buildChromeDevtoolsEntry(cdp.port) : undefined;
      // Write where claude READS (C9, §13): the nearest existing config inside the
      // project's own repo, else the project root. Writing into an in-repo game folder
      // is invisible to the repo-root `claude` the developer actually runs.
      const target = resolveMcpTarget(projectRoot);
      const mcpPath = target.mcpPath;
      const existing = target.exists ? fs.readFileSync(mcpPath, 'utf8') : null;
      const trackedBefore = gitTrackedState(mcpPath); // read BEFORE the write, for the warning
      // mergeMcpConfig THROWS on a corrupt existing file rather than clobbering it.
      // Bake the token that names THIS editor+project, so a config that later reaches a
      // recycled port held by another editor is refused rather than silently obeyed (C6).
      const merged = mergeMcpConfig(existing, { modoki, chromeDevtools }, backendUrl, instanceToken);
      atomicWriteFileSync(mcpPath, merged); // never truncate the user's file on a mid-write fault
      // Refuses for an adopted ancestor + for an already-TRACKED file (this repo's own
      // root .mcp.json is committed — ignoring it would change nothing but the story).
      const gitignored = ensureMcpGitignored(target);
      // §5.3 — an opened EXISTING project with no CLAUDE.md gets the primer, so its `claude`
      // knows the tools instead of flailing. Never overwrites (absent is the only trigger),
      // and a lost template is a quiet no-op — the wiring above already succeeded.
      const claudeMd = ensureProjectClaudeMd({
        projectRoot,
        templatePath: path.join(REPO_ROOT, 'engine', 'templates', 'starter', 'CLAUDE.md'),
        projectName: projectDisplayName(projectRoot),
      });
      return {
        ok: true, projectRoot, backendUrl, mcpPath, gitignored,
        claudeMdWritten: claudeMd.written,
        mcpLocation: target.location,
        mcpShadowing: target.shadowing,
        // An explicit click MAY write a tracked file — it's the user's own repo and git
        // shows them the diff (unlike the unattended heal, which refuses outright). But
        // say so: we just baked a machine-local port into a committed, shared file.
        mcpTrackedWarning: trackedBefore === 'tracked'
          ? `${mcpPath} is tracked by git — this wrote machine-specific ports into a committed file. Review the diff before committing it (other clones/teammates use different ports).`
          : undefined,
        cdpPort: chromeDevtools ? cdp.port : null,
        // Tell the panel WHY chrome-devtools was skipped, so "no CDP" is explained rather
        // than mysterious (the pref is on, but the port isn't ours).
        cdpSkipped: CDP.enabled && !cdp.ours
          ? (cdp.reachable
            ? `port ${CDP.port} is in use by another editor — chrome-devtools not written`
            : `port ${CDP.port} did not open (in use at launch?) — chrome-devtools not written`)
          : undefined,
        claude: detectClaudeCli(),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('modoki:set-cdp-enabled', (e, enabled: boolean) => {
    if (!fromMainFrame(e)) return { ok: false, error: 'untrusted frame' };
    // The remote-debugging switch is applied at STARTUP only (cdp.ts), so a change
    // needs a relaunch. Packaged only — in dev the launcher owns the port via env.
    if (!app.isPackaged) return { ok: false, error: 'In dev, CDP is controlled by MODOKI_CDP_PORT in launch-editor.sh.' };
    writeCdpEnabled(app.getPath('userData'), !!enabled);
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  // ── main OWNS the Vite server (dev AND packaged — "run Vite in prod", C4c-3b).
  //    It serves the editor shell + the open project's game code + assets, rooted
  //    at MODOKI_PROJECT. Owning the process is what lets "Open Project" re-root it
  //    live (setProject). Started AFTER the backend announces itself (so the launch
  //    script's "backend listening" wait isn't gated on Vite boot) and BEFORE the
  //    window loads (createWindow waits for DEV_URL). Skip with MODOKI_NO_DEV_SERVER=1
  //    (an external dev server you manage yourself). NOTE (packaged): the Vite root
  //    (engine/ + node_modules) must be shipped UNPACKED from the asar so Vite can
  //    read it — that's the electron-builder packaging step (overlaps Phase 7). ──
  // Packaged: the app bundle (REPO_ROOT = app.asar.unpacked) is read-only + signed,
  // so Vite can't write its dep-optimize cache under the Vite root. Point it at a
  // writable userData dir (vite.config reads MODOKI_VITE_CACHEDIR); inherited by the
  // spawned Vite. Dev leaves it unset (Vite default under the repo).
  if (app.isPackaged && !process.env.MODOKI_VITE_CACHEDIR) {
    const cacheDir = path.join(app.getPath('userData'), 'vite-cache');
    // BUST THE STALE CACHE ON AN APP-BUILD CHANGE. Vite keys its dep-optimize cache on the
    // LOCKFILE, not the @modoki/engine SOURCE (a symlinked workspace dep) — so after an app update
    // (new engine code, unchanged deps) it reuses the OLD pre-bundled @modoki/engine chunk and every
    // import of a newly-added export fails ("@modoki_engine_runtime.js does not provide an export
    // named 'Transient'"), crashing the editor renderer. userData survives app updates, so the stale
    // cache persists across them. Fix: wipe the cache whenever the build changes. buildSig = version
    // + this main.cjs's size/mtime — main.cjs is regenerated (fresh mtime) on every `build:electron`,
    // so a rebuild always busts it; same build reuses it (fast relaunch). Best-effort: a re-optimize
    // is far cheaper than a stale-cache crash.
    try {
      const st = fs.statSync(__filename); // the packaged main.cjs (app.asar.unpacked/.../dist/main.cjs)
      const buildSig = `${app.getVersion()}:${st.size}:${Math.round(st.mtimeMs)}`;
      const sigFile = path.join(app.getPath('userData'), '.vite-cache-build');
      const prev = fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf8') : '';
      if (prev !== buildSig) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(sigFile, buildSig);
        console.log(`[modoki-electron] app build changed — cleared stale Vite dep-cache (${buildSig})`);
      }
    } catch (e) {
      console.warn(`[modoki-electron] vite-cache build check failed (continuing): ${e instanceof Error ? e.message : e}`);
    }
    process.env.MODOKI_VITE_CACHEDIR = cacheDir;
  }
  if (process.env.MODOKI_NO_DEV_SERVER !== '1') {
    // Immediate feedback for the (potentially minute-plus) first-launch provisioning +
    // Vite cold-start gap, before the editor window exists. Packaged only — dev is fast
    // and an extra window would just get in the way of the HMR/MCP loop.
    if (app.isPackaged) showSplash();
    try {
      setSplashStatus('Preparing the editor runtime…');
      healProjectOnOpen(state.root);
      // Core toolchain: ALWAYS provision the pinned Node on a packaged launch — even
      // for a deps-less / no-package.json project (ensureProjectDeps would skip it) —
      // AND before the Vite child spawns, so it inherits MODOKI_NODE/MODOKI_NPM_CLI
      // and the Build-Support install SSE (which runs IN that child) can npm-install
      // the model tools. Also makes "Core (Node / npm)" show present out of the box.
      // Idempotent (cheap stat when already provisioned).
      if (app.isPackaged) { setSplashStatus('Preparing Node runtime…'); await ensureNodeProvisioned(); }
      setSplashStatus('Installing dependencies…');
      await ensureProjectDeps(state.root);
      setSplashStatus('Starting editor…');
      await startDevServer({ repoRoot: REPO_ROOT, projectRoot: state.root, url: DEV_URL });
    } catch (e) {
      const msg = e instanceof Error ? (e.stack || e.message) : String(e);
      console.error('[modoki-electron] failed to start dev server:', msg);
      // Surface it — otherwise a packaged app (esp. Windows, where the main-process
      // console isn't attached to any terminal) just vanishes and reads as a
      // silent "crash" with no clue what failed. A dialog names the failing step.
      // Show the dialog (modal, sits above the frameless splash) BEFORE closing the
      // splash — destroying the last window first would trip window-all-closed →
      // app.quit() and race the dialog away.
      try {
        const logHint = getLogFilePath() ? `\n\nFull log: ${getLogFilePath()}` : '';
        dialog.showErrorBox(
          'Modoki could not open the project',
          `Opening:\n${state.root}\n\nfailed while starting the editor:\n\n${msg}${logHint}`,
        );
      } catch { /* pre-window dialog best-effort */ }
      closeSplash();
      app.quit();
      return;
    }
  }

  await createWindow(backendBase);
  // The splash stays up until the editor renderer has actually mounted (its
  // menu-structure IPC → revealMainWindow), or the createWindow timeout fallback —
  // so the hand-off is splash → painted editor, with no black window in between.

  // Self-update from the GitHub Releases feed (packaged + signed builds only;
  // no-op in dev). Silent on launch — surfaces only a "restart to install" prompt
  // once a newer signed build has downloaded.
  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(backendBase);
  });
}).catch((e) => {
  // Terminal startup handler. Without this, ANY rejection in the whenReady body (a lost
  // port race, a failed provision) became an unhandled rejection: the process stayed
  // alive with no backend, no window, and no message — a silent launch failure with
  // nothing to report (on Windows there isn't even a console). Fail LOUD instead.
  const why = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error('[modoki-electron] startup failed:', why);
  logToFile('error', `[startup] ${why}`);
  try { dialog.showErrorBox('Modoki Editor — startup failed', `${e instanceof Error ? e.message : String(e)}\n\nLog: ${getLogFilePath()}`); } catch { /* pre-ready */ }
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Electron does NOT await an async before-quit listener, so a bare `async () =>`
// would let the process exit before close() finishes. Defer the quit: prevent it
// once, run the (awaited) teardown, then exit for real.
let quitting = false;
app.on('before-quit', (e) => {
  // An update install ("Restart Now") drives its OWN quit via Squirrel — do NOT
  // preventDefault or app.exit(0) here, or the install handshake is aborted and
  // the update silently doesn't apply. The process-exit hook in devServer still
  // reaps the Vite child. (E1)
  if (isUpdateInstalling()) return;
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void (async () => {
    // Bound the teardown so a wedged close() (e.g. a stuck SSE socket) can't hang
    // the quit, and always exit even if a step rejects. (E4)
    const teardown = (async () => {
      await backendHandle?.close().catch(() => {});
      await state.backend?.stop().catch(() => {});
      await closeSsrLoader().catch(() => {});
      await stopDevServer().catch(() => {});
    })();
    const timeout = new Promise((r) => setTimeout(r, 5000));
    try {
      await Promise.race([teardown, timeout]);
    } finally {
      app.exit(0);
    }
  })();
});
