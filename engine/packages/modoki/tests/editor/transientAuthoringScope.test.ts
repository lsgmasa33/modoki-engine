/** Authoring scope — a live entity tagged `Transient` (a UIEntries pooled row, a timeline scrub or
 *  control-track spawn) is a RUNTIME artifact, and no editor reader that treats the live tree as
 *  AUTHORING input may take it for authored content.
 *
 *  The question used to be answered by two hand-rolled copies of the same walk and not asked at all
 *  by two other readers (#1301, #1306). These cover the shared predicate plus the two readers that
 *  never had it. `serializeScene`'s own side is covered by transientSerializeSkip.test.ts.
 *
 *  ⚠️ The pool spawns these while the sim is STOPPED (it runs above TRANSFORM so a paused list keeps
 *  recycling), which is why these two readers looked unreachable. The measurement is in
 *  docs/prefabs.md § Authoring scope.
 */
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

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); index.set(e.id(), e); return e; },
  unregisterEntity: (e: any) => index.delete(e.id()),
  destroyEntity: (e: any) => { ((e: any) => index.delete(e.id()))(e); e.destroy(); },
}));
vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => getAllEntitiesImpl(),
  findEntity: (id: number) => findEntityImpl(id),
  markStructureDirty: vi.fn(),
  deleteEntities: (ids: number[]) => deleteEntitiesImpl(ids),
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
  // Mirrors the real readTraitDataFull: the keys a trait PERSISTS — its koota
  // schema for a SoA trait, the live object's own keys for AoS — NOT the
  // meta.fields Inspector subset that readTraitData reads.
  readTraitDataFull: (id: number, meta: any) => {
    const e: any = findEntityImpl(id);
    if (!e || !e.has(meta.trait)) return null;
    if (meta.category === 'tag') return {};
    const data = e.get(meta.trait);
    const schema = (meta.trait as { schema?: unknown }).schema;
    const keys = schema && typeof schema === 'object' ? Object.keys(schema) : Object.keys(data);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = data[k];
    return out;
  },
  writeTraitField: (id: number, meta: any, field: string, value: unknown) => writeTraitFieldImpl(id, meta, field, value),
}));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => TRAITS.find((t) => t.name === n),
  getAllTraits: () => TRAITS,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn(), replaceCachedPrefab: vi.fn() }));

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


async function withTransientChild() {
  const { m, root } = await setup();
  const { Transient } = await import('../../src/runtime/core/traits/Transient');
  // A generated child under the authored root: the pooled-row shape, where only the subtree ROOT
  // carries the tag and its own children do not.
  const gen = testWorld.spawn(EntityAttributes({ name: 'PooledRow', parentId: root, guid: 'pooled-guid' }), Transform({ x: 7, y: 0, z: 0 }));
  index.set(gen.id(), gen);
  const inner = testWorld.spawn(EntityAttributes({ name: 'RowLabel', parentId: gen.id(), guid: 'pooled-label-guid' }), Transform({ x: 0, y: 0, z: 0 }));
  index.set(inner.id(), inner);
  gen.add(Transient);
  return { m, root, Transient, genId: gen.id(), innerId: inner.id() };
}

describe('collectTransientSubtreeIds — the shared predicate', () => {
  it('excludes a tagged entity AND its untagged descendants', async () => {
    const { genId, innerId } = await withTransientChild();
    const { collectTransientSubtreeIds } = await import('../../src/editor/scene/authoringScope');
    const excluded = collectTransientSubtreeIds(getAllEntitiesImpl() as never);
    expect(excluded.has(genId)).toBe(true);
    // ⚠️ The load-bearing half. Only the ROOT of a generated subtree is tagged, so a reader that
    // filtered on `has(Transient)` alone would keep this child and drop its parent — writing an
    // orphaned half-subtree, which is worse than not filtering at all.
    expect(excluded.has(innerId)).toBe(true);
  });

  it('excludes nothing, and keeps the list identity, when no entity is tagged', async () => {
    await setup();
    const { collectTransientSubtreeIds, filterAuthoringVisible } = await import('../../src/editor/scene/authoringScope');
    const all = getAllEntitiesImpl() as never[];
    expect(collectTransientSubtreeIds(all as never).size).toBe(0);
    expect(filterAuthoringVisible(all as never)).toBe(all); // same array — the common case allocates nothing
  });
});

