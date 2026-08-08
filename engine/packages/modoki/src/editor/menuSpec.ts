/** The renderer → Electron menu spec: turn the editor's menu tree into something serializable,
 *  plus the id → action map the IPC click relay dispatches through.
 *
 *  Extracted from `EditorApp.tsx` so the ID SCHEME is unit-testable — it is the part that can be
 *  wrong in a way nothing visible reports (see `menuItemId`). */

import type { BarMenuItem } from './components/MenuBar';

/** A serializable menu item — no functions cross IPC, so an actionable item carries an `id` that
 *  is dispatched back and looked up in the action map. */
export interface MenuSpecItem {
  id?: string;
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: MenuSpecItem[];
}

export interface MenuSpec {
  menus: { name: string; items: MenuSpecItem[] }[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/**
 * An item's id: its position AND its label — e.g. `Build#0#2:build-now`.
 *
 * The label is in there on purpose. A purely positional id is unsafe once a menu's contents can
 * change while a native menu is OPEN: Electron's MenuItem click closure captures the id when the
 * template is built, macOS keeps displaying an already-open menu after `setApplicationMenu`
 * replaces it, and the renderer swaps its action map for the new one immediately. So a click on a
 * stale item dispatches an OLD id into a NEW map.
 *
 * With positional ids that RESOLVES — to whatever now sits at that index. Measured shape of the
 * accident: at boot the Build menu's iOS submenu is a single placeholder row, so `Build#0#2` is
 * "Build now"; ~2s later the device listing lands and index 2 is the third iPhone, whose action
 * picks that phone and starts a build to it. Including the label makes the stale id MISS instead,
 * and a miss is the correct answer to a click on a menu that no longer exists.
 *
 * The index stays because two rows may legitimately share a label — device names repeat.
 */
export function menuItemId(path: string, index: number, label: string): string {
  return `${path}#${index}:${slug(label)}`;
}

/**
 * Build the spec + the action map together (they must agree on ids, so one function owns both).
 *
 * Nesting is capped at ONE level, matching `MenuBar`: a submenu inside a submenu is dropped rather
 * than rendered, and a submenu PARENT's own action is registered but never dispatched from the OS
 * menu — Electron ignores a click on a parent. Anything that must stay reachable belongs inside
 * the submenu.
 */
export function buildMenuSpec(menus: Record<string, BarMenuItem[]>): {
  menuSpec: MenuSpec;
  menuActionMap: Record<string, () => void>;
} {
  const menuActionMap: Record<string, () => void> = {};
  const toSpecItems = (items: BarMenuItem[], path: string, depth = 0): MenuSpecItem[] =>
    items.map((it, i) => {
      if (it.separator) return { separator: true };
      const id = menuItemId(path, i, it.label);
      if (it.action) menuActionMap[id] = it.action;
      return {
        id, label: it.label, shortcut: it.shortcut, disabled: it.disabled, checked: it.checked,
        ...(it.submenu && depth === 0 ? { submenu: toSpecItems(it.submenu, id, depth + 1) } : {}),
      };
    });
  return {
    menuSpec: { menus: Object.entries(menus).map(([name, items]) => ({ name, items: toSpecItems(items, name) })) },
    menuActionMap,
  };
}
