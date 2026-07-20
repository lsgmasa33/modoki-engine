/** Authoring + round-trip of an ARBITRARY-DEPTH scene override. A live world
 *  D ⟵ B ⟵ A (D nests B nests A), with a scene edit on A two levels deep, must
 *  serialize that edit onto D's entry as a PATH-keyed nestedOverrides ("2.2"),
 *  storing only the scene's delta (fields the prefab chain already provides are
 *  subtracted), and re-instantiating with that map must reproduce the value. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, parentId: 0, guid: 0, sortOrder: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0, parentLocalId: 0 } },
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
  if (meta.category === 'tag') return {};
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
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn(), getCachedPrefab: vi.fn(() => null) }));
let guidN = 0;
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  newGuid: () => `guid-${++guidN}`,
  registerAsset: vi.fn(),
  getGuidForPath: () => undefined,
  getAssetType: () => 'prefab',
  isGuid: (s: string) => typeof s === 'string' && s.includes('-'),
  isExternalUrl: () => false,
  isInternalAssetPath: () => false,
  resolveRef: (g: string) => `/__prefabs__/${g}.json`,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));
vi.mock('../../src/runtime/scene/SceneManager', () => ({ sceneManager: { loadScene: vi.fn() } }));
vi.mock('../../src/editor/undo/undoManager', () => ({ clearHistory: vi.fn() }));

beforeEach(async () => {
  testWorld = createWorld(); index.clear(); guidN = 0;
  const { clearAllOverrideMarks } = await import('../../src/runtime/loaders/overrideMarks');
  clearAllOverrideMarks();
});

const A = 'eeeeeeee-0000-4000-8000-0000000000aa';
const B = 'eeeeeeee-0000-4000-8000-0000000000bb';
const D = 'eeeeeeee-0000-4000-8000-0000000000dd';

// A: root A1 with Transform {x,y}. B nests A at row 2. D nests B at row 2.
const aPrefab = { id: A, version: 1 as const, name: 'A', rootLocalId: 1, entities: [{ localId: 1, name: 'A1', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'A1', parentId: 0, guid: '' } } }] };
const makeB = (aOverride?: any) => ({ id: B, version: 2 as const, name: 'B', rootLocalId: 1, entities: [
  { localId: 1, name: 'B1', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'B1', parentId: 0, guid: '' } } },
  { localId: 2, name: 'A1', prefab: A, traits: { EntityAttributes: { name: 'A1', parentId: 1, guid: '' } }, ...(aOverride ? { overrides: aOverride } : {}) },
] });
const dPrefab = { id: D, version: 2 as const, name: 'D', rootLocalId: 1, entities: [
  { localId: 1, name: 'D1', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'D1', parentId: 0, guid: '' } } },
  { localId: 2, name: 'B1', prefab: B, traits: { EntityAttributes: { name: 'B1', parentId: 1, guid: '' } } },
] };

function aRoot(): number {
  let id = 0;
  testWorld.query(PrefabInstance).updateEach(([pi], e) => { const p = pi as any; if (p.source === A && p.rootInstanceId === e.id()) id = e.id(); });
  return id;
}

describe('serialize an arbitrary-depth scene override (D ⟵ B ⟵ A)', () => {
  it('writes the deep edit as a path-keyed nestedOverrides on the top instance', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource } = await import('../../src/editor/scene/prefab');
    const { serializeScene } = await import('../../src/editor/scene/serialize');
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');
    setPrefabCache(A, aPrefab as any); setPrefabCache(B, makeB() as any); setPrefabCache(D, dPrefab as any);

    const root = instantiatePrefab(dPrefab as any); setPrefabSource(root, D);
    // Scene edit on A (two levels deep): x = 7.
    const a = aRoot();
    writeTraitFieldImpl(a, TRAITS[0], 'x', 7); markOverride(a, 'Transform', 'x');

    const scene = await serializeScene();
    const top = scene.entities.find((e) => e.prefab === D)!;
    expect(top).toBeTruthy();
    // Path "2.2": D's B-row (2) → B's A-row (2). Value is the scene's deep edit.
    expect(top.nestedOverrides).toEqual({ '2.2': { 1: { Transform: { x: 7 } } } });
    // A is NOT written as a standalone scene entity (it expands from the chain).
    expect(scene.entities.filter((e) => e.prefab === A)).toHaveLength(0);
  });

  it('stores only the scene DELTA — fields the prefab chain already provides are subtracted', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource } = await import('../../src/editor/scene/prefab');
    const { serializeScene } = await import('../../src/editor/scene/serialize');
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');
    // B overrides A.y = 5 (middle layer). Scene will edit only A.x.
    setPrefabCache(A, aPrefab as any); setPrefabCache(B, makeB({ 1: { Transform: { y: 5 } } }) as any); setPrefabCache(D, dPrefab as any);

    const root = instantiatePrefab(dPrefab as any); setPrefabSource(root, D);
    const a = aRoot();
    expect((index.get(a)!.get(Transform) as any).y).toBe(5); // B's override is live on A
    writeTraitFieldImpl(a, TRAITS[0], 'x', 7); markOverride(a, 'Transform', 'x');

    const scene = await serializeScene();
    const top = scene.entities.find((e) => e.prefab === D)!;
    // Only x (the scene's own edit). y=5 belongs to prefab B and is NOT baked in,
    // so changing B.y later still propagates.
    expect(top.nestedOverrides).toEqual({ '2.2': { 1: { Transform: { x: 7 } } } });
  });

  it('round-trips: re-instantiating with the serialized nestedOverrides reproduces the value', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource } = await import('../../src/editor/scene/prefab');
    const { serializeScene } = await import('../../src/editor/scene/serialize');
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');
    setPrefabCache(A, aPrefab as any); setPrefabCache(B, makeB() as any); setPrefabCache(D, dPrefab as any);

    const root = instantiatePrefab(dPrefab as any); setPrefabSource(root, D);
    const a = aRoot();
    writeTraitFieldImpl(a, TRAITS[0], 'x', 7); markOverride(a, 'Transform', 'x');
    const scene = await serializeScene();
    const deep = scene.entities.find((e) => e.prefab === D)!.nestedOverrides;

    // Reload into a fresh world via the editor forwarder (mirrors runtime apply).
    testWorld = createWorld(); index.clear();
    const root2 = instantiatePrefab(dPrefab as any, 0, undefined, deep); setPrefabSource(root2, D);
    expect((index.get(aRoot())!.get(Transform) as any).x).toBe(7);
  });
});
