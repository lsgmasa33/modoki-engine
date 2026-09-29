/**
 * #1813: a prefab file with no `entities` array (hand-edited, truncated, agent-written) reached the EDITOR cache through the
 * runtime loader, which cached the parsed JSON as it was, and `preloadNestedPrefabs` then threw `Cannot read properties of
 * undefined (reading 'map')` out of every save, Create Prefab and undo warm. About 53 readers assume the shape, so the
 * shape is checked ONCE, where a prefab enters a cache (`isPrefabDocument`): the loader's fetch, `replaceCachedPrefab`,
 * the editor's fetch and its one seat. A non-document reads as a prefab that did not load (I18), never as an empty one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import {
  acquirePrefab, getCachedPrefab, replaceCachedPrefab, disposeAllCachedResources,
} from '../../src/runtime/loaders/meshTemplateCache';
import { isPrefabDocument } from '../../src/runtime/loaders/prefabRoot';
import { type PrefabFile } from '../../src/editor/scene/prefab';
import {
  getCachedPrefabSync, getPrefabSource, preloadNestedPrefabs, primeEditorPrefabCache, seatEditorPrefabCache,
  setPrefabCache,
} from '../../src/editor/scene/prefabCache';

const P = '55555555-2222-4333-8444-000000001813';
const Q = '55555555-2222-4333-8444-000000001814';
const P_PATH = '/games/g/assets/P.prefab.json';
const Q_PATH = '/games/g/assets/Q.prefab.json';
/** Q as a hand edit left it: an id and a name, no rows. */
const entityless = { version: 8, id: Q, name: 'Q' };
/** P, whose row 2 expands Q. */
const pDoc = { version: 8, id: P, name: 'P', rootLocalId: 1, entities: [
  { localId: 1, name: 'R', traits: {} }, { localId: 2, name: 'Qrow', prefab: Q, traits: {} },
] };

let served: Record<string, unknown> = {};
beforeEach(() => {
  clearManifest();
  registerAsset(P, P_PATH, 'prefab');
  registerAsset(Q, Q_PATH, 'prefab');
  served = { [P_PATH]: pDoc, [Q_PATH]: entityless };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = served[String(url)];
    return (body === undefined
      ? { ok: false, status: 404, statusText: 'Not Found', text: async () => '', json: async () => ({}) }
      : { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;
  }));
});
afterEach(() => {
  for (const k of [P, Q, P_PATH, Q_PATH]) seatEditorPrefabCache(k, null);
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

describe('the one shape check (#1813)', () => {
  // The accept side as well as the refuse side: a guard that refuses too much turns every prefab missing.
  it('accepts a document with rows, and one with NO rows (entities: [] expands to no root, #1768\'s own case)', () => {
    expect(isPrefabDocument(pDoc)).toBe(true);
    expect(isPrefabDocument({ entities: [] })).toBe(true);
  });
  it('refuses what is not one', () => {
    for (const bad of [null, undefined, 'x', 3, [], {}, entityless, { entities: {} }, { entities: 'rows' }, { entities: [null] }, { entities: [[]] }, { entities: [1] }]) {
      expect(isPrefabDocument(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('an entity-less prefab file reaches neither cache (#1813)', () => {
  it('the runtime loader\'s fetch caches nothing for it — and caches an empty-rows document (the accept side)', async () => {
    // Mutation: drop the `isPrefabDocument` throw in `fetchPrefab` — the runtime cache holds the entity-less object.
    await acquirePrefab(1, Q);
    expect(getCachedPrefab(Q)).toBeUndefined();
    served[Q_PATH] = { ...entityless, entities: [] };
    disposeAllCachedResources();
    await acquirePrefab(1, Q);
    expect(getCachedPrefab(Q)).toEqual({ ...entityless, entities: [] });
  });

  it('replaceCachedPrefab evicts instead of seating a non-document', async () => {
    // Mutation: back to `!data || typeof data !== 'object'` in `replaceCachedPrefab` — it seats the entity-less object.
    await acquirePrefab(1, P);
    expect(getCachedPrefab(P)).toEqual(pDoc); // precondition: owned and cached, so a replace would SEAT
    // P's own id: a non-document naming ANOTHER guid re-registers that guid at P's path, and P then misses for that reason alone.
    replaceCachedPrefab(P, { version: 8, id: P, name: 'P' });
    expect(getCachedPrefab(P)).toBeUndefined();
  });

  it('every editor-cache writer leaves the key absent, and preloadNestedPrefabs no longer throws over it', async () => {
    // Mutation: make `seatEditorEntry` set whatever it is handed — the warm throws `reading 'map'`, the #1813 symptom.
    for (const seat of [
      () => primeEditorPrefabCache(Q, entityless as unknown as PrefabFile),
      () => seatEditorPrefabCache(Q, entityless as unknown as PrefabFile),
      () => setPrefabCache(Q, entityless as unknown as PrefabFile),
    ]) {
      seat();
      expect(getCachedPrefabSync(Q)).toBeNull();
      await expect(preloadNestedPrefabs(pDoc as unknown as PrefabFile)).resolves.toBeUndefined();
    }
  });

  it('the editor\'s own fetch reads it as not loaded', async () => {
    // Mutation: drop the `isPrefabDocument` check in `fetchPrefabSource` — the object is returned and cached.
    served[Q_PATH] = { ...entityless, entities: [1] }; // iterates without a throw, so only the explicit check refuses it
    expect(await getPrefabSource(Q)).toBeNull();
    expect(getCachedPrefabSync(Q)).toBeNull();
  });
});
