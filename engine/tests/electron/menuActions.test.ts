/** Unit tests for the native-menu introspection + trigger logic (backing `modoki_menu`).
 *  Written against the structural `MenuItemLike` interface, so no real Electron `Menu` is
 *  built — hand-shaped literals stand in for the live application menu. Pins the label-path
 *  matching, the id lookup, and the "fired the right click()" + refusal cases. */

import { describe, it, expect, vi } from 'vitest';
import {
  normalizeLabel, splitMenuPath, serializeMenu, findMenuItem, triggerMenuItem, actionablePaths,
  type MenuItemLike,
} from '../../electron/menuActions';

/** A miniature app menu resembling the real one (File / View), with click spies. */
function makeMenu() {
  const zoomIn = vi.fn(), zoomOut = vi.fn(), actualSize = vi.fn(), newProject = vi.fn();
  const items: MenuItemLike[] = [
    {
      label: 'File', submenu: { items: [
        { label: 'New Project…', id: 'new-project', accelerator: 'CmdOrCtrl+Shift+N', click: newProject },
        { type: 'separator' },
        { label: 'Close', role: 'close' },
      ] },
    },
    {
      label: 'View', submenu: { items: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: zoomIn },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: zoomOut },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: actualSize },
        { label: 'Disabled Thing', enabled: false, click: vi.fn() },
        { label: 'Hidden Thing', visible: false, click: vi.fn() },
      ] },
    },
  ];
  return { items, zoomIn, zoomOut, actualSize, newProject };
}

describe('normalizeLabel / splitMenuPath', () => {
  it('strips mnemonics, ellipsis, check glyph, case', () => {
    expect(normalizeLabel('&Zoom In…')).toBe('zoom in');
    expect(normalizeLabel('✓ Actual Size')).toBe('actual size');
    expect(normalizeLabel('Open Recent...')).toBe('open recent');
  });
  it('splits on /, >, and \\ and drops empties', () => {
    expect(splitMenuPath('View/Zoom In')).toEqual(['View', 'Zoom In']);
    expect(splitMenuPath('View > Zoom In')).toEqual(['View', 'Zoom In']);
    expect(splitMenuPath(' View // Zoom In ')).toEqual(['View', 'Zoom In']);
  });
});

describe('serializeMenu', () => {
  it('carries label paths, omits separators + hidden, flags actionable', () => {
    const tree = serializeMenu(makeMenu().items);
    const view = tree.find((n) => n.label === 'View')!;
    expect(view.actionable).toBe(false); // a submenu header (no click, no role) is not firable
    const zoomIn = view.submenu!.find((n) => n.label === 'Zoom In')!;
    expect(zoomIn.path).toBe('View/Zoom In');
    expect(zoomIn.accelerator).toBe('CmdOrCtrl+Plus');
    expect(zoomIn.actionable).toBe(true);
    // separator dropped, hidden dropped
    expect(view.submenu!.some((n) => n.label === 'Hidden Thing')).toBe(false);
    const file = tree.find((n) => n.label === 'File')!;
    expect(file.submenu!.some((n) => n.type === 'separator')).toBe(false);
  });
});

describe('findMenuItem', () => {
  it('finds by root-anchored label path (case-insensitive)', () => {
    const { items, zoomIn } = makeMenu();
    expect(findMenuItem(items, { path: 'view/zoom in' })?.click).toBe(zoomIn);
  });
  it('finds by id anywhere in the tree', () => {
    const { items, newProject } = makeMenu();
    expect(findMenuItem(items, { id: 'new-project' })?.click).toBe(newProject);
  });
  it('returns null for an unknown path and for a path past a leaf', () => {
    const { items } = makeMenu();
    expect(findMenuItem(items, { path: 'View/Nope' })).toBeNull();
    expect(findMenuItem(items, { path: 'View/Zoom In/Deeper' })).toBeNull();
  });
});

describe('triggerMenuItem', () => {
  it('fires the matched item\'s click and reports the label', () => {
    const { items, actualSize } = makeMenu();
    const res = triggerMenuItem(items, { path: 'View/Actual Size' });
    expect(res).toEqual({ ok: true, fired: 'Actual Size' });
    expect(actualSize).toHaveBeenCalledOnce();
  });

  it('refuses a disabled item', () => {
    const { items } = makeMenu();
    const res = triggerMenuItem(items, { path: 'View/Disabled Thing' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/disabled/);
  });

  it('refuses a container (submenu header with no click/role)', () => {
    const { items } = makeMenu();
    const res = triggerMenuItem(items, { path: 'View' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no action/);
  });

  it('on a miss, returns the actionable paths as a hint', () => {
    const { items } = makeMenu();
    const res = triggerMenuItem(items, { path: 'View/Nonexistent' });
    expect(res.ok).toBe(false);
    expect(res.available).toContain('View/Zoom In');
    expect(res.available).toContain('File/New Project…');
  });

  it('400 shape when neither path nor id given; error when no menu', () => {
    expect(triggerMenuItem(makeMenu().items, {}).ok).toBe(false);
    expect(triggerMenuItem(null, { path: 'View/Zoom In' })).toEqual({ ok: false, error: 'no application menu is installed' });
  });

  it('threads the (menuItem, window, webContents) click context — so native role items can fire', () => {
    // The false-success fix: a bare item.click?.() no-ops Electron role items (reload/copy/…).
    // Passing the focused window + webContents is what makes them actually execute; assert they reach
    // the handler. A role item stands in for the native case (its click is a spy here).
    const win = { id: 'win' }, wc = { id: 'wc' };
    const reload = vi.fn();
    const items: MenuItemLike[] = [{ label: 'View', submenu: { items: [{ label: 'Reload', role: 'reload', click: reload }] } }];
    const res = triggerMenuItem(items, { path: 'View/Reload' }, { window: win, webContents: wc });
    expect(res).toEqual({ ok: true, fired: 'Reload' });
    expect(reload).toHaveBeenCalledWith(items[0].submenu!.items[0], win, wc);
  });

  it('still fires custom (zero-arg) handlers when no context is passed', () => {
    const { items, zoomIn } = makeMenu();
    expect(triggerMenuItem(items, { path: 'View/Zoom In' }).ok).toBe(true);
    expect(zoomIn).toHaveBeenCalledOnce(); // extra args are simply ignored by () => … handlers
  });
});

describe('actionablePaths', () => {
  it('lists enabled, clickable leaves (not disabled, not containers)', () => {
    const paths = actionablePaths(serializeMenu(makeMenu().items));
    expect(paths).toContain('View/Zoom In');
    expect(paths).toContain('File/Close'); // role:'close' counts as actionable
    expect(paths).not.toContain('View/Disabled Thing');
  });
});
