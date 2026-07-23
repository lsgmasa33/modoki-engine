/**
 * "Open Project" workspace plumbing for the Electron editor (ELECTRON_PLAN
 * Phase 4): a native folder picker, a persisted recent-projects list, and the
 * application menu that drives both. Opening a project rebinds the main-hosted
 * backend's cwd to the chosen folder (see main.ts setProject).
 *
 * Dev note: in `dev:electron` the renderer is still served by THIS repo's Vite
 * dev server, so opening a folder rebinds the asset/scene backend (Assets panel,
 * reimport, scene mutate all target the new root) but does NOT load a different
 * project's game *code* — that needs the packaged renderer + game
 * self-registration (Phase 4 remainder + Phase 7).
 */

import { app, dialog, Menu, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_RECENTS = 10;
// All recents live under a FIXED "modoki-app" dir (via the app-support root), NOT
// app.getPath('userData'): userData differs by launch method AND per dev clone (see
// userDataDir.ts), so keying the LOCATION off it would split the history unpredictably.
// The name is historical — it is just a stable machine-wide bucket, deliberately NOT the
// packaged app's userData (which is appData/"Modoki Editor"). Scoping still happens, but
// by CONTENT (recentsScope below), not by directory.
const RECENTS_DIR = () => path.join(app.getPath('appData'), 'modoki-app');
// Pre-scoping shared file (a SINGLE global list). Retained as the migration SOURCE +
// the fallback when no scope is set (tests / a bare call). It's what let a packaged
// DMG auto-open a DEV clone's last project (cross-branch skew → white screen), so it's
// no longer the live store once a scope is set.
const globalRecentsFile = () => path.join(RECENTS_DIR(), 'recent-projects.json');
// Legacy dev location, migrated once into the global file. Pinned to the LITERAL old dir:
// dev's userData used to BE appData/"Electron", but userDataDir.ts now scopes it per clone,
// so deriving this from getPath('userData') would point at the new (empty) dir and silently
// disable the migration. A legacy path must be spelled out, not re-derived.
const legacyRecentsFile = () => path.join(app.getPath('appData'), 'Electron', 'recent-projects.json');

// The editor-instance identity that SCOPES recents: the install path (packaged) or the
// repo root (dev). Set once by main at startup. Each editor identity gets its OWN
// recents file, so a packaged editor never inherits a dev clone's history and two
// clones don't collide. Keyed by install PATH (not version/hash) → an in-place version
// upgrade keeps its recents. Toolchain + per-project layout are deliberately NOT scoped
// this way (the toolchain is machine-shared; layout follows the project).
let recentsScope: string | null = null;
export function setRecentsScope(id: string): void { recentsScope = id || null; }

/** The scoped recents file for the current editor identity: a sanitized basename +
 *  short content hash keeps it human-recognizable AND filesystem-safe/collision-free. */
function scopedRecentsFile(): string {
  const id = recentsScope!;
  const hash = crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
  const base = path.basename(id).replace(/[^\w.-]+/g, '-').slice(0, 40) || 'editor';
  return path.join(RECENTS_DIR(), 'recents', `${base}-${hash}.json`);
}

/** The live recents file: scoped when an editor identity is set (the normal path),
 *  else the pre-scoping global file (back-compat / no-scope callers). */
function recentsFile(): string {
  return recentsScope ? scopedRecentsFile() : globalRecentsFile();
}

function readRecentsRaw(file: string): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(j) ? j.filter((p): p is string => typeof p === 'string') : [];
  } catch { return []; }
}

/** One-time migration of the legacy dev recents (…/Electron/) into the GLOBAL file,
 *  newest-first preferring the legacy order, then rename the legacy file so it runs
 *  once. (Pre-scoping behavior, preserved for the unscoped/global fallback.)
 *
 *  Deliberately does NOT seed a scoped file from the global list. The global list is a
 *  SHARED junk drawer — dev clones wrote every clone's projects into it — so seeding
 *  would import OTHER editor instances' projects into this one's recents. A scoped
 *  recents file therefore starts empty and accumulates ONLY the projects THIS editor
 *  instance opens (addRecentProject), which is the whole point of per-instance scoping.
 *  Best-effort; any fs error is swallowed. */
