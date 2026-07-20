/** Pure tree helpers for the Hierarchy panel — search pruning, type collection, and
 *  the tag-based folder grouping. Extracted from Hierarchy.tsx (like assetPaths.ts is
 *  from Assets.tsx) so the logic is unit-testable without rendering React.
 *
 *  Folders are DERIVED from ROOT entities' EntityAttributes.editorFolder ("/"-delimited
 *  path) — a folder exists while a root lives in it or a descendant folder does. The one
 *  exception is EMPTY folders the user just created: those have no tagged root yet, so the
 *  panel keeps their paths in editor-local state and passes them as `extraPaths` here to
 *  synthesize the (rootless) folder node. Once a root is dropped in, the folder becomes
 *  scene-backed and the marker is dropped. */

import type { EntityInfo } from '../../runtime/ecs/entityUtils';

/** Prune the entity tree to nodes matching `pred`, KEEPING every ancestor of a match
 *  so the surviving rows still read as a tree. A node survives iff it matches OR one
 *  of its descendants does; a matching node shows only its matching subtree
 *  (non-matching descendants are pruned). Returns a fresh tree (originals untouched). */
export function filterEntityTree(nodes: EntityInfo[], pred: (e: EntityInfo) => boolean): EntityInfo[] {
  const out: EntityInfo[] = [];
  for (const n of nodes) {
    const keptChildren = n.children && n.children.length ? filterEntityTree(n.children, pred) : [];
    if (pred(n) || keptChildren.length > 0) out.push({ ...n, children: keptChildren });
  }
  return out;
}

/** Component/trait types present across the tree, `[trait, count]` sorted
 *  alphabetically by trait name — feeds the Hierarchy's Type ▾ filter. */
export function collectEntityTypes(nodes: EntityInfo[]): [string, number][] {
  const counts = new Map<string, number>();
  const walk = (list: EntityInfo[]) => {
    for (const e of list) {
      for (const t of e.traits) counts.set(t, (counts.get(t) ?? 0) + 1);
      if (e.children) walk(e.children);
    }
  };
  walk(nodes);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Normalize a folder path: trim each segment, drop empties, rejoin. `''` = ungrouped. */
export function normalizeFolderPath(s: string): string {
  return s.split('/').map((x) => x.trim()).filter(Boolean).join('/');
}

export interface HierarchyFolder {
  path: string;              // "Enemies/Ranged"
  name: string;              // "Ranged" (leaf segment)
  children: HierarchyFolder[];
  roots: EntityInfo[];       // roots tagged exactly this path
}

/** Partition roots into a nestable folder tree + the ungrouped remainder. Ancestor
 *  folders are synthesized so "Enemies/Ranged" renders under an "Enemies" node even
 *  when nothing is tagged directly on "Enemies". Folders sort alphabetically; roots
 *  within a folder keep sortOrder. */
export function buildHierarchyFolders(roots: EntityInfo[], extraPaths: Iterable<string> = []): { folders: HierarchyFolder[]; ungrouped: EntityInfo[] } {
  const ungrouped: EntityInfo[] = [];
  const topFolders: HierarchyFolder[] = [];
  const byPath = new Map<string, HierarchyFolder>();
  const ensure = (path: string): HierarchyFolder => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const parts = path.split('/');
    const node: HierarchyFolder = { path, name: parts[parts.length - 1], children: [], roots: [] };
    byPath.set(path, node);
    if (parts.length === 1) topFolders.push(node);
    else ensure(parts.slice(0, -1).join('/')).children.push(node);
    return node;
  };
  for (const r of roots) {
    const f = normalizeFolderPath(r.editorFolder || '');
    if (!f) { ungrouped.push(r); continue; }
    ensure(f).roots.push(r);
  }
  // Seed rootless (just-created) folders so they render even with nothing in them.
  for (const p of extraPaths) { const f = normalizeFolderPath(p); if (f) ensure(f); }
  const sortNode = (n: HierarchyFolder) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.roots.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    n.children.forEach(sortNode);
  };
  topFolders.sort((a, b) => a.name.localeCompare(b.name));
  topFolders.forEach(sortNode);
  return { folders: topFolders, ungrouped };
}

/** Total roots in a folder subtree (itself + all descendant folders). */
export function countFolderRoots(node: HierarchyFolder): number {
  return node.roots.length + node.children.reduce((n, c) => n + countFolderRoots(c), 0);
}

/** All folder paths in a subtree (itself + every descendant subfolder). Used by the
 *  Alt-click recursive folder toggle to open/close the whole folder subtree at once. */
export function folderSubtreePaths(node: HierarchyFolder): string[] {
  const out = [node.path];
  for (const c of node.children) out.push(...folderSubtreePaths(c));
  return out;
}

/** Ids of every root entity that is a member of a folder subtree (itself + descendant
 *  folders). The Alt-click recursive folder toggle expands/collapses these roots'
 *  ENTITY subtrees too, so re-opening the folder shows its members already collapsed. */
export function folderSubtreeRootIds(node: HierarchyFolder): number[] {
  const out = node.roots.map((r) => r.id);
  for (const c of node.children) out.push(...folderSubtreeRootIds(c));
  return out;
}

/** Everything that must be un-collapsed for `selectedId`'s row to actually exist in the
 *  Hierarchy DOM: its ancestor entities, and the folder its ROOT ancestor is tagged into
 *  (plus that folder's own ancestor folders, since "Enemies/Ranged" renders inside
 *  "Enemies"). Selecting in the viewport can land on an entity buried under both, and a
 *  row that isn't rendered can't be scrolled to.
 *
 *  `flat` is the unfiltered entity list. Returns empty arrays for an unknown id or a
 *  bare root, so the caller can skip the state write entirely. */
export function revealTargetsFor(
  flat: EntityInfo[],
  selectedId: number,
): { ancestorIds: number[]; folderPaths: string[] } {
  const byId = new Map(flat.map((e) => [e.id, e]));
  const ancestorIds: number[] = [];
  let cur = byId.get(selectedId);
  while (cur && cur.parentId > 0) {
    ancestorIds.push(cur.parentId);
    cur = byId.get(cur.parentId);
  }
  // `cur` is now the root ancestor (or the entity itself). Only roots carry editorFolder.
  const folderPaths: string[] = [];
  const folder = normalizeFolderPath(cur?.editorFolder || '');
  if (folder) {
    const segs = folder.split('/');
    for (let i = 1; i <= segs.length; i++) folderPaths.push(segs.slice(0, i).join('/'));
  }
  return { ancestorIds, folderPaths };
}
