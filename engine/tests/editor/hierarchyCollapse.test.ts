/** Hierarchy collapse persistence + ownership (#839).
 *
 *  The defect these pin: the panel used to record "a swap happened, the collapse set needs
 *  restoring" as an UNKEYED boolean, and consume it from `onStructureDirtyCoalesced` — an
 *  event a world swap does not guarantee will fire. An unconsumed claim then gated
 *  `saveCollapsedGuids` off for the rest of the scene, and the first entity the user created
 *  finally ran the restore and overwrote whatever they had collapsed.
 *
 *  The fix keys the claim on the scene path the set was restored FOR, so the two questions
 *  the panel actually asks — "restore needed?" and "may we save?" — are answered from an
 *  identity rather than from a flag nobody clears. */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  loadCollapsedGuids, saveCollapsedGuids, computeRestoredCollapse, collapsedIdsToGuids,
  needsCollapseRestore, shouldPersistCollapse, ENTITY_COLLAPSE_LS_KEY, type CollapseOwner,
  type CollapseNode,
} from '../../packages/modoki/src/editor/panels/hierarchyCollapse';

const A = 'scenes/Alpha.json';
const B = 'scenes/Beta.json';

/** A tree big enough to clear the small-tree floor: 3 parents, each with two children. */
function bigTree(): CollapseNode[] {
  const out: CollapseNode[] = [];
  for (let p = 1; p <= 3; p++) {
    out.push({ id: p, parentId: 0, guid: `g-parent-${p}` });
    out.push({ id: p * 10, parentId: p, guid: `g-child-${p}-a` });
    out.push({ id: p * 10 + 1, parentId: p, guid: `g-child-${p}-b` });
  }
  return out; // 9 nodes, 3 of them parents
}

// The module under test is a localStorage-backed store. The engine lane's environment does
// not supply one, and a stub that only no-ops (the `dirtyAssets.test.ts` shape) would make
// every round-trip assertion below vacuously pass — so back it with a real in-memory map.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
});
afterAll(() => { vi.unstubAllGlobals(); });

beforeEach(() => { store.clear(); });

describe('collapse persistence round-trip', () => {
  it('a MISSING entry reads as null (never seen), a saved EMPTY array as a real answer', () => {
    expect(loadCollapsedGuids(A)).toBeNull();
    saveCollapsedGuids(A, []);
    expect(loadCollapsedGuids(A)).toEqual([]);   // "seen, and all-expanded" — not "never seen"
  });

  it('keeps scenes apart under the one storage key', () => {
    saveCollapsedGuids(A, ['g-parent-1']);
    saveCollapsedGuids(B, ['g-parent-3']);
    expect(loadCollapsedGuids(A)).toEqual(['g-parent-1']);
    expect(loadCollapsedGuids(B)).toEqual(['g-parent-3']);
    expect(Object.keys(JSON.parse(localStorage.getItem(ENTITY_COLLAPSE_LS_KEY)!))).toEqual([A, B]);
  });

  it('an empty scene path neither reads nor writes', () => {
    saveCollapsedGuids('', ['g-parent-1']);
    expect(localStorage.getItem(ENTITY_COLLAPSE_LS_KEY)).toBeNull();
    expect(loadCollapsedGuids('')).toBeNull();
  });

  it('survives a corrupt entry rather than throwing', () => {
    localStorage.setItem(ENTITY_COLLAPSE_LS_KEY, '{ not json');
    expect(loadCollapsedGuids(A)).toBeNull();
    expect(() => saveCollapsedGuids(A, ['g-parent-1'])).not.toThrow();
    expect(loadCollapsedGuids(A)).toEqual(['g-parent-1']);
  });
});

describe('computeRestoredCollapse', () => {
  it('a small tree is always fully expanded', () => {
    const flat: CollapseNode[] = [
      { id: 1, parentId: 0, guid: 'g1' }, { id: 2, parentId: 1, guid: 'g2' },
    ];
    expect(computeRestoredCollapse(flat, ['g1'])).toEqual(new Set());
  });

  it('a never-seen scene collapses every parent, and only parents', () => {
    const got = computeRestoredCollapse(bigTree(), null);
    expect([...got].sort((a, b) => a - b)).toEqual([1, 2, 3]);   // leaves are never included
  });

  it('a seen scene restores exactly the saved guids, mapped to CURRENT ids', () => {
    // Same scene, ids reassigned by a reload: guid g-parent-2 is now id 2 (was anything).
    const got = computeRestoredCollapse(bigTree(), ['g-parent-2']);
    expect([...got]).toEqual([2]);
  });

  it('drops a saved guid that no longer exists, and an entity that has no guid', () => {
    const flat = bigTree().concat([{ id: 99, parentId: 0 }, { id: 991, parentId: 99 }]);
    const got = computeRestoredCollapse(flat, ['g-parent-1', 'g-deleted-entity']);
    expect([...got]).toEqual([1]);   // not 99 (no guid), not the vanished guid
  });

  it('round-trips through collapsedIdsToGuids', () => {
    const flat = bigTree();
    const restored = computeRestoredCollapse(flat, ['g-parent-1', 'g-parent-3']);
    expect(collapsedIdsToGuids(flat, restored).sort()).toEqual(['g-parent-1', 'g-parent-3']);
  });

  it('collapsedIdsToGuids drops ids with no guid — a guid is what survives reassignment', () => {
    const flat: CollapseNode[] = [{ id: 1, parentId: 0, guid: 'g1' }, { id: 2, parentId: 0 }];
    expect(collapsedIdsToGuids(flat, new Set([1, 2]))).toEqual(['g1']);
  });
});

