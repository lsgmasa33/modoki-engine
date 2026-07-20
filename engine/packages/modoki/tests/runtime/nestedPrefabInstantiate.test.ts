/** Nested prefab instantiation (runtime). A prefab row carrying a `prefab` ref
 *  recursively expands the child prefab. The two instances must stay distinct:
 *  inner members get the inner root's rootInstanceId, the inner root hangs under
 *  the outer member via its parentId, and the outer pass must NOT stomp inner
 *  rootInstanceIds. Also guards against reference cycles. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

let testWorld: ReturnType<typeof createWorld>;
const cachedPrefabs = new Map<string, unknown>();

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: vi.fn(),
  setStructureCallback: vi.fn(),
  indexEntityGuid: () => {},
  findEntityById: (_id: number) => undefined,
  findEntityByGuid: (guid: string, world: any = testWorld) => {
    let found: any;
    world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (!found && ea.guid === guid) found = e; });
    return found;
  },
}));

vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: '', parentId: 0, guid: '' } },
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

/** Snapshot every PrefabInstance entity: { source, localId, rootInstanceId, parentId }. */
function snapshot() {
  const out: { id: number; source: string; localId: number; rootInstanceId: number; parentId: number }[] = [];
  testWorld.query(PrefabInstance, EntityAttributes).updateEach(([pi, ea], e) => {
    out.push({
      id: e.id(),
      source: (pi as Record<string, unknown>).source as string,
      localId: (pi as Record<string, unknown>).localId as number,
      rootInstanceId: (pi as Record<string, unknown>).rootInstanceId as number,
      parentId: (ea as Record<string, unknown>).parentId as number,
    });
  });
  return out;
}

const innerPrefab = {
  id: 'Inner', rootLocalId: 1,
  entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'I1', parentId: 0 } } },
    { localId: 2, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'I2', parentId: 1 } } },
  ],
};
const outerPrefab = {
  id: 'Outer', rootLocalId: 1,
  entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'O1', parentId: 0 } } },
    { localId: 2, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'O2', parentId: 1 } } },
    // nested-instance row: hangs under O2 (outer localId 2), expands Inner.
    { localId: 3, prefab: 'Inner', traits: { EntityAttributes: { name: 'Inner', parentId: 2 } } },
  ],
};

