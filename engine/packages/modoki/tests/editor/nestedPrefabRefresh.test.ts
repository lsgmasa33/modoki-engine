/** Nested-prefab overrides + refresh propagation (integration, drives the real
 *  apply/refresh machinery end to end with a cascading deleteEntities like the
 *  runtime's). Covers:
 *   - a per-instance override on a NESTED child member serializes into the outer
 *     prefab's reference row (child-localId space),
 *   - editing the INNER prefab refreshes every live inner copy in place, each
 *     keeping its OWN override, with no orphan/duplicate and correct re-parenting,
 *   - editing the OUTER prefab rebuilds the instance correctly but currently RESETS
 *     a live per-copy override on the nested child (the design plan's "risk R3" for
 *     the outer-refresh path — documented here so a future fix flips this assert). */

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
/** Cascading delete (mirrors runtime entityUtils.deleteEntities): removes each id
 *  AND all its EntityAttributes.parentId descendants, so destroying an outer member
 *  also tears down the nested instance hanging under it. */
function deleteEntitiesImpl(ids: number[]) {
  const childrenByParent = new Map<number, number[]>();
  for (const e of getAllEntitiesImpl()) {
    if (e.parentId > 0) {
      const arr = childrenByParent.get(e.parentId) ?? [];
      arr.push(e.id); childrenByParent.set(e.parentId, arr);
    }
  }
  const toDelete = new Set<number>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (toDelete.has(id)) continue;
    toDelete.add(id);
    for (const c of childrenByParent.get(id) ?? []) stack.push(c);
  }
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
// write-file always succeeds so apply runs through to the refresh.
// @ts-expect-error mock global
global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));

beforeEach(async () => {
  testWorld = createWorld();
  index.clear();
  const { clearAllOverrideMarks } = await import('../../src/runtime/loaders/overrideMarks');
  clearAllOverrideMarks();
});
const getModule = () => import('../../src/editor/scene/prefab');

const INNER = 'bbbbbbbb-0000-4000-8000-0000000inner';
const OUTER = 'bbbbbbbb-0000-4000-8000-0000000outer';
// Inner: root I1 (localId 1) + child I2 (localId 2).
const innerPrefab = {
  id: INNER, version: 1 as const, name: 'Inner', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'I1', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'I1', parentId: 0, guid: '' } } },
    { localId: 2, name: 'I2', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'I2', parentId: 1, guid: '' } } },
  ],
};
// Outer: M1 root, M2 child, nested Inner row (localId 3) under M2.
const outerPrefab = {
  id: OUTER, version: 2 as const, name: 'Outer', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'M1', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'M1', parentId: 0, guid: '' } } },
    { localId: 2, name: 'M2', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'M2', parentId: 1, guid: '' } } },
    { localId: 3, name: 'I1', prefab: INNER, traits: { EntityAttributes: { name: 'I1', parentId: 2, guid: '' } } },
  ],
};

/** Inner-instance root (PrefabInstance.source===INNER, rootInstanceId===self) hung
 *  under outer member `m2Ecs`; if `m2Ecs` omitted, returns any one inner root. */
function innerRootUnder(m2Ecs?: number): number {
  let found = 0;
  testWorld.query(PrefabInstance).updateEach(([pi], e) => {
    const p = pi as Record<string, unknown>;
    if (p.source !== INNER || p.rootInstanceId !== e.id()) return;
    const parent = (e.get(EntityAttributes) as Record<string, unknown>).parentId as number;
    if (m2Ecs === undefined || parent === m2Ecs) found = e.id();
  });
  return found;
}
function memberByLocal(root: number, localId: number): number {
  let id = 0;
  testWorld.query(PrefabInstance).updateEach(([pi], e) => {
    const p = pi as Record<string, unknown>;
    if (p.rootInstanceId === root && p.localId === localId) id = e.id();
  });
  return id;
}
/** Live Transform.x of every entity named `name`. */
function xsNamed(name: string): number[] {
  const out: number[] = [];
  testWorld.query(EntityAttributes, Transform).updateEach(([ea, t], _e) => {
    if ((ea as any).name === name) out.push((t as any).x);
  });
  return out;
}

