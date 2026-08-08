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

import { installAppMenu } from '../../electron/projects';

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
