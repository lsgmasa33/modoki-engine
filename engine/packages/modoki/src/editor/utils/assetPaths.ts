/** Pure path/tree helpers for the Assets panel. Extracted from Assets.tsx so the
 *  logic (compound-extension splitting, collision-free copy/paste names, folder
 *  rename remapping, folder-tree building) can be unit-tested without rendering
 *  the React component. */

import type { SpriteAssetRef } from '../../runtime/loaders/spriteSheet';
import { JSON_ASSET_SUFFIX_TYPE } from '../../runtime/loaders/assetTypeClassifier';

export interface AssetEntry {
  guid?: string;
  path: string;
  name: string;
  type: string;
  /** Sliced-sprite block (`type === 'sprite'` only) — parent texture + rect/pivot.
   *  Lets the Assets panel nest sprites under their texture (Unity-style sub-assets). */
  sprite?: SpriteAssetRef;
}

export interface FolderNode {
  name: string;
  path: string;         // folder path like "/models/tropical-island"
  children: FolderNode[];
  files: AssetEntry[];
}

/** The compound extensions that must survive a rename as ONE unit — the engine's own
 *  `.<kind>.json` asset kinds (from the shared classifier, so a new kind is picked up
 *  automatically) plus the two sidecars, which are not asset kinds and so are not in it. */
const COMPOUND_EXTS: ReadonlyArray<string> = [
  ...JSON_ASSET_SUFFIX_TYPE.map(([suffix]) => suffix),
  '.meta.json',
  '.meta.local.json',
];

/** Split an asset path into its folder, base filename, and extension. The base is
 *  what the user edits when renaming/duplicating, so what counts as "extension"
 *  decides what they are ALLOWED to edit.
 *
 *  A KNOWN compound extension (`.prefab.json`, `.mat.json`, `.meta.json`, …) is kept
 *  intact; otherwise only the LAST extension is split off.
 *
 *  ⚠️ This used to split on the FIRST dot, which silently made every dot in a filename
 *  un-editable. macOS names a screenshot `Screenshot 2026-08-20 at 11.35.37 AM.png`, so
 *  the rename box offered `Screenshot 2026-08-20 at 11` and renaming it to "Test"
 *  produced `Test.35.37 AM.png` — the timestamp was welded on as an extension and could
 *  not be removed (reported from a live editor, 2026-08-21). A versioned `v1.2.glb` edited
 *  as `v1`, and `Level.1.court.json` as `Level`. Duplicate/paste naming shares this split,
 *  so a copy of `v1.2.glb` was `v1 copy.2.glb`.
 *  The first-dot rule was reaching for the compound extensions above; it could not tell
 *  them from an ordinary dot, so it now asks the classifier instead of guessing. The
 *  codebase already knew the rule was wrong — `planAutoImports` below documents using
 *  last-extension stripping "NOT splitAssetPath's first-dot split" for multi-dot models.
 *
 *  A LEADING dot (a dotfile like `.gitkeep`) is part of the base, not an empty-base
 *  extension, so a dotfile rename/duplicate keeps its name instead of producing
 *  `${dir}/ copy.gitkeep`. */
export function splitAssetPath(p: string): { dir: string; base: string; ext: string } {
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.substring(0, slash) : '';
  const filename = slash >= 0 ? p.substring(slash + 1) : p;

  // A known compound extension wins over the last-dot rule — `weed.prefab.json` must
  // edit as `weed`, never as `weed.prefab`. Longest match first so `.meta.local.json`
  // is not shadowed by `.meta.json`... (they do not overlap today, but the ordering
  // makes that independent of the classifier's list order).
  const lower = filename.toLowerCase();
  let compound = '';
  for (const suffix of COMPOUND_EXTS) {
    if (lower.endsWith(suffix) && filename.length > suffix.length && suffix.length > compound.length) {
      compound = suffix;
    }
  }
  if (compound) {
    return { dir, base: filename.substring(0, filename.length - compound.length), ext: filename.substring(filename.length - compound.length) };
  }

  // Otherwise the extension is the LAST dot onward. `start` keeps a dotfile's leading
  // dot on the base: for `.gitkeep` the only dot is at 0, which is not an extension.
  const start = filename.startsWith('.') ? 1 : 0;
  const dot = filename.lastIndexOf('.');
  if (dot < start) return { dir, base: filename, ext: '' };
  return { dir, base: filename.substring(0, dot), ext: filename.substring(dot) };
}

/** Plan which freshly-discovered assets to auto-import with default config
 *  (Unity-style import-on-add). PURE so the policy is unit-tested without IO.
 *
 *  `added` = the entries that just appeared on disk (the diff vs the previous
 *  scan). `allPaths` = the full current path set, used to spot existing import
 *  OUTPUTS so a model isn't re-imported.
 *
 *   - MODEL → import (creates a prefab; FBX/OBJ/DAE bake to GLB first), UNLESS a
 *     sibling `<name>.prefab.json` already exists — that's the import output, so
 *     the model has already been imported.
 *   - TEXTURE → import (convert with default config). No sibling marker, but only
 *     genuinely-new entries are ever passed, so each converts exactly once.
 *
 *  Everything else (prefab / mesh / material / scene / sidecars / …) is an import
 *  OUTPUT, not a source — ignored, so import results never re-trigger imports. The
 *  sibling check uses last-extension stripping (NOT splitAssetPath's first-dot
 *  split) to match importModelWithMeta's prefab path for multi-dot model names. */
