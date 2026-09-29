/** #1805 close-out review, finding 1: an asset delete evicted the EDITOR prefab cache while the LOADER kept its entry
 *  until the scene that owned it let go. A scene swap's warm (`warmEditorPrefabCacheFor`) seeds a cold editor key from that
 *  loader entry, so the first reload after a delete put the deleted prefab straight back in the editor cache — and an
 *  instantiate expanded a prefab that no longer exists (seed 199's route), one reload later. The delete tombstones what it
 *  evicted (`editorPrefabDeleted`); the warm reads such a key from disk instead: a 404 while the file is gone, the document
 *  once an undo put it back, which clears the tombstone. Since #1834 the delete evicts the loader's entry too, so the
 *  tombstone is the SECOND line: the cases below seat a loader entry after the delete (`replaceCachedPrefab`, the owner
 *  kept) to test the warm's own check, which would otherwise be unreachable here.
 *
 *  Driven through the real loader cache, the real delete repair and the real warm. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { getTraitByName } from '@modoki/engine/runtime';
import { clearManifest, registerAsset, loadManifestJson, getGuidForPath } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { acquirePrefab, getCachedPrefab, replaceCachedPrefab, disposeAllCachedResources } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { applyAssetPathMoves } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { getCachedPrefabSync, primeEditorPrefabCache, seatEditorPrefabCache, editorPrefabDeleted } from '../../packages/modoki/src/editor/scene/prefab';
import { warmEditorPrefabCacheFor } from '../../packages/modoki/src/editor/scene/prefabCacheWarm';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const GUID = '55555555-2222-4333-8444-000000001805';
const OTHER_GUID = '55555555-2222-4333-8444-000000001834';
const PATH = '/games/g/assets/ui/Row.prefab.json';
const doc = { version: 8, id: GUID, name: 'Row', rootLocalId: 1, entities: [{ localId: 1, name: 'Row', traits: {} }] };

/** What the fake disk holds at PATH; undefined = the file is gone. */
let onDisk: unknown = doc;
beforeEach(() => {
  clearManifest();
  registerAsset(GUID, PATH, 'prefab');
  onDisk = doc;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url) === PATH && onDisk !== undefined
    ? { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(onDisk), json: async () => JSON.parse(JSON.stringify(onDisk)) }
    : { ok: false, status: 404, statusText: 'Not Found', text: async () => '', json: async () => ({}) }) as unknown as Response));
});
afterEach(() => {
  // A seated document clears a tombstone (`deletedEditorKeys` is module state): each case starts with none.
  for (const k of [GUID, PATH]) { seatEditorPrefabCache(k, doc as never); seatEditorPrefabCache(k, null); }
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

/** A world holding one instance of the prefab — what the swap's warm reads its sources from. */
function worldWithInstance() {
  const w = createWorld();
  const pi = getTraitByName('PrefabInstance')!;
  w.spawn(pi.trait({ source: GUID, rootInstanceId: 1, localId: 1 }));
  return w;
}

describe('a deleted prefab stays out of the editor cache across a swap (#1805 close-out review)', () => {
  it('the warm does not seed it back from a loader entry seated after the delete', async () => {
    // Mutation: drop `!editorPrefabDeleted(source)` from the warm — the deleted document is back after one swap.
    await acquirePrefab(1, GUID);
    primeEditorPrefabCache(GUID, doc as never);
    onDisk = undefined;
    applyAssetPathMoves([{ from: PATH, to: null }]);
    expect(getCachedPrefabSync(GUID)).toBeNull();
    expect(getCachedPrefab(GUID)).toBeUndefined(); // the delete evicted the loader's too (#1834)
    replaceCachedPrefab(GUID, doc); // …and something seated it again: the tombstone is the second line
    expect(getCachedPrefab(GUID)).toEqual(doc); // precondition
    await warmEditorPrefabCacheFor(worldWithInstance());
    expect(getCachedPrefabSync(GUID)).toBeNull();
  });

  it('an undo that put the file back is read from disk by the next warm, which clears the tombstone', async () => {
    // Mutation: never clear the tombstone in `seatEditorEntry` — the restored prefab's key stays marked deleted.
    await acquirePrefab(1, GUID);
    primeEditorPrefabCache(GUID, doc as never);
    onDisk = undefined;
    applyAssetPathMoves([{ from: PATH, to: null }]);
    onDisk = { ...doc, name: 'Row, restored' };
    await warmEditorPrefabCacheFor(worldWithInstance());
    expect((getCachedPrefabSync(GUID) as unknown as { name: string } | null)?.name).toBe('Row, restored');
    expect(editorPrefabDeleted(GUID)).toBe(false);
  });

  it('a guid the editor never held is tombstoned too — the manifest still maps it into the deleted folder', async () => {
    // Mutation: drop the manifest pass in `evictDeletedEditorPrefabs` — the warm seeds the cold key from the loader.
    await acquirePrefab(1, GUID);
    expect(getCachedPrefabSync(GUID)).toBeNull(); // precondition: the editor never held it
    expect(editorPrefabDeleted(GUID)).toBe(false); // precondition: no tombstone left by another case
    onDisk = undefined;
    applyAssetPathMoves([{ from: '/games/g/assets/ui', to: null, prefix: true }]);
    expect(editorPrefabDeleted(GUID)).toBe(true);
    replaceCachedPrefab(GUID, doc); // a loader entry seated after the delete (see the header)
    await warmEditorPrefabCacheFor(worldWithInstance());
    expect(getCachedPrefabSync(GUID)).toBeNull();
  });

  it('a prefab held under its guid alone is evicted even when the delete\'s PRUNED manifest landed first (the "one window", #1834)', () => {
    // The dev editor loads the delete's inline rescan with `prune` before the renderer repair runs, so the manifest no longer
    // maps the guid to the deleted path. Mutation: resolve a guid key by `resolveGuidToPath` again in
    // `evictDeletedEditorPrefabs` — the trashed document stays readable under its guid.
    loadManifestJson({ version: 1, assets: [{ guid: GUID, path: PATH, type: 'prefab' }] } as never, { prune: true });
    primeEditorPrefabCache(GUID, doc as never); // under the guid alone: no path key to trace it by
    onDisk = undefined;
    loadManifestJson({ version: 1, assets: [{ guid: OTHER_GUID, path: '/games/g/assets/ui/Other.prefab.json', type: 'prefab' }] } as never, { prune: true });
    expect(getGuidForPath(PATH)).toBeUndefined(); // precondition: the pruned manifest no longer maps it
    applyAssetPathMoves([{ from: PATH, to: null }]);
    expect(getCachedPrefabSync(GUID)).toBeNull();
    expect(editorPrefabDeleted(GUID)).toBe(true);
  });
});
