/** installAppMenu — the View-menu Zoom items.
 *
 *  Pins the deliberate design: Zoom In / Zoom Out / Actual Size use CUSTOM click handlers
 *  (routing to onZoom → the clamp+persist controller), NOT Electron's built-in zoomIn/zoomOut/
 *  resetZoom roles (which would reintroduce the un-clamped, non-persisted drift). Captures the
 *  template handed to Menu.buildFromTemplate; electron is mocked. */
import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const cap = vi.hoisted(() => ({ tpl: null as Electron.MenuItemConstructorOptions[] | null }));
vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(os.tmpdir(), 'modoki-menu-test', name) },
  dialog: {},
  Menu: {
    buildFromTemplate: (t: Electron.MenuItemConstructorOptions[]) => { cap.tpl = t; return {}; },
    setApplicationMenu: () => {},
  },
}));

import fs from 'node:fs';
import { installAppMenu, addRecentProject, setRecentsScope } from '../../electron/projects';

function buildWithZoom() {
  const onZoom = vi.fn();
  installAppMenu({
    currentRoot: '/x',
    onNewProject() {}, onOpenProject() {}, onOpenRecent() {},
    // A renderer View menu must exist for the native viewRoleTail (incl. zoom) to be appended.
    rendererMenus: { menus: [{ name: 'View', items: [] }] },
    onZoom,
  });
  const view = (cap.tpl ?? []).find((m) => m.label === 'View');
  const items = (view?.submenu ?? []) as Electron.MenuItemConstructorOptions[];
  const byLabel = (l: string) => items.find((i) => i.label === l);
  return { onZoom, zoomIn: byLabel('Zoom In'), zoomOut: byLabel('Zoom Out'), actual: byLabel('Actual Size') };
}

describe('installAppMenu — submenu items (#170 Build-menu device picker)', () => {
  it('maps a renderer item carrying `submenu` into an Electron submenu with no click on the parent', () => {
    const onMenuAction = vi.fn();
    installAppMenu({
      currentRoot: '/x',
      onNewProject() {}, onOpenProject() {}, onOpenRecent() {},
      rendererMenus: {
        menus: [{
          name: 'Build',
          items: [{ id: 'ios-target', label: 'iOS Target', submenu: [{ id: 'ios-a', label: 'iPhone Air' }] }],
        }],
      },
      onMenuAction,
    });
    const build = (cap.tpl ?? []).find((m) => m.label === 'Build');
    const items = (build?.submenu ?? []) as Electron.MenuItemConstructorOptions[];
    const parent = items.find((i) => i.label === 'iOS Target');
    // Electron ignores a click handler on a submenu parent — attaching one would misleadingly
    // suggest the parent itself is actionable, so installAppMenu must not set it.
    expect(parent?.click).toBeUndefined();
    expect(Array.isArray(parent?.submenu)).toBe(true);
  });

  it('each submenu child dispatches its OWN id through onMenuAction', () => {
    const onMenuAction = vi.fn();
    installAppMenu({
      currentRoot: '/x',
      onNewProject() {}, onOpenProject() {}, onOpenRecent() {},
      rendererMenus: {
        menus: [{
          name: 'Build',
          items: [{
            id: 'ios-target',
            label: 'iOS Target',
            submenu: [{ id: 'ios-a', label: 'iPhone Air' }, { id: 'ios-b', label: 'iPhone 8' }],
          }],
        }],
      },
      onMenuAction,
    });
    const build = (cap.tpl ?? []).find((m) => m.label === 'Build');
    const items = (build?.submenu ?? []) as Electron.MenuItemConstructorOptions[];
    const parent = items.find((i) => i.label === 'iOS Target');
    const children = (parent?.submenu ?? []) as Electron.MenuItemConstructorOptions[];
    (children.find((c) => c.label === 'iPhone Air')!.click as () => void)();
    (children.find((c) => c.label === 'iPhone 8')!.click as () => void)();
    expect(onMenuAction.mock.calls.map((c) => c[0])).toEqual(['ios-a', 'ios-b']);
  });

  it('a `separator: true` entry inside a submenu becomes {type: "separator"}', () => {
    installAppMenu({
      currentRoot: '/x',
      onNewProject() {}, onOpenProject() {}, onOpenRecent() {},
      rendererMenus: {
        menus: [{
          name: 'Build',
          items: [{
            id: 'ios-target',
            label: 'iOS Target',
            submenu: [{ id: 'ios-a', label: 'iPhone Air' }, { separator: true }, { id: 'ios-b', label: 'iPhone 8' }],
          }],
        }],
      },
    });
    const build = (cap.tpl ?? []).find((m) => m.label === 'Build');
    const items = (build?.submenu ?? []) as Electron.MenuItemConstructorOptions[];
    const parent = items.find((i) => i.label === 'iOS Target');
    const children = (parent?.submenu ?? []) as Electron.MenuItemConstructorOptions[];
    expect(children[1]).toEqual({ type: 'separator' });
  });
});

