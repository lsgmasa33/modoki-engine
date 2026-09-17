/** Pure list/tree shaping for the Assets panel — what the panel SHOWS, decided
 *  without rendering anything.
 *
 *  Extracted from `Assets.tsx` (#105 Phase 3). These were `useMemo` bodies inside
 *  a 2,111-line component, which meant the only way to exercise them was to drive
 *  the whole panel through an e2e spec. They are ordinary functions over ordinary
 *  data; the `useMemo`s in the panel now just call them.
 *
 *  `visibleOrder` is the one that most needed pinning: it MIRRORS the render's
 *  walk order (category groups in canonical order, or a DFS of the folder tree,
 *  children before files, expanded nodes only) and drives shift-range selection,
 *  arrow-key navigation and Select All. If it drifts from the render, the keyboard
 *  silently navigates in an order the user cannot see — the class of bug that has
 *  no visual symptom until someone holds an arrow key. */

import { compareAssetTypes } from './assetTypeIcons';
import type { AssetEntry, FolderNode } from '../utils/assetPaths';

export type ViewMode = 'category' | 'folder';

/** Toggle key for the top-level "Assets" section header. Kept out of the folder
 *  path-space (which the real folders use) so it never collides with one. */
export const ASSETS_SECTION = '@@assets-section';

/** Where a sprite shows, decided once for the list, the footer and the nesting (#1249).
 *
 *  By default a sprite is a sub-asset: it renders as a child of its texture row and is never a row
 *  of its own. That rule cannot also answer a narrowing that asks FOR sprites — deciding it on the
 *  sprite's own row, which never renders, made the `sprite` type chip list 0 rows while its menu
 *  entry counted every sprite, and made a search for a slice's name find nothing. So:
 *  - the `sprite` chip is on → every sprite is a flat row, and nothing nests (a texture that is
 *    listed too would otherwise show the same sprites twice);
 *  - search text with no type chip → a matching sprite is a flat row only when its texture row is
 *    not listed, because a listed texture already shows it as a child;
 *  - otherwise → sprites nest and are not rows. */
export function spriteRowsEnabled(typeFilter: ReadonlySet<string>): boolean {
  return typeFilter.has('sprite');
}

/** Sliced sprites grouped under the texture GUID they were cut from, for the texture row to render
 *  as children. Empty while sprites are flat rows (`spriteRowsEnabled`) — see there. */
export function spritesByTexture(
  assets: ReadonlyArray<AssetEntry>,
  typeFilter: ReadonlySet<string>,
): Map<string, AssetEntry[]> {
  const m = new Map<string, AssetEntry[]>();
  if (spriteRowsEnabled(typeFilter)) return m;
  for (const a of assets) {
    if (a.type !== 'sprite' || !a.sprite?.texture) continue;
    const arr = m.get(a.sprite.texture);
    if (arr) arr.push(a); else m.set(a.sprite.texture, [a]);
  }
  return m;
}

/** Search text AND (when any chip is active) the type filter. Sprites follow the rule in
 *  `spriteRowsEnabled`'s doc: nested by default, flat rows when the narrowing asks for them. */
export function filterAssets(
  assets: ReadonlyArray<AssetEntry>,
  filter: string,
  typeFilter: ReadonlySet<string>,
): AssetEntry[] {
  const q = filter.toLowerCase();
  const hasType = typeFilter.size > 0;
  const spriteChip = spriteRowsEnabled(typeFilter);
  const matches = (a: AssetEntry) => !q || a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q);
  const listed = (a: AssetEntry) => a.type !== 'sprite' && (!hasType || typeFilter.has(a.type)) && matches(a);
  // Only a search with no chip needs to know which textures are listed; build the set only then.
  const searchSprites = !hasType && q !== '';
  const listedTextures = new Set<string>();
  if (searchSprites) for (const a of assets) if (a.guid && listed(a)) listedTextures.add(a.guid);
  return assets.filter((a) => {
    if (a.type !== 'sprite') return listed(a);
    if (spriteChip) return matches(a);
    return searchSprites && matches(a) && !(a.sprite?.texture && listedTextures.has(a.sprite.texture));
  });
}

/** Total assets that CAN appear in the list — the denominator of the footer's "N of M assets".
 *  Sprites count only while the current narrowing can make them rows (the `sprite` chip, or search
 *  text with no chip — `filterAssets`): counting them otherwise compares a sprite-free numerator
 *  against a sprite-inflated denominator, so the footer sticks on "N of M" forever once any texture
 *  is sliced; NOT counting them while a search lists them let N exceed M ("600 of 250 assets" for a
 *  600-slice sheet whose slices match and whose name does not). */