describe('nested override serialization', () => {
  it('a per-instance override on a nested child serializes into the outer reference row', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, serializePrefab } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    setPrefabCache(OUTER, outerPrefab as any);
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');

    const outerRoot = instantiatePrefab(outerPrefab as any);
    setPrefabSource(outerRoot, OUTER);

    // Override the nested child I2's Transform.x on THIS instance only.
    const innerRoot = innerRootUnder();
    const i2 = memberByLocal(innerRoot, 2);
    writeTraitFieldImpl(i2, TRAITS[0], 'x', 5); markOverride(i2, 'Transform', 'x');

    const out = serializePrefab(outerRoot, OUTER)!;
    const ref = out.entities.find((e) => e.prefab)!;
    expect(ref.prefab).toBe(INNER);
    // The override rides on the reference row in the CHILD's localId space (I2 = 2).
    expect(ref.overrides?.[2]?.Transform?.x).toBe(5);
  });
});

describe('inner-prefab edit refreshes all inner copies, preserving per-copy overrides', () => {
  it('keeps copy A’s nested override and propagates the new base to both copies', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, applyToPrefabSelective } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    setPrefabCache(OUTER, outerPrefab as any);
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');

    // Two independent outer instances → two inner copies.
    const outerA = instantiatePrefab(outerPrefab as any); setPrefabSource(outerA, OUTER);
    const m2A = memberByLocal(outerA, 2);
    const outerB = instantiatePrefab(outerPrefab as any); setPrefabSource(outerB, OUTER);

    // Copy A: override the nested child I2.x = 5.
    const innerA = innerRootUnder(m2A);
    const i2A = memberByLocal(innerA, 2);
    writeTraitFieldImpl(i2A, TRAITS[0], 'x', 5); markOverride(i2A, 'Transform', 'x');

    // Edit the INNER prefab base (via copy B's root I1.x = 9) and apply → this
    // rewrites the inner prefab and refreshes BOTH inner copies.
    const innerB = innerRootUnder(memberByLocal(outerB, 2));
    writeTraitFieldImpl(innerB, TRAITS[0], 'x', 9); markOverride(innerB, 'Transform', 'x');
    await applyToPrefabSelective(innerB, new Set(['1.Transform.x']));

    // Still exactly two inner copies (two I1 roots, two I2 children) — no orphan/dup.
    expect(xsNamed('I1')).toHaveLength(2);
    expect(xsNamed('I2')).toHaveLength(2);
    // New base I1.x = 9 reached both copies.
    expect(xsNamed('I1').every((x) => x === 9)).toBe(true);
    // Copy A’s nested override survived (one I2 still at 5); copy B stayed at base 0.
    expect(xsNamed('I2').filter((x) => x === 5)).toHaveLength(1);
    expect(xsNamed('I2').filter((x) => x === 0)).toHaveLength(1);
    // The outer members are untouched (two M1, two M2).
    expect(xsNamed('M1')).toHaveLength(2);
    expect(xsNamed('M2')).toHaveLength(2);
  });
});

describe('outer-prefab edit rebuilds the instance (risk R3: nested live override survives)', () => {
  it('applies the outer change and preserves the nested per-copy override', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, applyToPrefabSelective } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    setPrefabCache(OUTER, outerPrefab as any);
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');

    const outerRoot = instantiatePrefab(outerPrefab as any); setPrefabSource(outerRoot, OUTER);
    const m2 = memberByLocal(outerRoot, 2);

    // Live per-copy override on the nested child, plus an outer-member edit to apply.
    const innerRoot = innerRootUnder(m2);
    const i2 = memberByLocal(innerRoot, 2);
    writeTraitFieldImpl(i2, TRAITS[0], 'x', 5); markOverride(i2, 'Transform', 'x');
    const m1 = memberByLocal(outerRoot, 1);
    writeTraitFieldImpl(m1, TRAITS[0], 'x', 7); markOverride(m1, 'Transform', 'x');

    await applyToPrefabSelective(outerRoot, new Set(['1.Transform.x']));

    // The outer apply took effect, and exactly one nested copy remains, correctly
    // re-parented under the rebuilt M2 (no orphan from the cascade, no duplicate).
    expect(xsNamed('M1')).toEqual([7]);
    expect(xsNamed('I1')).toHaveLength(1);
    expect(xsNamed('I2')).toHaveLength(1);
    const newRoot = (() => { let r = 0; testWorld.query(PrefabInstance).updateEach(([pi], e) => { const p = pi as any; if (p.source === OUTER && p.rootInstanceId === e.id()) r = e.id(); }); return r; })();
    const newM2 = memberByLocal(newRoot, 2);
    const newInner = innerRootUnder(newM2);
    expect(newInner).toBeGreaterThan(0); // nested copy hangs under the rebuilt M2

    // The live per-copy override on the nested child survives the OUTER rebuild
    // (captured before teardown, re-applied after re-expansion — risk R3 fixed).
    expect(xsNamed('I2')).toEqual([5]);
  });
});