describe('serializePrefab (Create Prefab) — #1306', () => {
  it('leaves a runtime subtree out of the new prefab file', async () => {
    const { m, root, genId, innerId } = await withTransientChild();
    void genId; void innerId;
    const file = m.serializePrefab(root, undefined, { name: 'Ship' });
    const names = (file?.entities ?? []).map((e: { name?: string }) => e.name);
    expect(names).toEqual(['Ship', 'Flame']);   // measured before the fix: [...,'PooledRow','RowLabel']
  });

  it('REPORTS how many it left out — the prefab must not quietly come out smaller', async () => {
    const { m, root } = await withTransientChild();
    let reported = -1;
    m.serializePrefab(root, undefined, { name: 'Ship', onRuntimeExcluded: (n: number) => { reported = n; } });
    expect(reported).toBe(2); // the tagged row AND its child
  });

  /** ⚠️ The count must be SELECTION-scoped, not world-scoped — and `withTransientChild()` cannot
   *  tell the two apart, because it parents the tagged subtree under the selection root, where both
   *  answers are 2. This fixture puts the runtime subtree somewhere else entirely.
   *
   *  World-scoped is not a rounding error, it is the alarm that makes the real report worthless: on
   *  a pooled scene EVERY Create Prefab, on any authored entity, would warn about a prefab that
   *  lost nothing — so the one time the warning is true, nobody is reading it any more. */
  it('counts only what the SELECTION lost, not every runtime entity in the scene', async () => {
    const { m, root } = await setup();
    const { Transient } = await import('../../src/runtime/core/traits/Transient');
    // A runtime subtree at the scene root — no relation to the entity being turned into a prefab.
    const stray = testWorld.spawn(EntityAttributes({ name: 'PooledRow', parentId: 0, guid: 'stray-guid' }), Transform({ x: 0, y: 0, z: 0 }));
    index.set(stray.id(), stray);
    const strayChild = testWorld.spawn(EntityAttributes({ name: 'RowLabel', parentId: stray.id(), guid: 'stray-child-guid' }), Transform({ x: 0, y: 0, z: 0 }));
    index.set(strayChild.id(), strayChild);
    stray.add(Transient);

    let reported = -1;
    const file = m.serializePrefab(root, undefined, { name: 'Ship', onRuntimeExcluded: (n: number) => { reported = n; } });

    expect((file?.entities ?? []).map((e: { name?: string }) => e.name)).toEqual(['Ship', 'Flame']); // nothing lost
    expect(reported).toBe(-1); // ...so nothing reported: the callback must not fire at all
  });

  it('does NOT report when there is nothing to leave out', async () => {
    const { m, root } = await setup();
    let called = false;
    m.serializePrefab(root, undefined, { name: 'Ship', onRuntimeExcluded: () => { called = true; } });
    expect(called).toBe(false);
  });

  it('keeps the whole subtree when the SELECTION ROOT is itself runtime — that is a deliberate bake', async () => {
    const { m, genId } = await withTransientChild();
    // Pointing Create Prefab straight at generated content is an explicit "save this"; excluding
    // the selection itself would write an empty file and look like a failure with no message.
    const file = m.serializePrefab(genId, undefined, { name: 'PooledRow' });
    expect((file?.entities ?? []).map((e: { name?: string }) => e.name)).toEqual(['PooledRow', 'RowLabel']);
  });
});