export function flatAssetTotal(
  assets: ReadonlyArray<AssetEntry>,
  filter: string,
  typeFilter: ReadonlySet<string>,
): number {
  if (spriteRowsEnabled(typeFilter) || (typeFilter.size === 0 && filter !== '')) return assets.length;
  return assets.reduce((n, a) => n + (a.type === 'sprite' ? 0 : 1), 0);
}

/** The assets a file action (delete, duplicate, cut/copy) applies to: the selection, minus sprites. A sprite
 *  has no file of its own — it is a slice record inside its texture's sidecar — which is why its context menu
 *  already offers none of these. Keyboard Select All now reaches sprite ROWS (#1249), so without this a
 *  Cmd+A → Delete under the sprite chip queued every sprite for a delete that removes nothing on disk and
 *  pushes an undo that restores nothing. */
export function fileActionTargets(selected: ReadonlyArray<AssetEntry>): AssetEntry[] {
  return selected.filter(isFileRow);
}

/** THE row-level answer to "does this row have a file of its own?" (#1257). Every selection-driven file
 *  action — delete/duplicate/copy (`fileActionTargets`), F2 rename (`resolveAssetKey`), the context menu's
 *  target count and a folder drop (`fileActionPaths`) — asks here, so the next sprite-like row type is one
 *  edit rather than a fourth local filter. */
export function isFileRow(a: AssetEntry): boolean {
  return a.type !== 'sprite';
}

/** `fileActionTargets` for callers that hold PATHS (a selection Set, a drag payload): drops every path
 *  whose listed entry is not a file row, keeps the rest in order (#1257). A path with NO entry in
 *  `assets` is kept — an engine built-in or a folder is not in the project list, and deciding what
 *  those mean is the caller's business, exactly as it was before this filter existed.
 *
 *  Why it matters beyond the 404s: the context menu derives `many` from this count, so one texture plus
 *  a few selected sprite rows used to read as a multi-selection and hid Rename, Instantiate, Re-import,
 *  Copy Path and Find References for the one real file. */
export function fileActionPaths(paths: Iterable<string>, assets: ReadonlyArray<AssetEntry>): string[] {
  const nonFile = new Set<string>();
  for (const a of assets) if (!isFileRow(a)) nonFile.add(a.path);
  return [...paths].filter((p) => !nonFile.has(p));
}

/** Category view: group by type, ordered by the shared canonical type order (so
 *  the section order matches the type-filter menu). A Map preserves insertion
 *  order, so inserting sorted keys makes both the render and `visibleOrder` walk
 *  the sections in canonical order. */
export function groupByType(filtered: ReadonlyArray<AssetEntry>): Map<string, AssetEntry[]> {
  const m = new Map<string, AssetEntry[]>();
  for (const a of filtered) {
    if (!m.has(a.type)) m.set(a.type, []);
    m.get(a.type)!.push(a);
  }
  return new Map([...m.entries()].sort((x, y) => compareAssetTypes(x[0], y[0])));
}

/** Visible asset paths in on-screen order — drives shift-range + arrow-key
 *  navigation and Select All. Mirrors the render: category groups in insertion
 *  order (only expanded ones), or a DFS of the folder tree (children before
 *  files, only under expanded nodes).
 *
 *  In folder view the "Assets" section header sits above the tree and its children
 *  render at depth 1, so navigation walks the collapsed root's children/files
 *  directly — the root node itself is never a navigable row. */
export function visibleOrder(opts: {
  viewMode: ViewMode;
  grouped: ReadonlyMap<string, AssetEntry[]>;
  assetsRoot: FolderNode;
  expanded: ReadonlySet<string>;
}): string[] {
  const { viewMode, grouped, assetsRoot, expanded } = opts;
  const out: string[] = [];
  if (viewMode === 'category') {
    for (const [type, items] of grouped) {
      if (expanded.has(type)) for (const a of items) out.push(a.path);
    }
  } else if (expanded.has(ASSETS_SECTION)) {
    const walk = (node: FolderNode) => {
      if (!expanded.has(node.path)) return;
      for (const c of node.children) walk(c);
      for (const f of node.files) out.push(f.path);
    };
    for (const c of assetsRoot.children) walk(c);
    for (const f of assetsRoot.files) out.push(f.path);
  }
  return out;
}
