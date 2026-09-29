/** #1825 — a file-direct `setTrait EntityAttributes.parentId` on a prefab instance ROOT is a reparent of the instance,
 *  as Unity treats an instance root's parent: scene-side, never part of the prefab.
 *
 *  `traitWriteContainer` routes every instance-root write into `overrides[rootLocalId]`, and the parent went there too:
 *  the loader does not read a parent from the overrides, so the instance did not move, and the stored override is a
 *  field an Apply would offer to write into the template. The parent now goes to the entry's own
 *  `traits.EntityAttributes.parentId`, where a Hierarchy drop and a save put it.
 *
 *  Mutation: drop the `parentGiven && container !== entity.traits` branch in sceneMutate.ts's setTrait — the instance
 *  reloads at the root, and the override listing offers `EntityAttributes.parentId`. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld } from 'koota';

const prefabs = new Map<string, unknown>();
vi.mock('../../packages/modoki/src/runtime/loaders/meshTemplateCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedPrefab: (ref: string) => prefabs.get(ref),
  loadModelTemplates: async () => {},
}));

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, loadSceneFile, instantiatePrefabIntoWorld,
  destroyEntity, type SceneData,
} from '@modoki/engine/runtime';
import { setPrefabCache, getCachedPrefabSync, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyOps, type MutableScene } from '../../packages/modoki/src/runtime/scene/sceneMutate';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';

registerAllTraits();

const P = 'aaaaaaaa-0000-4000-8000-000000001825';
const G = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const GROUP = G(900);
const ROOT = G(901);
const row = (localId: number, nodeGuid: string, name: string, parentId: number) => ({
  localId, nodeGuid, name,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const pDoc = () => ({ id: P, version: 6, name: 'P', rootLocalId: 1, entities: [row(1, G(1), 'R', 0), row(2, G(2), 'A', 1)] });

/** Group at the root, and an instance of P at the root beside it, as a scene file stores them. */
const scene = (): MutableScene => ({
  id: 'h1825', version: SCENE_FORMAT_VERSION, name: 'S', resources: [],
  entities: [
    { id: 1, name: 'Group', traits: { EntityAttributes: { name: 'Group', guid: GROUP, parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
    { id: 2, name: 'I', prefab: P, guid: ROOT,
      traits: { EntityAttributes: { name: 'I', parentId: 0 }, PrefabInstance: { source: P, localId: 1, rootInstanceId: ROOT } },
      overrides: { 1: { Transform: { x: 0, y: 0, z: 0 } } } },
  ],
} as unknown as MutableScene);

/** A fresh world built from `data`, as a load does. */
async function load(data: SceneData): Promise<void> {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)), {
    loadModels: false,
    fetchPrefab: async (ref) => (prefabs.get(ref) as object) ?? null,
    onDeletePlaceholder: (id) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _old, _extra, overrides, structure, nested, rootGuid, _folder, nestedStructure) => {
      const world = getCurrentWorld();
      const rootId = instantiatePrefabIntoWorld(world, (getCachedPrefabSync(source) ?? prefabs.get(source)) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure);
      if (!rootId) return undefined;
      if (rootGuid) for (const e of world.entities) if (e.id() === rootId) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as object), guid: rootGuid });
      return rootId;
    },
  });
}

beforeEach(() => {
  prefabs.clear();
  prefabs.set(P, pDoc());
  setPrefabCache(P, pDoc() as never);
});

describe('file-direct parentId on an instance root (#1825)', () => {
  it('the reload puts the instance under the new parent, and Apply has no parent override to carry', async () => {
    const data = scene();
    const res = applyOps(data, [{ op: 'setTrait', entity: { guid: ROOT }, trait: 'EntityAttributes', fields: { parentId: GROUP } }]);
    expect(res.errors).toEqual([]);
    await load(data as unknown as SceneData);
    const all = getAllEntities();
    const group = all.find((e) => e.guid === GROUP)!;
    const root = all.find((e) => e.guid === ROOT)!;
    expect(root.parentId).toBe(group.id);
    // What an Apply offers to write into the template: the instance's own override keys.
    const keys = collectInstanceOverrideKeys(root.id, getCachedPrefabSync(P) as PrefabFile).fields;
    expect(keys.filter((k) => k.includes('EntityAttributes.parentId'))).toEqual([]);
  });
});
