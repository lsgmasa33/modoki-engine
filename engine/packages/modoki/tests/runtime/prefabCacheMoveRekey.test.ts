/**
 * #1751 F6: a prefab file MOVED (`/api/move-file`, marked as the editor's own, so the watcher never evicts) keeps its
 * runtime cache entry readable. The cache is keyed by PATH: once the manifest maps the guid to the new path, the old
 * entry was unreachable, a synchronous reader (a `UIEntries` pool) read `undefined` and went blank, and a later write's
 * `replaceCachedPrefab(newPath)` found no owner there and evicted instead of replacing.
 *
 * `rekeyCachedPrefab` MOVES the entry, owners and revision to the new path and re-registers the guid there in the same
 * step. A first version copied and kept the old key; the kept entry then served stale content (the rename-back and swap
 * cases below, both red against it). The scene is the unit of release (CLAUDE.md § Resource Management), so the moved
 * owners must go with their scene: a leak here is silent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearManifest, registerAsset, resolveRef } from '../../src/runtime/loaders/assetManifest';
import {
  acquirePrefab, releaseAllForScene, getResourceStats, getCachedPrefab, getPrefabRevision, replaceCachedPrefab,
  rekeyCachedPrefab, disposeAllCachedResources, invalidatePrefab,
} from '../../src/runtime/loaders/meshTemplateCache';
import { applyAssetPathMoves } from '../../src/editor/panels/assetEditorBindings';
import { setPrefabCache, getCachedPrefabSync, primeEditorPrefabCache } from '../../src/editor/scene/prefabCache';

const GUID = '55555555-2222-4333-8444-000000001751';
const OLD = '/games/g/assets/ui/Row.prefab.json';
const NEW = '/games/g/assets/ui/Entry.prefab.json';
const doc = { version: 8, id: GUID, name: 'Row', rootLocalId: 1, entities: [] };

beforeEach(() => {
  clearManifest();
  registerAsset(GUID, OLD, 'prefab');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('.prefab.json')
    ? { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(doc) }
    : { ok: false, status: 404, statusText: 'Not Found', text: async () => '' }) as unknown as Response));
});

afterEach(() => {
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

/** The manifest learns the move: the guid now names the new path. */
const manifestMoved = () => registerAsset(GUID, NEW, 'prefab');

