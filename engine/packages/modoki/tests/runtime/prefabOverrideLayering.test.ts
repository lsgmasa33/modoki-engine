/** Override LAYERING across a 3-tier chain: prefab A ⟵ prefab B (contains A) ⟵
 *  scene C (contains B). Resolution order for a field on A is:
 *      A base  <  B's nested-row override  <  C's scene nestedOverride
 *  (each higher layer wins; mergeOverrideMaps overlays the scene on the row).
 *  Because nested instances are stored as REFERENCES (never flattened), an A base
 *  change propagates into C wherever no higher layer shadows it. This file is the
 *  executable answer to "does our system layer A/B/C overrides correctly?". */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

let testWorld: ReturnType<typeof createWorld>;
const cachedPrefabs = new Map<string, unknown>();

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: vi.fn(),
  setStructureCallback: vi.fn(),
}));
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

// ── Fixtures ─────────────────────────────────────────────────────────────
// A: a one-member prefab whose root (localId 1) has Transform.x.
const makeA = (x: number) => ({
  id: 'A', rootLocalId: 1,
  entities: [{ localId: 1, traits: { Transform: { x }, EntityAttributes: { name: 'A1', parentId: 0 } } }],
});
// B: root B1 (localId 1) + a nested A row (localId 2). `aOverride` is B's override
// on A's members (keyed by A's localId), i.e. the middle layer.
const makeB = (aOverride?: Record<number, Record<string, Record<string, unknown>>>) => ({
  id: 'B', rootLocalId: 1,
  entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'B1', parentId: 0 } } },
    { localId: 2, prefab: 'A', traits: { EntityAttributes: { name: 'A1', parentId: 1 } }, ...(aOverride ? { overrides: aOverride } : {}) },
  ],
});

/** Live Transform.x of the A instance's root (source 'A', self-rooted). */
function aRootX(): number | undefined {
  let x: number | undefined;
  testWorld.query(PrefabInstance, Transform).updateEach(([pi, tf], e) => {
    const p = pi as Record<string, unknown>;
    if (p.source === 'A' && p.rootInstanceId === e.id()) x = (tf as Record<string, number>).x;
  });
  return x;
}

/** Instantiate "scene C": expand B, optionally with C's scene-level override on the
 *  A instance (nestedOverrides keyed by B's A-row localId = 2). */
async function instantiateSceneC(
  B: ReturnType<typeof makeB>,
  cOverrideOnA?: Record<number, Record<string, Record<string, unknown>>>,
) {
  const { instantiatePrefabIntoWorld } = await getLoader();
  const nestedOverrides = cOverrideOnA ? { 2: cOverrideOnA } : undefined;
  instantiatePrefabIntoWorld(testWorld, B, 0, undefined, 'B', undefined, undefined, undefined, nestedOverrides);
}

describe('override layering across prefab A ⟵ prefab B ⟵ scene C', () => {
  it('CASE 1 — no overrides: A base is used, and an A base change propagates into C', async () => {
    cachedPrefabs.set('A', makeA(1));
    cachedPrefabs.set('B', makeB());
    await instantiateSceneC(makeB());
    expect(aRootX()).toBe(1); // A base shows through B into C

    // Change A's base (A is referenced, not flattened) → propagates on next load.
    testWorld = createWorld();
    cachedPrefabs.set('A', makeA(9));
    await instantiateSceneC(makeB());
    expect(aRootX()).toBe(9);
  });

  it('CASE 2 — B overrides A: C sees B’s override value, not A base', async () => {
    cachedPrefabs.set('A', makeA(1));
    const B = makeB({ 1: { Transform: { x: 2 } } }); // B overrides A.localId1 x = 2
    cachedPrefabs.set('B', B);
    await instantiateSceneC(B);
    expect(aRootX()).toBe(2);
  });

  it('CASE 3 — only C overrides A (no A/B override): C’s value wins', async () => {
    cachedPrefabs.set('A', makeA(1));
    cachedPrefabs.set('B', makeB());
    await instantiateSceneC(makeB(), { 1: { Transform: { x: 3 } } }); // C overrides A.localId1 x = 3
    expect(aRootX()).toBe(3);
  });

  it('PRECEDENCE — B and C both override A: the scene (C) wins over the prefab (B)', async () => {
    cachedPrefabs.set('A', makeA(1));
    const B = makeB({ 1: { Transform: { x: 2 } } }); // B says 2...
    cachedPrefabs.set('B', B);
    await instantiateSceneC(B, { 1: { Transform: { x: 3 } } }); // ...C says 3 → C wins
    expect(aRootX()).toBe(3);
  });

  it('PARTIAL — B overrides one field, A base change propagates to the OTHER field', async () => {
    // A defines x and (via base) y; B overrides only x. Changing A base y must still
    // reach C; B’s x override still shadows A base x.
    cachedPrefabs.set('A', { id: 'A', rootLocalId: 1, entities: [{ localId: 1, traits: { Transform: { x: 1, y: 5 }, EntityAttributes: { name: 'A1', parentId: 0 } } }] });
    const B = makeB({ 1: { Transform: { x: 2 } } });
    cachedPrefabs.set('B', B);
    await instantiateSceneC(B);

    let live: Record<string, number> | undefined;
    testWorld.query(PrefabInstance, Transform).updateEach(([pi, tf], e) => {
      const p = pi as Record<string, unknown>;
      if (p.source === 'A' && p.rootInstanceId === e.id()) live = tf as Record<string, number>;
    });
    expect(live!.x).toBe(2); // B override shadows A base x
    expect(live!.y).toBe(5); // A base y propagates (not shadowed by any layer)
  });
});
