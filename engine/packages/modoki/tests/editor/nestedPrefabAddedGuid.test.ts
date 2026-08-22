/** A user-added NESTED prefab instance keeps its own guid across an editor rebuild.
 *
 *  Found by the close-out sweep for QA-PREFAB-0004, which fixed the LOADER's copy of this.
 *  `grep -rn spawnNestedInstance` returns exactly two implementations of `StructureApplyOps` —
 *  the runtime loader and this editor path — and only the loader was fixed.
 *
 *  It matters more here, not less: `captureNestedRef` reads the live guid onto the reference
 *  node precisely so a rebuild can put it back, and `rebuildInstance` already does exactly that
 *  for the OUTER root ("refs into the instance survive the rebuild"). Dropping it on the nested
 *  root means Revert to Prefab / Apply / the undo of a prefab drop re-expands it with the
 *  TEMPLATE's guid — and prefab templates clear member guids, so it comes back as `''`: not
 *  addressable by guid at all, which is worse than the loader's fresh-guid churn. */

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

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); index.set(e.id(), e); return e; },
  unregisterEntity: (e: any) => index.delete(e.id()),
  destroyEntity: (e: any) => { index.delete(e.id()); e.destroy(); },
  findEntityByGuid: vi.fn(),
  indexEntityGuid: vi.fn(),
}));
vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => {
    const out: { id: number; name: string; parentId: number; sortOrder: number; traits: string[] }[] = [];
    testWorld.query(EntityAttributes).updateEach(([ea]: any[], e: any) => {
      const d = ea as Record<string, unknown>;
      out.push({ id: e.id(), name: d.name as string, parentId: d.parentId as number, sortOrder: 0, traits: [] });
    });
    return out;
  },
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: vi.fn(),
  readTraitData: (id: number, meta: any) => {
    const e: any = index.get(id);
    if (!e || !e.has(meta.trait)) return null;
    const data = e.get(meta.trait);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(meta.fields)) out[k] = data[k];
    return out;
  },
  readTraitDataFull: (id: number, meta: any) => {
    const e: any = index.get(id);
    return e && e.has(meta.trait) ? { ...e.get(meta.trait) } : null;
  },
  // A REAL implementation, unlike the sibling files' vi.fn(): the whole claim here is that the
  // guid actually lands on the entity, which a spy cannot show.
  writeTraitField: (id: number, meta: any, field: string, value: unknown) => {
    const e: any = index.get(id);
    if (!e || !e.has(meta.trait)) return;
    e.set(meta.trait, { ...e.get(meta.trait), [field]: value });
  },
  subtreeIds: () => [],
}));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => TRAITS.find((t) => t.name === n),
  getAllTraits: () => TRAITS,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn() }));
vi.mock('../../src/runtime/ui/uiTreeStore', () => ({ markUIDirty: vi.fn() }));
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  newGuid: () => 'gen-guid',
  registerAsset: vi.fn(),
  getGuidForPath: () => undefined,
  isGuid: (s: string) => typeof s === 'string' && s.includes('-'),
  resolveRef: (g: string) => `/__prefabs__/${g}.json`,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));

const OUTER = 'aaaaaaaa-0000-4000-8000-00000000oute';
const ADDED = 'aaaaaaaa-0000-4000-8000-000000added';
const NESTED_GUID = 'c913bd4a-3cc3-4201-9cef-30479f890e80';

/** Templates clear member guids — that is exactly why a dropped guid comes back EMPTY. */
const outerPrefab = {
  id: OUTER, version: 1 as const, name: 'Outer', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'O1', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'O1', parentId: 0, guid: '' } } },
    { localId: 2, name: 'O2', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'O2', parentId: 1, guid: '' } } },
  ],
};
const addedPrefab = {
  id: ADDED, version: 1 as const, name: 'Added', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'A1', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'A1', parentId: 0, guid: '' } } },
  ],
};

beforeEach(() => { testWorld = createWorld(); index.clear(); });

function guidOf(id: number): string {
  const e: any = index.get(id);
  return e?.has(EntityAttributes) ? (e.get(EntityAttributes).guid as string) : '<missing>';
}

async function expandWithNestedAdd(guid: string) {
  const mod = await import('../../src/editor/scene/prefab');
  mod.setPrefabCache(ADDED, addedPrefab as never);
  const rootId = mod.instantiatePrefab(outerPrefab as never, 0);
  mod.setPrefabSource(rootId, OUTER);
  mod.applyStructureByRootInstance(rootId, outerPrefab as never, {
    added: [{
      parentLocalId: 2, guid, name: 'A1', traits: {}, children: [], prefab: ADDED,
    }],
  } as never);
  return { mod, rootId };
}

/** The nested instance root is the ADDED-sourced entity. */
function nestedRootId(): number {
  let found = 0;
  testWorld.query(PrefabInstance).updateEach(([pi]: any[], e: any) => {
    if (!found && (pi as Record<string, unknown>).source === ADDED) found = e.id();
  });
  return found;
}

describe('applyStructureByRootInstance — user-added nested instance guid', () => {
  it('re-expands the nested instance under its CAPTURED guid', async () => {
    await expandWithNestedAdd(NESTED_GUID);
    const id = nestedRootId();
    expect(id).toBeGreaterThan(0);
    expect(guidOf(id)).toBe(NESTED_GUID);
  });

  it('leaves the guid empty when the node carries none (no invented identity)', async () => {
    await expandWithNestedAdd('');
    const id = nestedRootId();
    expect(id).toBeGreaterThan(0);
    expect(guidOf(id)).toBe('');
  });

  it('does not disturb the OUTER instance root', async () => {
    const { rootId } = await expandWithNestedAdd(NESTED_GUID);
    expect(guidOf(rootId)).not.toBe(NESTED_GUID);
  });
});
