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
