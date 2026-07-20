/** Entity name override on a prefab instance. Renaming an instance member must
 *  be captured as a per-localId `EntityAttributes.name` override (so it round-
 *  trips through scene save/load and prefab refresh) — a renamed instance must
 *  NOT snap back to the prefab's name. Other members keep the prefab name. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, parentId: 0, guid: 0, sortOrder: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0 } },
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

beforeEach(() => { testWorld = createWorld(); index.clear(); });

const getModule = () => import('../../src/editor/scene/prefab');

const P = 'aaaaaaaa-0000-4000-8000-000000000abc';
const prefab = {
  id: P, version: 1 as const, name: 'P', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'Root', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Root', parentId: 0, guid: '', sortOrder: 0 } } },
    { localId: 2, name: 'Flame', traits: { Transform: { x: 1 }, EntityAttributes: { name: 'Flame', parentId: 1, guid: '', sortOrder: 0 } } },
  ],
};

describe('EntityAttributes.name override on a prefab instance', () => {
  it('captures a renamed member as an EntityAttributes.name override', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, captureInstanceOverrides } = await getModule();
    setPrefabCache(P, prefab as any);
    const root = instantiatePrefab(prefab as any);
    setPrefabSource(root, P);

    // Rename the child member (localId 2) on the live instance — mark it, exactly
    // as the editor's Hierarchy rename does (writeTraitFieldWithUndo → mark). An
    // override must be an explicit, marked edit, not a bare value divergence.
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');
    const child = getAllEntitiesImpl().find((e) => e.name === 'Flame')!;
    const e = index.get(child.id);
    e.set(EntityAttributes, { ...e.get(EntityAttributes), name: 'Flame Left' });
    markOverride(child.id, 'EntityAttributes', 'name');

    const ov = captureInstanceOverrides(root, prefab as any);
    expect(ov[2]?.EntityAttributes?.name).toBe('Flame Left');
    // Untouched root has no name override.
    expect(ov[1]?.EntityAttributes?.name).toBeUndefined();
  });

  // Regression: a prefab RE-IMPORT that changes a member's base transform (e.g. the
  // FBX-wrapper bake rewriting root-bone scale/rotation) must NOT freeze an
  // UN-EDITED instance's now-divergent value as a spurious override — that pins the
  // instance to the old base and breaks it (mesh collapses) while fresh instances
  // render. Only an explicit (marked) edit is an override.
  it('does NOT capture a member that merely diverges from a re-imported base (no mark)', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, captureInstanceOverrides } = await getModule();
    setPrefabCache(P, prefab as any);
    const root = instantiatePrefab(prefab as any);
    setPrefabSource(root, P);

    // The instance member (localId 2) inherits Transform.x = 1 from the prefab.
    // Simulate a re-import: the prefab base for localId 2 now has x = 99. The live
    // (un-edited, unmarked) instance still has x = 1 — diverges from the new base.
    const reimported = {
      ...prefab,
      entities: prefab.entities.map((e) =>
        e.localId === 2 ? { ...e, traits: { ...e.traits, Transform: { x: 99 } } } : e),
    };

    const ov = captureInstanceOverrides(root, reimported as any);
    // No mark → the divergence is inherited-stale, not an override → not captured.
    expect(ov[2]?.Transform?.x).toBeUndefined();
  });

  it('DOES capture the same member when the user explicitly edited it (marked)', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, captureInstanceOverrides } = await getModule();
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');
    setPrefabCache(P, prefab as any);
    const root = instantiatePrefab(prefab as any);
    setPrefabSource(root, P);

    // User deliberately sets x = 7 on the instance member and marks it.
    const child = getAllEntitiesImpl().find((e) => e.name === 'Flame')!;
    const e = index.get(child.id);
    e.set(Transform, { ...e.get(Transform), x: 7 });
    markOverride(child.id, 'Transform', 'x');

    const ov = captureInstanceOverrides(root, prefab as any);
    expect(ov[2]?.Transform?.x).toBe(7);
  });

  it('getOverrides surfaces EntityAttributes.name so the inspector can flag it', async () => {
    const { getOverrides } = await getModule();
    const overrides = getOverrides(2, { EntityAttributes: { name: 'Flame Left', parentId: 1, guid: '', sortOrder: 0 } }, prefab as any);
    expect(overrides.has('EntityAttributes.name')).toBe(true);
  });

  it('a pristine instance reports NO name override', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, captureInstanceOverrides } = await getModule();
    setPrefabCache(P, prefab as any);
    const root = instantiatePrefab(prefab as any);
    setPrefabSource(root, P);
    const ov = captureInstanceOverrides(root, prefab as any);
    expect(ov[2]?.EntityAttributes?.name).toBeUndefined();
    expect(ov[1]?.EntityAttributes?.name).toBeUndefined();
  });
});
