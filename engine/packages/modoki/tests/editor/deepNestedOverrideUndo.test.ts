/** Missing Test 6 (editor-prefab-system.md) — deep nesting + per-field override
 *  + UNDO. Serialize and refresh of an arbitrary-depth scene override are covered
 *  (deepNestedOverrideSerialize / nestedSceneOverride); the triple combo with the
 *  real undo manager was not.
 *
 *  A live world D ⟵ B ⟵ A (D nests B nests A) gets a scene edit on A two levels
 *  deep. We push a real field-edit undo entry (mirroring what the Inspector does:
 *  redo writes the field + marks the override, undo restores the prior value +
 *  clears the mark) and drive the REAL async undoManager. After the edit the deep
 *  override serializes onto D's path-keyed `nestedOverrides`; after `await undo()`
 *  it is gone (back to base); after `await redo()` it is back — proving the
 *  deep-nest override path and the async undo stack compose correctly. */

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
// NB: undoManager is REAL here — this test drives its async undo/redo.

beforeEach(async () => {
  testWorld = createWorld(); index.clear(); guidN = 0;
  const { clearAllOverrideMarks } = await import('../../src/runtime/loaders/overrideMarks');
  clearAllOverrideMarks();
  const { clearHistory } = await import('../../src/editor/undo/undoManager');
  clearHistory();
});

const A = 'eeeeeeee-0000-4000-8000-0000000000aa';
const B = 'eeeeeeee-0000-4000-8000-0000000000bb';
const D = 'eeeeeeee-0000-4000-8000-0000000000dd';

const aPrefab = { id: A, version: 1 as const, name: 'A', rootLocalId: 1, entities: [{ localId: 1, name: 'A1', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'A1', parentId: 0, guid: '' } } }] };
const bPrefab = { id: B, version: 2 as const, name: 'B', rootLocalId: 1, entities: [
  { localId: 1, name: 'B1', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'B1', parentId: 0, guid: '' } } },
  { localId: 2, name: 'A1', prefab: A, traits: { EntityAttributes: { name: 'A1', parentId: 1, guid: '' } } },
] };
const dPrefab = { id: D, version: 2 as const, name: 'D', rootLocalId: 1, entities: [
  { localId: 1, name: 'D1', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'D1', parentId: 0, guid: '' } } },
  { localId: 2, name: 'B1', prefab: B, traits: { EntityAttributes: { name: 'B1', parentId: 1, guid: '' } } },
] };

function aRoot(): number {
  let id = 0;
  testWorld.query(PrefabInstance).updateEach(([pi], e) => { const p = pi as any; if (p.source === A && p.rootInstanceId === e.id()) id = e.id(); });
  return id;
}

describe('Missing Test 6 — deep-nested override + per-field edit + undo (real async undoManager)', () => {
  it('undo restores the deep member to base (override gone); redo re-applies it', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource } = await import('../../src/editor/scene/prefab');
    const { serializeScene } = await import('../../src/editor/scene/serialize');
    const { markOverride, clearOverrideMarks } = await import('../../src/runtime/loaders/overrideMarks');
    const { pushAction, undo, redo } = await import('../../src/editor/undo/undoManager');

    setPrefabCache(A, aPrefab as any); setPrefabCache(B, bPrefab as any); setPrefabCache(D, dPrefab as any);

    const root = instantiatePrefab(dPrefab as any); setPrefabSource(root, D);
    const a = aRoot();
    expect(a).toBeGreaterThan(0);
    expect((index.get(a)!.get(Transform) as any).x).toBe(0); // base

    // Mirror an Inspector field edit on the deeply-nested member A: write x=7 and
    // mark the override, with an undo that restores the prior value + clears the mark.
    const prior = 0;
    const next = 7;
    const doEdit = () => { writeTraitFieldImpl(a, TRAITS[0], 'x', next); markOverride(a, 'Transform', 'x'); };
    doEdit();
    pushAction({
      label: 'Edit A1.Transform.x',
      redo: () => { writeTraitFieldImpl(a, TRAITS[0], 'x', next); markOverride(a, 'Transform', 'x'); },
      undo: () => { writeTraitFieldImpl(a, TRAITS[0], 'x', prior); clearOverrideMarks(a); },
    });

    // After the edit: deep override serializes onto D's path "2.2".
    let scene = await serializeScene();
    let top = scene.entities.find((e) => e.prefab === D)!;
    expect(top.nestedOverrides).toEqual({ '2.2': { 1: { Transform: { x: 7 } } } });

    // UNDO (awaited — undoManager is async): member back to base, no deep override.
    const undone = await undo();
    expect(undone).toBe(true);
    expect((index.get(a)!.get(Transform) as any).x).toBe(0);
    scene = await serializeScene();
    top = scene.entities.find((e) => e.prefab === D)!;
    expect(top.nestedOverrides ?? {}).toEqual({});

    // REDO: the deep override returns exactly.
    const redone = await redo();
    expect(redone).toBe(true);
    expect((index.get(a)!.get(Transform) as any).x).toBe(7);
    scene = await serializeScene();
    top = scene.entities.find((e) => e.prefab === D)!;
    expect(top.nestedOverrides).toEqual({ '2.2': { 1: { Transform: { x: 7 } } } });
  });
});
