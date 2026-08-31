/** Assets-panel view state — the folder tree's `expanded` / `pendingFolders` sets, the view
 *  mode, and the type filter — held at MODULE scope rather than in the panel, and persisted to
 *  localStorage on every mutation.
 *
 *  ⚠️ These MUST NOT go back into `useState` (#309). An undo builder's closures outlive the
 *  render, so a panel-bound setter silently no-ops once the panel unmounts and the mounted
 *  persist effect never re-runs — leaving localStorage stale for the next mount to read back.
 *  Why a store rather than `persist.ts`'s `_assetViewSetters` registry, and which other panel
 *  state is safe without this: docs/editor.md § "Undoable panel state cannot live in useState".
 *
 *  Kept framework-light on purpose: plain functions + a listener set (unit-testable with no
 *  renderer), and React sees it only through the `use*` hooks below. */

import { useSyncExternalStore } from 'react';
import { ASSETS_SECTION, type ViewMode } from './assetListing';
import { clearUnscopedLegacyKey, projectScopedKey } from '../projectScopedKey';

const LS_EXPANDED = 'editor:assets:expanded:v2';
const LS_PENDING_FOLDERS = 'editor:assets:pendingFolders';
const LS_TYPE_FILTER = 'editor:assets:typeFilter';
const LS_VIEW_MODE = 'editor:assets:viewMode';
const LS_CURRENT_FOLDER = 'editor:assets:currentFolder';

/** The keys whose values are PATHS INTO THE PROJECT, and so must be per-project (#473) — as
 *  opposed to `typeFilter`/`viewMode`, which are preferences that mean the same thing everywhere
 *  and stay global deliberately.
 *
 *  `pendingFolders` is the one with teeth. It holds folders created but not yet backed by any
 *  asset, and the reconcile in `Assets.tsx` prunes only entries the scan COVERS — so a folder
 *  from another project is never pruned, shows up as a phantom node in this project's tree, and
 *  the moment the human clicks it and imports, `/api/write-file` creates it for real. Scoping
 *  `currentFolder` alone does not stop that: the phantom node is what gets clicked. */
const PROJECT_SCOPED_KEYS = [LS_EXPANDED, LS_PENDING_FOLDERS, LS_CURRENT_FOLDER] as const;

function loadStringSet(key: string, fallback: () => Set<string>): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : fallback();
  } catch { return fallback(); }
}

function loadViewMode(): ViewMode {
  try { return localStorage.getItem(LS_VIEW_MODE) === 'folder' ? 'folder' : 'category'; }
  catch { return 'category'; }
}

function save(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota — the in-memory value still stands */ }
}

// The `v2` key bump seeds the top-level "Assets" section header open by default over any
// older saved set (it did not exist in v1), so an empty/absent value is NOT an empty set.
let expanded = new Set<string>([ASSETS_SECTION]);
let pendingFolders = new Set<string>();
let typeFilter = new Set<string>();
let viewMode: ViewMode = 'category';
let currentFolder: string | null = null;

/** ⚠️ Loaded on FIRST USE, never at module evaluation. The scoped keys need
 *  `setEditorProjectScope` to have run, and module-eval order against `createEditor` is not
 *  something this module may rely on — `projectScopedKey`'s header says why, and today's
 *  ordering only happens to work because `EditorApp` is a lazy import. Deferring to first use
 *  removes the dependency instead of resting on it. */
let loaded = false;
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  // A pre-#473 unscoped value belongs to whichever project wrote it last and cannot be
  // attributed now, so it is dropped rather than migrated into one project's namespace.
  for (const base of PROJECT_SCOPED_KEYS) clearUnscopedLegacyKey(base);
  expanded = loadStringSet(projectScopedKey(LS_EXPANDED), () => new Set([ASSETS_SECTION]));
  pendingFolders = loadStringSet(projectScopedKey(LS_PENDING_FOLDERS), () => new Set());
  typeFilter = loadStringSet(LS_TYPE_FILTER, () => new Set());
  viewMode = loadViewMode();
  try { currentFolder = localStorage.getItem(projectScopedKey(LS_CURRENT_FOLDER)); } catch { currentFolder = null; }
}

