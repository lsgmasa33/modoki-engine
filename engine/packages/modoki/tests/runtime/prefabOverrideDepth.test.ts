/** Arbitrary-DEPTH override layering (runtime). A scene/outer layer can override a
 *  member nested any number of levels down, and the OUTERMOST layer wins at every
 *  depth. Chain: scene ⟵ prefab D ⟵ prefab B ⟵ prefab A. The override is addressed
 *  by a dot-joined path of nested-row localIds ("2.2" = A, reached via D's B-row 2
 *  then B's A-row 2). Verifies forwarding, precedence, and base propagation. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

let testWorld: ReturnType<typeof createWorld>;
const cachedPrefabs = new Map<string, unknown>();

vi.mock('../../src/runtime/ecs/world', () => ({ getCurrentWorld: () => testWorld, registerEntity: vi.fn(), setStructureCallback: vi.fn() }));
vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: '', parentId: 0 } },
    { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: '', localId: 0, rootInstanceId: 0, parentLocalId: 0 } },
  ];
  return { getAllTraits: () => traits, getTraitByName: (n: string) => traits.find(t => t.name === n) };
});
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  loadModelTemplates: vi.fn().mockResolvedValue(undefined),
  getCachedPrefab: (guid: string) => cachedPrefabs.get(guid) ?? null,
}));
vi.mock('../../src/runtime/ui/uiTreeStore', () => ({ markUIDirty: vi.fn() }));

beforeEach(() => { testWorld = createWorld(); cachedPrefabs.clear(); });
afterEach(() => { testWorld.destroy(); });
const getLoader = () => import('../../src/runtime/loaders/loadSceneFile');

// A ⟵ B ⟵ D. Each nests the previous at localId 2.
const makeA = (x: number) => ({ id: 'A', rootLocalId: 1, entities: [{ localId: 1, traits: { Transform: { x }, EntityAttributes: { name: 'A1', parentId: 0 } } }] });
const makeB = (aOverride?: Record<number, Record<string, Record<string, unknown>>>) => ({
  id: 'B', rootLocalId: 1,
  entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'B1', parentId: 0 } } },
    { localId: 2, prefab: 'A', traits: { EntityAttributes: { name: 'A1', parentId: 1 } }, ...(aOverride ? { overrides: aOverride } : {}) },
  ],
});
const makeD = (deepOnA?: Record<string, Record<number, Record<string, Record<string, unknown>>>>) => ({
  id: 'D', rootLocalId: 1,
  entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'D1', parentId: 0 } } },
    // nested B at row 2; D's own deep override on A rides on this row's nestedOverrides.
    { localId: 2, prefab: 'B', traits: { EntityAttributes: { name: 'B1', parentId: 1 } }, ...(deepOnA ? { nestedOverrides: deepOnA } : {}) },
  ],
});

function aRootX(): number | undefined {
  let x: number | undefined;
  testWorld.query(PrefabInstance, Transform).updateEach(([pi, tf], e) => {
    const p = pi as Record<string, unknown>;
    if (p.source === 'A' && p.rootInstanceId === e.id()) x = (tf as Record<string, number>).x;
  });
  return x;
}
/** Instantiate "scene": expand D, optional scene override on A via path "2.2". */
async function scene(D: ReturnType<typeof makeD>, sceneDeepOnA?: Record<number, Record<string, Record<string, unknown>>>) {
  const { instantiatePrefabIntoWorld } = await getLoader();
  const nestedOverrides = sceneDeepOnA ? { '2.2': sceneDeepOnA } : undefined;
  instantiatePrefabIntoWorld(testWorld, D, 0, undefined, 'D', undefined, undefined, undefined, nestedOverrides);
}

describe('arbitrary-depth override: scene ⟵ D ⟵ B ⟵ A', () => {
  it('expands all four levels with exactly one A instance', async () => {
    cachedPrefabs.set('A', makeA(1)); cachedPrefabs.set('B', makeB()); cachedPrefabs.set('D', makeD());
    await scene(makeD());
    let aCount = 0;
    testWorld.query(PrefabInstance).updateEach(([pi], e) => { const p = pi as any; if (p.source === 'A' && p.rootInstanceId === e.id()) aCount++; });
    expect(aCount).toBe(1);
    expect(aRootX()).toBe(1); // A base shows through B and D
  });

  it('SCENE overrides A two levels deep (path "2.2") — the deep value is applied', async () => {
    cachedPrefabs.set('A', makeA(1)); cachedPrefabs.set('B', makeB()); cachedPrefabs.set('D', makeD());
    await scene(makeD(), { 1: { Transform: { x: 7 } } });
    expect(aRootX()).toBe(7);
  });

  it('OUTERMOST WINS at depth: base 1 < B says 2 < D says 5 < scene says 7', async () => {
    cachedPrefabs.set('A', makeA(1));
    cachedPrefabs.set('B', makeB({ 1: { Transform: { x: 2 } } }));            // B overrides A
    cachedPrefabs.set('D', makeD({ '2': { 1: { Transform: { x: 5 } } } }));   // D deep-overrides A (through B's row 2)

    // D over B (no scene): D wins → 5.
    await scene(makeD({ '2': { 1: { Transform: { x: 5 } } } }));
    expect(aRootX()).toBe(5);

    // Scene over D over B: scene wins → 7.
    testWorld = createWorld();
    await scene(makeD({ '2': { 1: { Transform: { x: 5 } } } }), { 1: { Transform: { x: 7 } } });
    expect(aRootX()).toBe(7);
  });

  it('base propagation at depth: changing A base reaches the scene when unshadowed', async () => {
    cachedPrefabs.set('A', makeA(1)); cachedPrefabs.set('B', makeB()); cachedPrefabs.set('D', makeD());
    await scene(makeD());
    expect(aRootX()).toBe(1);
    testWorld = createWorld();
    cachedPrefabs.set('A', makeA(9));
    await scene(makeD());
    expect(aRootX()).toBe(9);
  });
});