describe('View-menu zoom items', () => {
  it('adds Zoom In / Zoom Out / Actual Size with the expected accelerators', () => {
    const { zoomIn, zoomOut, actual } = buildWithZoom();
    expect(zoomIn?.accelerator).toBe('CmdOrCtrl+Plus');
    expect(zoomOut?.accelerator).toBe('CmdOrCtrl+-');
    expect(actual?.accelerator).toBe('CmdOrCtrl+0');
  });

  it('uses custom click handlers, NOT the built-in zoom roles (keeps clamp+persist)', () => {
    const { zoomIn, zoomOut, actual } = buildWithZoom();
    for (const it of [zoomIn, zoomOut, actual]) {
      expect(it?.role).toBeUndefined();
      expect(typeof it?.click).toBe('function');
    }
  });

  it('routes each item to onZoom(in|out|reset)', () => {
    const { onZoom, zoomIn, zoomOut, actual } = buildWithZoom();
    (zoomIn!.click as () => void)();
    (zoomOut!.click as () => void)();
    (actual!.click as () => void)();
    expect(onZoom.mock.calls.map((c) => c[0])).toEqual(['in', 'out', 'reset']);
  });
});

/** The Open Recent ✓ marker — a #869 instance the architecture guard structurally cannot see.
 *
 *  ⚠️ The guard bans `path.resolve(x) === y`; this was `p === opts.currentRoot`, the
 *  assign-first-compare-later form, which escapes a line regex entirely (close-out review found
 *  three live instances of that shape). `p` comes from `getRecentProjects()` — one of the two
 *  untrusted spelling sources #869 names — so a differently-cased recents entry left the ✓ off
 *  the project that IS open. That compounds: the user cannot see it is already open, clicks it,
 *  and `onOpenRecent`'s matching `!==` then re-runs a full `setProject` on it. */
describe('installAppMenu — Open Recent marks the OPEN project (#869)', () => {
  const recentsOf = () => {
    const file = (cap.tpl ?? []).find((m) => m.label === 'File');
    const items = (file?.submenu ?? []) as Electron.MenuItemConstructorOptions[];
    const openRecent = items.find((i) => i.label === 'Open Recent');
    return (openRecent?.submenu ?? []) as Electron.MenuItemConstructorOptions[];
  };

  it('ticks a recents entry that is the open project spelled differently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tick-'));
    try {
      setRecentsScope('test-scope');
      addRecentProject(dir);
      const flipped = process.platform === 'win32'
        ? (dir[0] === dir[0].toLowerCase() ? dir[0].toUpperCase() : dir[0].toLowerCase()) + dir.slice(1)
        : dir;
      installAppMenu({
        currentRoot: flipped,
        onNewProject() {}, onOpenProject() {}, onOpenRecent() {},
      });
      const labels = recentsOf().map((i) => String(i.label));
      expect(labels.length, 'premise: the recents entry is present').toBeGreaterThan(0);
      expect(labels.some((l) => l.startsWith('✓'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT tick a recents entry that is a different project', () => {
    // The inverse, or the fix would be "always tick everything".
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tick-'));
    try {
      const a = path.join(base, 'proj-a');
      const b = path.join(base, 'proj-b');
      fs.mkdirSync(a); fs.mkdirSync(b);
      setRecentsScope('test-scope-2');
      addRecentProject(a);
      installAppMenu({ currentRoot: b, onNewProject() {}, onOpenProject() {}, onOpenRecent() {} });
      expect(recentsOf().map((i) => String(i.label)).some((l) => l.startsWith('✓'))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
