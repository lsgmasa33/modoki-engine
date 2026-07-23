/** Native application-menu introspection + trigger — the backing logic for the `modoki_menu`
 *  MCP tool. Extracted from `main.ts` and written against a minimal `MenuItemLike` interface (a
 *  structural subset of Electron's `MenuItem`) so the tree-walk, label-path matching, and
 *  serialization are unit-testable WITHOUT building a real `Menu` in the main process.
 *
 *  WHY THIS EXISTS. `modoki_press_key` explicitly cannot fire native Electron menu accelerators
 *  (Chromium swallows them before the renderer sees the key), so menu-only actions — View → Zoom
 *  In/Out/Actual Size, and every relayed `onMenuAction` item — were unreachable from MCP. This
 *  walks the live application menu and invokes an item's `click()` by label PATH or `id`, the same
 *  callback a human's click runs. Discovery (`list`) returns the tree so an agent can find the path
 *  first rather than guess it. */

/** The structural subset of Electron's `MenuItem` this module needs. Electron's real MenuItem is a
 *  superset, so a live app menu satisfies it; tests pass hand-built literals. */
export interface MenuItemLike {
  label?: string;
  id?: string;
  role?: string;
  type?: string; // 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean;
  // Electron types these as `string | null` (not undefined), so accept null to match a live MenuItem.
  accelerator?: string | null;
  sublabel?: string | null;
  submenu?: { items: MenuItemLike[] } | null;
  click?: (...args: unknown[]) => void;
}

/** A serialized menu node (what `list` returns) — labels/ids/state only, never the click fn. */
export interface MenuNode {
  label: string;
  id?: string;
  role?: string;
  accelerator?: string;
  enabled: boolean;
  /** The '/'-joined label path from the menu root to this item — the exact string `path` accepts. */
  path: string;
  /** True when this item has a click handler or role, i.e. `trigger` can actually fire it. */
  actionable: boolean;
  submenu?: MenuNode[];
}

/** Normalize a label for matching: drop the `&` mnemonic markers, a trailing `…`/`...`, a leading
 *  macOS `✓ ` check glyph, and surrounding whitespace, then lowercase. So "Zoom In", "zoom in",
 *  and "&Zoom In…" all match. */
export function normalizeLabel(label: string | undefined): string {
  return (label ?? '')
    .replace(/&/g, '')
    .replace(/…$|\.\.\.$/u, '')
    .replace(/^✓\s*/u, '')
    .trim()
    .toLowerCase();
}

/** Split a user path on `/`, `>`, or `\` (so "View/Zoom In", "View > Zoom In" both work), trimming
 *  each segment. Empty segments (a stray separator) are dropped. */
export function splitMenuPath(path: string): string[] {
  return path.split(/[/>\\]/).map((s) => s.trim()).filter(Boolean);
}

/** Serialize a menu tree to `MenuNode[]`, carrying each item's full label path. Separators and
 *  invisible items are omitted (they are not addressable). */
export function serializeMenu(items: readonly MenuItemLike[], parentPath = ''): MenuNode[] {
  const out: MenuNode[] = [];
  for (const it of items) {
    if (it.type === 'separator') continue;
    if (it.visible === false) continue;
    const label = it.label ?? it.role ?? '';
    const path = parentPath ? `${parentPath}/${label}` : label;
    const node: MenuNode = {
      label,
      ...(it.id ? { id: it.id } : {}),
      ...(it.role ? { role: it.role } : {}),
      ...(it.accelerator ? { accelerator: it.accelerator } : {}),
      enabled: it.enabled !== false,
      path,
      actionable: typeof it.click === 'function' || typeof it.role === 'string',
    };
    if (it.submenu && it.submenu.items.length) node.submenu = serializeMenu(it.submenu.items, path);
    out.push(node);
  }
  return out;
}

/** Find a menu item by `id` (exact, searched depth-first anywhere in the tree) or by label `path`
 *  (root-anchored, segment-by-segment). Returns the item or null. */
