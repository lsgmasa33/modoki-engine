/** tagEntityTreeAsInstance — regression tests for the GUID-only invariant.
 *
 *  PrefabInstance.source must store a GUID, never a literal asset path. The
 *  "create prefab from entity" flows (Hierarchy + Assets) register the new
 *  prefab's GUID↔path, then call tagEntityTreeAsInstance with the PATH; the
 *  function must normalize that path to the registered GUID before writing the
 *  trait (mirroring setPrefabSource). A raw path here bakes a literal into the
 *  scene JSON on save and trips resolveRef's hard rejection on load.
 *
 *  Uses a real koota world + traits with the world/registry/entityUtils modules
 *  mocked to inject the test world. assetManifest is REAL so registerAsset /
 *  getGuidForPath exercise the actual path→guid resolution. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '' as string, isActive: true, sortOrder: 0, parentId: 0, layer: '' as '' | '3d' | '2d' | 'ui' });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });

let testWorld: ReturnType<typeof createWorld>;
const entityIndex = new Map<number, any>();
// Minimal EntityInfo list (collectTree only reads id + parentId).
let entityInfos: { id: number; parentId: number }[] = [];

vi.mock('../../src/runtime/ecs/world', () => ({
  onWorldSwap: () => () => {},
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => entityIndex.set(e.id(), e),
  unregisterEntity: (e: any) => entityIndex.delete(e.id()),
}));

vi.mock('../../src/runtime/ecs/entityUtils', () => ({
  getAllEntities: () => entityInfos,
  findEntity: (id: number) => entityIndex.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: vi.fn(),
  readTraitData: vi.fn(),
  writeTraitField: vi.fn(),
}));

vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (name: string) => {
    if (name === 'PrefabInstance') return { name, trait: PrefabInstance, category: 'component', fields: {} };
    if (name === 'Transform') return { name, trait: Transform, category: 'component', fields: {} };
    if (name === 'EntityAttributes') return { name, trait: EntityAttributes, category: 'component', fields: {} };
    return undefined;
  },
  getAllTraits: () => [],
}));

async function getModule() {
  return import('../../src/editor/scene/prefab');
}
async function getManifest() {
  return import('../../src/runtime/loaders/assetManifest');
}

function spawnNode(parentId: number): number {
  const e = testWorld.spawn(Transform, EntityAttributes({ parentId }));
  entityIndex.set(e.id(), e);
  entityInfos.push({ id: e.id(), parentId });
  return e.id();
}

describe('tagEntityTreeAsInstance', () => {
  beforeEach(() => {
    testWorld = createWorld();
    entityIndex.clear();
    entityInfos = [];
  });

  it('normalizes a registered prefab PATH to its GUID', async () => {
    const { registerAsset } = await getManifest();
    const { tagEntityTreeAsInstance } = await getModule();

    const path = '/games/x/assets/prefabs/tree.prefab.json';
    const guid = 'c1000000-0000-4000-8000-000000000001';
    registerAsset(guid, path, 'prefab');

    const rootId = spawnNode(0);
    const childId = spawnNode(rootId);

    tagEntityTreeAsInstance(rootId, path);

    // Both root and child carry PrefabInstance.source = the GUID, never the path.
    expect(entityIndex.get(rootId).get(PrefabInstance).source).toBe(guid);
    expect(entityIndex.get(childId).get(PrefabInstance).source).toBe(guid);
  });

  it('passes a GUID source through unchanged', async () => {
    const { tagEntityTreeAsInstance } = await getModule();
    const guid = 'c1000000-0000-4000-8000-000000000002';
    const rootId = spawnNode(0);

    tagEntityTreeAsInstance(rootId, guid);

    expect(entityIndex.get(rootId).get(PrefabInstance).source).toBe(guid);
  });

  it('assigns localIds in BFS order (root = 1)', async () => {
    const { registerAsset } = await getManifest();
    const { tagEntityTreeAsInstance } = await getModule();
    const path = '/games/x/assets/prefabs/group.prefab.json';
    const guid = 'c1000000-0000-4000-8000-000000000003';
    registerAsset(guid, path, 'prefab');

    const rootId = spawnNode(0);
    const childId = spawnNode(rootId);

    tagEntityTreeAsInstance(rootId, path);

    expect(entityIndex.get(rootId).get(PrefabInstance).localId).toBe(1);
    expect(entityIndex.get(childId).get(PrefabInstance).localId).toBe(2);
    expect(entityIndex.get(childId).get(PrefabInstance).rootInstanceId).toBe(rootId);
  });
});
