/** #1934 close-out review F1: a load keeps only the copies of missing prefabs that ITS OWN scene file carries. A base and
 *  its level each carry a copy of the same missing prefab — two versions, when the prefab came back, changed, and went
 *  again between the two saves. Read across the chain in load order (bases first), the level's instance expanded from the
 *  base's, and the level's next save replaced its own backup with the base's version. Unity keeps a backup in the scene
 *  file that holds the instance and reads no other scene's (`MergedAsMissingWithSceneBackup`).
 *
 *  Owner ruling B (#2001 S5, #2028): no copy expands anything — the instance shows the Missing Prefab placeholder either
 *  way. Until S6 stops writing them, the save still writes the scene's own copy back, so the per-scene store stays. */
import { describe, it, expect, vi } from 'vitest';
import { createWorld } from 'koota';

vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: () => undefined,
  loadModelTemplates: async () => {},
}));

import { getCurrentWorld, setCurrentWorld, getAllEntities, loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, type SceneData } from '@modoki/engine/runtime';
import { embeddedPrefabDoc } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';

registerAllTraits();

const P = 'cccccccc-0000-4000-8000-00000000aaaa';
const BASE = 'bbbbbbbb-0000-4000-8000-00000000bbbb';
const LEVEL = 'abababab-0000-4000-8000-00000000cccc';
const row = (localId: number, name: string, parentId: number, nodeGuid: string) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
/** P as one version or the other: the root and one member, named after the version. */
const pDoc = (version: string) => ({ id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
  row(1, `R_${version}`, 0, 'eeeeeeee-0000-4000-8000-000000000001'), row(2, `A_${version}`, 1, 'eeeeeeee-0000-4000-8000-000000000002'),
] });
/** A top-level instance of P (P is missing: the fetch finds nothing). */
const instanceOfP = (guid: string) => ({ id: 1, prefab: P, guid, traits: { EntityAttributes: { name: 'P1', parentId: 0 } } });

/** Load `data` into the current world, beside what it holds, as one scene of a chain. */
async function loadInto(data: object): Promise<void> {
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false, clearMarks: false,
    fetchPrefab: async () => null,
    onDeletePlaceholder: (id: number) => { const w = getCurrentWorld(); for (const e of w.entities) if (e.id() === id) { destroyEntity(e, w); break; } },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, _g, _f, nestedStructure, load) => {
      const read = load?.read;
      const doc = read?.(source);
      if (!doc) return undefined;
      return instantiatePrefabIntoWorld(getCurrentWorld(), doc as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure, { read }) || undefined;
    },
  });
}
const names = () => getAllEntities().map((e) => e.name).sort();

describe('a load reads its own scene\'s copies (#1934 close-out F1)', () => {
  it('the level\'s instance is a placeholder (ruling B), and the level keeps its own copy for its save, not its base\'s', async () => {
    // Mutation: key the copy store by one scene for every load (`noteEmbeddedPrefabs`' `scene`) — the level reads
    // back the base's version, R_base.
    setCurrentWorld(createWorld());
    await loadInto({ id: BASE, version: SCENE_FORMAT_VERSION, resources: [], entities: [], embeddedPrefabs: { [P]: pDoc('base') } });
    await loadInto({ id: LEVEL, version: SCENE_FORMAT_VERSION, resources: [], embeddedPrefabs: { [P]: pDoc('level') }, entities: [instanceOfP('dddddddd-0000-4000-8000-000000000001')] });
    expect(names()).toEqual(['P1']);
    const rootName = (scene: string) => (embeddedPrefabDoc(getCurrentWorld(), scene, P) as { entities?: { name?: string }[] } | undefined)?.entities?.[0]?.name;
    expect([rootName(LEVEL), rootName(BASE)]).toEqual(['R_level', 'R_base']);
  });

  it('a level with no copy of its own does not expand from its base\'s: its instance stays a placeholder', async () => {
    // The same mutation expands it from the base's copy: [A_base, P1 → R_base].
    setCurrentWorld(createWorld());
    await loadInto({ id: BASE, version: SCENE_FORMAT_VERSION, resources: [], entities: [], embeddedPrefabs: { [P]: pDoc('base') } });
    await loadInto({ id: LEVEL, version: SCENE_FORMAT_VERSION, resources: [], entities: [instanceOfP('dddddddd-0000-4000-8000-000000000002')] });
    expect(names()).toEqual(['P1']);
  });
});
