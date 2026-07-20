/** Apply-to-prefab tears down an instance and re-instantiates it from the new
 *  prefab. The re-instantiated root must keep its ORIGINAL parent — otherwise a
 *  nested instance (root hung under an outer member) or any instance parented to
 *  a non-root entity gets detached to the scene root on every apply. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, sortOrder: 0, parentId: 0, guid: '' as string });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, sortOrder: 0, parentId: 0, guid: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0 } },
] as const;

let testWorld: ReturnType<typeof createWorld>;
const index = new Map<number, any>();
const traitNamesOf = (e: any) => TRAITS.filter((t) => e.has(t.trait)).map((t) => t.name);

function getAllEntitiesImpl() {
  const out: { id: number; name: string; parentId: number; sortOrder: number; traits: string[] }[] = [];
  testWorld.query(EntityAttributes).updateEach(([ea], e) => {
    const d = ea as Record<string, unknown>;
    out.push({ id: e.id(), name: d.name as string, parentId: d.parentId as number, sortOrder: 0, traits: traitNamesOf(e) });
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
  deleteEntities: (ids: number[]) => { for (const id of ids) { index.get(id)?.destroy(); index.delete(id); } },
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
  writeTraitField: (id: number, meta: any, field: string, value: unknown) => {
    const e = index.get(id); if (!e || !e.has(meta.trait)) return;
    e.set(meta.trait, { ...(e.get(meta.trait) as object), [field]: value });
  },
}));
vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
  getAllTraits: () => TRAITS,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn() }));

// write-file always succeeds so apply runs to completion.
// @ts-expect-error mock global
global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));

beforeEach(() => { testWorld = createWorld(); index.clear(); });
const getModule = () => import('../../src/editor/scene/prefab');

const SRC = 'aaaaaaaa-0000-4000-8000-000000000abc';
const prefab = {
  id: SRC, version: 1 as const, name: 'Widget', rootLocalId: 1,
  entities: [{ localId: 1, name: 'Widget', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'Widget', parentId: 0, guid: '' } } }],
};

describe('apply-to-prefab refresh preserves the instance parent', () => {
  it('re-attaches the refreshed instance root to its original (non-root) parent', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, applyToPrefabSelective } = await getModule();
    setPrefabCache(SRC, prefab as any);

    // A plain parent entity ("Mount") that the instance hangs under.
    const mount = testWorld.spawn(EntityAttributes({ name: 'Mount', parentId: 0, guid: 'g-mount' }));
    index.set(mount.id(), mount);

    // Instantiate the prefab UNDER the mount.
    const rootId = instantiatePrefab(prefab as any, mount.id());
    setPrefabSource(rootId, SRC);
    expect((index.get(rootId)!.get(EntityAttributes) as Record<string, unknown>).parentId).toBe(mount.id());

    // Edit a field on the instance, then apply it back → triggers a full refresh.
    index.get(rootId)!.set(Transform, { x: 7, y: 0, z: 0 });
    const result = await applyToPrefabSelective(rootId, new Set(['1.Transform.x']));
    expect(result.promotedAdditions).toBe(0);

    // After refresh, exactly one Widget instance exists and it is STILL under Mount.
    const widgets = getAllEntitiesImpl().filter((e) => e.name === 'Widget');
    expect(widgets).toHaveLength(1);
    expect(widgets[0].parentId).toBe(mount.id());
  });
});
