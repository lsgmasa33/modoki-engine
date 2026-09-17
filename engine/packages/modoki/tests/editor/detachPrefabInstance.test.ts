/** Detach prefab instance (editor "Detach Prefab"). Severing the prefab link
 *  must strip the `PrefabInstance` trait off the instance root AND every
 *  descendant — including nested-instance members — turning the live tree into
 *  plain, unlinked entities. The captured snapshot must restore every trait on
 *  undo (reattach). Other traits (Transform, etc.) are untouched. */

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

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  // The guid lookups entityRef resolves through — a scan of the live index, which is all a test needs.
  findEntityByGuid: (g: string) => [...index.values()].find((e: any) => e.has(EntityAttributes) && e.get(EntityAttributes).guid === g),
  indexEntityGuid: vi.fn(),
  getGuidIndex: () => new Map(),
  rebuildGuidIndexSync: vi.fn(),
  registerEntity: (e: any) => index.set(e.id(), e),
  unregisterEntity: (e: any) => index.delete(e.id()),
  destroyEntity: (e: any) => { ((e: any) => index.delete(e.id()))(e); e.destroy(); },
}));

vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => getAllEntitiesImpl(),
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: vi.fn(),
  // Real enough for entityRef: it reads the entity's guid to key the snapshot by (#1264 close-out).
  readTraitData: (id: number, meta: any) => { const e: any = index.get(id); return e && e.has(meta.trait) ? { ...e.get(meta.trait) } : undefined; },
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
  writeTraitField: (id: number, meta: any, field: string, value: unknown) => { const e: any = index.get(id); if (e) e.set(meta.trait, { ...e.get(meta.trait), [field]: value }); },
}));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
  getAllTraits: () => TRAITS,
}));

vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn(), replaceCachedPrefab: vi.fn() }));

beforeEach(() => { testWorld = createWorld(); index.clear(); });

const getModule = () => import('../../src/editor/scene/prefab');

const SRC = 'aaaaaaaa-0000-4000-8000-00000000 src1'.replace(' src1', '0001');
const INNER_SRC = 'aaaaaaaa-0000-4000-8000-00000000 src2'.replace(' src2', '0002');

/** Spawn a 3-deep instance tree:
 *   Root (instance root, src SRC) → Child (member) → InnerRoot (nested instance,
 *   src INNER_SRC) → InnerChild (nested member). */
function spawnNestedInstance() {
  const root = testWorld.spawn(Transform({ x: 1 }), EntityAttributes({ name: 'Root', parentId: 0 }), PrefabInstance({ source: SRC, localId: 1, rootInstanceId: 0 }));
  index.set(root.id(), root);
  root.set(PrefabInstance, { source: SRC, localId: 1, rootInstanceId: root.id() });

  const child = testWorld.spawn(Transform({ x: 2 }), EntityAttributes({ name: 'Child', parentId: root.id() }), PrefabInstance({ source: SRC, localId: 2, rootInstanceId: root.id() }));
  index.set(child.id(), child);

  const innerRoot = testWorld.spawn(Transform({ x: 3 }), EntityAttributes({ name: 'InnerRoot', parentId: child.id() }), PrefabInstance({ source: INNER_SRC, localId: 1, rootInstanceId: 0 }));
  index.set(innerRoot.id(), innerRoot);
  innerRoot.set(PrefabInstance, { source: INNER_SRC, localId: 1, rootInstanceId: innerRoot.id(), parentLocalId: 3 });

  const innerChild = testWorld.spawn(Transform({ x: 4 }), EntityAttributes({ name: 'InnerChild', parentId: innerRoot.id() }), PrefabInstance({ source: INNER_SRC, localId: 2, rootInstanceId: innerRoot.id() }));
  index.set(innerChild.id(), innerChild);

  return { root, child, innerRoot, innerChild };
}

const hasPI = (e: any) => e.has(PrefabInstance);