describe('a moved prefab keeps its runtime cache entry (#1751 F6)', () => {
  // Mutation: make `rekeyCachedPrefab` return 0 without re-keying — the guid misses once the manifest moves. Mutation:
  // drop its `registerAsset` — the guid still names the old path, where nothing is.
  it('reads the entry through the guid right after the move, and after the manifest catches up, with its revision', async () => {
    await acquirePrefab(1, GUID);
    replaceCachedPrefab(GUID, { ...doc, name: 'Row v2' }); // a revision, as an Apply's write leaves one
    const rev = getPrefabRevision(GUID);
    expect(rev).toBeGreaterThan(0);
    expect(rekeyCachedPrefab(OLD, NEW)).toBe(1);
    // No window: the guid names the new path at once, before the renderer's manifest broadcast.
    expect((getCachedPrefab(GUID) as { name: string } | undefined)?.name).toBe('Row v2');
    manifestMoved();
    expect((getCachedPrefab(GUID) as { name: string } | undefined)?.name).toBe('Row v2');
    // A pool's `guid@revision` signature does not change under it: the bytes did not.
    expect(getPrefabRevision(GUID)).toBe(rev);
  });

  // Close-out review (a): with the old key kept, renaming back after an edit read the PRE-edit document from it — and
  // with the revision carried, a pool never noticed. Held by TWO mechanisms (the old key's delete, and the moved entry
  // overwriting the new key), so either alone passes. Mutation: the first version — keep the old key AND skip the
  // overwrite when the new key has an entry.
  it('renaming back after an edit reads the edited document', async () => {
    await acquirePrefab(1, GUID);
    rekeyCachedPrefab(OLD, NEW);
    replaceCachedPrefab(GUID, { ...doc, name: 'edited' });
    rekeyCachedPrefab(NEW, OLD);
    expect((getCachedPrefab(GUID) as { name: string } | undefined)?.name).toBe('edited');
    expect(getResourceStats().prefabs).toEqual({ [OLD]: 1 });
  });

  // Close-out review (b): A→B, then C→A. With A's old entry kept, C read A's document. The same two mechanisms as (a).
  // Mutation: keep the old key AND skip the overwrite.
  it('a swap (A→B, then C→A) reads each prefab\'s own document', async () => {
    const C = '55555555-2222-4333-8444-000000001753';
    const C_PATH = '/games/g/assets/ui/Other.prefab.json';
    registerAsset(C, C_PATH, 'prefab');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify(url.endsWith('Other.prefab.json') ? { ...doc, id: C, name: 'Other' } : doc),
    }) as unknown as Response));
    await acquirePrefab(1, GUID);
    await acquirePrefab(1, C);
    rekeyCachedPrefab(OLD, NEW);
    rekeyCachedPrefab(C_PATH, OLD);
    expect((getCachedPrefab(C) as { name: string } | undefined)?.name).toBe('Other');
    expect((getCachedPrefab(GUID) as { name: string } | undefined)?.name).toBe('Row');
  });

  // The #1308 half: a write after the move REPLACES (it finds the owners at the new path) instead of evicting.
  // Mutation: skip the owner copy — `replaceCachedPrefab` evicts, and the read is undefined.
  it('a write after the move replaces the entry rather than evicting it', async () => {
    await acquirePrefab(1, GUID);
    rekeyCachedPrefab(OLD, NEW);
    manifestMoved();
    replaceCachedPrefab(GUID, { ...doc, name: 'after' });
    expect((getCachedPrefab(GUID) as { name: string } | undefined)?.name).toBe('after');
  });

  // Mutation: move the entry to the new key but not its owners — an ownerless entry no release ever drops.
  it('the owning scene\'s release leaves no entry and no owner under either path', async () => {
    await acquirePrefab(1, GUID);
    rekeyCachedPrefab(OLD, NEW);
    expect(Object.keys(getResourceStats().prefabs)).toEqual([NEW]);
    releaseAllForScene(1);
    expect(getResourceStats().prefabs).toEqual({});
    expect(getCachedPrefab(GUID)).toBeUndefined(); // the new path, which the guid names now
    registerAsset(GUID, OLD, 'prefab');
    expect(getCachedPrefab(GUID)).toBeUndefined(); // …and the old one
  });

  // Mutation: have `rekeyCachedPrefab` SHARE the old key's owner Set with the new key instead of copying it (and keep
  // the old key) — scene 2's acquire then lands in both, and scene 1's release leaves the old key held by a scene that
  // never loaded that path.
  it('a second scene that acquires the moved prefab under the new path survives the first scene\'s release', async () => {
    await acquirePrefab(1, GUID);
    rekeyCachedPrefab(OLD, NEW);
    manifestMoved();
    await acquirePrefab(2, GUID);
    releaseAllForScene(1);
    expect(getResourceStats().prefabs).toEqual({ [NEW]: 1 });
    expect((getCachedPrefab(GUID) as { name: string } | undefined)?.name).toBe('Row');
    releaseAllForScene(2);
    expect(getResourceStats().prefabs).toEqual({});
  });

  // Mutation: drop the `prefix` branch — a folder move re-keys nothing.
  it('a folder move re-keys every prefab under it, and nothing that merely shares the prefix', async () => {
    const SIBLING = '55555555-2222-4333-8444-000000001752';
    registerAsset(SIBLING, '/games/g/assets/ui2/Other.prefab.json', 'prefab');
    await acquirePrefab(1, GUID);
    await acquirePrefab(1, SIBLING);
    expect(rekeyCachedPrefab('/games/g/assets/ui', '/games/g/assets/hud', true)).toBe(1);
    registerAsset(GUID, '/games/g/assets/hud/Row.prefab.json', 'prefab');
    expect(getCachedPrefab(GUID)).toBeDefined();
    expect(Object.keys(getResourceStats().prefabs)).not.toContain('/games/g/assets/hud2/Other.prefab.json');
  });

  // The wiring: every move reaches `applyAssetPathMoves` (the route's renderer repair and the panel's own pass), and it
  // re-keys BOTH caches. Mutation: drop the prefab re-key loop there — the guid misses after the manifest moves.
  it('the move repair re-keys the runtime entry and the editor cache\'s path key', async () => {
    await acquirePrefab(1, GUID);
    setPrefabCache(OLD, doc as never);
    // A document left at the destination by a file deleted earlier (#1738): the moved one must answer there. Mutation:
    // keep an existing entry at the new key in `rekeyEditorPrefabCache`.
    setPrefabCache(NEW, { ...doc, name: 'a deleted file' } as never);
    applyAssetPathMoves([{ from: OLD, to: NEW }]);
    manifestMoved();
    expect(getCachedPrefab(GUID)).toBeDefined();
    expect((getCachedPrefabSync(NEW) as unknown as { name: string } | null)?.name).toBe('Row');
    expect(getCachedPrefabSync(OLD)).toBeNull();
    setPrefabCache(NEW, null as never);
  });

  /** `fetch` held open per path until `release(path)`; every other path answers at once. */
  const holdFetches = (held: string[]) => {
    const gates = new Map(held.map((p) => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return [p, { wait, open }] as const; }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      await gates.get(url)?.wait;
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(doc) } as unknown as Response;
    }));
    return (p: string) => gates.get(p)!.open();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // Close-out re-review: a load of the OLD path still in flight when the file moves. Refused, or its `registerAsset`
  // points the guid back at a path with no file; and with it refused the owners are left with no entry, so the file is
  // fetched where it is now. Mutations: drop the old path's refusal — the guid resolves to OLD; drop the re-fetch — no
  // entry.
  it('a load of the old path in flight at the move: the guid keeps naming the new path, and the entry arrives there', async () => {
    const release = holdFetches([OLD]);
    const loading = acquirePrefab(2, GUID);
    manifestMoved(); // the broadcast reaches the renderer before the repair
    rekeyCachedPrefab(OLD, NEW);
    release(OLD);
    await loading;
    await settle();
    expect(resolveRef(GUID)).toBe(NEW);
    expect((getCachedPrefab(GUID) as { name: string } | undefined)?.name).toBe('Row');
    expect(getResourceStats().prefabs).toEqual({ [NEW]: 1 });
  });

  // Close-out re-review (c): an evicted-but-owned entry at the old path, and a fetch of the NEW path already in flight
  // (another scene acquiring once the manifest moved). That fetch carries the moved file and must be left to land.
  // Held by TWO mechanisms (the new path's fetch is not refused, and owners left with no entry are re-fetched), so either
  // alone passes. Mutation: refuse the new path's fetch AND drop the re-fetch.
  it('a fetch of the new path already in flight is left to land', async () => {
    await acquirePrefab(1, GUID);
    invalidatePrefab(OLD); // a watcher eviction: owners kept, entry gone
    manifestMoved();
    const release = holdFetches([NEW]);
    const loading = acquirePrefab(3, GUID);
    rekeyCachedPrefab(OLD, NEW);
    release(NEW);
    await loading;
    await settle();
    expect((getCachedPrefab(GUID) as { name: string } | undefined)?.name).toBe('Row');
    expect(getResourceStats().prefabs).toEqual({ [NEW]: 2 });
  });
});

