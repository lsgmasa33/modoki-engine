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

const LS_EXPANDED = 'editor:assets:expanded:v2';
const LS_PENDING_FOLDERS = 'editor:assets:pendingFolders';
const LS_TYPE_FILTER = 'editor:assets:typeFilter';
const LS_VIEW_MODE = 'editor:assets:viewMode';

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
let expanded = loadStringSet(LS_EXPANDED, () => new Set([ASSETS_SECTION]));
let pendingFolders = loadStringSet(LS_PENDING_FOLDERS, () => new Set());
let typeFilter = loadStringSet(LS_TYPE_FILTER, () => new Set());
let viewMode = loadViewMode();

const listeners = new Set<() => void>();
function emit(): void { for (const l of listeners) l(); }
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

export const getExpanded = (): Set<string> => expanded;
export const getPendingFolders = (): Set<string> => pendingFolders;
export const getTypeFilter = (): Set<string> => typeFilter;
export const getViewMode = (): ViewMode => viewMode;

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
  setSet(expanded, updater, (n) => { expanded = n; }, LS_EXPANDED);
}
export function setPendingFolders(updater: (prev: Set<string>) => Set<string>): void {
  setSet(pendingFolders, updater, (n) => { pendingFolders = n; }, LS_PENDING_FOLDERS);
}
export function setTypeFilter(updater: (prev: Set<string>) => Set<string>): void {
  setSet(typeFilter, updater, (n) => { typeFilter = n; }, LS_TYPE_FILTER);
}

export function setViewMode(mode: ViewMode): void {
  if (mode === viewMode) return;
  viewMode = mode;
  try { localStorage.setItem(LS_VIEW_MODE, mode); } catch { /* ignore */ }
  emit();
}

export const useExpanded = (): Set<string> => useSyncExternalStore(subscribe, getExpanded, getExpanded);
export const usePendingFolders = (): Set<string> => useSyncExternalStore(subscribe, getPendingFolders, getPendingFolders);
export const useTypeFilter = (): Set<string> => useSyncExternalStore(subscribe, getTypeFilter, getTypeFilter);
export const useViewMode = (): ViewMode => useSyncExternalStore(subscribe, getViewMode, getViewMode);

/** Reset to the persisted-default state. FOR TESTS ONLY — module state outlives a single
 *  test otherwise, and a leaked `expanded` entry makes the next test pass for the wrong
 *  reason. Re-reads localStorage so a test can seed it and then load. */
export function __resetAssetFolderStateForTest(): void {
  expanded = loadStringSet(LS_EXPANDED, () => new Set([ASSETS_SECTION]));
  pendingFolders = loadStringSet(LS_PENDING_FOLDERS, () => new Set());
  typeFilter = loadStringSet(LS_TYPE_FILTER, () => new Set());
  viewMode = loadViewMode();
  listeners.clear();
}
