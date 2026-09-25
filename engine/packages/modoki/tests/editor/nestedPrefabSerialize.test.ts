/** Nested prefab serialize + round-trip (editor). A prefab edited in isolation
 *  that CONTAINS a child prefab instance must serialize the child as a single
 *  reference row (child GUID + diffs) — its members must NOT leak into the flat
 *  output — and an instantiate→serialize round-trip must be stable. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 } },
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

vi.mock('../../src/runtime/core/ecs/world', () => ({
  // #1461: tagEntityTreeAsInstance now stamps member guids, and applyGuidRemap re-indexes each
  // renamed entity. This mock is an explicit list, so a new reachable export must be named here.
  indexEntityGuid: () => {},
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); index.set(e.id(), e); return e; },
  unregisterEntity: (e: any) => index.delete(e.id()),
  destroyEntity: (e: any) => { ((e: any) => index.delete(e.id()))(e); e.destroy(); },
}));

vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => getAllEntitiesImpl(),
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: (ids: number[]) => { for (const id of ids) { index.get(id)?.destroy(); index.delete(id); } },
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
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
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
  getAllTraits: () => TRAITS,
}));

vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn(), replaceCachedPrefab: vi.fn() }));

beforeEach(() => { testWorld = createWorld(); index.clear(); });

const getModule = () => import('../../src/editor/scene/prefab');

const INNER = 'aaaaaaaa-0000-4000-8000-00000000inner'.replace('inner', '0001');
const OUTER = 'aaaaaaaa-0000-4000-8000-00000000outer'.replace('outer', '0002');

// Inner: root 'Hull' with a child 'Bolt'. The reference row keeps the root name
// ('Hull'); only the CHILD ('Bolt') must never leak into the flat output.
const innerPrefab = {
  id: INNER, version: 1 as const, name: 'Inner', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'Hull', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Hull', parentId: 0, guid: '' } } },
    { localId: 2, name: 'Bolt', traits: { Transform: { x: 1 }, EntityAttributes: { name: 'Bolt', parentId: 1, guid: '' } } },
  ],
};
// Outer contains O1(root), O2 child, and a nested Inner instance under O2.
const outerPrefab = {
  id: OUTER, version: 2 as const, name: 'Outer', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'O1', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'O1', parentId: 0, guid: '' } } },
    { localId: 2, name: 'O2', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'O2', parentId: 1, guid: '' } } },
    { localId: 3, name: 'Hull', prefab: INNER, traits: { EntityAttributes: { name: 'Hull', parentId: 2, guid: '' } } },
  ],
};

describe('serializePrefab — nested prefabs', () => {
  it('writes a nested instance as ONE reference row; inner members do not leak', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, serializePrefab, PREFAB_FORMAT_VERSION } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    setPrefabCache(OUTER, outerPrefab as any);

    const outerRoot = instantiatePrefab(outerPrefab as any);
    setPrefabSource(outerRoot, OUTER);

    const out = serializePrefab(outerRoot, OUTER)!;
    expect(out).not.toBeNull();
    // Read from the constant, not a literal (#1468's 4 → 5 bump found both of these). What this
    // asserts is that the serializer stamps the CURRENT version even though the prefab nests one —
    // the rule #379 replaced was `nestedRefs.size > 0 ? 2 : 1`, which derived the field from content
    // and could go backwards. Which NUMBER the constant holds is pinned once, deliberately, by the
    // literal in `tests/e2e/editor-hierarchy.spec.ts`; a second literal here would only be another
    // place to forget on the next bump.
    expect(out.version).toBe(PREFAB_FORMAT_VERSION);
    // O1 + O2 + one nested-ref row (named after the inner root 'Hull') = 3.
    // The inner CHILD 'Bolt' must be gone (it expands from the child file).
    expect(out.entities).toHaveLength(3);
    expect(out.entities.some((e) => e.name === 'Bolt')).toBe(false);
    expect(out.entities.filter((e) => e.prefab)).toHaveLength(1);

    const ref = out.entities.find((e) => e.prefab)!;
    expect(ref.prefab).toBe(INNER);
    expect(ref.name).toBe('Hull');
    // Its parentId localId points at O2's localId in the flat output.
    const o2 = out.entities.find((e) => e.name === 'O2')!;
    expect((ref.traits.EntityAttributes as Record<string, unknown>).parentId).toBe(o2.localId);
    // Pristine instance ⇒ no overrides / structure noise.
    expect(ref.overrides).toBeUndefined();
    expect(ref.added).toBeUndefined();
  });

  it('round-trips: instantiate the serialized prefab and re-serialize identically', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, serializePrefab } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    setPrefabCache(OUTER, outerPrefab as any);

    const root1 = instantiatePrefab(outerPrefab as any);
    setPrefabSource(root1, OUTER);
    const out1 = serializePrefab(root1, OUTER)!;

    // Re-seed cache with the serialized outer + re-instantiate into a fresh world.
    testWorld = createWorld(); index.clear();
    setPrefabCache(OUTER, out1 as any);
    const root2 = instantiatePrefab(out1 as any);
    setPrefabSource(root2, OUTER);
    const out2 = serializePrefab(root2, OUTER)!;

    expect(out2.entities).toHaveLength(out1.entities.length);
    const ref1 = out1.entities.find((e) => e.prefab);
    const ref2 = out2.entities.find((e) => e.prefab);
    expect(ref2?.prefab).toBe(ref1?.prefab);
    // The inner child still doesn't leak after a round-trip.
    expect(out2.entities.some((e) => e.name === 'Bolt')).toBe(false);
    expect(out2.entities.filter((e) => e.prefab)).toHaveLength(1);
  });
});

describe('Create-Prefab-on-a-child then save outer → nested reference (regression)', () => {
  // Reproduces the user-reported bug: "Create Prefab" on an entity inside a
  // prefab-edit session must cache the new prefab by its GUID (PrefabInstance.source
  // is GUID-only), so saving the OUTER prefab references it instead of flattening.
  it('serializes the just-created child prefab as a reference row, not flattened', async () => {
    const mani = await import('../../src/runtime/loaders/assetManifest');
    const { serializePrefab, setPrefabCache, tagEntityTreeAsInstance, PREFAB_FORMAT_VERSION } = await getModule();

    // Live edit world: a plain "Ship" root with a plain "Flame" child.
    const ship = testWorld.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'Ship', parentId: 0, guid: 'g-ship' }));
    index.set(ship.id(), ship);
    const flame = testWorld.spawn(Transform({ x: 1 }), EntityAttributes({ name: 'Flame', parentId: ship.id(), guid: 'g-flame' }));
    index.set(flame.id(), flame);

    // --- Create Prefab on the Flame (mirrors Hierarchy.handleCreatePrefab) ---
    const childPrefab = serializePrefab(flame.id())!;
    expect(childPrefab.id).toBeTruthy();
    const savePath = '/games/x/assets/prefabs/Flame.prefab.json';
    mani.registerAsset(childPrefab.id!, savePath, 'prefab');
    setPrefabCache(childPrefab.id!, childPrefab);   // THE FIX: cache by GUID, not path
    tagEntityTreeAsInstance(flame.id(), savePath);  // Flame becomes an instance (source = GUID)

    // --- Now save the OUTER prefab (the Ship) ---
    const out = serializePrefab(ship.id(), 'g-ship-prefab')!;
    expect(out.version).toBe(PREFAB_FORMAT_VERSION);
    const ref = out.entities.find((e) => e.prefab);
    expect(ref, 'Flame should be a nested reference row, not flattened').toBeTruthy();
    expect(ref!.prefab).toBe(childPrefab.id);
    // Flattening would have written the Flame's Transform inline on a second row.
    expect(out.entities.filter((e) => e.name === 'Flame')).toHaveLength(1);
    expect(ref!.traits.Transform).toBeUndefined(); // ref row carries only EntityAttributes
  });
});

describe('tagEntityTreeAsInstance mirrors the rows serializePrefab wrote (#1278)', () => {
  const TAG_PATH = 'aaaaaaaa-0000-4000-8000-0000000000fa';

  /** R ─┬─ A
   *     ├─ Hull   ← a self-rooted instance of INNER, with its own member Bolt
   *     └─ B ── C
   *
   *  BFS is R, A, Hull, B, Bolt, C — so the dropped member (Bolt) is visited BEFORE a
   *  surviving one (C). That ordering is what makes the two numberings diverge: C is row 5
   *  in the file and used to be tagged 6. A shallower tree hides the bug, because BFS puts a
   *  nested instance's members last. */
  const buildTree = () => {
    const mk = (name: string, parentId: number, guid: string, x = 0) => {
      const e = testWorld.spawn(Transform({ x }), EntityAttributes({ name, parentId, guid }));
      index.set(e.id(), e);
      return e;
    };
    const r = mk('R', 0, 'g-r');
    const a = mk('A', r.id(), 'g-a');
    const hull = mk('Hull', r.id(), 'g-hull');
    const b = mk('B', r.id(), 'g-b');
    const bolt = mk('Bolt', hull.id(), 'g-bolt', 1);
    const c = mk('C', b.id(), 'g-c');
    // Make Hull a live instance of INNER: the root is self-rooted, the member points at it.
    hull.add(PrefabInstance({ source: INNER, localId: 1, rootInstanceId: hull.id() }));
    bolt.add(PrefabInstance({ source: INNER, localId: 2, rootInstanceId: hull.id() }));
    return { r, a, hull, b, bolt, c };
  };

  const piOf = (e: { get(t: unknown): unknown }) => e.get(PrefabInstance) as Record<string, unknown>;

  it('gives every member the localId its OWN row carries, across a dropped nested member', async () => {
    const { serializePrefab, setPrefabCache, tagEntityTreeAsInstance } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    const { r, hull, bolt, c } = buildTree();

    const p = serializePrefab(r.id())!;
    // Hull is one reference row; Bolt is gone. R, A, Hull(ref), B, C.
    expect(p.entities.map((e) => e.name)).toEqual(['R', 'A', 'Hull', 'B', 'C']);
    expect(p.entities.some((e) => e.name === 'Bolt')).toBe(false);

    tagEntityTreeAsInstance(r.id(), TAG_PATH);

    // THE defect: every tagged entity must carry the localId of the row that describes IT.
    for (const row of p.entities) {
      if (row.prefab) continue; // nested ref row — checked separately below
      const live = [...index.values()].find((e: any) => (e.get(EntityAttributes) as any).name === row.name);
      expect(piOf(live).localId, `${row.name} must be tagged with its own row's localId`).toBe(row.localId);
    }
    // Stated concretely, because the loop above would also pass on an empty file:
    const cRow = p.entities.find((e) => e.name === 'C')!;
    expect(cRow.localId).toBe(5);
    expect(piOf(c).localId).toBe(5); // was 6 — Bolt consumed a number the file never assigned

    // The nested instance keeps its OWN prefab and only learns which row produced it,
    // exactly as instantiatePrefabIntoWorld does on reload.
    const hullRow = p.entities.find((e) => e.prefab)!;
    expect(piOf(hull).source).toBe(INNER);
    expect(piOf(hull).parentLocalId).toBe(hullRow.localId);

    // Its member is left alone entirely — not retagged onto the new prefab.
    expect(piOf(bolt).source).toBe(INNER);
    expect(piOf(bolt).rootInstanceId).toBe(hull.id());
  });

  /** An OWNED grand-nested instance — one that the nested prefab's OWN file produced, marked by
   *  `parentLocalId > 0`. It re-expands from its owner's row (O1 → OUTER's row 3), so it gets NO
   *  row of its own and keeps OUTER's stamp (#1382). This case used to assert the opposite — a
   *  second `Hull` row, re-stamped onto it — which wrote the instance twice: instantiating the new
   *  prefab gave two Hulls, and the scene's next save wrote `removed:[3]` plus a reference node.
   *
   *  What still holds from the first #1278 review: the skip is by the row PARTITION
   *  (`captureNestedChannels`' `ownedMemberEcsIds`), never "every descendant of a nested root", so
   *  nothing ordered after it is dropped or numbered one short — D, the entity that rule once left
   *  with no PrefabInstance at all, is still tagged with its own row. */
  it('an OWNED grand-nested instance gets no row of its own, and nothing after it is skipped (#1382)', async () => {
    const { serializePrefab, setPrefabCache, tagEntityTreeAsInstance } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    setPrefabCache(OUTER, outerPrefab as any);
    const mk = (name: string, parentId: number, guid: string, x = 0) => {
      const e = testWorld.spawn(Transform({ x }), EntityAttributes({ name, parentId, guid }));
      index.set(e.id(), e); return e;
    };
    // R -> O1(instance of OUTER) -> O2(member) -> Hull(OWNED instance of INNER) -> Bolt
    // R -> B -> C -> D            (plain, ordered after the nested subtree in BFS)
    const r = mk('R', 0, 'g-r4');
    const o1 = mk('O1', r.id(), 'g-o1');
    const b = mk('B', r.id(), 'g-b4');
    const o2 = mk('O2', o1.id(), 'g-o2');
    const c = mk('C', b.id(), 'g-c4');
    const hull = mk('Hull', o2.id(), 'g-hull4');
    const d = mk('D', c.id(), 'g-d4');
    const bolt = mk('Bolt', hull.id(), 'g-bolt4', 1);
    o1.add(PrefabInstance({ source: OUTER, localId: 1, rootInstanceId: o1.id() }));
    o2.add(PrefabInstance({ source: OUTER, localId: 2, rootInstanceId: o1.id() }));
    // parentLocalId 3 = OUTER's own nested row, i.e. this instance is OWNED by OUTER.
    hull.add(PrefabInstance({ source: INNER, localId: 1, rootInstanceId: hull.id(), parentLocalId: 3 }));
    bolt.add(PrefabInstance({ source: INNER, localId: 2, rootInstanceId: hull.id() }));

    const p = serializePrefab(r.id())!;
    // One reference row: O1. Hull re-expands from it (OUTER's row 3), and so does Bolt.
    expect(p.entities.filter((e) => e.prefab).map((e) => e.name)).toEqual(['O1']);
    expect(p.entities.map((e) => e.name)).not.toContain('Hull');
    expect(p.entities.map((e) => e.name)).not.toContain('Bolt');

    tagEntityTreeAsInstance(r.id(), TAG_PATH);

    // Every non-nested row is tagged with its own localId — none silently skipped.
    for (const row of p.entities) {
      if (row.prefab) continue;
      const live = [...index.values()].find((e: any) => (e.get(EntityAttributes) as any).name === row.name);
      expect(live.has(PrefabInstance), `${row.name} must be tagged at all`).toBe(true);
      expect(piOf(live).localId, `${row.name} must carry its own row's localId`).toBe(row.localId);
    }
    // D is the entity the old "skip every descendant" rule lost entirely.
    expect(d.has(PrefabInstance)).toBe(true);
    expect(piOf(d).localId).toBe(p.entities.find((e) => e.name === 'D')!.localId);
    // Hull keeps OUTER's row stamp — the tagger does not touch an owned instance.
    expect(piOf(hull).parentLocalId).toBe(3);
    expect(piOf(hull).source).toBe(INNER);
  });

  /** The plan tagging computes is a SECOND read of the world — `serializePrefab` runs, then the
   *  caller awaits a file write (on a Replace, the confirmReplace DIALOG). If the tree or the
   *  prefab cache moved in that window, tagging would stamp localIds addressing rows the file
   *  does not have, and such an entity is written to neither the scene entry nor the overrides —
   *  it vanishes on the next load. Untagged is the degradation that loses nothing. */
  it('refuses to tag, loudly, when the tree no longer matches the prefab that was written', async () => {
    const { serializePrefab, tagEntityTreeAsInstance } = await getModule();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mk = (name: string, parentId: number, guid: string) => {
      const e = testWorld.spawn(Transform({ x: 0 }), EntityAttributes({ name, parentId, guid }));
      index.set(e.id(), e); return e;
    };
    const r = mk('R', 0, 'g-r6');
    const a = mk('A', r.id(), 'g-a6');
    const written = serializePrefab(r.id())!;   // two rows: R, A
    const late = mk('Late', a.id(), 'g-late6'); // a member appears during the await

    tagEntityTreeAsInstance(r.id(), TAG_PATH, written);

    expect(err).toHaveBeenCalledWith(expect.stringContaining('no longer matches the prefab just written'));
    // Nothing tagged at all — a partial tag is what writes an id addressing a row that is not there.
    expect(r.has(PrefabInstance)).toBe(false);
    expect(a.has(PrefabInstance)).toBe(false);
    expect(late.has(PrefabInstance)).toBe(false);
    err.mockRestore();
  });

  it('tags normally when the tree still matches — the guard is not always-on', async () => {
    const { serializePrefab, tagEntityTreeAsInstance } = await getModule();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mk = (name: string, parentId: number, guid: string) => {
      const e = testWorld.spawn(Transform({ x: 0 }), EntityAttributes({ name, parentId, guid }));
      index.set(e.id(), e); return e;
    };
    const r = mk('R', 0, 'g-r7'); const a = mk('A', r.id(), 'g-a7');
    const written = serializePrefab(r.id())!;

    tagEntityTreeAsInstance(r.id(), TAG_PATH, written);

    expect(err).not.toHaveBeenCalled();
    expect(piOf(r).localId).toBe(1);
    expect(piOf(a).localId).toBe(2);
    err.mockRestore();
  });

  it('clears a stale parentLocalId on a row this prefab owns (koota set is a partial merge)', async () => {
    const { serializePrefab, setPrefabCache, tagEntityTreeAsInstance } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    const mk = (name: string, parentId: number, guid: string) => {
      const e = testWorld.spawn(Transform({ x: 0 }), EntityAttributes({ name, parentId, guid }));
      index.set(e.id(), e); return e;
    };
    const r = mk('R', 0, 'g-r5');
    // Create Prefab directly ON an owned nested instance: it becomes row 1 of the NEW prefab,
    // so its parentLocalId must be cleared. Left at 3, serialize.ts's `parentIsMember &&
    // parentLocalId` writes no scene entry for it and the new link vanishes on reload.
    r.add(PrefabInstance({ source: INNER, localId: 1, rootInstanceId: r.id(), parentLocalId: 3 }));

    serializePrefab(r.id());
    tagEntityTreeAsInstance(r.id(), TAG_PATH);
    expect(piOf(r).source).toBe(TAG_PATH);
    expect(piOf(r).parentLocalId).toBe(0);
  });
});

