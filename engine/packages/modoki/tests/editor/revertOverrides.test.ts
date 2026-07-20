/** Revert prefab overrides (editor "Revert Overrides…"). Reverting selected
 *  overrides on a SINGLE instance resets them to the prefab base WITHOUT touching
 *  the .prefab.json. It is implemented as a teardown + clean re-instantiation with
 *  only the NON-reverted overrides/structure re-applied, so every diff category
 *  (field, added trait, removed trait, added/removed entity) reverts uniformly.
 *  Unselected overrides must survive; undo must restore the full pre-revert state. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EngineFlame = trait({ idleScale: 0, boostScale: 0 });
const Spin = trait({ speed: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EngineFlame', trait: EngineFlame, category: 'component', fields: { idleScale: 0, boostScale: 0 } },
  { name: 'Spin', trait: Spin, category: 'component', fields: { speed: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, parentId: 0, guid: 0, sortOrder: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0, parentLocalId: 0 } },
] as const;

let testWorld: ReturnType<typeof createWorld>;
const index = new Map<number, any>();
const traitNamesOf = (e: any) => TRAITS.filter((t) => e.has(t.trait)).map((t) => t.name);

function getAllEntitiesImpl() {
  const out: any[] = [];
  testWorld.query(EntityAttributes).updateEach(([ea], e) => {
    const d = ea as Record<string, unknown>;
    out.push({ id: e.id(), name: d.name, parentId: d.parentId, sortOrder: d.sortOrder ?? 0, traits: traitNamesOf(e) });
  });
  return out;
}
function findEntityImpl(id: number) { return index.get(id); }
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
  for (const id of ids) {
    const e = index.get(id);
    if (!e) continue;
    e.destroy();
    index.delete(id);
  }
}

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  unregisterEntity: (e: any) => index.delete(e.id()),
}));
vi.mock('../../src/runtime/ecs/entityUtils', () => ({
  getAllEntities: () => getAllEntitiesImpl(),
  findEntity: (id: number) => findEntityImpl(id),
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

beforeEach(async () => {
  testWorld = createWorld();
  index.clear();
  const { clearAllOverrideMarks } = await import('../../src/runtime/loaders/overrideMarks');
  clearAllOverrideMarks();
});

const SRC = 'cccccccc-0000-4000-8000-00000000c0e8';
// Two-member prefab: root "Ship" (localId 1) with child "Flame" (localId 2).
const shipPrefab = {
  id: SRC, version: 1 as const, name: 'Ship', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'Ship', traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'Ship', parentId: 0, guid: '' } } },
    { localId: 2, name: 'Flame', traits: { Transform: { x: 0, y: 0, z: 0 }, EngineFlame: { idleScale: 0.1, boostScale: 3 }, EntityAttributes: { name: 'Flame', parentId: 1, guid: '' } } },
  ],
};

/** Live trait data for the (single) member of `root`'s instance with `localId`. */
function memberData(root: number, localId: number, traitName: string): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  testWorld.query(PrefabInstance).updateEach(([pi], e) => {
    const p = pi as Record<string, unknown>;
    if (p.rootInstanceId !== root || p.localId !== localId) return;
    const meta = TRAITS.find((t) => t.name === traitName)!;
    if (e.has(meta.trait)) out = { ...(e.get(meta.trait) as Record<string, unknown>) };
  });
  return out;
}
/** The current instance root id for source SRC (re-derived after a rebuild). */
function currentRoot(): number {
  let root = 0;
  testWorld.query(PrefabInstance).updateEach(([pi], e) => {
    const p = pi as Record<string, unknown>;
    if (p.source === SRC && p.rootInstanceId === e.id()) root = e.id();
  });
  return root;
}

async function setup() {
  const m = await import('../../src/editor/scene/prefab');
  m.setPrefabCache(SRC, shipPrefab as any);
  const root = m.instantiatePrefab(shipPrefab as any);
  m.setPrefabSource(root, SRC);
  return { m, root };
}

