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

// The undo builder posts to /api/move-file via the editor backendFetch → global fetch.
let moveOk = true;
const mockFetch = vi.fn(async () => ({ ok: moveOk, status: moveOk ? 200 : 500, json: async () => ({}) } as any));
vi.stubGlobal('fetch', mockFetch);

import {
  getExpanded, getPendingFolders, getTypeFilter, getViewMode,
  setExpanded, setPendingFolders, setTypeFilter, setViewMode,
  __resetAssetFolderStateForTest,
} from '../../src/editor/panels/assetFolderState';
import { makeFolderRenameUndo, makeNewFolderUndo } from '../../src/editor/panels/assetUndo';
import { ASSETS_SECTION } from '../../src/editor/panels/assetListing';

const LS_EXPANDED = 'editor:assets:expanded:v2';
const LS_PENDING_FOLDERS = 'editor:assets:pendingFolders';

const readLS = (key: string): string[] => JSON.parse(localStorage.getItem(key) ?? '[]');

beforeEach(() => {
  localStorage.clear();
  moveOk = true;
  mockFetch.mockClear();
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
    localStorage.setItem(LS_EXPANDED, JSON.stringify(['/a', '/b']));
    localStorage.setItem('editor:assets:viewMode', 'folder');
    __resetAssetFolderStateForTest();
    expect([...getExpanded()]).toEqual(['/a', '/b']);
    expect(getViewMode()).toBe('folder');
  });

  it('degrades to the default on a corrupt persisted value rather than throwing', () => {
    localStorage.setItem(LS_EXPANDED, '{not json');
    localStorage.setItem(LS_PENDING_FOLDERS, JSON.stringify({ not: 'an array' }));
    __resetAssetFolderStateForTest();
    expect(getExpanded().has(ASSETS_SECTION)).toBe(true);
    expect(getPendingFolders().size).toBe(0);
  });
});

describe('mutation persists immediately — no mounted effect involved (#309)', () => {
  it('setExpanded updates the value AND localStorage in one call', () => {
    setExpanded((p) => new Set(p).add('/models'));
    expect(getExpanded().has('/models')).toBe(true);
    expect(readLS(LS_EXPANDED)).toContain('/models');
  });

  it('setPendingFolders updates the value AND localStorage in one call', () => {
    setPendingFolders((p) => new Set(p).add('/new'));
    expect([...getPendingFolders()]).toEqual(['/new']);
    expect(readLS(LS_PENDING_FOLDERS)).toEqual(['/new']);
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

describe('the #309 scenario, driven through the real undo builder', () => {
  // The panel is not mounted anywhere in this file — which is exactly the condition under
  // which the old captured setters no-opped. Passing the store's module functions is what
  // makes the same call land.
  const renameUndo = () => makeFolderRenameUndo({
    oldPath: '/A', newPath: '/B', folderName: 'A',
    refresh: () => {},
    setPendingFolders, setExpanded,
  });

  it('undo remaps the expanded set back to the old path and persists it', async () => {
    setExpanded((p) => new Set(p).add('/B'));
    setPendingFolders((p) => new Set(p).add('/B'));

    await renameUndo().undo();

    expect(getExpanded().has('/A')).toBe(true);
    expect(getExpanded().has('/B')).toBe(false);
    expect(getPendingFolders().has('/A')).toBe(true);
    // The persisted value follows — the half that used to go stale and be read back at
    // the next mount as a phantom node.
    expect(readLS(LS_EXPANDED)).toContain('/A');
    expect(readLS(LS_EXPANDED)).not.toContain('/B');
    expect(readLS(LS_PENDING_FOLDERS)).toEqual(['/A']);
  });

  it('redo remaps forward again and persists', async () => {
    setExpanded((p) => new Set(p).add('/B'));
    const action = renameUndo();
    await action.undo();
    await action.redo();

    expect(getExpanded().has('/B')).toBe(true);
    expect(getExpanded().has('/A')).toBe(false);
    expect(readLS(LS_EXPANDED)).toContain('/B');
  });

  it('a FAILED move leaves both the set and localStorage untouched', async () => {
    setExpanded((p) => new Set(p).add('/B'));
    moveOk = false;   // /api/move-file rejects

    await renameUndo().undo();

    // #308's bar: the client tree must not remap when the folder did not move.
    expect(getExpanded().has('/B')).toBe(true);
    expect(getExpanded().has('/A')).toBe(false);
    expect(readLS(LS_EXPANDED)).toContain('/B');
  });

  // #309, second half: undoing a CREATE is a folder delete, so it must clear the folder out of
  // BOTH sets. It used to prune only `pendingFolders`, leaving an `expanded` key — put there by
  // a later rename's `.add(newPath)` — for a folder that no longer exists, persisted forever.
  it('makeNewFolderUndo drops the folder from BOTH sets and persists both', async () => {
    setPendingFolders((p) => new Set(p).add('/fresh'));
    setExpanded((p) => new Set(p).add('/fresh').add('/fresh-sibling'));

    await makeNewFolderUndo({ path: '/fresh', refresh: () => {}, setPendingFolders, setExpanded }).undo();

    expect(getPendingFolders().has('/fresh')).toBe(false);
    expect(readLS(LS_PENDING_FOLDERS)).toEqual([]);
    expect(getExpanded().has('/fresh')).toBe(false);
    expect(readLS(LS_EXPANDED)).not.toContain('/fresh');
    // A sibling sharing the prefix is NOT swept up with it.
    expect(getExpanded().has('/fresh-sibling')).toBe(true);
    expect(readLS(LS_EXPANDED)).toContain('/fresh-sibling');
  });
});
