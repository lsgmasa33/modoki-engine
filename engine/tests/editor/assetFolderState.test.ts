/** `remapCurrentFolder` — the Assets panel remembers a "current folder"
 *  (`currentFolder`), and nothing repaired it when that folder was renamed or deleted. A stale
 *  value survives because `defaultTargetFolder` only checks the path's SHAPE
 *  (`ASSET_ROOT_RE`), not whether it still exists, so the next import/create writes through
 *  `/api/write-file`'s `mkdirSync(recursive: true)` and RESURRECTS the folder the human just
 *  renamed or deleted away from. This is the same mechanism as #186/#854 — state keyed by an
 *  asset PATH must follow that path when the file moves. */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import {
  getCurrentFolder, setCurrentFolder, remapCurrentFolder, __resetAssetFolderStateForTest,
  __subscribeAssetFolderStateForTest,
  getExpanded, setExpanded, getPendingFolders, setPendingFolders, remapFolderSets,
} from '../../packages/modoki/src/editor/panels/assetFolderState';
import { projectScopedKey } from '../../packages/modoki/src/editor/projectScopedKey';
import { applyAssetPathMoves } from '../../packages/modoki/src/editor/panels/assetEditorBindings';

// The module under test is a localStorage-backed store. The engine lane's environment does
// not supply one, and a stub that only no-ops would make round-trip assertions vacuously
// pass — so back it with a real in-memory map (same shape as `hierarchyCollapse.test.ts`).
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
});
afterAll(() => { vi.unstubAllGlobals(); });

beforeEach(() => {
  store.clear();
  __resetAssetFolderStateForTest();
});

