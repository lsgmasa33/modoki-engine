/** Missing Test 9 (editor-prefab-system.md) — failed/partial instantiate leaves
 *  no ORPHANED partial subtree. The existing prefabInstantiateContract test asserts
 *  an uncached nested row is *skipped*; this asserts the stronger property the
 *  finding asked for: when expansion bails partway (a deeper nested prefab is
 *  uncached, or a reference CYCLE aborts the inner expand), the entities that DID
 *  spawn form a clean tree — every spawned entity's parent chain still resolves to
 *  the instance root (or the scene root), with nothing dangling off a never-spawned
 *  node, and the spawned count equals exactly the resolvable rows. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';
import { rowPlaceholderOf } from '../../src/runtime/core/unresolvedPrefabRef';

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

vi.mock('../../src/runtime/core/ecs/world', () => ({
  onWorldSwap: () => () => {},
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  findEntityById: (id: number) => index.get(id),
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); index.set(e.id(), e); return e; },
  unregisterEntity: (e: any) => index.delete(e.id()),
  destroyEntity: (e: any) => { ((e: any) => index.delete(e.id()))(e); e.destroy(); },
}));
vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => getAllEntitiesImpl(),
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: vi.fn(),
  readTraitData: vi.fn(),
  // Mirrors the real readTraitDataFull: the keys a trait PERSISTS — its koota
  // schema for a SoA trait, the live object's own keys for AoS — NOT the
  // meta.fields Inspector subset that readTraitData reads.
  readTraitDataFull: (id: number, meta: any) => {
    const e: any = index.get(id);
    if (!e || !e.has(meta.trait)) return null;
    if (meta.category === 'tag') return {};
    const data = e.get(meta.trait);
    const schema = (meta.trait as { schema?: unknown }).schema;
    const keys = schema && typeof schema === 'object' ? Object.keys(schema) : Object.keys(data);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = data[k];
    return out;
  },
  writeTraitField: vi.fn(),
}));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => TRAITS.find((t) => t.name === n),
  getAllTraits: () => TRAITS,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn(), replaceCachedPrefab: vi.fn() }));
vi.mock('../../src/runtime/ui/uiTreeStore', () => ({ markUIDirty: vi.fn() }));
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  onFontInvalidated: () => () => {},
  newGuid: () => 'gen-guid',
  registerAsset: vi.fn(),
  getGuidForPath: () => undefined,
  isGuid: (s: string) => typeof s === 'string' && s.includes('-'),
  resolveRef: (g: string) => `/__prefabs__/${g}.json`,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));

beforeEach(() => { testWorld = createWorld(); index.clear(); });
const getModule = () => Promise.all([import('../../src/editor/scene/prefabCache'), import('../../src/editor/scene/prefabInstantiate')]).then(([m0, m1]) => ({ ...m0, ...m1 }));

const findByName = (name: string): number => {
  let id = 0;
  testWorld.query(EntityAttributes).updateEach(([ea], e) => { if ((ea as any).name === name) id = e.id(); });
  return id;
};

/** Assert no spawned entity dangles: every entity's parentId is either 0 (scene
 *  root) or points at another LIVE entity in the world. A stranded partial subtree
 *  would show up as an entity whose parentId is a dead/never-spawned id. */
function expectNoOrphans(rootId: number) {
  const live = new Set(getAllEntitiesImpl().map((e) => e.id));
  for (const e of getAllEntitiesImpl()) {
    if (e.id === rootId) continue;
    expect(e.parentId === 0 || live.has(e.parentId)).toBe(true);
  }
}

describe('Missing Test 9 — partial instantiate leaves no orphaned subtree', () => {
  it('uncached GRANDCHILD: middle expands, deepest row is its placeholder, no dangling subtree', async () => {
    // Outer nests Mid (cached) nests Deep (NOT cached). Expansion expands Outer +
    // Mid fully; Deep's row is skipped. Nothing should dangle off the absent Deep.
    const OUTER = 'aaaaaaaa-0000-4000-8000-00000partial1';
    const MID = 'aaaaaaaa-0000-4000-8000-00000partial2';
    const DEEP = 'aaaaaaaa-0000-4000-8000-00000partial3'; // never cached

    const mid = {
      id: MID, version: 2 as const, name: 'Mid', rootLocalId: 1,
      entities: [
        { localId: 1, name: 'MidRoot', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'MidRoot', parentId: 0, guid: '' } } },
        { localId: 2, name: 'DeepRoot', prefab: DEEP, traits: { EntityAttributes: { name: 'DeepRoot', parentId: 1, guid: '' } } },
      ],
    };
    const outer = {
      id: OUTER, version: 2 as const, name: 'Outer', rootLocalId: 1,
      entities: [
        { localId: 1, name: 'OuterRoot', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'OuterRoot', parentId: 0, guid: '' } } },
        { localId: 2, name: 'MidRoot', prefab: MID, traits: { EntityAttributes: { name: 'MidRoot', parentId: 1, guid: '' } } },
      ],
    };

    const { instantiatePrefab, setPrefabCache } = await getModule();
    setPrefabCache(MID, mid as any); // Deep deliberately NOT cached

    const root = instantiatePrefab(outer as any);
    expect(root).toBeGreaterThan(0);

    // Outer + Mid expanded; Deep's row shows its Missing Prefab placeholder (#2001 S5, ruling D: today skipped it).
    expect(findByName('OuterRoot')).toBe(root);
    expect(findByName('MidRoot')).toBeGreaterThan(0);
    const deep = findByName('DeepRoot');
    expect(rowPlaceholderOf(index.get(deep))).toMatchObject({ source: DEEP, reason: 'missing' });
    expect((index.get(deep).get(EntityAttributes) as any).parentId).toBe(findByName('MidRoot'));
    // The two resolvable roots and the placeholder — no partial Deep fragment spawned.
    expect(getAllEntitiesImpl()).toHaveLength(3);
    // Mid hangs under Outer; nothing dangles off the absent Deep.
    const midId = findByName('MidRoot');
    expect((index.get(midId).get(EntityAttributes) as any).parentId).toBe(root);
    expectNoOrphans(root);
  });

  it('reference CYCLE: the self-nested row is a damaged placeholder, outer stays clean', async () => {
    // A prefab that nests ITSELF. The inner recursion hits the _stack guard and
    // returns 0; the outer row is skipped (if (!childRoot) continue). The single
    // top-level root spawns; no partial cyclic subtree accumulates.
    const SELF = 'bbbbbbbb-0000-4000-8000-00000cycle001';
    const self = {
      id: SELF, version: 2 as const, name: 'Self', rootLocalId: 1,
      entities: [
        { localId: 1, name: 'SelfRoot', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'SelfRoot', parentId: 0, guid: '' } } },
        { localId: 2, name: 'SelfNested', prefab: SELF, traits: { EntityAttributes: { name: 'SelfNested', parentId: 1, guid: '' } } },
      ],
    };

    const { instantiatePrefab, setPrefabCache } = await getModule();
    setPrefabCache(SELF, self as any);

    const root = instantiatePrefab(self as any);
    expect(root).toBeGreaterThan(0);
    // The top SelfRoot, and the self-nested row as a DAMAGED placeholder (#2001 S5, rule 9 + ruling D, hub 2026-10-02):
    // today skipped the row silently; the cycle is now shown, and the row round-trips verbatim.
    expect(findByName('SelfRoot')).toBe(root);
    expect(rowPlaceholderOf(index.get(findByName('SelfNested')))).toMatchObject({ source: SELF, reason: 'damaged' });
    expect(getAllEntitiesImpl()).toHaveLength(2);
    expectNoOrphans(root);
  });
});
