/** captureInstanceStructure must NOT flag a nested-prefab row as `removed`.
 *  A nested row (a prefab entity carrying a `prefab` ref) expands into its OWN
 *  foreign-instance root, which is never a direct member of the parent instance.
 *  The old code saw "no member at this localId" and recorded it as removed — which
 *  detached the spaceship's engine flames to scene root on every re-serialize.
 *  Also: serializeScene must not flag/emit such an instance separately. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, parentId: 0, guid: 0, sortOrder: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0 } },
] as const;

let testWorld: ReturnType<typeof createWorld>;
const index = new Map<number, any>();
const traitNamesOf = (e: any) => TRAITS.filter((t) => e.has(t.trait)).map((t) => t.name);

function getAllEntitiesImpl() {
  const out: { id: number; name: string; parentId: number; sortOrder: number; traits: string[] }[] = [];
  testWorld.query(EntityAttributes).updateEach(([ea], e) => {
    const d = ea as Record<string, unknown>;
    out.push({ id: e.id(), name: d.name as string, parentId: d.parentId as number, sortOrder: (d.sortOrder as number) ?? 0, traits: traitNamesOf(e) });
  });
  return out;
}
function readTraitDataImpl(id: number, meta: any) {
  const e = index.get(id);
  if (!e || !e.has(meta.trait)) return null;
  const data = e.get(meta.trait);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(meta.fields)) out[k] = data[k];
  return out;
}

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  unregisterEntity: (e: any) => index.delete(e.id()),
}));
vi.mock('../../src/runtime/ecs/entityUtils', () => ({
  getAllEntities: () => getAllEntitiesImpl(),
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: vi.fn(),
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
  writeTraitField: vi.fn(),
}));
vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => TRAITS.find((t) => t.name === n),
  getAllTraits: () => TRAITS,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn() }));

beforeEach(async () => {
  testWorld = createWorld();
  index.clear();
  const { clearAllOverrideMarks } = await import('../../src/runtime/loaders/overrideMarks');
  clearAllOverrideMarks();
});

const getModule = () => import('../../src/editor/scene/prefab');

const FLAME = 'cccccccc-0000-4000-8000-00000000c0e8';
// Spaceship-like outer prefab: root 'Ship' (localId 1) with a nested flame row
// (localId 2, prefab FLAME, parented to the ship root).
const flamePrefab = {
  id: FLAME, version: 1 as const, name: 'Flame', rootLocalId: 1,
  entities: [{ localId: 1, name: 'Flame', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Flame', parentId: 0, guid: '' } } }],
};
const shipPrefab = {
  id: 'aaaaaaaa-0000-4000-8000-0000000ship1', version: 2 as const, name: 'Ship', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'Ship', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Ship', parentId: 0, guid: '' } } },
    { localId: 2, name: 'Flame', prefab: FLAME, traits: { EntityAttributes: { name: 'Flame', parentId: 1, guid: '' } } },
  ],
};

describe('captureInstanceStructure — nested-prefab rows', () => {
  it('does NOT flag a nested-prefab row as removed', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, captureInstanceStructure } = await getModule();
    setPrefabCache(FLAME, flamePrefab as any);
    setPrefabCache(shipPrefab.id, shipPrefab as any);

    const shipRoot = instantiatePrefab(shipPrefab as any);
    setPrefabSource(shipRoot, shipPrefab.id);

    const struct = captureInstanceStructure(shipRoot, shipPrefab as any);

    // localId 2 is a nested-prefab row (expands as a child instance) — it must NOT
    // appear in `removed`, and the flame instance must NOT be folded into `added`.
    expect(struct.removed).toHaveLength(0);
    expect(struct.added).toHaveLength(0);
  });
});
