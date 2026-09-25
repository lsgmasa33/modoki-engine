/** #1468 Phase 6 close-out review 2: the LOADER registers the runtime prefab cache as the identity resolver's last
 *  document fallback (`setRuntimeFrameDocFallback` in `instantiatePrefabIntoWorld`). A device has no editor cache,
 *  so without it a frame whose root record a flat respawn lost (a kept base scene across a swap) read no document,
 *  and every moved member in it read as unmoved. The unit test in `identityParents.test.ts` calls the setter
 *  itself; this one proves the loader does. Mutation: drop that call from `instantiatePrefabIntoWorld`. */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
}));

import { getCurrentWorld, setCurrentWorld, instantiatePrefabIntoWorld } from '@modoki/engine/runtime';
import { frameDocReader, setFrameDocFallback } from '../../packages/modoki/src/runtime/core/ecs/identityParents';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
const P = 'aaaaaaaa-0000-4000-8000-00000000f1a1';
const doc = { id: P, rootLocalId: 1, entities: [
  { localId: 1, traits: { EntityAttributes: { name: 'Root', parentId: 0 } } },
  { localId: 2, traits: { EntityAttributes: { name: 'Leaf', parentId: 1 } } },
] };
const prev = getCurrentWorld();
afterAll(() => { setCurrentWorld(prev); });

describe('the loader registers the runtime cache as the last document fallback', () => {
  it('a world that never expanded a source still reads its document, with no editor cache registered', () => {
    setFrameDocFallback(undefined); // a device: no editor
    prefabs.set(P, doc);
    const spawned = createWorld();
    setCurrentWorld(spawned);
    instantiatePrefabIntoWorld(spawned, doc as never, 0, undefined, P);
    // A second world — the flat respawn's — never expanded P and holds no record for it.
    const respawned = createWorld();
    expect(frameDocReader(respawned)(P)).toBe(doc);
    respawned.destroy();
    spawned.destroy();
  });
});
