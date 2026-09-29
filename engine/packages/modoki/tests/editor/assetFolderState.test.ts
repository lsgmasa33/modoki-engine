// @vitest-environment jsdom
/** assetFolderState — the Assets panel's folder-tree view state, moved OUT of the panel's
 *  `useState` into a module-level store (#309).
 *
 *  THE BUG THIS PINS. The panel's undo builders capture `setExpanded`/`setPendingFolders` in
 *  closures that outlive the render. Rename folder `/A` → `/B` while `/A` is expanded, close
 *  the Assets panel, then undo: the setters were bound to an unmounted fiber and silently
 *  no-opped with no warning, the mounted persist effect never re-ran, and localStorage kept the
 *  `/B`-prefixed value for the next mount to read back. So the assertions below deliberately
 *  drive the store and the real undo builder with NO component mounted anywhere: that IS the
 *  failure condition, and it is why these tests need no renderer.
 *
 *  The store is plain functions + a listener set, so React appears only via the `use*` hooks
 *  (not exercised here — a hook test would assert `useSyncExternalStore`, not this module). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// This jsdom env doesn't provide localStorage (same gap layoutStore.test.ts works around).
// It must exist BEFORE the store module is imported: the store reads its initial values at
// module load, so an import-first order would test the empty-fallback path forever.
function installLocalStorage() {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}
installLocalStorage();

import {
  getExpanded, getPendingFolders, getTypeFilter, getViewMode,
  setExpanded, setPendingFolders, setTypeFilter, setViewMode,
  getCurrentFolder, setCurrentFolder,
  __resetAssetFolderStateForTest,
} from '../../src/editor/panels/assetFolderState';
import { ASSETS_SECTION } from '../../src/editor/panels/assetListing';
import { setEditorProjectScope, projectScopedKey } from '../../src/editor/projectScopedKey';

// These three hold PATHS, so they are per-project (#473) — the literal key is never what the
// module reads. `typeFilter`/`viewMode` are preferences and stay global.
const LS_EXPANDED = () => projectScopedKey('editor:assets:expanded:v2');
const LS_PENDING_FOLDERS = () => projectScopedKey('editor:assets:pendingFolders');
const LS_CURRENT_FOLDER = () => projectScopedKey('editor:assets:currentFolder');

const readLS = (key: string): string[] => JSON.parse(localStorage.getItem(key) ?? '[]');

beforeEach(() => {
  localStorage.clear();
  setEditorProjectScope('Skin Test');
  __resetAssetFolderStateForTest();
});
afterEach(() => { localStorage.clear(); });

describe('defaults', () => {
  it('seeds the Assets section open when nothing is persisted (the v2 key bump)', () => {
    expect(getExpanded().has(ASSETS_SECTION)).toBe(true);
    expect(getPendingFolders().size).toBe(0);
    expect(getTypeFilter().size).toBe(0);
    expect(getViewMode()).toBe('category');
  });

  it('reads persisted values back at load', () => {
    localStorage.setItem(LS_EXPANDED(), JSON.stringify(['/a', '/b']));
    localStorage.setItem('editor:assets:viewMode', 'folder');
    __resetAssetFolderStateForTest();
    expect([...getExpanded()]).toEqual(['/a', '/b']);
    expect(getViewMode()).toBe('folder');
  });

  it('degrades to the default on a corrupt persisted value rather than throwing', () => {
    localStorage.setItem(LS_EXPANDED(), '{not json');
    localStorage.setItem(LS_PENDING_FOLDERS(), JSON.stringify({ not: 'an array' }));
    __resetAssetFolderStateForTest();
    expect(getExpanded().has(ASSETS_SECTION)).toBe(true);
    expect(getPendingFolders().size).toBe(0);
  });
});

// #473. One clone serves every project from the same origin and asset URLs carry no project
// segment, so an unscoped path key makes one project's folders appear in the next one. For
// `pendingFolders` that is not cosmetic: the Assets reconcile prunes only entries the scan
// COVERS, so a foreign folder is never pruned, shows as a phantom node, and the first import
// into it has `/api/write-file` create it for real.
describe('path state is per-project (#473)', () => {
  it('does not leak pendingFolders / expanded / currentFolder into another project', () => {
    setPendingFolders((p) => new Set(p).add('/assets/wip'));
    setExpanded((p) => new Set(p).add('/assets/wip'));
    setCurrentFolder('/assets/rigs');

    setEditorProjectScope('3D Test');
    __resetAssetFolderStateForTest();

    expect(getPendingFolders().size).toBe(0);
    expect(getExpanded().has('/assets/wip')).toBe(false);
    expect(getCurrentFolder()).toBeNull();
  });

  it('gives each project its folders back on return', () => {
    setPendingFolders((p) => new Set(p).add('/assets/wip'));
    setCurrentFolder('/assets/rigs');

    setEditorProjectScope('3D Test');
    __resetAssetFolderStateForTest();
    setCurrentFolder('/assets/models');       // 3D Test browses somewhere of its own

    setEditorProjectScope('Skin Test');
    __resetAssetFolderStateForTest();
    expect([...getPendingFolders()]).toEqual(['/assets/wip']);
    expect(getCurrentFolder()).toBe('/assets/rigs');
  });

  it('keeps typeFilter and viewMode GLOBAL — they are preferences, not paths', () => {
    setTypeFilter(() => new Set(['mesh']));
    setViewMode('folder');

    setEditorProjectScope('3D Test');
    __resetAssetFolderStateForTest();

    expect([...getTypeFilter()]).toEqual(['mesh']);
    expect(getViewMode()).toBe('folder');
  });

  it('drops a pre-#473 unscoped value rather than adopting it into one project', () => {
    localStorage.setItem('editor:assets:pendingFolders', JSON.stringify(['/assets/stale']));
    localStorage.setItem('editor:assets:currentFolder', '/assets/stale');
    __resetAssetFolderStateForTest();

    expect(getPendingFolders().size).toBe(0);
    expect(getCurrentFolder()).toBeNull();
    expect(localStorage.getItem('editor:assets:pendingFolders')).toBeNull();
    expect(localStorage.getItem('editor:assets:currentFolder')).toBeNull();
  });

  it('persists currentFolder under the scoped key, and clears it on null', () => {
    setCurrentFolder('/assets/rigs');
    expect(localStorage.getItem(LS_CURRENT_FOLDER())).toBe('/assets/rigs');
    setCurrentFolder(null);
    expect(localStorage.getItem(LS_CURRENT_FOLDER())).toBeNull();
    expect(getCurrentFolder()).toBeNull();
  });
});

describe('mutation persists immediately — no mounted effect involved (#309)', () => {
  it('setExpanded updates the value AND localStorage in one call', () => {
    setExpanded((p) => new Set(p).add('/models'));
    expect(getExpanded().has('/models')).toBe(true);
    expect(readLS(LS_EXPANDED())).toContain('/models');
  });

  it('setPendingFolders updates the value AND localStorage in one call', () => {
    setPendingFolders((p) => new Set(p).add('/new'));
    expect([...getPendingFolders()]).toEqual(['/new']);
    expect(readLS(LS_PENDING_FOLDERS())).toEqual(['/new']);
  });

  it('setTypeFilter and setViewMode persist too', () => {
    setTypeFilter(() => new Set(['mesh']));
    setViewMode('folder');
    expect([...getTypeFilter()]).toEqual(['mesh']);
    expect(localStorage.getItem('editor:assets:viewMode')).toBe('folder');
  });

  it('keeps the in-memory value when localStorage throws (private mode / quota)', () => {
    const spy = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
    expect(() => setExpanded((p) => new Set(p).add('/x'))).not.toThrow();
    expect(getExpanded().has('/x')).toBe(true);   // the store still holds it
    spy.mockRestore();
  });
});

describe('snapshot identity — useSyncExternalStore compares by reference', () => {
  it('an updater returning the SAME set is a no-op: identity held, nothing written', () => {
    setExpanded((p) => new Set(p).add('/a'));
    const before = getExpanded();
    const writes = vi.spyOn(globalThis.localStorage, 'setItem');

    setExpanded((p) => p);                        // updater declines to change anything

    expect(getExpanded()).toBe(before);           // identity preserved → no spurious re-render
    expect(writes).not.toHaveBeenCalled();        // and no redundant persist
    writes.mockRestore();
  });

  it('every mutation yields a NEW set object, so a subscriber can diff by identity', () => {
    const first = getExpanded();
    setExpanded((p) => new Set(p).add('/a'));
    expect(getExpanded()).not.toBe(first);
  });
});
