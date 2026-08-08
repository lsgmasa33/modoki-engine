/** The renderer → Electron menu spec, and specifically its ID SCHEME.
 *
 *  This is here because the ids are the one part of the menu bridge that can be wrong WITHOUT
 *  anything looking wrong: a click still lands, it just runs a different item's action. The
 *  scenario the scheme defends against is spelled out in `menuItemId` — a native menu left open
 *  while the Build menu's device list arrives. */

import { describe, it, expect, vi } from 'vitest';
import { buildMenuSpec, menuItemId } from '../../src/editor/menuSpec';
import type { BarMenuItem } from '../../src/editor/components/MenuBar';

describe('menuItemId', () => {
  it('carries the label, not just the position', () => {
    expect(menuItemId('Build#0', 2, 'Build now')).toBe('Build#0#2:build-now');
  });

  it('keeps the index, because two rows can share a label', () => {
    // Device names repeat — two phones both called "iPhone" are a real desk, not a contrivance.
    expect(menuItemId('Build#0', 1, 'iPhone')).not.toBe(menuItemId('Build#0', 2, 'iPhone'));
  });
});

describe('buildMenuSpec — a stale id must MISS, not resolve to something else', () => {
  const menuWith = (items: BarMenuItem[]) => ({ Build: items });

  it('the id at a given index changes when that row becomes a different item', () => {
    // THE REGRESSION. Boot: the iOS submenu is one placeholder row, so index 2 is "Build now".
    // Seconds later the device listing lands and index 2 is a phone whose action picks it AND
    // starts a build. With positional-only ids the stale click resolved into the new map and
    // built to a device the user never chose.
    const before = buildMenuSpec(menuWith([
      { label: 'iOS Device', submenu: [
        { label: 'No iOS device paired', disabled: true },
        { label: '', separator: true },
        { label: 'Build now', action: () => {} },
      ] },
    ]));
    const after = buildMenuSpec(menuWith([
      { label: 'iOS Device', submenu: [
        { label: 'iPhone Air', action: () => {} },
        { label: 'iPhone 8', action: () => {} },
        { label: 'Puni Puni', action: () => {} },
      ] },
    ]));

    const staleBuildNowId = Object.keys(before.menuActionMap).find((k) => k.endsWith(':build-now'));
    expect(staleBuildNowId).toBeDefined();
    // The whole point: dispatching the OLD id against the NEW map finds nothing.
    expect(after.menuActionMap[staleBuildNowId!]).toBeUndefined();
  });

  it('an unchanged menu keeps its ids stable across rebuilds', () => {
    // The scheme must not go so far that every republish invalidates every open menu — a rebuild
    // triggered by something unrelated (an undo-label change) must leave working ids working.
    const items = (): BarMenuItem[] => [{ label: 'Web → site', action: () => {} }];
    expect(Object.keys(buildMenuSpec(menuWith(items())).menuActionMap))
      .toEqual(Object.keys(buildMenuSpec(menuWith(items())).menuActionMap));
  });
});

describe('buildMenuSpec — structure', () => {
  it('registers an action per actionable item and dispatches the right one', () => {
    const air = vi.fn(), eight = vi.fn();
    const { menuActionMap } = buildMenuSpec({
      Build: [{ label: 'iOS Device', submenu: [{ label: 'Air', action: air }, { label: '8', action: eight }] }],
    });
    const ids = Object.keys(menuActionMap);
    menuActionMap[ids.find((k) => k.endsWith(':8'))!]();
    expect(eight).toHaveBeenCalledTimes(1);
    expect(air).not.toHaveBeenCalled();
  });

  it('separators carry no id and no action', () => {
    const { menuSpec, menuActionMap } = buildMenuSpec({ Build: [{ label: '', separator: true }] });
    expect(menuSpec.menus[0].items[0]).toEqual({ separator: true });
    expect(Object.keys(menuActionMap)).toHaveLength(0);
  });

  it('drops a submenu nested inside a submenu (one level, matching MenuBar)', () => {
    const deep = vi.fn();
    const { menuSpec, menuActionMap } = buildMenuSpec({
      Build: [{ label: 'A', submenu: [{ label: 'B', submenu: [{ label: 'C', action: deep }] }] }],
    });
    const b = menuSpec.menus[0].items[0].submenu![0];
    expect(b.submenu).toBeUndefined();
    // "C" never reaches the OS menu, so its action must not be registered either — a registered
    // id nothing can dispatch is a promise the bridge cannot keep.
    expect(Object.keys(menuActionMap).some((k) => k.endsWith(':c'))).toBe(false);
  });

  it('passes checked/disabled/shortcut through for the OS menu to render', () => {
    const { menuSpec } = buildMenuSpec({
      Build: [{ label: 'Air', checked: true, disabled: true, shortcut: 'Cmd+B' }],
    });
    expect(menuSpec.menus[0].items[0]).toMatchObject({ checked: true, disabled: true, shortcut: 'Cmd+B' });
  });
});
