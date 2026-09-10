/** The renderer → Electron menu spec, and specifically its ID SCHEME.
 *
 *  This is here because the ids are the one part of the menu bridge that can be wrong WITHOUT
 *  anything looking wrong: a click still lands, it just runs a different item's action. The
 *  scenario the scheme defends against is spelled out in `menuItemId` — a native menu left open
 *  while the Build menu's device list arrives. */

import { describe, it, expect, vi } from 'vitest';
import { buildMenuSpec, menuItemId, resolveMenuAction, handleMenuAction } from '../../src/editor/menuSpec';
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

/** #1032 sibling (`family/refusal-not-surfaced`), found by the close-out sweep: a relayed
 *  menu click whose id is no longer in the action map used to answer with a console.warn —
 *  invisible to the user, whose menu item simply did nothing.
 *
 *  ⚠️ Ids here come from `menuItemId`, never hand-spelled. An earlier version of this file
 *  used `'File/Save All#0'`, a shape the code never emits — harmless to the assertions, and
 *  exactly the wrong example to leave in the file whose stated job is to pin the ID SCHEME. */
describe('resolveMenuAction', () => {
  const SAVE = menuItemId('File#0', 0, 'Save All');

  it('returns the action for an id the map still owns', () => {
    const run = vi.fn();
    const out = resolveMenuAction({ [SAVE]: run }, SAVE);
    expect('run' in out).toBe(true);
    if ('run' in out) { out.run(); }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a MISS returns a message for the USER, not just an absence', () => {
    const out = resolveMenuAction({ [SAVE]: vi.fn() }, menuItemId('File#0', 0, 'Save Some'));
    expect('miss' in out).toBe(true);
    if ('miss' in out) {
      // The point: something the user can be shown. An empty string is as silent as the
      // console.warn this replaced.
      expect(out.miss.length).toBeGreaterThan(0);
      // ⚠️ Cause-neutral. TWO routes reach a miss (an open menu, and an accelerator whose
      // closure captured a now-stale id — see the docstring), so a message naming one of
      // them tells half of all users something false. "Reopen the menu" is the wording this
      // pins against: the accelerator route never opened one.
      expect(out.miss).not.toMatch(/reopen/i);
      expect(out.miss).toMatch(/again/i);
    }
  });

  it('a stale id MISSES rather than resolving into the rebuilt map — across buildMenuSpec', () => {
    // The hazard menuItemId documents, spanning both functions: the id a user clicked before
    // a rebuild must not land on whatever now sits at that index. An empty-map miss (the
    // version this replaced) could not fail; it was strictly weaker than the test above and
    // asserted on a vi.fn() that was wired to nothing.
    const nowAtThatIndex = vi.fn();
    const before = buildMenuSpec({ Build: [{ label: 'iOS Device', submenu: [
      { label: 'No iOS device paired', disabled: true },
      { label: 'Build now', action: () => {} },
    ] }] });
    const after = buildMenuSpec({ Build: [{ label: 'iOS Device', submenu: [
      { label: 'iPhone Air', action: nowAtThatIndex },
      { label: 'iPhone 8', action: nowAtThatIndex },
    ] }] });

    const staleId = Object.keys(before.menuActionMap).find((k) => k.includes('build-now'));
    expect(staleId).toBeDefined();
    const out = resolveMenuAction(after.menuActionMap, staleId!);

    expect('miss' in out).toBe(true);
    expect(nowAtThatIndex).not.toHaveBeenCalled();
  });
});

/** The half that was actually broken. `resolveMenuAction` made the MESSAGE testable; deleting
 *  the showToast call still restored the #1032 defect with every test green. These pin the
 *  delivery, not the string. */
describe('handleMenuAction', () => {
  const SAVE = menuItemId('File#0', 0, 'Save All');
  const sinks = () => ({ showToast: vi.fn(), warn: vi.fn() });

  it('a hit runs the action and shows the user NOTHING', () => {
    const run = vi.fn();
    const s = sinks();
    expect(handleMenuAction({ [SAVE]: run }, SAVE, s)).toBe('ran');
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.showToast).not.toHaveBeenCalled();
  });

  it('a miss TELLS THE USER — a console warning alone is the defect, not the fix', () => {
    const s = sinks();
    expect(handleMenuAction({}, SAVE, s)).toBe('missed');
    expect(s.showToast).toHaveBeenCalledTimes(1);
    expect(s.showToast.mock.calls[0][0]).toMatch(/again/i);
    expect(s.showToast.mock.calls[0][1]).toBe('warn');
    // The console line stays too — it carries the id, which the toast deliberately does not.
    expect(s.warn).toHaveBeenCalledTimes(1);
    expect(s.warn.mock.calls[0][0]).toContain(SAVE);
  });

  it('a miss runs NO action from the current map', () => {
    const other = vi.fn();
    const s = sinks();
    handleMenuAction({ [menuItemId('File#0', 0, 'Something Else')]: other }, SAVE, s);
    expect(other).not.toHaveBeenCalled();
  });
});
