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

/** Sliced sprites grouped under the texture GUID they were cut from. They render
 *  as children of that texture row, never as standalone entries. */
export function spritesByTexture(assets: ReadonlyArray<AssetEntry>): Map<string, AssetEntry[]> {
  const m = new Map<string, AssetEntry[]>();
  for (const a of assets) {
    if (a.type !== 'sprite' || !a.sprite?.texture) continue;
    const arr = m.get(a.sprite.texture);
    if (arr) arr.push(a); else m.set(a.sprite.texture, [a]);
  }
  return m;
}

/** Search text AND (when any chip is active) the type filter. Sprites are always
 *  excluded from the flat lists — they render as texture children. */
export function filterAssets(
  assets: ReadonlyArray<AssetEntry>,
  filter: string,
  typeFilter: ReadonlySet<string>,
): AssetEntry[] {
  const q = filter.toLowerCase();
  const hasType = typeFilter.size > 0;
  return assets.filter((a) => {
    if (a.type === 'sprite') return false;
    if (hasType && !typeFilter.has(a.type)) return false;
    if (q && !a.name.toLowerCase().includes(q) && !a.path.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Total assets that CAN appear in the flat list — the denominator of the footer's
 *  "N of M assets". Sliced sprites are excluded for the same reason as in
 *  `filterAssets`: counting them compares a sprite-free numerator against a
 *  sprite-inflated denominator, so the footer sticks on "N of M" forever once any
 *  texture is sliced. */
export function flatAssetTotal(assets: ReadonlyArray<AssetEntry>): number {
  return assets.reduce((n, a) => n + (a.type === 'sprite' ? 0 : 1), 0);
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