export function findMenuItem(
  items: readonly MenuItemLike[],
  target: { id?: string; path?: string },
): MenuItemLike | null {
  if (target.id) {
    const byId = (list: readonly MenuItemLike[]): MenuItemLike | null => {
      for (const it of list) {
        if (it.id === target.id) return it;
        if (it.submenu) { const hit = byId(it.submenu.items); if (hit) return hit; }
      }
      return null;
    };
    return byId(items);
  }
  if (target.path) {
    const segs = splitMenuPath(target.path).map(normalizeLabel);
    if (!segs.length) return null;
    let level: readonly MenuItemLike[] = items;
    let found: MenuItemLike | null = null;
    for (let i = 0; i < segs.length; i++) {
      found = level.find((it) => normalizeLabel(it.label ?? it.role) === segs[i]) ?? null;
      if (!found) return null;
      if (i < segs.length - 1) {
        if (!found.submenu) return null; // path descends past a leaf
        level = found.submenu.items;
      }
    }
    return found;
  }
  return null;
}

export interface TriggerResult {
  ok: boolean;
  /** The label path of the item that fired (on success). */
  fired?: string;
  /** Failure reason (on !ok). */
  error?: string;
  /** On a not-found failure, the actionable label paths available, as a discovery hint. */
  available?: string[];
}

/** The focused window + web contents to pass into a menu item's `click(menuItem, window,
 *  webContents)`. Electron's NATIVE role dispatch (reload/copy/toggleDevTools/… — a
 *  `webContentsMethod`/`windowMethod` role) needs these to act on; invoking `click()` with none
 *  (as a bare `item.click?.()` does) makes those roles a SILENT no-op while still returning
 *  ok:true — the false-success this context closes. Custom `() => …` handlers (our Zoom/menu-relay
 *  items) ignore the extra args, so passing context is always safe. The caller (main.ts) supplies
 *  the live `BrowserWindow`/`WebContents`; tests pass spies. */
export interface ClickContext {
  window?: unknown;
  webContents?: unknown;
}

/** Flatten a serialized tree to the label paths of every ACTIONABLE, enabled item — the useful
 *  "what could I have fired?" hint on a miss. */
export function actionablePaths(nodes: readonly MenuNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly MenuNode[]) => {
    for (const n of list) {
      if (n.actionable && n.enabled) out.push(n.path);
      if (n.submenu) walk(n.submenu);
    }
  };
  walk(nodes);
  return out;
}

/** Resolve `target` against the application menu and invoke its `click()` — the same callback a
 *  human's click runs. Pure w.r.t. the menu (passed in); the caller supplies the live
 *  `Menu.getApplicationMenu()`. A disabled item is refused (a human couldn't click it either); a
 *  non-actionable item (no click/role — e.g. a submenu header) is refused with a clear reason. */
export function triggerMenuItem(
  items: readonly MenuItemLike[] | null,
  target: { id?: string; path?: string },
  ctx?: ClickContext,
): TriggerResult {
  if (!items) return { ok: false, error: 'no application menu is installed' };
  if (!target.id && !target.path) return { ok: false, error: 'provide an item `path` (e.g. "View/Zoom In") or `id`' };
  const item = findMenuItem(items, target);
  if (!item) {
    return {
      ok: false,
      error: `no menu item matches ${target.id ? `id "${target.id}"` : `path "${target.path}"`}`,
      available: actionablePaths(serializeMenu(items)),
    };
  }
  const label = item.label ?? item.role ?? '(unnamed)';
  if (item.enabled === false) return { ok: false, error: `menu item "${label}" is disabled` };
  if (typeof item.click !== 'function' && typeof item.role !== 'string') {
    return { ok: false, error: `menu item "${label}" has no action (it is a container/label, not a command)` };
  }
  try {
    // Pass (menuItem, window, webContents) — the same shape Electron's own menu dispatch uses — so
    // native role items (reload/copy/toggleDevTools/…) actually execute instead of no-opping while
    // we falsely report success. Custom click handlers ignore the extra args.
    item.click?.(item, ctx?.window, ctx?.webContents);
  } catch (e) {
    return { ok: false, error: `menu item "${label}" click threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, fired: label };
}