describe('revertOverridesSelective', () => {
  it('reverts the selected field to base; leaves the unselected override intact', async () => {
    const { m, root } = await setup();
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');

    // Two overrides on the Flame member (localId 2): idleScale and Transform.x.
    const flameId = (() => { let id = 0; testWorld.query(PrefabInstance).updateEach(([pi], e) => { if ((pi as any).localId === 2 && (pi as any).rootInstanceId === root) id = e.id(); }); return id; })();
    writeTraitFieldImpl(flameId, TRAITS[1], 'idleScale', 0.5); markOverride(flameId, 'EngineFlame', 'idleScale');
    writeTraitFieldImpl(flameId, TRAITS[0], 'x', 4.1); markOverride(flameId, 'Transform', 'x');

    // Revert ONLY idleScale.
    const result = await m.revertOverridesSelective(root, new Set(['2.EngineFlame.idleScale']));
    expect(result).not.toBeNull();

    const newRoot = result!.newRootId;
    expect(memberData(newRoot, 2, 'EngineFlame')!.idleScale).toBe(0.1); // back to base
    expect(memberData(newRoot, 2, 'Transform')!.x).toBe(4.1);           // override kept
  });

  it('reverting an added trait removes it from the instance', async () => {
    const { m, root } = await setup();
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');

    // Add a Spin trait the prefab doesn't define at the root (localId 1).
    const rootEntity = index.get(root);
    rootEntity.add(Spin({ speed: 9 }));
    markOverride(root, 'Spin', 'speed');
    expect(memberData(root, 1, 'Spin')).toBeDefined();

    const result = await m.revertOverridesSelective(root, new Set(['1.Spin.speed']));
    expect(result).not.toBeNull();
    // Fresh member has no Spin trait — the added override is gone.
    expect(memberData(result!.newRootId, 1, 'Spin')).toBeUndefined();
  });

  it('undo restores the full pre-revert state; redo re-applies the revert', async () => {
    const { m, root } = await setup();
    const { markOverride } = await import('../../src/runtime/loaders/overrideMarks');

    const flameId = (() => { let id = 0; testWorld.query(PrefabInstance).updateEach(([pi], e) => { if ((pi as any).localId === 2 && (pi as any).rootInstanceId === root) id = e.id(); }); return id; })();
    writeTraitFieldImpl(flameId, TRAITS[1], 'idleScale', 0.5); markOverride(flameId, 'EngineFlame', 'idleScale');

    const result = await m.revertOverridesSelective(root, new Set(['2.EngineFlame.idleScale']));
    expect(result).not.toBeNull();
    const { source, prefab, fullOverrides, fullStructure, reducedOverrides, reducedStructure } = result!;
    expect(memberData(result!.newRootId, 2, 'EngineFlame')!.idleScale).toBe(0.1); // reverted

    // Undo → rebuild with the full (pre-revert) overrides: idleScale back to 0.5.
    let cur = m.rebuildInstance(result!.newRootId, source, prefab, fullOverrides, fullStructure);
    expect(memberData(cur, 2, 'EngineFlame')!.idleScale).toBe(0.5);

    // Redo → rebuild with the reduced overrides: idleScale reverted again.
    cur = m.rebuildInstance(cur, source, prefab, reducedOverrides, reducedStructure);
    expect(memberData(cur, 2, 'EngineFlame')!.idleScale).toBe(0.1);
    expect(currentRoot()).toBe(cur); // single live instance, no leaks
  });

  it('rebuildInstance teardown sweeps live non-member descendants, not a frozen id set (F5)', async () => {
    const { m, root } = await setup();
    const countAntennas = () => getAllEntitiesImpl().filter((e: any) => e.name === 'Antenna').length;

    // A live plain "Antenna" child hangs under the root member but is NOT listed in
    // the structure we rebuild with, and the structure's consumedEcsIds is empty —
    // exactly the stale-snapshot situation F5 describes (the frozen set captured at
    // a PRIOR cycle no longer names the currently-live added entity). A clean
    // rebuild that doesn't mention the Antenna must tear it down rather than leave it
    // dangling under a destroyed root. The old code keyed teardown off the frozen
    // consumedEcsIds (empty here) + members, so it leaked the Antenna; the fix walks
    // the live subtree and removes every non-member descendant.
    const antenna = testWorld.spawn(EntityAttributes({ name: 'Antenna', parentId: root, guid: 'antenna-guid' }), Transform({ x: 1, y: 0, z: 0 }));
    index.set(antenna.id(), antenna);
    expect(countAntennas()).toBe(1);

    const emptyStructure = { added: [], removed: [], removedTraits: {}, consumedEcsIds: new Set<number>() };
    const newRoot = m.rebuildInstance(root, SRC, shipPrefab as any, {}, emptyStructure);

    expect(countAntennas()).toBe(0);   // live descendant swept, not leaked
    expect(currentRoot()).toBe(newRoot); // single clean instance, no orphans
  });

  it('returns null for a non-instance entity', async () => {
    const { m } = await setup();
    const plain = testWorld.spawn(EntityAttributes({ name: 'Plain', parentId: 0 }));
    index.set(plain.id(), plain);
    expect(await m.revertOverridesSelective(plain.id(), new Set(['1.Transform.x']))).toBeNull();
  });
});