export function planAutoImports(
  added: ReadonlyArray<AssetEntry>,
  allPaths: ReadonlySet<string>,
): { models: AssetEntry[]; textures: AssetEntry[] } {
  const models: AssetEntry[] = [];
  const textures: AssetEntry[] = [];
  for (const a of added) {
    if (a.type === 'model') {
      // A `.colmesh.glb` is collision SOURCE geometry (generated by the Model
      // inspector's "Generate Collision Mesh"), not a render model — importing it
      // would wrongly mint a prefab/material + a stray scene mesh. Its own lean
      // `.mesh.json` is hand-authored, so treat it as an import output, not a source.
      if (a.path.endsWith('.colmesh.glb')) continue;
      const prefabSibling = a.path.replace(/\.[^./]+$/, '.prefab.json');
      if (!allPaths.has(prefabSibling)) models.push(a);
    } else if (a.type === 'texture') {
      textures.push(a);
    }
  }
  return { models, textures };
}

/** Build a non-colliding "X copy" path for a duplicate. */
export function duplicatePathFor(srcPath: string, taken: Set<string>): string {
  const { dir, base, ext } = splitAssetPath(srcPath);
  const make = (suffix: string) => `${dir}/${base}${suffix}${ext}`;
  let candidate = make(' copy');
  let n = 2;
  while (taken.has(candidate)) { candidate = make(` copy ${n}`); n++; }
  return candidate;
}

/** Destination path when pasting `srcPath` into `folder`, avoiding collisions
 *  (appends " copy" / " copy N", preserving compound extensions). */
export function pastePathIn(folder: string, srcPath: string, taken: Set<string>): string {
  const { base, ext } = splitAssetPath(srcPath);
  const norm = folder === '/' ? '' : folder;
  let candidate = `${norm}/${base}${ext}`;
  if (!taken.has(candidate)) return candidate;
  candidate = `${norm}/${base} copy${ext}`;
  let n = 2;
  while (taken.has(candidate)) { candidate = `${norm}/${base} copy ${n}${ext}`; n++; }
  return candidate;
}

/** Rewrite a path-set after a folder rename: any entry equal to or under
 *  `oldP` is reparented to `newP`. Used to keep the expanded/pending sets
 *  consistent when a folder (and its whole subtree) is renamed. */
export function remapPrefix(set: Set<string>, oldP: string, newP: string): Set<string> {
  const next = new Set<string>();
  for (const v of set) {
    if (v === oldP) next.add(newP);
    else if (v.startsWith(oldP + '/')) next.add(newP + v.slice(oldP.length));
    else next.add(v);
  }
  return next;
}

/** What happened to a path. `to: null` means the asset is GONE (delete) → unbind; a string
 *  means it MOVED → remap, because the asset survives (its GUID and `.meta.json` sidecar
 *  move with it) and only its location changed. `prefix` makes it a FOLDER operation,
 *  matching the folder itself and everything beneath it. */
export interface PathMove {
  readonly from: string;
  readonly to: string | null;
  readonly prefix?: boolean;
  /** Replacement display name, when the caller knows it (an asset rename). */
  readonly name?: string;
}

/** Where `path` ends up under `move`, or `undefined` if the move does not touch it.
 *  `null` = gone. `remapPrefix` above is the sibling of this same segment-boundary rule for
 *  a `Set<string>` of paths rather than a single one — the two coexist rather than being
 *  unified because this one needs the three-valued (`undefined`/`null`/string) return that a
 *  `Set` rewrite has no use for, and both now live in this leaf module so the next person
 *  sees them together. Exported for the test that pins folder-prefix matching. */
export function applyMove(path: string, move: PathMove): string | null | undefined {
  if (move.prefix) {
    // Segment-boundary match ONLY: renaming `/assets/anim` must not capture
    // `/assets/animations/x.json`, which a bare startsWith would.
    if (path !== move.from && !path.startsWith(move.from + '/')) return undefined;
    if (move.to === null) return null;
    return move.to + path.slice(move.from.length);
  }
  if (path !== move.from) return undefined;
  return move.to;
}

/** Collapse a single-folder wrapper chain so redundant manifest roots (e.g. the
 *  virtual `/` named "assets" wrapping the `/assets` URL-prefix folder, also named
 *  "assets") don't render as "assets ▸ assets". Descends while a node has no files
 *  and exactly one child folder, landing on the first node that actually branches
 *  (where the category folders live). Shared by the project + Engine sections. */
