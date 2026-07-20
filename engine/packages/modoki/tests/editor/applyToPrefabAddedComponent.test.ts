/** applyToPrefabSelective — applying an ADDED component (a trait the prefab lacks
 *  at that localId) must write the whole trait into the prefab file. Regression
 *  for the silent-drop bug: the value path did `if (!traitBag) continue`, so a
 *  user-added component (e.g. ShipShake) was never persisted on Apply-to-Prefab.
 *
 *  Drives the real applyToPrefabSelective. The dev-server write is stubbed to
 *  capture the serialized prefab and return not-ok, which stops the function
 *  before the heavy refresh — we only need to assert what would be written. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, sortOrder: 0, parentId: 0, guid: '' as string });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });
const ShipShake = trait({ posAmpX: 0, posAmpY: 0, speed: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, sortOrder: 0, parentId: 0, guid: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0 } },
  { name: 'ShipShake', trait: ShipShake, category: 'component', fields: { posAmpX: 0, posAmpY: 0, speed: 0 } },
] as const;

let testWorld: ReturnType<typeof createWorld>;
const entityIndex = new Map<number, any>();
let entityInfos: { id: number; name: string; parentId: number; sortOrder: number; traits: string[] }[] = [];

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

// Capture what would be written to disk; return not-ok so applyToPrefabSelective
// stops before refreshAllInstances (we only assert the serialized prefab).
let writtenContent: string | null = null;
// @ts-expect-error mock global
global.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
  if (url.includes('/api/write-file') && init?.body) {
    writtenContent = JSON.parse(init.body).content;
  }
  return { ok: false, json: async () => ({}) } as Response;
});

async function getModule() { return import('../../src/editor/scene/prefab'); }

const ROOT = 500;
const SRC = 'aaaaaaaa-0000-4000-8000-000000000001'; // prefab source GUID

function makeOldPrefab() {
  // Prefab root (localId 1) has Transform + EntityAttributes but NO ShipShake.
  return {
    id: SRC, version: 1 as const, name: 'ship', rootLocalId: 1,
    entities: [{ localId: 1, name: 'Ship', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'Ship', parentId: 0 } } }],
  };
}

describe('applyToPrefabSelective — added component persists to the prefab', () => {
  beforeEach(() => {
    testWorld = createWorld();
    entityIndex.clear();
    entityInfos = [];
    writtenContent = null;
  });

  it('writes the whole added trait (with live values) into the prefab file', async () => {
    const { setPrefabCache, applyToPrefabSelective } = await getModule();
    setPrefabCache(SRC, makeOldPrefab() as any);

    // Live instance root: a prefab member (localId 1) the user gave a ShipShake.
    const root = testWorld.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'Ship', parentId: 0, guid: 'g-root' }),
      ShipShake({ posAmpX: 0.5, posAmpY: 0.25, speed: 3 }),
      PrefabInstance({ source: SRC, localId: 1, rootInstanceId: ROOT }),
    );
    // Re-key on the real spawned id (ROOT is only a label; rootInstanceId must match id()).
    const rootId = root.id();
    testWorld.query(PrefabInstance).updateEach(([pi]) => { (pi as any).rootInstanceId = rootId; });
    entityIndex.set(rootId, root);
    entityInfos.push({ id: rootId, name: 'Ship', parentId: 0, sortOrder: 0, traits: ['Transform', 'EntityAttributes', 'ShipShake', 'PrefabInstance'] });

    // The dialog emits one key per overridden field of the added trait.
    await applyToPrefabSelective(rootId, new Set(['1.ShipShake.speed', '1.ShipShake.posAmpX']));

    expect(writtenContent).toBeTruthy();
    const written = JSON.parse(writtenContent!);
    const ship = written.entities.find((e: any) => e.localId === 1);
    expect(ship.traits.ShipShake).toBeDefined();
    // Seeded from the full live trait, so all fields are present (not just the keyed ones).
    expect(ship.traits.ShipShake).toMatchObject({ posAmpX: 0.5, posAmpY: 0.25, speed: 3 });
    // Pre-existing prefab traits remain intact.
    expect(ship.traits.Transform).toBeDefined();
    expect(ship.traits.EntityAttributes).toBeDefined();
  });
});