export function migrateLegacyRecents(): void {
  const legacy = legacyRecentsFile();
  if (legacy !== globalRecentsFile() && fs.existsSync(legacy)) {
    const merged = [...readRecentsRaw(legacy), ...readRecentsRaw(globalRecentsFile())]
      .filter((p, i, a) => a.indexOf(p) === i)
      .slice(0, MAX_RECENTS);
    try {
      fs.mkdirSync(RECENTS_DIR(), { recursive: true });
      fs.writeFileSync(globalRecentsFile(), JSON.stringify(merged, null, 2));
      fs.renameSync(legacy, `${legacy}.migrated`);
    } catch { /* best-effort */ }
  }
}

export function getRecentProjects(): string[] {
  return readRecentsRaw(recentsFile()).filter((p) => fs.existsSync(p));
}

export function addRecentProject(root: string): void {
  const list = [root, ...getRecentProjects().filter((p) => p !== root)].slice(0, MAX_RECENTS);
  try {
    fs.mkdirSync(path.dirname(recentsFile()), { recursive: true });
    fs.writeFileSync(recentsFile(), JSON.stringify(list, null, 2));
  } catch { /* best-effort */ }
}

/** True if project path `p` lives inside `repoRoot`. */
export function isUnderRepo(repoRoot: string, p: string): boolean {
  const rel = path.relative(repoRoot, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Pure policy for which project the editor auto-opens on launch — split out of
 *  main's resolveInitialProject so it's unit-testable without electron `app`/env.
 *
 *  The load-bearing rule is the **two-clone guard**: recents live in a FIXED machine-wide
 *  dir (RECENTS_DIR — NOT userData), and the pre-scoping GLOBAL file is a shared junk
 *  drawer, so a SIBLING clone's absolute project path can appear in the list this guard
 *  sees. Auto-reopening it crosses clones — you get the wrong game
 *  AND an apparent "lost layout" (the dock layout is saved per-project). So in dev
 *  we reopen the most-recent project UNDER THIS clone's `repoRoot`, never a
 *  sibling's. Single-clone users are unaffected (all their recents are under
 *  repoRoot). Packaged apps skip the guard: there's one app and projects live
 *  anywhere on disk, so the global most-recent is correct. */
export function chooseInitialProject(opts: {
  envProject?: string;   // MODOKI_PROJECT — hard override (CI/build/explicit)
  envDefault?: string;   // MODOKI_PROJECT_DEFAULT — launcher's soft seed
  recents: string[];     // existing recents, newest-first (absolute, already existence-filtered)
  repoRoot: string;      // this clone's repo root
  packaged: boolean;     // app.isPackaged
  devFallback: string;   // where to land in dev with no memory + no seed (e.g. <repo>/games/3d-test)
}): { kind: 'path'; path: string } | { kind: 'pick' } {
  const { envProject, envDefault, recents, repoRoot, packaged, devFallback } = opts;
  if (envProject) return { kind: 'path', path: path.resolve(envProject) };
  if (packaged) {
    return recents[0] ? { kind: 'path', path: recents[0] } : { kind: 'pick' };
  }
  const sameClone = recents.find((p) => isUnderRepo(repoRoot, p));
  if (sameClone) return { kind: 'path', path: sameClone };
  if (envDefault) return { kind: 'path', path: path.resolve(envDefault) };
  return { kind: 'path', path: devFallback };
}

/** Classify a folder the user picked as a project destination, so the caller can
 *  decide open-vs-scaffold-vs-reject:
 *   - 'project'  — already a Modoki project (has project.config.json) → OPEN it
 *   - 'empty'    — empty or nonexistent → safe to SCAFFOLD a new project into
 *   - 'occupied' — has files but no project.config.json → neither open nor scaffold
 *                  (scaffolding would refuse anyway; opening yields a fileless project)
 *  Used by the first-run flow so picking an empty folder creates a game (== File →
 *  New Project) instead of opening an empty, broken project. */
export function projectFolderKind(dir: string): 'project' | 'empty' | 'occupied' {
  if (fs.existsSync(path.join(dir, 'project.config.json'))) return 'project';
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return 'empty'; } // nonexistent → scaffoldable
  return entries.length === 0 ? 'empty' : 'occupied';
}