/** Is `path` a FOLDER, given what the panel knows? Three sources because a folder exists in the
 *  UI before it exists on disk: `pendingFolders` (optimistically created, no file in it yet),
 *  `diskFolders` (empty folders the backend reported), and — the one that covers the common case
 *  — any folder that has assets under it, which is implied by the asset list rather than listed
 *  anywhere.
 *
 *  Extracted for #867. It was written inline twice (the collision checks in `commitFolderRename`
 *  and the new-folder path) and needed a third time by `planFilesDropMoves`, which is where the
 *  cost of NOT having it showed up: a drag could not tell a folder from a file, so it built an
 *  exact-path move and repaired nothing under it. */
export function isFolderPath(
  path: string,
  known: { pendingFolders: ReadonlySet<string>; diskFolders: readonly string[]; assets: readonly AssetEntry[] },
): boolean {
  if (known.pendingFolders.has(path)) return true;
  if (known.diskFolders.includes(path)) return true;
  return known.assets.some((a) => a.path === path || a.path.startsWith(path + '/'));
}

/** A move that RELOCATES rather than deletes — `PathMove` with its `to: null` case ruled out.
 *  A drag-and-drop can only ever put a file somewhere, so the planner below is total in `to`. */
export type RelocateMove = PathMove & { to: string };

/** Plan the moves a drag-and-drop into `targetFolder` should make — the PURE half of
 *  `handleFilesDrop` (`Assets.tsx`), separated so the decision can be tested without the panel
 *  (`docs/editor.md` § "Where a panel's LOGIC belongs").
 *
 *  ⚠️ **`prefix` is the whole point of this function existing** (#867). A dragged FOLDER used to
 *  produce `{from, to}` with no `prefix`, so `applyMove` took its exact-path branch and returned
 *  `undefined` for every descendant — the parked writes, CAS baselines, bindings and Inspector
 *  selection under a moved folder were all left pointing into a folder that no longer existed. The
 *  drag payload has carried `isFolder: true` since folders became draggable and **nothing ever read
 *  it**; it is not read here either, because a multi-selection drag carries one payload for many
 *  paths. The tree is asked about each path instead, which is right for every entry.
 *
 *  The skips are the pre-existing rules, unchanged: a no-op move into the current folder, dropping
 *  a folder onto itself, and dropping a folder into its own descendant (which would orphan it). */
export function planFilesDropMoves(
  filePaths: readonly string[],
  targetFolder: string,
  isFolder: (path: string) => boolean,
): RelocateMove[] {
  const normalizedTarget = targetFolder === '/' ? '' : targetFolder;
  const out: RelocateMove[] = [];
  for (const filePath of filePaths) {
    const originalFolder = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
    if (targetFolder === originalFolder) continue;          // already there
    if (targetFolder === filePath) continue;                // onto itself
    if (targetFolder.startsWith(filePath + '/')) continue;  // into its own descendant
    const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
    const to = `${normalizedTarget}/${fileName}`;
    out.push(isFolder(filePath) ? { from: filePath, to, prefix: true } : { from: filePath, to });
  }
  return out;
}

export function effectiveAssetsRoot(root: FolderNode): FolderNode {
  let node = root;
  while (node.files.length === 0 && node.children.length === 1) node = node.children[0];
  return node;
}

/** All folder paths in a subtree (the node itself + every descendant folder) —
 *  used for Option/Alt-click "expand/collapse all". */
export function collectFolderPaths(node: FolderNode, out: string[] = []): string[] {
  out.push(node.path);
  for (const c of node.children) collectFolderPaths(c, out);
  return out;
}

/** Build a hierarchical folder tree from a flat asset list. `extraFolders`
 *  seeds folders that hold no assets (freshly-created empty folders) so they
 *  still appear — the backend scanner only reports files. */
export function buildFolderTree(assets: AssetEntry[], extraFolders: string[] = []): FolderNode {
  const root: FolderNode = { name: 'assets', path: '/', children: [], files: [] };
  const folderMap = new Map<string, FolderNode>();
  folderMap.set('/', root);

  const getOrCreate = (folderPath: string): FolderNode => {
    if (folderMap.has(folderPath)) return folderMap.get(folderPath)!;
    const parts = folderPath.split('/').filter(Boolean);
    const name = parts[parts.length - 1];
    const parentPath = '/' + parts.slice(0, -1).join('/');
    const parent = getOrCreate(parentPath.length > 1 ? parentPath : '/');
    const node: FolderNode = { name, path: folderPath, children: [], files: [] };
    parent.children.push(node);
    folderMap.set(folderPath, node);
    return node;
  };

  for (const a of assets) {
    const lastSlash = a.path.lastIndexOf('/');
    const folderPath = lastSlash > 0 ? a.path.substring(0, lastSlash) : '/';
    getOrCreate(folderPath).files.push(a);
  }
  // Seed folders that hold no assets (freshly-created empty folders).
  for (const f of extraFolders) { if (f && f !== '/') getOrCreate(f); }

  // Sort children and files alphabetically.
  const sortNode = (node: FolderNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}
