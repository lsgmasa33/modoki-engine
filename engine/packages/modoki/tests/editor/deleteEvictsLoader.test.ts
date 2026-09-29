/** #1834: an Assets delete evicts the prefab from the LOADER's cache and keeps the scene's ownership. The delete is the
 *  editor's own write, so no watcher evicts it; without this a reload of the owning scene (which acquires before it
 *  releases) re-expanded the deleted prefab from the loader's entry. The delete is not undoable (#1868, owner ruling D2),
 *  so what used to be the second half of this — the undo refetching the entry — went with it; the ownership kept here is
 *  what lets the scene's next load fetch the file again if it comes back from the OS Trash. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeAssetRoute, type FakeAssetRoute } from './fakeAssetRoute';
import { applyAssetPathMoves } from '../../src/editor/panels/assetEditorBindings';
import { clearManifest, loadManifestJson, registerAsset } from '../../src/runtime/loaders/assetManifest';
import { acquirePrefab, getCachedPrefab, getResourceStats, disposeAllCachedResources } from '../../src/runtime/loaders/meshTemplateCache';
import { setRunMode } from '../../src/runtime/core/playState';

const G = 'aaaaaaaa-1834-4000-8000-000000000001';
const P = '/assets/prefabs/Q.prefab.json';

let route: FakeAssetRoute;
let spies: Array<{ mockRestore: () => void }> = [];
const manifestOfDisk = () => ({
  version: 2, folders: [],
  assets: [...route.disk.keys()].filter((p) => p.endsWith('.prefab.json'))
    .map((p) => ({ path: p, type: 'prefab', guid: (JSON.parse(route.text(p)!) as { id: string }).id })),
});

beforeEach(() => {
  setRunMode('stopped');
  clearManifest();
  route = makeFakeAssetRoute();
  route.put(P, JSON.stringify({ version: 8, id: G, name: 'Q', rootLocalId: 1, entities: [] }));
  vi.stubGlobal('fetch', route.fetch);
  loadManifestJson(manifestOfDisk(), { prune: true });
  spies.push(vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}));
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies = [];
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

describe('an Assets delete evicts the loader\'s entry and keeps the owner (#1834)', () => {
  it('the deleted prefab is no longer served, and the scene still owns it', async () => {
    // Mutation: drop `evictDeletedPrefabs` from `applyAssetPathMoves`' delete branch — the deleted prefab is still served.
    await acquirePrefab(1, G);
    expect(getCachedPrefab(G)).toBeDefined(); // precondition
    route.disk.delete(P);
    loadManifestJson(manifestOfDisk(), { prune: true });
    applyAssetPathMoves([{ from: P, to: null }]);
    registerAsset(G, P, 'prefab'); // Electron's additive view: G still maps, so only the eviction can make this miss
    expect(getCachedPrefab(G)).toBeUndefined();
    expect(getResourceStats().prefabs[P]).toBe(1);
  });
});