const listeners = new Set<() => void>();
function emit(): void { for (const l of listeners) l(); }
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

export const getExpanded = (): Set<string> => { ensureLoaded(); return expanded; };
export const getPendingFolders = (): Set<string> => { ensureLoaded(); return pendingFolders; };
export const getTypeFilter = (): Set<string> => { ensureLoaded(); return typeFilter; };
export const getViewMode = (): ViewMode => { ensureLoaded(); return viewMode; };

/** The folder the human is looking at — the default target for Import / paste / New Folder.
 *  Per-project: `defaultTargetFolder` returns it verbatim when it matches `ASSET_ROOT_RE`, and
 *  that regex tests a path's SHAPE, not its existence, so an unscoped value made one project's
 *  folder the write target in the next one. */
export const getCurrentFolder = (): string | null => { ensureLoaded(); return currentFolder; };

export function setCurrentFolder(path: string | null): void {
  ensureLoaded();
  if (path === currentFolder) return;
  currentFolder = path;
  const key = projectScopedKey(LS_CURRENT_FOLDER);
  try {
    if (path) localStorage.setItem(key, path);
    else localStorage.removeItem(key);
  } catch { /* private mode / quota — the in-memory value still stands */ }
  emit();
}

/** Apply `updater` and persist. The updater must RETURN A NEW SET rather than mutate the one
 *  it is handed — `useSyncExternalStore` compares snapshots by identity, so a mutated-in-place
 *  set would persist correctly and never re-render. Every caller already uses the
 *  `(prev) => new Set(prev)` shape the old `useState` setters required. */
function setSet(
  current: Set<string>, updater: (prev: Set<string>) => Set<string>,
  assign: (next: Set<string>) => void, key: string,
): void {
  const next = updater(current);
  if (next === current) return;   // no-op update: don't persist, don't wake subscribers
  assign(next);
  save(key, [...next]);
  emit();
}

export function setExpanded(updater: (prev: Set<string>) => Set<string>): void {
  ensureLoaded();
  setSet(expanded, updater, (n) => { expanded = n; }, projectScopedKey(LS_EXPANDED));
}
export function setPendingFolders(updater: (prev: Set<string>) => Set<string>): void {
  ensureLoaded();
  setSet(pendingFolders, updater, (n) => { pendingFolders = n; }, projectScopedKey(LS_PENDING_FOLDERS));
}
export function setTypeFilter(updater: (prev: Set<string>) => Set<string>): void {
  ensureLoaded();
  setSet(typeFilter, updater, (n) => { typeFilter = n; }, LS_TYPE_FILTER);
}

export function setViewMode(mode: ViewMode): void {
  ensureLoaded();
  if (mode === viewMode) return;
  viewMode = mode;
  try { localStorage.setItem(LS_VIEW_MODE, mode); } catch { /* ignore */ }
  emit();
}

// No `useCurrentFolder` hook: the panel reads it imperatively inside `defaultTargetFolder`, so a
// subscription would buy a re-render nothing renders from. Add one when something displays it.
export const useExpanded = (): Set<string> => useSyncExternalStore(subscribe, getExpanded, getExpanded);
export const usePendingFolders = (): Set<string> => useSyncExternalStore(subscribe, getPendingFolders, getPendingFolders);
export const useTypeFilter = (): Set<string> => useSyncExternalStore(subscribe, getTypeFilter, getTypeFilter);
export const useViewMode = (): ViewMode => useSyncExternalStore(subscribe, getViewMode, getViewMode);

/** Reset to the persisted-default state. FOR TESTS ONLY — module state outlives a single
 *  test otherwise, and a leaked `expanded` entry makes the next test pass for the wrong
 *  reason. Re-reads localStorage so a test can seed it and then load. */
export function __resetAssetFolderStateForTest(): void {
  loaded = false;   // re-arm the lazy load so a test can seed localStorage and then read
  ensureLoaded();
  listeners.clear();
}