describe('rebuildInstance — #1301', () => {
  it('carries Transient across the teardown + respawn', async () => {
    const { m, root } = await setup();
    const { Transient } = await import('../../src/runtime/core/traits/Transient');
    index.get(root).add(Transient);
    const emptyStructure = { added: [], removed: [], removedTraits: {}, consumedEcsIds: new Set<number>() };
    const newRoot = m.rebuildInstance(root, SRC, shipPrefab as never, {}, emptyStructure);
    // Transience belongs to the IDENTITY, like the durable guid the rebuild already carries. Before
    // the fix this read false, which is what made a preview artifact serializable.
    expect(index.get(newRoot).has(Transient)).toBe(true);
  });

  it('does not invent Transient for an authored instance', async () => {
    const { m, root } = await setup();
    const { Transient } = await import('../../src/runtime/core/traits/Transient');
    const emptyStructure = { added: [], removed: [], removedTraits: {}, consumedEcsIds: new Set<number>() };
    const newRoot = m.rebuildInstance(root, SRC, shipPrefab as never, {}, emptyStructure);
    expect(index.get(newRoot).has(Transient)).toBe(false);
  });
});

describe('nested generated subtrees — whose rows are whose', () => {
  /** The rule is per REGION, not per tag: exclude every generated subtree that STARTS inside the
   *  selection, except one starting at the selection root itself.
   *
   *  ⚠️ Neither simpler rule works, and both were tried:
   *  - "exclude every tagged entity in the selection" breaks the bake case, because in production
   *    EVERY member of a generated subtree carries the tag (`spawnEntity` tags everything spawned
   *    inside a system tick), not just its root — so baking a pooled row would write a one-entity
   *    prefab and drop its label.
   *  - "skip filtering whenever the selection sits anywhere inside a tagged subtree" (what the
   *    first cut did) re-opens #1306: an UNRELATED generated subtree deeper in the selection is
   *    then written into the file as an authored member and tagged as an instance member, silently,
   *    with the report suppressed. Found by the close-out re-review, measured. */
  async function nested() {
    const m = await import('../../src/editor/scene/prefab');
    const { Transient } = await import('../../src/runtime/core/traits/Transient');
    const spawn = (name: string, parentId: number, guid: string) => {
      const e = testWorld.spawn(EntityAttributes({ name, parentId, guid }), Transform({ x: 0, y: 0, z: 0 }));
      index.set(e.id(), e);
      return e;
    };
    const outer = spawn('OuterPooled', 0, 'outer-guid');   // a generated region...
    const middle = spawn('Middle', outer.id(), 'middle-guid');        // ...with an untagged node in it
    const authored = spawn('Authored', middle.id(), 'authored-guid');
    const inner = spawn('InnerPooled', middle.id(), 'inner-guid');    // a DIFFERENT generated region
    const innerChild = spawn('InnerRow', inner.id(), 'inner-child-guid');
    outer.add(Transient); inner.add(Transient); innerChild.add(Transient);
    return { m, Transient, outer, middle, authored, inner, innerChild };
  }

  it('excludes a generated region that starts INSIDE the selection, even when the selection itself sits in one', async () => {
    const { m, middle } = await nested();
    let reported = -1;
    const file = m.serializePrefab(middle.id(), undefined, { name: 'Middle', onRuntimeExcluded: (n: number) => { reported = n; } });
    expect((file?.entities ?? []).map((e: { name?: string }) => e.name)).toEqual(['Middle', 'Authored']);
    expect(reported).toBe(2); // InnerPooled + InnerRow
  });

  it('does not tag that region as a member of the new instance either', async () => {
    const { m, middle, inner } = await nested();
    const file = m.serializePrefab(middle.id(), undefined, { name: 'Middle' });
    m.tagEntityTreeAsInstance(middle.id(), SRC, file!);
    const piMeta = TRAITS.find((t) => t.name === 'PrefabInstance')!;
    expect(middle.has(piMeta.trait)).toBe(true);
    // Unfixed this was stamped localId 2 of the new instance — a live pooled row the pool will
    // recycle out from under an instance that believes it owns it.
    expect(inner.has(piMeta.trait)).toBe(false);
  });

  it('bakes the WHOLE selected region when pointed at generated content, tagged children included', async () => {
    const { m, inner } = await nested();
    let reported = -1;
    // Every member of a generated region is tagged in production, so this is the case that a
    // per-tag rule silently destroys: the prefab must still contain InnerRow.
    const file = m.serializePrefab(inner.id(), undefined, { name: 'InnerPooled', onRuntimeExcluded: (n: number) => { reported = n; } });
    expect((file?.entities ?? []).map((e: { name?: string }) => e.name)).toEqual(['InnerPooled', 'InnerRow']);
    expect(reported).toBe(-1);
  });
});

