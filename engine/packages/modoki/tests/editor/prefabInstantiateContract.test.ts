/** Two contracts the prefab system relies on but that were previously untested,
 *  both surfaced during the architecture review (see PREFAB_REVIEW.md):
 *
 *   1. PRELOAD CONTRACT — `instantiatePrefab` is SYNCHRONOUS, so a nested
 *      (v2) prefab's children only expand if the child file is already in the
 *      editor prefab cache. Callers MUST `await preloadNestedPrefabs(prefab)`
 *      first. Without it the nested row is silently skipped. The UI instantiate
 *      paths (Assets) honor this; this test pins the contract so a regression in
 *      a caller that forgets the preload is caught by the negative case.
 *
 *   2. EDITOR RE-ANCHOR — `applyStructureByRootInstance` re-anchors an added
 *      subtree whose anchor localId is merely MISSING from the prefab to the
 *      instance root (rather than dropping it). The runtime twin
 *      `applyStructureByLocalToEcs` now does the SAME (review F7 routed both through
 *      one shared `applyStructureCore`; parity is pinned by structuralApplyParity.test.ts).
 *      This test pins the editor side; an anchor *removed this pass* is still skipped. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';
import { markUIDirty } from '../../src/runtime/ui/uiTreeStore';

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
// UI projection dirty signal — a UI prefab won't render without it (see fix).
vi.mock('../../src/runtime/ui/uiTreeStore', () => ({ markUIDirty: vi.fn() }));

const fileServer = new Map<string, unknown>(); // guid -> prefab JSON
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  newGuid: () => 'gen-guid',
  registerAsset: vi.fn(),
  getGuidForPath: () => undefined,
  isGuid: (s: string) => typeof s === 'string' && s.includes('-'),
  resolveRef: (g: string) => `/__prefabs__/${g}.json`,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));
// @ts-expect-error mock global
global.fetch = vi.fn(async (url: string) => {
  const m = /\/__prefabs__\/(.+)\.json$/.exec(url);
  const guid = m?.[1];
  if (guid && fileServer.has(guid)) return { ok: true, json: async () => fileServer.get(guid) } as Response;
  return { ok: false, json: async () => ({}) } as Response;
});

beforeEach(() => { testWorld = createWorld(); index.clear(); fileServer.clear(); });
const getModule = () => import('../../src/editor/scene/prefab');

const countByName = (name: string) =>
  getAllEntitiesImpl().filter((e) => e.name === name).length;
const findByName = (name: string): number => {
  let id = 0;
  testWorld.query(EntityAttributes).updateEach(([ea], e) => { if ((ea as any).name === name) id = e.id(); });
  return id;
};

describe('preload contract — instantiatePrefab needs nested children cached first', () => {
  // Unique GUIDs per describe so the module-level prefabCache from other tests
  // can't accidentally satisfy the "no preload" case.
  const INNER = 'cccccccc-0000-4000-8000-00000contract1';
  const OUTER = 'cccccccc-0000-4000-8000-00000contract2';
  const inner = {
    id: INNER, version: 1 as const, name: 'Inner', rootLocalId: 1,
    entities: [{ localId: 1, name: 'InnerRoot', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'InnerRoot', parentId: 0, guid: '' } } }],
  };
  const outer = {
    id: OUTER, version: 2 as const, name: 'Outer', rootLocalId: 1,
    entities: [
      { localId: 1, name: 'OuterRoot', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'OuterRoot', parentId: 0, guid: '' } } },
      { localId: 2, name: 'InnerRoot', prefab: INNER, traits: { EntityAttributes: { name: 'InnerRoot', parentId: 1, guid: '' } } },
    ],
  };

  it('WITHOUT preload: the nested row is silently skipped (children not expanded)', async () => {
    fileServer.set(INNER, inner);
    const { instantiatePrefab } = await getModule();
    const root = instantiatePrefab(outer as any);
    expect(root).toBeGreaterThan(0);
    expect(countByName('OuterRoot')).toBe(1);
    // Nested child was never cached → row skipped → no InnerRoot in the world.
    expect(countByName('InnerRoot')).toBe(0);
  });

  it('WITH preloadNestedPrefabs: the nested child expands under its outer member', async () => {
    fileServer.set(INNER, inner);
    const { instantiatePrefab, preloadNestedPrefabs } = await getModule();
    await preloadNestedPrefabs(outer as any);
    const root = instantiatePrefab(outer as any);
    expect(root).toBeGreaterThan(0);
    expect(countByName('OuterRoot')).toBe(1);
    expect(countByName('InnerRoot')).toBe(1);
    // The inner root hangs under the outer root (ecs-id parent chain).
    const innerId = findByName('InnerRoot');
    const ea = index.get(innerId).get(EntityAttributes) as Record<string, unknown>;
    expect(ea.parentId).toBe(root);
  });
});

describe('UI render signal — instantiatePrefab marks the UI projection dirty', () => {
  // A UI prefab (UIElement entities) only renders when the DOM UI tree is rebuilt,
  // which requires markUIDirty(); markStructureDirty() alone (Hierarchy) is not
  // enough. Without this a UI prefab instantiates but renders nothing.
  const SRC = 'eeeeeeee-0000-4000-8000-0000000uidirt';
  const prefab = {
    id: SRC, version: 1 as const, name: 'UIPanel', rootLocalId: 1,
    entities: [{ localId: 1, name: 'Panel', traits: { EntityAttributes: { name: 'Panel', parentId: 0, guid: '', sortOrder: 0 } } }],
  };

  it('calls markUIDirty on instantiate', async () => {
    const { instantiatePrefab } = await getModule();
    (markUIDirty as unknown as ReturnType<typeof vi.fn>).mockClear();
    instantiatePrefab(prefab as any);
    expect(markUIDirty).toHaveBeenCalled();
  });
});

describe('editor applyStructureByRootInstance — missing anchor re-anchors to root', () => {
  const SRC = 'dddddddd-0000-4000-8000-0000reanchor1';
  // Flat prefab: root (1) + one member child (2).
  const prefab = {
    id: SRC, version: 1 as const, name: 'P', rootLocalId: 1,
    entities: [
      { localId: 1, name: 'Root', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Root', parentId: 0, guid: '' } } },
      { localId: 2, name: 'Child', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Child', parentId: 1, guid: '' } } },
    ],
  };

  it('spawns the added subtree under the instance root when its parentLocalId is gone', async () => {
    const { instantiatePrefab, applyStructureByRootInstance } = await getModule();
    const root = instantiatePrefab(prefab as any);
    expect(root).toBeGreaterThan(0);

    // An added subtree anchored at a localId that does not exist in this instance.
    applyStructureByRootInstance(root, prefab as any, {
      added: [{
        parentLocalId: 99, // <- missing
        guid: 'added-guid',
        name: 'Orphan',
        traits: { Transform: { x: 5 }, EntityAttributes: { name: 'Orphan', parentId: 0, guid: 'added-guid' } },
        children: [],
      }],
    });

    expect(countByName('Orphan')).toBe(1);
    // Editor behavior: re-anchored to the instance root (NOT dropped).
    const orphanId = findByName('Orphan');
    const ea = index.get(orphanId).get(EntityAttributes) as Record<string, unknown>;
    expect(ea.parentId).toBe(root);
  });
});