describe('instantiatePrefabIntoWorld — nested prefabs', () => {
  it('expands a nested prefab with correct rootInstanceId + parent chain', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();
    cachedPrefabs.set('Inner', innerPrefab);

    const outerRoot = instantiatePrefabIntoWorld(testWorld, outerPrefab, 0, undefined, 'Outer');

    const snap = snapshot();
    expect(snap).toHaveLength(4); // O1, O2, I1, I2

    const byName = (n: string) => snap.find(s => s.localId === ({ O1: 1, O2: 2, I1: 1, I2: 2 }[n]) &&
      s.source === (n.startsWith('O') ? 'Outer' : 'Inner'))!;
    const O1 = byName('O1'), O2 = byName('O2'), I1 = byName('I1'), I2 = byName('I2');

    // Outer members share the outer root's rootInstanceId.
    expect(O1.rootInstanceId).toBe(outerRoot);
    expect(O2.rootInstanceId).toBe(outerRoot);
    expect(O1.parentId).toBe(0);          // root → scene parent
    expect(O2.parentId).toBe(O1.id);

    // Inner members form their OWN instance, rooted at I1.
    expect(I1.rootInstanceId).toBe(I1.id);   // NOT stomped to outerRoot
    expect(I2.rootInstanceId).toBe(I1.id);
    expect(I1.parentId).toBe(O2.id);         // inner root hangs under the outer member
    expect(I2.parentId).toBe(I1.id);

    // The two instances are genuinely distinct.
    expect(I1.rootInstanceId).not.toBe(outerRoot);
  });

  it('collectResourceRefsFromEntities emits a prefab ref for a nested `prefab` field', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const childGuid = 'aaaaaaaa-0000-4000-8000-0000000000cc';
    const refs = collectResourceRefsFromEntities([
      { id: 1, prefab: childGuid, traits: { EntityAttributes: { name: 'Nested', parentId: 0 } } },
    ] as any);
    // SceneManager walks each fetched prefab with this collector to discover (and
    // acquire) nested children — so the nested guid MUST be surfaced as a prefab ref.
    expect(refs.some((r) => r.type === 'prefab' && r.path === childGuid)).toBe(true);
  });

  it('expands the SAME nested prefab twice as siblings (no false cycle)', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();
    cachedPrefabs.set('Inner', innerPrefab);
    // Outer nests Inner under BOTH O1 and O2 (like two engine flames sharing one
    // flame prefab). The cycle guard must not trip on the second expansion.
    const twin = {
      id: 'Twin', rootLocalId: 1,
      entities: [
        { localId: 1, traits: { EntityAttributes: { name: 'T1', parentId: 0 } } },
        { localId: 2, prefab: 'Inner', traits: { EntityAttributes: { name: 'L', parentId: 1 } } },
        { localId: 3, prefab: 'Inner', traits: { EntityAttributes: { name: 'R', parentId: 1 } } },
      ],
    };
    const root = instantiatePrefabIntoWorld(testWorld, twin, 0, undefined, 'Twin');
    const snap = snapshot();
    // Outer T1 + TWO full Inner instances (I1+I2 each) = 1 + 4 = 5 entities.
    expect(snap.filter((s) => s.source === 'Twin')).toHaveLength(1);
    const innerRoots = snap.filter((s) => s.source === 'Inner' && s.rootInstanceId === s.id);
    expect(innerRoots).toHaveLength(2);                     // both nested copies expanded
    expect(snap.filter((s) => s.source === 'Inner')).toHaveLength(4); // 2 members × 2 copies
    expect(root).toBeGreaterThan(0);
  });

  it('derives stable, non-colliding member GUIDs end-to-end (instantiate → deriveInstanceMemberGuids)', async () => {
    const { instantiatePrefabIntoWorld, deriveInstanceMemberGuids } = await getLoader();
    const { deriveGuid, isGuid } = await import('../../src/runtime/loaders/assetManifest');
    cachedPrefabs.set('Inner', innerPrefab);

    // Outer nests the SAME Inner prefab under two rows (3 & 4) — siblings whose
    // inner members share localIds and would collide without parentLocalId steps.
    const twin = {
      id: 'Twin', rootLocalId: 1,
      entities: [
        { localId: 1, traits: { EntityAttributes: { name: 'T1', parentId: 0 } } },
        { localId: 3, prefab: 'Inner', traits: { EntityAttributes: { name: 'L', parentId: 1 } } },
        { localId: 4, prefab: 'Inner', traits: { EntityAttributes: { name: 'R', parentId: 1 } } },
      ],
    };
    const root = instantiatePrefabIntoWorld(testWorld, twin, 0, undefined, 'Twin');

    // The scene loader assigns the instance ROOT a scene guid; do the same here so
    // derivation has an anchor.
    const SCENE_GUID = 'abcdabcd-1234-4321-abcd-abcdabcdabcd';
    for (const e of testWorld.entities) {
      if ((e as { id(): number }).id() === root) {
        (e as any).set(EntityAttributes, { ...(e as any).get(EntityAttributes), guid: SCENE_GUID });
      }
    }

    deriveInstanceMemberGuids(testWorld);

    // Collect every Inner member's derived guid.
    const innerGuids: string[] = [];
    testWorld.query(PrefabInstance, EntityAttributes).updateEach(([pi, ea], _e) => {
      if ((pi as Record<string, unknown>).source === 'Inner') {
        innerGuids.push((ea as Record<string, string>).guid);
      }
    });

    expect(innerGuids).toHaveLength(4);                 // 2 members × 2 sibling instances
    expect(innerGuids.every(isGuid)).toBe(true);        // all derived + well-formed
    expect(new Set(innerGuids).size).toBe(4);           // NO collisions across siblings
    // Deterministic: the two inner roots are derived from their producing rows.
    expect(innerGuids).toContain(deriveGuid(`${SCENE_GUID}|3`));
    expect(innerGuids).toContain(deriveGuid(`${SCENE_GUID}|4`));

    // Idempotent — a second derivation pass changes nothing.
    deriveInstanceMemberGuids(testWorld);
    const again: string[] = [];
    testWorld.query(PrefabInstance, EntityAttributes).updateEach(([pi, ea], _e) => {
      if ((pi as Record<string, unknown>).source === 'Inner') again.push((ea as Record<string, string>).guid);
    });
    expect(again.sort()).toEqual(innerGuids.sort());
  });

  it('spawnPrefabInstance mints a FRESH root guid per runtime instance (no collisions)', async () => {
    const { spawnPrefabInstance } = await getLoader();
    const { isGuid } = await import('../../src/runtime/loaders/assetManifest');
    cachedPrefabs.set('Inner', innerPrefab);

    // Two runtime instantiations of the SAME prefab (gameplay spawns, not scene-load).
    const rootA = spawnPrefabInstance(testWorld, innerPrefab, { source: 'Inner' });
    const rootB = spawnPrefabInstance(testWorld, innerPrefab, { source: 'Inner' });
    expect(rootA).toBeGreaterThan(0);
    expect(rootB).toBeGreaterThan(0);
    expect(rootA).not.toBe(rootB);

    const guidOf = (id: number): string => {
      let g = '';
      for (const e of testWorld.entities) {
        if ((e as { id(): number }).id() === id) { g = ((e as any).get(EntityAttributes)?.guid as string) || ''; break; }
      }
      return g;
    };
    const guidA = guidOf(rootA);
    const guidB = guidOf(rootB);
    expect(isGuid(guidA)).toBe(true);
    expect(isGuid(guidB)).toBe(true);
    expect(guidA).not.toBe(guidB); // distinct root guids → instances never collide

    // Members derive off each unique root, so every member guid is unique too.
    const memberGuids: string[] = [];
    testWorld.query(PrefabInstance, EntityAttributes).updateEach(([_pi, ea]) => {
      const g = (ea as Record<string, string>).guid;
      if (g) memberGuids.push(g);
    });
    expect(memberGuids.length).toBe(new Set(memberGuids).size); // no duplicate guids anywhere
  });

  it('applies scene nestedOverrides to the nested instance + stamps parentLocalId', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();
    cachedPrefabs.set('Inner', innerPrefab);

    // Scene-level override on the nested instance at outer row localId 3: set the
    // inner root's (innerLocalId 1) Transform.x to 99.
    const nestedOverrides = { 3: { 1: { Transform: { x: 99 } } } };
    instantiatePrefabIntoWorld(testWorld, outerPrefab, 0, undefined, 'Outer', undefined, undefined, undefined, nestedOverrides);

    // Find the inner root (source Inner, self-rooted) and read its live data.
    let innerRootX: number | undefined;
    let innerRootParentLocal: number | undefined;
    testWorld.query(PrefabInstance, Transform).updateEach(([pi, tf], e) => {
      const p = pi as Record<string, unknown>;
      if (p.source === 'Inner' && p.rootInstanceId === e.id()) {
        innerRootX = (tf as Record<string, number>).x;
        innerRootParentLocal = p.parentLocalId as number;
      }
    });
    expect(innerRootX).toBe(99);          // scene override applied to the nested instance
    expect(innerRootParentLocal).toBe(3); // stamped with the producing row's localId
  });

  it('mergeOverrideMaps overlays b on a (b wins) without mutating inputs', async () => {
    const { mergeOverrideMaps } = await getLoader();
    const a = { 1: { Transform: { x: 1, y: 2 } } };
    const b = { 1: { Transform: { x: 9 }, EngineFlame: { idleScale: 0.5 } }, 2: { Transform: { z: 3 } } };
    const out = mergeOverrideMaps(a, b);
    expect(out[1].Transform).toEqual({ x: 9, y: 2 });        // b.x wins, a.y kept
    expect(out[1].EngineFlame).toEqual({ idleScale: 0.5 });  // added from b
    expect(out[2].Transform).toEqual({ z: 3 });              // added from b
    expect(a[1].Transform).toEqual({ x: 1, y: 2 });          // a not mutated
  });

  it('does not hang on a reference cycle (Outer ↔ Inner)', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();
    const cyclicInner = {
      id: 'Inner', rootLocalId: 1,
      entities: [
        { localId: 1, traits: { EntityAttributes: { name: 'I1', parentId: 0 } } },
        { localId: 2, prefab: 'Outer', traits: { EntityAttributes: { name: 'Outer', parentId: 1 } } },
      ],
    };
    cachedPrefabs.set('Inner', cyclicInner);
    cachedPrefabs.set('Outer', outerPrefab);

    expect(() => instantiatePrefabIntoWorld(testWorld, outerPrefab, 0, undefined, 'Outer')).not.toThrow();
    // Outer expanded once; the cycle back to Outer is refused (cycle guard).
    const outers = snapshot().filter(s => s.source === 'Outer');
    expect(outers.length).toBeGreaterThan(0);
  });
});