describe('ownership — the #839 mechanism', () => {
  // Stand-in world identities; the module only ever compares by reference.
  const W1 = { world: 1 };
  const W2 = { world: 2 };
  const own = (w: object, path: string): CollapseOwner => ({ world: w, path });

  it('needs a restore at mount, and again after each world swap', () => {
    expect(needsCollapseRestore(null, W1, A)).toBe(true);
    expect(needsCollapseRestore(own(W1, A), W1, A)).toBe(false);
    expect(needsCollapseRestore(own(W1, A), W2, A)).toBe(true);
  });

  it('a swap to the SAME scene still needs a restore — the world is new, so the ids are', () => {
    // Play→Stop and a plain reload keep the path and hand out fresh entity ids. A path-keyed
    // claim would see no change and skip the restore, leaving stale ids on screen.
    expect(needsCollapseRestore(own(W1, A), W2, A)).toBe(true);
  });

  it('REGRESSION (Save As): a path change with NO swap must NOT demand a restore', () => {
    // `saveScene()` re-points the path with no world swap and no structural change
    // (editor/scene/serialize.ts, both branches). Keyed on the PATH this read as "needs
    // restore", and the next structural change re-restored from a never-seen entry — i.e.
    // collapse-all — wiping the arrangement the user had just saved and persisting THAT.
    // The ids did not move; only the file name did.
    expect(needsCollapseRestore(own(W1, A), W1, B)).toBe(false);
    expect(shouldPersistCollapse(own(W1, A), W1, B)).toBe(true);   // …and it saves, under B
  });

  it('REGRESSION (newScene): losing the scene path DOES demand a restore', () => {
    // `newScene()` deletes and respawns into the SAME world and clears the editor path, so the
    // world test alone says "nothing to do" — and koota recycles ids, so the outgoing scene's
    // collapsed ids land on the new scene's entities and render collapsed with no user action.
    // Keying on the world alone regressed exactly this; the empty-path clause restores it.
    expect(needsCollapseRestore(own(W1, A), W1, '')).toBe(true);
    // …but arriving at an empty path from an empty path is not a change.
    expect(needsCollapseRestore(own(W1, ''), W1, '')).toBe(false);
  });

  it('prefab-edit exit is answered by the WORLD clause, not by an empty-path one', () => {
    // `exitPrefabEditing()` awaits `loadScene(target)`, which swaps the world while the editor
    // path is still null from prefab-edit ENTRY and writes the real path only in its own tail.
    // The panel does not restore while `aSceneSwapIsHappening()`, so by the time it asks, the
    // path is real and the world has changed — this clause:
    expect(needsCollapseRestore(own(W1, ''), W2, A)).toBe(true);
    // ⚠️ And the mirror must NOT fire: same world, '' → a real path is "untitled world, then
    // Save As". Restoring there would load the target path's entry (collapse-all, for a file
    // never seen) over the arrangement the user is saving.
    expect(needsCollapseRestore(own(W1, ''), W1, A)).toBe(false);
  });

  it('will not save a set that belongs to a DEAD world', () => {
    expect(shouldPersistCollapse(own(W1, A), W2, A)).toBe(false);
  });

  it('will not save before any restore has happened', () => {
    expect(shouldPersistCollapse(null, W1, A)).toBe(false);
  });

  it('saves once the set has been restored for the live world', () => {
    expect(shouldPersistCollapse(own(W1, A), W1, A)).toBe(true);
  });

  it('never saves when there is no scene path, even for the live world', () => {
    // newScene() and prefab-edit mode: a live owner, but nowhere to write.
    expect(shouldPersistCollapse(own(W1, ''), W1, '')).toBe(false);
  });

  it('REGRESSION: an unconsumed claim costs one skipped save, not a dead gate', () => {
    // The original shape was a boolean cleared only by restoreCollapse. Model both: a claim
    // nothing consumes leaves the boolean stuck true forever, so `save` is unreachable for every
    // later toggle. An identity answers from the LIVE world instead, so the moment a restore runs
    // the gate opens — there is no flag to clear, and nothing can forget to clear it.
    let owner: CollapseOwner = null;                       // swapped; nothing consumed the claim
    expect(shouldPersistCollapse(owner, W2, A)).toBe(false);
    expect(needsCollapseRestore(owner, W2, A)).toBe(true);  // and it still ASKS to be restored

    owner = own(W2, A);                                     // the settled refresh finally lands
    expect(shouldPersistCollapse(owner, W2, A)).toBe(true);
    expect(needsCollapseRestore(owner, W2, A)).toBe(false);
  });
});
