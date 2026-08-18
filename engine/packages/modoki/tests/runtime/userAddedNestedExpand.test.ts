/** Runtime load path for a user-added nested instance: a scene entry's `added`
 *  carries a REFERENCE node (node.prefab set). instantiatePrefabIntoWorld +
 *  applyStructureByLocalToEcs must expand the child prefab as a nested instance
 *  under the anchor member — the round-trip that preserves exact placement. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, parentId: 0, guid: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0, parentLocalId: 0 } },
] as const;

// Mirrors the real module: `spawnEntity` registers into the id index and `findEntityById`
// reads it. A double that skips the registration answers undefined for an entity it just
// created — which is not how the engine behaves.
const idIndex = new Map<number, any>();
vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => createWorld(),
  registerEntity: (e: any) => idIndex.set(e.id(), e),
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); idIndex.set(e.id(), e); return e; },
  unregisterEntity: (e: any) => idIndex.delete(e.id()),
  destroyEntity: (e: any) => { idIndex.delete(e.id()); e.destroy(); },
  setStructureCallback: vi.fn(),
  indexEntityGuid: vi.fn(),
  findEntityById: (id: number) => idIndex.get(id),
}));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getAllTraits: () => TRAITS,
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
}));

// Child prefab cache (the user-added nested instance's source).
const Q = 'qqqqqqqq-0000-4000-8000-00000000000q';
const qPrefab = {
  id: Q, rootLocalId: 1,
  entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Q1', parentId: 0 }, Transform: { x: 1 } } }],
};
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  getCachedPrefab: (ref: string) => (ref === Q ? qPrefab : null),
  loadModelTemplates: vi.fn(),
}));

const getModule = () => import('../../src/runtime/loaders/loadSceneFile');

function dump(world: ReturnType<typeof createWorld>) {
  const out: { id: number; name: string; parentId: number; guid: string; source?: string }[] = [];
  for (const e of world.entities as any) {
    if (!e.has(EntityAttributes)) continue;
    const ea = e.get(EntityAttributes);
    out.push({ id: e.id(), name: ea.name, parentId: ea.parentId, guid: ea.guid, source: e.has(PrefabInstance) ? e.get(PrefabInstance).source : undefined });
  }
  return out;
}

// Parent prefab P: root P1(1) + member P2(2).
const pPrefab = {
  id: 'pppppppp-0000-4000-8000-00000000000p', rootLocalId: 1,
  entities: [
    { localId: 1, traits: { EntityAttributes: { name: 'P1', parentId: 0 } } },
    { localId: 2, traits: { EntityAttributes: { name: 'P2', parentId: 1 } } },
  ],
};

describe('runtime — user-added nested instance reference node expands under its member', () => {
  let world: ReturnType<typeof createWorld>;
  beforeEach(() => { world = createWorld(); idIndex.clear(); });

  it('expands the child prefab under the anchor member (parentLocalId 2 → P2)', async () => {
    const { instantiatePrefabIntoWorld } = await getModule();
    const added = [{
      parentLocalId: 2, guid: 'q-guid', name: 'Q1', traits: {}, children: [],
      prefab: Q, // reference node
    }];

    instantiatePrefabIntoWorld(world, pPrefab, 0, undefined, pPrefab.id, undefined, { added });

    const ents = dump(world);
    const p2 = ents.find((e) => e.name === 'P2')!;
    const q1 = ents.find((e) => e.name === 'Q1')!;
    expect(q1).toBeTruthy();
    // Expanded as a real instance (carries the child source) under P2.
    expect(q1.source).toBe(Q);
    expect(q1.parentId).toBe(p2.id);
    // …AND under the guid the reference node was serialized with (QA-PREFAB-0004). Placement
    // was already preserved here; identity was not, so a reload silently re-addressed it.
    expect(q1.guid).toBe('q-guid');
  });
});
