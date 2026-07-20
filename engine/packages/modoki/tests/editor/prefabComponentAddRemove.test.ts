/** Adding / removing a COMPONENT on a prefab vs. an instance (integration).
 *  Components are the trickiest override category — they cross the value path
 *  (added trait → fields) and the structural path (removedTraits). Covers:
 *   - removing a prefab component from an instance → captured as removedTraits,
 *   - apply-to-prefab of that removal → prefab file loses it AND every instance
 *     loses it after refresh,
 *   - revert of that removal → the component is restored from the prefab base,
 *   - adding a component on one instance + apply → prefab gains it → a SECOND
 *     instance gains it on refresh (no clobbering of unrelated state). */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const Spin = trait({ speed: 0 });
const Glow = trait({ intensity: 0, radius: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'Spin', trait: Spin, category: 'component', fields: { speed: 0 } },
  { name: 'Glow', trait: Glow, category: 'component', fields: { intensity: 0, radius: 0 } },
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
function deleteEntitiesImpl(ids: number[]) {
  const childrenByParent = new Map<number, number[]>();
  for (const e of getAllEntitiesImpl()) {
    if (e.parentId > 0) { const a = childrenByParent.get(e.parentId) ?? []; a.push(e.id); childrenByParent.set(e.parentId, a); }
  }
  const toDelete = new Set<number>(); const stack = [...ids];
  while (stack.length) { const id = stack.pop()!; if (toDelete.has(id)) continue; toDelete.add(id); for (const c of childrenByParent.get(id) ?? []) stack.push(c); }
  for (const id of toDelete) { index.get(id)?.destroy(); index.delete(id); }
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
  deleteEntities: (ids: number[]) => deleteEntitiesImpl(ids),
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
  writeTraitField: (id: number, meta: any, field: string, value: unknown) => writeTraitFieldImpl(id, meta, field, value),
}));
vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => TRAITS.find((t) => t.name === n),
  getAllTraits: () => TRAITS,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn() }));
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  newGuid: () => 'gen-guid',
  registerAsset: vi.fn(),
  getGuidForPath: () => undefined,
  isGuid: (s: string) => typeof s === 'string' && s.includes('-'),
  resolveRef: (g: string) => `/__prefabs__/${g}.json`,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));

// Record what apply writes to the prefab file, and return ok:true so the refresh runs.
let writtenPrefab: any = null;
// @ts-expect-error mock global
global.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
  if (url.includes('/api/write-file') && init?.body) writtenPrefab = JSON.parse(JSON.parse(init.body).content);
  return { ok: true, json: async () => ({}) } as Response;
});

beforeEach(async () => {
  testWorld = createWorld(); index.clear(); writtenPrefab = null;
  const { clearAllOverrideMarks } = await import('../../src/runtime/loaders/overrideMarks');
  clearAllOverrideMarks();
});
const getModule = () => import('../../src/editor/scene/prefab');

const SHIP = 'dddddddd-0000-4000-8000-00000000ship';
// Single-member prefab whose root has Transform + Spin (no Glow).
const shipPrefab = {
  id: SHIP, version: 1 as const, name: 'Ship', rootLocalId: 1,
  entities: [{ localId: 1, name: 'Ship', traits: { Transform: { x: 0, y: 0, z: 0 }, Spin: { speed: 2 }, EntityAttributes: { name: 'Ship', parentId: 0, guid: '' } } }],
};
const rootMember = (root: number, localId: number): any => {
  let e: any; testWorld.query(PrefabInstance).updateEach(([pi], ent) => { const p = pi as any; if (p.rootInstanceId === root && p.localId === localId) e = ent; });
  return e;
};
const shipRoots = (): number[] => {
  const out: number[] = []; testWorld.query(PrefabInstance).updateEach(([pi], e) => { const p = pi as any; if (p.source === SHIP && p.rootInstanceId === e.id()) out.push(e.id()); }); return out;
};

describe('remove a prefab component from an instance', () => {
  it('captures it as removedTraits', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, captureInstanceStructure } = await getModule();
    setPrefabCache(SHIP, shipPrefab as any);
    const root = instantiatePrefab(shipPrefab as any); setPrefabSource(root, SHIP);

    rootMember(root, 1).remove(Spin); // user removes the prefab-defined Spin
    const struct = captureInstanceStructure(root, shipPrefab as any);
    expect(struct.removedTraits[1]).toEqual(['Spin']);
  });

  it('apply-to-prefab persists the removal to the file AND strips it from every instance', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, applyToPrefabSelective } = await getModule();
    setPrefabCache(SHIP, shipPrefab as any);
    const a = instantiatePrefab(shipPrefab as any); setPrefabSource(a, SHIP);
    const b = instantiatePrefab(shipPrefab as any); setPrefabSource(b, SHIP);

    rootMember(a, 1).remove(Spin);
    await applyToPrefabSelective(a, new Set(['-trait.1.Spin']));

    // Written prefab file no longer defines Spin.
    expect(writtenPrefab.entities[0].traits.Spin).toBeUndefined();
    // Both refreshed instances lost Spin (b too, which never touched it).
    for (const root of shipRoots()) expect(rootMember(root, 1).has(Spin)).toBe(false);
  });
});

describe('revert a removed component', () => {
  it('restores the prefab-defined component (with base values) on the instance', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, revertOverridesSelective } = await getModule();
    setPrefabCache(SHIP, shipPrefab as any);
    const root = instantiatePrefab(shipPrefab as any); setPrefabSource(root, SHIP);

    rootMember(root, 1).remove(Spin); // instance drops Spin...
    const result = await revertOverridesSelective(root, new Set(['-trait.1.Spin']));
    expect(result).not.toBeNull();

    // ...and reverting the removal brings it back at the prefab base value.
    const member = rootMember(result!.newRootId, 1);
    expect(member.has(Spin)).toBe(true);
    expect((member.get(Spin) as any).speed).toBe(2);
  });
});

describe('add a component on an instance then apply', () => {
  it('promotes the new component to the prefab and a second instance gains it on refresh', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, applyToPrefabSelective } = await getModule();
    setPrefabCache(SHIP, shipPrefab as any);
    const a = instantiatePrefab(shipPrefab as any); setPrefabSource(a, SHIP);
    const b = instantiatePrefab(shipPrefab as any); setPrefabSource(b, SHIP);

    // Add Glow to instance A only.
    rootMember(a, 1).add(Glow({ intensity: 0.8, radius: 4 }));
    await applyToPrefabSelective(a, new Set(['1.Glow.intensity', '1.Glow.radius']));

    // Prefab file now defines Glow with the full live trait.
    expect(writtenPrefab.entities[0].traits.Glow).toMatchObject({ intensity: 0.8, radius: 4 });
    // Every refreshed instance now carries Glow — including B, which never had it.
    for (const root of shipRoots()) {
      const m = rootMember(root, 1);
      expect(m.has(Glow)).toBe(true);
      expect((m.get(Glow) as any).intensity).toBe(0.8);
    }
  });
});