/** Native folder picker. Returns the chosen absolute path, or null if cancelled. */
export async function pickProjectFolder(win: BrowserWindow | null): Promise<string | null> {
  const res = win
    ? await dialog.showOpenDialog(win, { title: 'Open Project', properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ title: 'Open Project', properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
}

/** Native picker for a NEW project's destination folder. `createDirectory` lets
 *  the user make + pick a fresh folder in the dialog. Returns the chosen absolute
 *  path, or null if cancelled. */
export async function pickNewProjectFolder(win: BrowserWindow | null): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = {
    title: 'New Project',
    buttonLabel: 'Create Project',
    message: 'Choose an empty folder for your new Modoki project.',
    properties: ['openDirectory', 'createDirectory'],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
}

/** A renderer-supplied menu item (serializable — no functions cross IPC). An
 *  actionable item carries an `id` dispatched back via onMenuAction; a separator
 *  has `separator: true`. */
export interface RendererMenuItem {
  id?: string;
  label?: string;
  shortcut?: string;   // e.g. "Cmd+S" — mapped to a CmdOrCtrl accelerator
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
}
/** The editor renderer's menu structure, pushed to main so the OS-level menu
 *  carries the editor's own actions (the in-window menu bar is dropped under
 *  Electron — see EditorApp). Ordered top-level menus (File, Edit, View, Build…). */
export interface RendererMenuSpec {
  menus: { name: string; items: RendererMenuItem[] }[];
}

/** Map a renderer shortcut ("Cmd+S") to an Electron accelerator ("CmdOrCtrl+S"). */
const toAccelerator = (s?: string): string | undefined => (s ? s.replace('Cmd', 'CmdOrCtrl') : undefined);

/**
 * Build + install the OS application menu. The editor's own actions (New Scene,
 * Save, Undo/Redo, layouts, Build…) come from the renderer's pushed `rendererMenus`
 * spec; clicking one relays its id back via `onMenuAction` (the renderer dispatches
 * it). The native Open Project / Open Recent items are owned by main and merged
 * into File. Before the renderer pushes a spec, a minimal native File menu still
 * lets the user open a project.
 */
export function installAppMenu(opts: {
  currentRoot: string;
  onNewProject(): void;
  onOpenProject(): void;
  onOpenRecent(root: string): void;
  rendererMenus?: RendererMenuSpec;
  onMenuAction?(id: string): void;
  onCheckForUpdates?(): void;
  onAbout?(): void;
  onZoom?(dir: 'in' | 'out' | 'reset'): void;
}): void {
  const recents = getRecentProjects();
  const isMac = process.platform === 'darwin';

  // Native (main-owned) File items: Open Project / Open Recent + window close.
  const fileHead: Electron.MenuItemConstructorOptions[] = [
    { label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N', click: () => opts.onNewProject() },
    { type: 'separator' },
    { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => opts.onOpenProject() },
    {
      label: 'Open Recent',
      submenu: recents.length
        ? recents.map((p) => ({ label: p === opts.currentRoot ? `✓ ${p}` : p, click: () => opts.onOpenRecent(p) }))
        : [{ label: '(none)', enabled: false }],
    },
  ];
  const fileTail: Electron.MenuItemConstructorOptions[] = [
    { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' },
  ];

  // Map a renderer item → an Electron menu item (separators pass through; an
  // actionable item dispatches its id back to the renderer on click).
  const toItem = (it: RendererMenuItem): Electron.MenuItemConstructorOptions => {
    if (it.separator || !it.id) return { type: 'separator' };
    const label = it.checked != null ? `${it.checked ? '✓ ' : ''}${it.label ?? ''}` : (it.label ?? '');
    return { label, accelerator: toAccelerator(it.shortcut), enabled: !it.disabled, click: () => opts.onMenuAction?.(it.id!) };
  };

  const rendererMenus = opts.rendererMenus?.menus ?? [];
  const hasFile = rendererMenus.some((m) => m.name === 'File');
  const hasWindow = rendererMenus.some((m) => m.name === 'Window');

  // Standard role tails appended to the editor's own Edit/View menus so OS-level
  // text editing + dev tools stay reachable (the in-window menu never had these).
  const editRoleTail: Electron.MenuItemConstructorOptions[] = [
    { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
  ];
  const viewRoleTail: Electron.MenuItemConstructorOptions[] = [
    // Whole-app UI zoom (VS Code–style). Custom click handlers, NOT Electron's zoomIn/
    // zoomOut/resetZoom roles, so they share the clamp + persistence of the Cmd/Ctrl+wheel
    // path (main's zoom controller). `CmdOrCtrl+Plus` also fires on Cmd/Ctrl+= (Electron
    // maps Plus to the unshifted = key), so no separate binding is needed.
    { type: 'separator' },
    { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => opts.onZoom?.('in') },
    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => opts.onZoom?.('out') },
    { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => opts.onZoom?.('reset') },
    // forceReload (Cmd+Shift+R) bypasses the HTTP cache — needed to pick up a
    // rebaked asset served at its stable immutable URL.
    { type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
  ];
  // Native window roles appended after the editor's own Window items (show panel)
  // so OS window controls stay reachable in the same menu.
  const windowRoleTail: Electron.MenuItemConstructorOptions[] = isMac
    ? [{ type: 'separator' }, { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    : [{ type: 'separator' }, { role: 'minimize' }, { role: 'close' }];

  const builtMenus: Electron.MenuItemConstructorOptions[] = rendererMenus.map(({ name, items }) => {
    const built = items.map(toItem);
    if (name === 'File') return { label: 'File', submenu: [...fileHead, { type: 'separator' }, ...built, ...fileTail] };
    if (name === 'Edit') return { label: 'Edit', submenu: [...built, ...editRoleTail] };
    if (name === 'View') return { label: 'View', submenu: [...built, ...viewRoleTail] };
    // Merge native window roles into the editor's Window menu so it doubles as the
    // OS Window menu (role:'window' marks it as the standard macOS Window menu).
    if (name === 'Window') return { label: 'Window', role: 'window', submenu: [...built, ...windowRoleTail] };
    return { label: name, submenu: built };
  });

  // "Check for Updates…" lives in the macOS app menu (its conventional spot, just
  // under About) and in a Help menu elsewhere. Omitted entirely when no handler is
  // wired. On mac this means replacing the canned `appMenu` role with an explicit
  // submenu (the role auto-generates About/Quit/etc. but can't be injected into).
  const checkForUpdatesItem: Electron.MenuItemConstructorOptions | null =
    opts.onCheckForUpdates ? { label: 'Check for Updates…', click: () => opts.onCheckForUpdates!() } : null;
  // Custom "About Modoki" (a cross-platform dialog owned by main) replaces the
  // native `role:'about'` panel so mac/Windows/Linux show identical content.
  const aboutItem: Electron.MenuItemConstructorOptions | null =
    opts.onAbout ? { label: 'About Modoki', click: () => opts.onAbout!() } : null;

  const macAppMenu: Electron.MenuItemConstructorOptions = {
    role: 'appMenu',
    submenu: [
      aboutItem ?? { role: 'about' },
      ...(checkForUpdatesItem ? [{ type: 'separator' as const }, checkForUpdatesItem] : []),
      { type: 'separator' }, { role: 'services' },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ],
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    // No renderer spec yet (launch) ⇒ a native-only File menu so Open Project works.
    ...(hasFile ? [] : [{ label: 'File', submenu: [...fileHead, ...fileTail] } as Electron.MenuItemConstructorOptions]),
    ...builtMenus,
    // Fall back to the canned Window menu only when the renderer hasn't supplied
    // its own (which already merges the native window roles, above).
    ...(hasWindow ? [] : [{ role: 'windowMenu' as const }]),
    // Non-mac: Help → About Modoki + Check for Updates… (mac puts both in the app
    // menu above). Separator between them only when both are present.
    ...(() => {
      if (isMac) return [];
      const helpItems = [
        aboutItem,
        aboutItem && checkForUpdatesItem ? ({ type: 'separator' } as Electron.MenuItemConstructorOptions) : null,
        checkForUpdatesItem,
      ].filter(Boolean) as Electron.MenuItemConstructorOptions[];
      return helpItems.length ? [{ role: 'help' as const, submenu: helpItems }] : [];
    })(),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
