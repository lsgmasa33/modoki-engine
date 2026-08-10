/** Unit tests for the native-menu introspection + trigger logic (backing `modoki_menu`).
 *  Written against the structural `MenuItemLike` interface, so no real Electron `Menu` is
 *  built — hand-shaped literals stand in for the live application menu. Pins the label-path
 *  matching, the id lookup, and the "fired the right click()" + refusal cases. */

import { describe, it, expect, vi } from 'vitest';
import {
  normalizeLabel, splitMenuPath, splitMenuPathLoose, serializeMenu, findMenuItem, triggerMenuItem, actionablePaths,
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
  it('splits on / and > and drops empties', () => {
    expect(splitMenuPath('View/Zoom In')).toEqual(['View', 'Zoom In']);
    expect(splitMenuPath('View > Zoom In')).toEqual(['View', 'Zoom In']);
    expect(splitMenuPath(' View // Zoom In ')).toEqual(['View', 'Zoom In']);
  });
  // A `\` is NOT a separator in the strict split: on Windows every File → Open Recent label IS
  // a native path, and shredding it produced segments matching nothing.
  it('keeps backslashes INSIDE a segment — a Windows path is a label, not a path of labels', () => {
    expect(splitMenuPath('File/Open Recent/E:\\Projects\\modoki\\games\\skin-test'))
      .toEqual(['File', 'Open Recent', 'E:\\Projects\\modoki\\games\\skin-test']);
  });
  it('splitMenuPathLoose keeps the old convenience reading for a human-typed path', () => {
    expect(splitMenuPathLoose('View\\Zoom In')).toEqual(['View', 'Zoom In']);
  });
});

/** Windows-only in practice, and it made the whole Open Recent submenu unreachable from MCP —
 *  which is how a project switch had to be driven to reproduce #190 in the first place. The
 *  refusal even listed the exact path it was rejecting, so the tool contradicted itself. */
describe('findMenuItem — a menu label that contains backslashes (Windows Open Recent)', () => {
  const recents: MenuItemLike[] = [
    { label: 'File', submenu: { items: [
      { label: 'Open Recent', submenu: { items: [
        { label: '✓ E:\\Projects\\modoki\\games\\court', click: vi.fn() },
        { label: 'E:\\Projects\\modoki\\games\\skin-test', click: vi.fn() },
      ] } },
    ] } },
  ];

  it('resolves the exact path serializeMenu advertises', () => {
    const path = serializeMenu(recents)[0].submenu![0].submenu![1].path;
    expect(path).toBe('File/Open Recent/E:\\Projects\\modoki\\games\\skin-test');
    expect(findMenuItem(recents, { path })?.label).toBe('E:\\Projects\\modoki\\games\\skin-test');
  });

  it('still resolves the checked (currently-open) entry, whose label carries the ✓ glyph', () => {
    expect(findMenuItem(recents, { path: 'File/Open Recent/E:\\Projects\\modoki\\games\\court' })?.label)
      .toBe('✓ E:\\Projects\\modoki\\games\\court');
  });

  it('does not regress the backslash-as-separator convenience where nothing matches literally', () => {
    const menu = makeMenu().items;
    expect(findMenuItem(menu, { path: 'View\\Zoom In' })?.label).toBe('Zoom In');
  });
});

/** The POSIX MIRROR of the bug above, and it was still live after the Windows fix. A macOS
 *  Open Recent label is an absolute POSIX path, so the label contains the PRIMARY separator —
 *  `serializeMenu` emits "File/Open Recent//Users/me/proj" and a segment-by-segment walk looks
 *  for a child called "Users". Same self-contradicting refusal (the exact advertised path,
 *  listed as available and rejected), same consequence: no agent-driven project switch on the
 *  platform this repo is mostly developed on. Found while live-verifying #190 on macOS. */
describe('findMenuItem — a menu label that IS an absolute POSIX path (macOS Open Recent)', () => {
  const recents: MenuItemLike[] = [
    { label: 'File', submenu: { items: [
      { label: 'Open Recent', submenu: { items: [
        { label: '✓ /Users/me/Projects/modoki/games/3d-test', click: vi.fn() },
        { label: '/Users/me/Projects/modoki/games/sling', click: vi.fn() },
      ] } },
    ] } },
  ];

  it('resolves the exact path serializeMenu advertises', () => {
    const path = serializeMenu(recents)[0].submenu![0].submenu![1].path;
    expect(path).toBe('File/Open Recent//Users/me/Projects/modoki/games/sling');
    expect(findMenuItem(recents, { path })?.label).toBe('/Users/me/Projects/modoki/games/sling');
  });

  it('still resolves the checked (currently-open) entry, whose label carries the ✓ glyph', () => {
    expect(findMenuItem(recents, { path: 'File/Open Recent//Users/me/Projects/modoki/games/3d-test' })?.label)
      .toBe('✓ /Users/me/Projects/modoki/games/3d-test');
  });

  it('a label containing separators beats a shallower same-named item — longest grouping wins', () => {
    // Without longest-first, "Open Recent" could be consumed and the remainder walked as
    // segments, which is exactly how the posix label got shredded.
    const menu: MenuItemLike[] = [
      { label: 'File', submenu: { items: [
        { label: 'Open Recent', submenu: { items: [
          { label: 'Users', click: vi.fn() },
          { label: '/Users/me/proj', click: vi.fn() },
        ] } },
      ] } },
    ];
    expect(findMenuItem(menu, { path: 'File/Open Recent//Users/me/proj' })?.label).toBe('/Users/me/proj');
    expect(findMenuItem(menu, { path: 'File/Open Recent/Users' })?.label).toBe('Users');
  });

  it('still tolerates a stray separator where no label could have absorbed it', () => {
    const menu = makeMenu().items;
    expect(findMenuItem(menu, { path: 'View//Zoom In' })?.label).toBe('Zoom In');
    expect(findMenuItem(menu, { path: '/View/Zoom In' })?.label).toBe('Zoom In');
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
    // The input has 3 entries (New Project, a separator, Close) — MenuNode has no `type` field
    // at all (a separator isn't serialized as an untyped node, it's omitted outright), so the
    // only way to pin "dropped" is a count: 2 survivors, not 3.
    const file = tree.find((n) => n.label === 'File')!;
    expect(file.submenu).toHaveLength(2);
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