describe('wouldCreateCycle — reference-cycle guard', () => {
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const B = 'aaaaaaaa-0000-4000-8000-00000000000b';
  const C = 'aaaaaaaa-0000-4000-8000-00000000000c';

  it('detects self and transitive A→B→A cycles, allows acyclic nesting', async () => {
    const { setPrefabCache, wouldCreateCycle } = await getModule();
    // A nests B, B nests A (cycle); C nests nothing.
    setPrefabCache(A, { id: A, version: 2, name: 'A', rootLocalId: 1, entities: [{ localId: 1, name: 'A', traits: {} }, { localId: 2, name: 'B', prefab: B, traits: {} }] } as any);
    setPrefabCache(B, { id: B, version: 2, name: 'B', rootLocalId: 1, entities: [{ localId: 1, name: 'B', traits: {} }, { localId: 2, name: 'A', prefab: A, traits: {} }] } as any);
    setPrefabCache(C, { id: C, version: 1, name: 'C', rootLocalId: 1, entities: [{ localId: 1, name: 'C', traits: {} }] } as any);

    expect(wouldCreateCycle(A, A)).toBe(true);  // self
    expect(wouldCreateCycle(A, B)).toBe(true);  // nesting B in A → B transitively contains A
    expect(wouldCreateCycle(A, C)).toBe(false); // C contains nothing
    expect(wouldCreateCycle(C, A)).toBe(false); // A does not contain C
  });
});