describe('remapCurrentFolder', () => {
  it('repoints currentFolder when it IS the renamed folder', () => {
    setCurrentFolder('/assets/anim');
    expect(getCurrentFolder()).toBe('/assets/anim'); // positive control

    remapCurrentFolder('/assets/anim', '/assets/clips');
    expect(getCurrentFolder()).toBe('/assets/clips');
  });

  it('repoints currentFolder when NESTED under the renamed folder, keeping the tail', () => {
    setCurrentFolder('/assets/anim/walk');
    expect(getCurrentFolder()).toBe('/assets/anim/walk'); // positive control

    remapCurrentFolder('/assets/anim', '/assets/clips');
    expect(getCurrentFolder()).toBe('/assets/clips/walk');
  });

  it('does NOT touch a sibling that merely shares a name prefix', () => {
    setCurrentFolder('/assets/animations/x');
    expect(getCurrentFolder()).toBe('/assets/animations/x'); // positive control

    remapCurrentFolder('/assets/anim', '/assets/clips');
    expect(getCurrentFolder()).toBe('/assets/animations/x'); // unchanged
  });

  it('clears currentFolder to null on a delete (to: null) when it was inside the deleted folder', () => {
    setCurrentFolder('/assets/anim/walk');
    expect(getCurrentFolder()).toBe('/assets/anim/walk'); // positive control

    remapCurrentFolder('/assets/anim', null);
    expect(getCurrentFolder()).toBeNull();
  });

  it('leaves currentFolder alone for an unrelated folder rename', () => {
    setCurrentFolder('/assets/textures');
    expect(getCurrentFolder()).toBe('/assets/textures'); // positive control

    remapCurrentFolder('/assets/anim', '/assets/clips');
    expect(getCurrentFolder()).toBe('/assets/textures');
  });

  // The five tests above all read back through `getCurrentFolder()`, which reads the same
  // module variable `setCurrentFolder` writes directly — so they would still pass if
  // `remapCurrentFolder` bypassed `setCurrentFolder` entirely and assigned the module
  // variable itself. Persistence and listener notification are the whole reason it routes
  // through `setCurrentFolder` instead, and neither was pinned. These four close that.

  it('PERSISTS the remapped value under the project-scoped key — not just the in-memory var', () => {
    const key = projectScopedKey('editor:assets:currentFolder');
    setCurrentFolder('/assets/anim');
    expect(store.get(key)).toBe('/assets/anim'); // positive control: setCurrentFolder itself persists

    remapCurrentFolder('/assets/anim', '/assets/clips');
    expect(store.get(key)).toBe('/assets/clips');
  });

  it('NOTIFIES subscribers on a remap that changes the value', () => {
    setCurrentFolder('/assets/anim');
    const onChange = vi.fn();
    const unsubscribe = __subscribeAssetFolderStateForTest(onChange);
    try {
      remapCurrentFolder('/assets/anim', '/assets/clips');
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('does NOT notify when the remap is a no-op (nothing touched)', () => {
    setCurrentFolder('/assets/textures');
    const onChange = vi.fn();
    const unsubscribe = __subscribeAssetFolderStateForTest(onChange);
    try {
      remapCurrentFolder('/assets/anim', '/assets/clips');
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('the DELETE path (to: null) also PERSISTS — removeItem, not just nulling the variable', () => {
    const key = projectScopedKey('editor:assets:currentFolder');
    setCurrentFolder('/assets/anim/walk');
    expect(store.has(key), 'positive control').toBe(true);

    remapCurrentFolder('/assets/anim', null);
    expect(getCurrentFolder()).toBeNull();
    expect(store.has(key)).toBe(false); // removeItem ran — a leftover string here would resurrect on reload
  });
});

/** The regression itself (#854's own fix, on the branch that added it): the two Assets.tsx call
 *  sites reached `remapCurrentFolder` directly, so `makeFolderRenameUndo`'s undo/redo — which
 *  moves the folder back on disk via `applyAssetPathMoves`, not via those call sites — never
 *  repaired `currentFolder`. Driven through the SEAM (`applyAssetPathMoves`), not the leaf
 *  function, because that is the entry point undo/redo actually uses and the one a per-site
 *  fix cannot reach. */
describe('applyAssetPathMoves repairs currentFolder (the undo/redo path #854 missed)', () => {
  afterEach(() => __resetAssetFolderStateForTest());

  it('follows a folder rename applied through the seam', () => {
    setCurrentFolder('/assets/anim');
    expect(getCurrentFolder()).toBe('/assets/anim'); // positive control

    applyAssetPathMoves([{ from: '/assets/anim', to: '/assets/clips', prefix: true }]);
    expect(getCurrentFolder()).toBe('/assets/clips');

    // …and the REVERSE move, exactly as `makeFolderRenameUndo.undo` issues it — this is the
    // move #854's per-call-site fix never reached, because undo does not go through
    // Assets.tsx's rename/delete handlers at all.
    applyAssetPathMoves([{ from: '/assets/clips', to: '/assets/anim', prefix: true }]);
    expect(getCurrentFolder()).toBe('/assets/anim');
  });
});

/** `remapFolderSets` — `expanded` and `pendingFolders` are keyed by folder path too, and were
 *  remapped by hand at three of the thirteen seam call sites (#867 review). A folder move left
 *  every entry under it stranded: a tree that reopens collapsed, and a `pendingFolders` entry
 *  naming a folder that no longer exists — which `defaultTargetFolder` will happily hand out,
 *  resurrecting it on the next create. Same mechanism as `remapCurrentFolder` above, one level up. */
describe('remapFolderSets', () => {
  it('repoints the moved folder AND everything under it', () => {
    setExpanded(() => new Set(['/assets/anim', '/assets/anim/sub', '/assets/other']));
    remapFolderSets([{ from: '/assets/anim', to: '/assets/archive/anim' }]);
    expect([...getExpanded()].sort()).toEqual(
      ['/assets/archive/anim', '/assets/archive/anim/sub', '/assets/other'],
    );
  });

  it('drops the subtree on a DELETE rather than repointing it', () => {
    setPendingFolders(() => new Set(['/assets/anim', '/assets/anim/sub', '/assets/keep']));
    remapFolderSets([{ from: '/assets/anim', to: null }]);
    expect([...getPendingFolders()]).toEqual(['/assets/keep']);
  });

  it('does NOT capture a path-prefix sibling — segment boundary, not startsWith', () => {
    setExpanded(() => new Set(['/assets/animations/x']));
    remapFolderSets([{ from: '/assets/anim', to: '/assets/clips' }]);
    expect([...getExpanded()]).toEqual(['/assets/animations/x']);
  });

  it('preserves set IDENTITY when nothing matched, so no persist and no re-render', () => {
    // `setSet` bails on an identical reference; returning a fresh Set every time would persist
    // to localStorage and wake `useSyncExternalStore` on every single-file rename in the project.
    setExpanded(() => new Set(['/assets/other']));
    const before = getExpanded();
    remapFolderSets([{ from: '/assets/anim/walk.anim.json', to: '/assets/anim/run.anim.json' }]);
    expect(getExpanded()).toBe(before);
  });

  it('runs from applyAssetPathMoves — the SEAM, not the three call sites it replaced', () => {
    setExpanded(() => new Set(['/assets/anim/sub']));
    applyAssetPathMoves([{ from: '/assets/anim', to: '/assets/archive/anim', prefix: true }]);
    expect([...getExpanded()]).toEqual(['/assets/archive/anim/sub']);
  });
});
