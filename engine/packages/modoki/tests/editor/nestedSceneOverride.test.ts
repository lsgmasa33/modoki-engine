/** Scene-level override on a prefab's NESTED instance. captureNestedSceneDelta
 *  must return only the fields the SCENE uniquely changed on the nested instance
 *  — the parent prefab row's own overrides (e.g. the flames' mirrored positions)
 *  are subtracted, so the scene stores just its delta (e.g. an edited idleScale)
 *  and survives a child-prefab base edit (via the override marks). */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EngineFlame = trait({ idleScale: 0, boostScale: 0, response: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EngineFlame', trait: EngineFlame, category: 'component', fields: { idleScale: 0, boostScale: 0, response: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, parentId: 0, guid: 0, sortOrder: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0, parentLocalId: 0 } },
] as const;

let testWorld: ReturnType<typeof createWorld>;
const index = new Map<number, any>();
const traitNamesOf = (e: any) => TRAITS.filter((t) => e.has(t.trait)).map((t) => t.name);

function getAllEntitiesImpl() {
  const out: any[] = [];
  testWorld.query(EntityAttributes).updateEach(([ea], e) => {
    const d = ea as Record<string, unknown>;
    out.push({ id: e.id(), name: d.name, parentId: d.parentId, sortOrder: d.sortOrder ?? 0, traits: traitNamesOf(e) });
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
function writeTraitFieldImpl(id: number, meta: any, field: string, value: unknown) {
  const e = index.get(id);
  if (!e || !e.has(meta.trait)) return;
  e.set(meta.trait, { ...e.get(meta.trait), [field]: value });
}

vi.mock('../../src/runtime/ecs/world', () => ({
  onWorldSwap: () => () => {},
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
  writeTraitField: (id: number, meta: any, field: string, value: unknown) => writeTraitFieldImpl(id, meta, field, value),
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

const FLAME = 'cccccccc-0000-4000-8000-00000000c0e8';
const flamePrefab = {
  id: FLAME, version: 1 as const, name: 'Flame', rootLocalId: 1,
  entities: [{ localId: 1, name: 'Flame', traits: { Transform: { x: 0, y: 0, z: 0 }, EngineFlame: { idleScale: 0.1, boostScale: 3, response: 1 }, EntityAttributes: { name: 'Flame', parentId: 0, guid: '' } } }],
};

describe('captureNestedSceneDelta', () => {
  it('returns only the scene-changed field; row-owned fields are subtracted', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, applyOverridesByRootInstance } = await import('../../src/editor/scene/prefab');
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');
    const { captureNestedSceneDelta } = await import('../../src/editor/scene/serialize');

    setPrefabCache(FLAME, flamePrefab as any);
    const root = instantiatePrefab(flamePrefab as any);
    setPrefabSource(root, FLAME);

    // Parent prefab's row override on this flame: position x=4.1 (marks it).
    applyOverridesByRootInstance(root, { 1: { Transform: { x: 4.1 } } });
    // User's SCENE edit: idleScale 0.1 -> 0.5 (set live + mark, as entityActions does).
    writeTraitFieldImpl(root, TRAITS[1], 'idleScale', 0.5);
    markOverride(root, 'EngineFlame', 'idleScale');

    const rowOverrides = { 1: { Transform: { x: 4.1 } } }; // the parent prefab's row override
    const delta = captureNestedSceneDelta(root, flamePrefab as any, rowOverrides);

    // Only the scene-specific idleScale remains; the row-owned Transform.x is gone.
    expect(delta[1]?.EngineFlame?.idleScale).toBe(0.5);
    expect(delta[1]?.Transform).toBeUndefined();
  });

  it('survives a child-prefab base edit that matches the scene override', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource } = await import('../../src/editor/scene/prefab');
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');
    const { captureNestedSceneDelta } = await import('../../src/editor/scene/serialize');

    setPrefabCache(FLAME, flamePrefab as any);
    const root = instantiatePrefab(flamePrefab as any);
    setPrefabSource(root, FLAME);
    writeTraitFieldImpl(root, TRAITS[1], 'idleScale', 0.5);
    markOverride(root, 'EngineFlame', 'idleScale');

    // Now the child prefab base idleScale is edited to 0.5 (coincides with override).
    const editedFlame = { ...flamePrefab, entities: [{ ...flamePrefab.entities[0], traits: { ...flamePrefab.entities[0].traits, EngineFlame: { idleScale: 0.5, boostScale: 3, response: 1 } } }] };
    const delta = captureNestedSceneDelta(root, editedFlame as any, undefined);

    // Mark survival: idleScale is still captured even though it now equals base.
    expect(delta[1]?.EngineFlame?.idleScale).toBe(0.5);
  });
});