describe('detachPrefabInstance', () => {
  it('strips PrefabInstance off the root and every descendant (nested included)', async () => {
    const { detachPrefabInstance } = await getModule();
    const { root, child, innerRoot, innerChild } = spawnNestedInstance();

    const snapshot = detachPrefabInstance(root.id());

    // All four entities had PrefabInstance → four captured, none left.
    expect(snapshot).toHaveLength(4);
    expect(hasPI(root)).toBe(false);
    expect(hasPI(child)).toBe(false);
    expect(hasPI(innerRoot)).toBe(false);
    expect(hasPI(innerChild)).toBe(false);

    // Other traits are untouched — entities still exist with their transforms.
    expect(root.has(Transform)).toBe(true);
    expect((innerChild.get(Transform) as Record<string, number>).x).toBe(4);
    expect(getAllEntitiesImpl()).toHaveLength(4);
  });

  it('reattach restores every captured PrefabInstance trait (undo)', async () => {
    const { detachPrefabInstance, reattachPrefabInstance } = await getModule();
    const { root, child, innerRoot, innerChild } = spawnNestedInstance();

    const snapshot = detachPrefabInstance(root.id());
    reattachPrefabInstance(snapshot);

    expect(hasPI(root)).toBe(true);
    expect(hasPI(child)).toBe(true);
    expect(hasPI(innerRoot)).toBe(true);
    expect(hasPI(innerChild)).toBe(true);

    // Inner members keep their OWN (inner) source + rootInstanceId, not the outer's.
    expect((innerRoot.get(PrefabInstance) as Record<string, unknown>).source).toBe(INNER_SRC);
    expect((innerRoot.get(PrefabInstance) as Record<string, unknown>).rootInstanceId).toBe(innerRoot.id());
    expect((child.get(PrefabInstance) as Record<string, unknown>).source).toBe(SRC);
    expect((child.get(PrefabInstance) as Record<string, unknown>).rootInstanceId).toBe(root.id());
    // A NESTED instance keeps the address of its row in the parent prefab — it keys that instance's
    // per-instance overrides. The snapshot used to drop it, so undo reattached it as top-level (0).
    expect((innerRoot.get(PrefabInstance) as Record<string, unknown>).parentLocalId).toBe(3);
  });

  it('returns an empty snapshot for a plain (non-instance) entity', async () => {
    const { detachPrefabInstance } = await getModule();
    const plain = testWorld.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'Plain', parentId: 0 }));
    index.set(plain.id(), plain);

    expect(detachPrefabInstance(plain.id())).toHaveLength(0);
  });

  it('reattach follows each entity by GUID — a delete+undo between detach and reattach can SWAP recycled ids (#1264 close-out)', async () => {
    const { detachPrefabInstance, reattachPrefabInstance } = await getModule();
    // Two members with durable guids under an instance root.
    const root = testWorld.spawn(Transform(), EntityAttributes({ name: 'R', parentId: 0, guid: 'bbbbbbbb-0000-4000-8000-000000000001' }), PrefabInstance({ source: SRC, localId: 1 }));
    index.set(root.id(), root);
    root.set(PrefabInstance, { source: SRC, localId: 1, rootInstanceId: root.id() });
    const spawnMember = (name: string, guid: string, localId: number) => {
      const e = testWorld.spawn(Transform(), EntityAttributes({ name, parentId: root.id(), guid }), PrefabInstance({ source: SRC, localId, rootInstanceId: root.id() }));
      index.set(e.id(), e);
      return e;
    };
    const A_GUID = 'bbbbbbbb-0000-4000-8000-00000000000a';
    const B_GUID = 'bbbbbbbb-0000-4000-8000-00000000000b';
    const a = spawnMember('A', A_GUID, 2);
    const b = spawnMember('B', B_GUID, 3);
    const [aId, bId] = [a.id(), b.id()];

    const snapshot = detachPrefabInstance(root.id());

    // Another undo entry runs in between: A and B are deleted, then respawned in their original order.
    // koota recycles last-freed-first, so each comes back on the OTHER's old id.
    index.delete(aId); a.destroy();
    index.delete(bId); b.destroy();
    const a2 = testWorld.spawn(Transform(), EntityAttributes({ name: 'A', parentId: root.id(), guid: A_GUID }));
    index.set(a2.id(), a2);
    const b2 = testWorld.spawn(Transform(), EntityAttributes({ name: 'B', parentId: root.id(), guid: B_GUID }));
    index.set(b2.id(), b2);
    expect([a2.id(), b2.id()], 'precondition: the ids really did swap').toEqual([bId, aId]);

    reattachPrefabInstance(snapshot);

    expect((a2.get(PrefabInstance) as Record<string, unknown>).localId, 'A keeps A\'s row').toBe(2);
    expect((b2.get(PrefabInstance) as Record<string, unknown>).localId, 'B keeps B\'s row').toBe(3);
  });

  /** The untag clears `parentLocalId` on a nested root THIS prefab owned, and must LEAVE the stamp
   *  on one owned by a child prefab further in — its owner is untouched. Close-out review found the
   *  second half asserted by nothing: deleting the `!removed.has(cur)` condition (so every kept
   *  linked descendant is zeroed) left the whole editor suite green. */
  it('untag clears parentLocalId only for a nested root IT owned, not one owned deeper (#1272)', async () => {
    const { untagEntityTreeAsInstance } = await getModule();
    const OUTER = 'ffffffff-0000-4000-8000-0000000000aa';
    const CHILD = 'ffffffff-0000-4000-8000-0000000000bb';
    const mk = (name: string, parentId: number, guid: string) => {
      const e = testWorld.spawn(Transform(), EntityAttributes({ name, parentId, guid }));
      index.set(e.id(), e); return e;
    };
    // R(tagged SRC) -> A(nested, owned by SRC) -> N(nested, owned by A's prefab)
    const r = mk('R', 0, 'ffffffff-0000-4000-8000-000000000001');
    const a = mk('A', r.id(), 'ffffffff-0000-4000-8000-000000000002');
    const n = mk('N', a.id(), 'ffffffff-0000-4000-8000-000000000003');
    r.add(PrefabInstance({ source: SRC, localId: 1, rootInstanceId: r.id() }));
    a.add(PrefabInstance({ source: OUTER, localId: 1, rootInstanceId: a.id(), parentLocalId: 2 }));
    n.add(PrefabInstance({ source: CHILD, localId: 1, rootInstanceId: n.id(), parentLocalId: 4 }));

    untagEntityTreeAsInstance(r.id(), SRC);

    expect(r.has(PrefabInstance), 'the tagged root is stripped').toBe(false);
    // A was owned by the prefab being undone -> its owner is going away.
    expect((a.get(PrefabInstance) as Record<string, unknown>).parentLocalId, 'A was owned by SRC').toBe(0);
    // N was owned by A's prefab, which is untouched -> its stamp still addresses a live row.
    expect((n.get(PrefabInstance) as Record<string, unknown>).parentLocalId, 'N is owned deeper').toBe(4);
  });

  it('reattach COUNTS the refs it could not resolve, and returns 0 when it restored everything (#1272)', async () => {
    const { detachPrefabInstance, reattachPrefabInstance } = await getModule();
    const R_GUID = 'eeeeeeee-0000-4000-8000-000000000001';
    const M_GUID = 'eeeeeeee-0000-4000-8000-000000000002';
    const root = testWorld.spawn(Transform(), EntityAttributes({ name: 'R', parentId: 0, guid: R_GUID }), PrefabInstance({ source: SRC, localId: 1 }));
    index.set(root.id(), root);
    root.set(PrefabInstance, { source: SRC, localId: 1, rootInstanceId: root.id() });
    const member = testWorld.spawn(Transform(), EntityAttributes({ name: 'M', parentId: root.id(), guid: M_GUID }), PrefabInstance({ source: SRC, localId: 2, rootInstanceId: root.id() }));
    index.set(member.id(), member);

    // Accept side first: everything still addressable restores, and reports nothing. A guard that
    // always fires is indistinguishable from one that works.
    const clean = detachPrefabInstance(root.id());
    expect(reattachPrefabInstance(clean)).toBe(0);

    // Now the #1272 shape: a snapshot member is no longer addressable by the guid it was captured
    // under. Silence here is what made the bug invisible — the count is the whole point.
    const snapshot = detachPrefabInstance(root.id());
    index.delete(member.id()); member.destroy();
    expect(reattachPrefabInstance(snapshot)).toBe(1);
  });

  it('reattach re-derives rootInstanceId from the ROOT\'s guid when the root came back on a new id (#1264 close-out)', async () => {
    const { detachPrefabInstance, reattachPrefabInstance } = await getModule();
    const R_GUID = 'cccccccc-0000-4000-8000-000000000001';
    const M_GUID = 'cccccccc-0000-4000-8000-000000000002';
    const root = testWorld.spawn(Transform(), EntityAttributes({ name: 'R', parentId: 0, guid: R_GUID }), PrefabInstance({ source: SRC, localId: 1 }));
    index.set(root.id(), root);
    root.set(PrefabInstance, { source: SRC, localId: 1, rootInstanceId: root.id() });
    const member = testWorld.spawn(Transform(), EntityAttributes({ name: 'M', parentId: root.id(), guid: M_GUID }), PrefabInstance({ source: SRC, localId: 2, rootInstanceId: root.id() }));
    index.set(member.id(), member);
    const oldRootId = root.id();

    const snapshot = detachPrefabInstance(root.id());

    // The root is deleted and respawned; a filler takes its recycled id first, so the root lands elsewhere.
    index.delete(oldRootId); root.destroy();
    const filler = testWorld.spawn(Transform(), EntityAttributes({ name: 'Filler', parentId: 0, guid: 'cccccccc-0000-4000-8000-0000000000ff' }));
    index.set(filler.id(), filler);
    const root2 = testWorld.spawn(Transform(), EntityAttributes({ name: 'R', parentId: 0, guid: R_GUID }));
    index.set(root2.id(), root2);
    expect(root2.id(), 'precondition: the root moved').not.toBe(oldRootId);

    reattachPrefabInstance(snapshot);

    expect((member.get(PrefabInstance) as Record<string, unknown>).rootInstanceId).toBe(root2.id());
    expect((root2.get(PrefabInstance) as Record<string, unknown>).rootInstanceId).toBe(root2.id());
    expect(filler.has(PrefabInstance), 'the recycled id is not handed the root\'s link').toBe(false);
  });
});