describe('a deleted prefab leaves the editor cache (#1805, I9)', () => {
  // An Assets delete is marked as the editor's own, so no watcher evicted: the editor's sync cache kept answering after the
  // trash while a world swap's re-fetch 404'd in the loader's, and an instantiate expanded a prefab that no longer exists
  // (the #1789 fuzzer's seed 199). The delete repair — `applyAssetPathMoves` with `to: null`, which the route's renderer
  // repair, the panel and every undo trash run — now evicts the EDITOR cache, and the LOADER's entry too since #1834
  // (held back until #1819's `require` made an undo against the resulting placeholder refuse), keeping the scene's
  // ownership so an undo that puts the file back refetches it (`restoreReannounce.test.ts`).
  afterEach(() => { for (const k of [GUID, OLD, NEW]) setPrefabCache(k, null as never); });

  // Mutation: drop the eviction from the delete branch of `applyAssetPathMoves` — both editor keys still answer. Mutation:
  // drop `evictDeletedPrefabs` there (#1834) — the loader still serves the deleted prefab.
  it('evicts every editor key — the path, and the guid — and the loader\'s entry, keeping its owner', async () => {
    await acquirePrefab(1, GUID);
    primeEditorPrefabCache(GUID, doc as never);
    primeEditorPrefabCache(OLD, doc as never);
    applyAssetPathMoves([{ from: OLD, to: null }]);
    expect(getCachedPrefabSync(GUID)).toBeNull();
    expect(getCachedPrefabSync(OLD)).toBeNull();
    expect(getCachedPrefab(GUID)).toBeUndefined();
    expect(getResourceStats().prefabs).toEqual({ [OLD]: 1 }); // the scene still references it: its release stays its own
  });

  // Mutation: drop the document-id match in `evictDeletedEditorPrefabs` — the guid key survives a pruned manifest.
  it('a guid the manifest already forgot is found by the document the path key holds', () => {
    primeEditorPrefabCache(GUID, doc as never);
    primeEditorPrefabCache(OLD, doc as never);
    clearManifest(); // the dev server's pruning rescan landed before the repair
    applyAssetPathMoves([{ from: OLD, to: null }]);
    expect(getCachedPrefabSync(GUID)).toBeNull();
  });

  // Mutation: drop the `prefix` branch of the eviction — the folder delete leaves the editor's entry.
  it('a folder delete evicts every prefab under it, and nothing that merely shares the prefix', async () => {
    const SIBLING = '55555555-2222-4333-8444-000000001805';
    const SIB_PATH = '/games/g/assets/ui2/Other.prefab.json';
    const sibling = { ...doc, id: SIBLING, name: 'Other' };
    registerAsset(SIBLING, SIB_PATH, 'prefab');
    // Each path serves its OWN document: the shared stub serves Row everywhere, and its fetch would register GUID at SIB_PATH.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(url === SIB_PATH ? sibling : doc) }) as unknown as Response));
    await acquirePrefab(1, GUID);
    await acquirePrefab(1, SIBLING);
    primeEditorPrefabCache(GUID, doc as never);
    primeEditorPrefabCache(SIBLING, sibling as never);
    applyAssetPathMoves([{ from: '/games/g/assets/ui', to: null, prefix: true }]);
    expect(getCachedPrefabSync(GUID)).toBeNull();
    expect(getCachedPrefabSync(SIBLING)).not.toBeNull();
    setPrefabCache(SIBLING, null as never);
  });
});
