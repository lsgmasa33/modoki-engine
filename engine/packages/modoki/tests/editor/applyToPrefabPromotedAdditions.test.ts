/** applyToPrefabSelective must REPORT how many "added" subtrees it promoted into
 *  the prefab. The caller (Apply dialog) relies on this to re-save the scene —
 *  otherwise the scene file keeps listing the now-promoted child as an `added`
 *  structural override and a reload re-spawns it on top of the freshly-expanded
 *  prefab member (the duplicate-Engine-Flame bug).
 *
 *  Drives the real applyToPrefabSelective end-to-end (write succeeds, instance is
 *  refreshed) against a real koota world; world/entityUtils/traitRegistry are
 *  mocked to inject the trait set and a no-op delete. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, sortOrder: 0, parentId: 0, guid: '' as string });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, sortOrder: 0, parentId: 0, guid: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0 } },
] as const;

let testWorld: ReturnType<typeof createWorld>;
const entityIndex = new Map<number, any>();
let entityInfos: { id: number; name: string; parentId: number; sortOrder: number; traits: string[] }[] = [];

const deleteEntitiesMock = vi.fn();

vi.mock('../../src/runtime/ecs/world', () => ({
  onWorldSwap: () => () => {},
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => entityIndex.set(e.id(), e),
  unregisterEntity: (e: any) => entityIndex.delete(e.id()),
  findEntityByGuid: (guid: string, world: any = testWorld) => {
    let found: any;
    world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (!found && ea.guid === guid) found = e; });
    return found;
  },
  indexEntityGuid: () => {},
  getGuidIndex: (world: any = testWorld) => {
    const m = new Map<string, any>();
    world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { const g = ea.guid; if (g && !m.has(g)) m.set(g, e); });
    return m;
  },
  rebuildGuidIndexSync: () => {},
}));

vi.mock('../../src/runtime/ecs/entityUtils', () => ({
  getAllEntities: () => entityInfos,
  findEntity: (id: number) => entityIndex.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: (...args: any[]) => deleteEntitiesMock(...args),
  writeTraitField: vi.fn(),
  readTraitData: (id: number, meta: any) => {
    const e = entityIndex.get(id);
    if (!e || !e.has(meta.trait)) return null;
    if (meta.category === 'tag') return {};
    const data = e.get(meta.trait);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(meta.fields)) out[k] = data[k];
    return out;
  },
}));

vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
  getAllTraits: () => TRAITS,
}));

let writtenContent: string | null = null;
// @ts-expect-error mock global — write-file succeeds so apply runs to completion.
global.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
  if (url.includes('/api/write-file') && init?.body) {
    writtenContent = JSON.parse(init.body).content;
  }
  return { ok: true, json: async () => ({}) } as Response;
});

async function getModule() { return import('../../src/editor/scene/prefab'); }

const SRC = 'aaaaaaaa-0000-4000-8000-000000000002';

function makePrefab() {
  // Prefab root (localId 1) only — no children. The instance adds one.
  return {
    id: SRC, version: 1 as const, name: 'ship', rootLocalId: 1,
    entities: [{ localId: 1, name: 'Ship', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'Ship', parentId: 0 } } }],
  };
}

describe('applyToPrefabSelective — reports promoted additions', () => {
  beforeEach(() => {
    testWorld = createWorld();
    entityIndex.clear();
    entityInfos = [];
    writtenContent = null;
    deleteEntitiesMock.mockClear();
  });

  it('returns promotedAdditions=1 when an added child is applied (so the caller re-saves)', async () => {
    const { setPrefabCache, applyToPrefabSelective } = await getModule();
    setPrefabCache(SRC, makePrefab() as any);

    // Instance root = prefab member localId 1.
    const root = testWorld.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'Ship', parentId: 0, guid: 'g-root' }),
      PrefabInstance({ source: SRC, localId: 1, rootInstanceId: 0 }),
    );
    const rootId = root.id();
    // rootInstanceId must equal the real spawned id.
    testWorld.query(PrefabInstance).updateEach(([pi]) => { (pi as any).rootInstanceId = rootId; });
    entityIndex.set(rootId, root);

    // A user-added child (the "Engine Flame") — NOT a prefab member (no PrefabInstance).
    const flame = testWorld.spawn(
      Transform({ x: 1, y: 0, z: 0 }),
      EntityAttributes({ name: 'Engine Flame L', parentId: rootId, guid: 'g-flame' }),
    );
    const flameId = flame.id();
    entityIndex.set(flameId, flame);

    entityInfos = [
      { id: rootId, name: 'Ship', parentId: 0, sortOrder: 0, traits: ['Transform', 'EntityAttributes', 'PrefabInstance'] },
      { id: flameId, name: 'Engine Flame L', parentId: rootId, sortOrder: 0, traits: ['Transform', 'EntityAttributes'] },
    ];

    const result = await applyToPrefabSelective(rootId, new Set([`+added.g-flame`]));

    // The contract the dialog depends on to know it must persist the scene.
    expect(result.promotedAdditions).toBe(1);
    // The live "added" entity was deleted (it becomes a prefab member on refresh).
    expect(deleteEntitiesMock).toHaveBeenCalledWith([flameId]);
    // And the flame was written into the prefab file as a new member.
    const written = JSON.parse(writtenContent!);
    expect(written.entities.some((e: any) => e.traits?.EntityAttributes?.name === 'Engine Flame L')).toBe(true);
  });

  it('returns promotedAdditions=0 for a value-only apply (no scene re-save needed)', async () => {
    const { setPrefabCache, applyToPrefabSelective } = await getModule();
    setPrefabCache(SRC, makePrefab() as any);

    const root = testWorld.spawn(
      Transform({ x: 9, y: 0, z: 0 }),
      EntityAttributes({ name: 'Ship', parentId: 0, guid: 'g-root' }),
      PrefabInstance({ source: SRC, localId: 1, rootInstanceId: 0 }),
    );
    const rootId = root.id();
    testWorld.query(PrefabInstance).updateEach(([pi]) => { (pi as any).rootInstanceId = rootId; });
    entityIndex.set(rootId, root);
    entityInfos = [{ id: rootId, name: 'Ship', parentId: 0, sortOrder: 0, traits: ['Transform', 'EntityAttributes', 'PrefabInstance'] }];

    const result = await applyToPrefabSelective(rootId, new Set(['1.Transform.x']));

    expect(result.promotedAdditions).toBe(0);
  });
});
