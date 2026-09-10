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

/** What a relayed menu click should do, given the action map current at click time.
 *  Extracted from EditorApp's IPC handler so the DECISION is unit-testable — the panel
 *  itself is `.tsx` and carries no tests (CLAUDE.md § Tests).
 *
 *  ⚠️ A miss is not a no-op you may swallow. The native menu is rebuilt whenever its
 *  labels/enabled state change, and ids carry the label, so a rebuild can strand an id.
 *  Doing nothing is the correct ACTION; doing it silently is the #1032 defect
 *  (`family/refusal-not-surfaced`) — from the user's side a menu item simply did not work,
 *  and a console.warn is not something they can see.
 *
 *  ⚠️ TWO routes reach a miss, and the message must be true of BOTH — an earlier wording
 *  said "the menu changed while it was open. Reopen it and click again", which is false and
 *  useless on the second:
 *    ① a native menu left OPEN across a rebuild relays an id the new map no longer owns;
 *    ② an ACCELERATOR. `projects.ts` gives every relayed item a click closure capturing its
 *      id at template-build time, and Chromium swallows those accelerators before the
 *      renderer's keymap sees them — so under Electron Cmd+Z IS the relay. `Edit/Undo`'s
 *      label carries `undoLabel()`, so its id changes as the stack changes, and main's menu
 *      is only rebuilt an IPC round-trip after the renderer assigns the new map. Two quick
 *      presses inside that window relay a stale id with no menu ever opened.
 *  So the wording stays cause-neutral and the remedy is "try it again", which is true either
 *  way. Distinguishing the routes would need main to say which one fired; the renderer
 *  cannot tell. */
export function resolveMenuAction(
  // ⚠️ `| undefined` is load-bearing, not decoration. As a bare `Record<string, () => void>`
  // TypeScript types the lookup as ALWAYS DEFINED, so `run ? … : …` is a condition that can
  // only go one way — `tsc` says so (TS2774) and the miss branch becomes unreachable at type
  // level even though it is the branch this function exists for. Caught by `npm run docs:api`
  // in this change's own close-out.
  actions: Readonly<Record<string, (() => void) | undefined>>,
  id: string,
): { run: () => void } | { miss: string } {
  const run = actions[id];
  return run
    ? { run }
    : { miss: 'That menu action was out of date — the menu had just been rebuilt. Try it again.' };
}

/** The whole outcome of a relayed menu click: run it, or tell the user it went stale.
 *
 *  ⚠️ This exists because extracting only `resolveMenuAction` did not finish the job — the
 *  MESSAGE became testable while the thing that had actually been broken, showing it to the
 *  user, stayed in `EditorApp.tsx` where nothing tests it. Deleting the `showToast` call
 *  restored the #1032 defect with all 11 tests still green (found in this change's own §2d
 *  re-review). The sinks are injected so the `.tsx` keeps only the wiring. */
export function handleMenuAction(
  actions: Readonly<Record<string, (() => void) | undefined>>,
  id: string,
  sinks: { showToast: (message: string, kind: 'warn') => void; warn: (message: string) => void },
): 'ran' | 'missed' {
  const outcome = resolveMenuAction(actions, id);
  if ('miss' in outcome) {
    sinks.warn(`[editor] ignoring a menu click for "${id}" — the action map no longer owns that id`);
    sinks.showToast(outcome.miss, 'warn');
    return 'missed';
  }
  outcome.run();
  return 'ran';
}