describe('tagEntityTreeAsInstance — the SECOND read of the same tree', () => {
  /** Create Prefab writes the file with `serializePrefab`, then converts the live tree into an
   *  instance with `tagEntityTreeAsInstance`, which re-walks the world and re-runs `planPrefabRows`
   *  — and refuses to tag at all when its plan does not match the file it was handed
   *  (`planMatchesFile` -> bare `return`). So the two reads must select the SAME entities: the
   *  moment one excludes a runtime subtree and the other does not, Create Prefab silently leaves
   *  the whole tree unlinked and the user gets a prefab asset with no instance in the scene.
   *
   *  ⚠️ Built on PLAIN entities, never on `setup()`'s instance: `setPrefabSource` tags the root, so
   *  a "root has PrefabInstance" assertion over that fixture is true before the call and cannot
   *  fail. The first cut of this test did exactly that and passed against the unfixed code. */
  it('selects the same entities as serializePrefab, so the tag is not refused', async () => {
    const m = await import('../../src/editor/scene/prefab');
    const { Transient } = await import('../../src/runtime/core/traits/Transient');
    const root = testWorld.spawn(EntityAttributes({ name: 'Widget', parentId: 0, guid: 'widget-guid' }), Transform({ x: 0, y: 0, z: 0 }));
    index.set(root.id(), root);
    const child = testWorld.spawn(EntityAttributes({ name: 'Face', parentId: root.id(), guid: 'face-guid' }), Transform({ x: 1, y: 0, z: 0 }));
    index.set(child.id(), child);
    const pooled = testWorld.spawn(EntityAttributes({ name: 'PooledRow', parentId: root.id(), guid: 'pooled-guid' }), Transform({ x: 9, y: 0, z: 0 }));
    index.set(pooled.id(), pooled);
    pooled.add(Transient);

    const file = m.serializePrefab(root.id(), undefined, { name: 'Widget' });
    expect((file?.entities ?? []).map((e: { name?: string }) => e.name)).toEqual(['Widget', 'Face']);

    m.tagEntityTreeAsInstance(root.id(), SRC, file!);

    const piMeta = TRAITS.find((t) => t.name === 'PrefabInstance')!;
    // The tag landed — i.e. planMatchesFile agreed. Unfixed, tagEntityTreeAsInstance's plan carries
    // the pooled row the file does not, the match fails, and this is false with nothing logged.
    expect(root.has(piMeta.trait)).toBe(true);
    // ...and the runtime subtree is NOT made a member: its localIds do not exist in the file, so a
    // later rebuild would delete rows it could never put back.
    expect(pooled.has(piMeta.trait)).toBe(false);
  });
});

describe('runtimeExcludedMessage — one wording, and only one', () => {
  it('agrees in number with the count', async () => {
    const { runtimeExcludedMessage } = await import('../../src/editor/scene/authoringScope');
    expect(runtimeExcludedMessage(1)).toContain('1 runtime entity was left out');
    expect(runtimeExcludedMessage(4)).toContain('4 runtime entities were left out');
  });
});
