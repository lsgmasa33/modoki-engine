/** Missing Test 10 (PREFAB_REVIEW F7) — editor↔runtime structural-apply parity.
 *
 *  The editor (`applyStructureByRootInstance`, prefab.ts) and the runtime
 *  (`applyStructureByLocalToEcs`, loadSceneFile.ts) each apply a captured structure
 *  (added/removed entities, removed traits) on top of a freshly-instantiated
 *  instance. They used to be two ~110-line hand-mirrored engines that drifted once
 *  (review C3). F7's fix routes BOTH through one world-parameterized core
 *  (`applyStructureCore`); this test runs the SAME structure fixtures through both
 *  public entry points and diffs the resulting entity tree (name → parent-name +
 *  trait set), so any future change that touches only one side fails here.
 *
 *  Both paths run against a real koota world; the editor side gets its world/
 *  entityUtils/traitRegistry deps mocked (it has editor deps), the runtime side
 *  imports the same module and operates on a koota world directly. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';
import { collectSubtreeIds } from '../../src/runtime/core/ecs/subtreeCollect';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });
const Rotate3D = trait({ axis: 'y' as string, speed: 1 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, parentId: 0, guid: 0, sortOrder: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0, parentLocalId: 0 } },
  { name: 'Rotate3D', trait: Rotate3D, category: 'component', fields: { axis: 0, speed: 0 } },
] as const;

// ── editor-side mock world (its module pulls editor deps) ─────────────────────
let editorWorld: ReturnType<typeof createWorld>;
const index = new Map<number, any>();
const traitNamesOf = (e: any) => TRAITS.filter((t) => e.has(t.trait)).map((t) => t.name);
/** name → ECS id at spawn, so a test can state the id collision it depends on. */
const spawnLog = new Map<string, number>();

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => editorWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  spawnEntity: (world: any, ...traits: any[]) => {
    const e = world.spawn(...traits);
    index.set(e.id(), e);
    if (e.has(EntityAttributes)) spawnLog.set(e.get(EntityAttributes).name, e.id());
    return e;
  },
  unregisterEntity: (e: any) => index.delete(e.id()),
  destroyEntity: (e: any) => { ((e: any) => index.delete(e.id()))(e); e.destroy(); },
  indexEntityGuid: vi.fn(),
  findEntityById: (id: number) => index.get(id),
  findEntityByGuid: vi.fn(),
}));
vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => {
    const out: any[] = [];
    editorWorld.query(EntityAttributes).updateEach(([ea], e) => {
      const d = ea as Record<string, unknown>;
      out.push({ id: e.id(), name: d.name, parentId: d.parentId, sortOrder: (d.sortOrder as number) ?? 0, traits: traitNamesOf(e) });
    });
    return out;
  },
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  // The real deleteEntities' walk (collectSubtreeIds) over the editor world, minus the dirty listeners.
  deleteEntities: (ids: number[]) => {
    const links: [number, number][] = [];
    editorWorld.query(EntityAttributes).updateEach(([ea], e) => { links.push([e.id(), (ea as any).parentId]); });
    for (const id of collectSubtreeIds(links, ids)) { const e = index.get(id); if (e) { e.destroy(); index.delete(id); } }
  },
  readTraitData: vi.fn(),
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
  getTraitByName: (n: string) => TRAITS.find((t) => t.name === n),
  getAllTraits: () => TRAITS,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  invalidatePrefab: vi.fn(), replaceCachedPrefab: vi.fn(),
  getCachedPrefab: vi.fn(),
  loadModelTemplates: vi.fn(),
}));
vi.mock('../../src/runtime/ui/uiTreeStore', () => ({ markUIDirty: vi.fn() }));
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  newGuid: () => 'gen-guid',
  registerAsset: vi.fn(),
  getGuidForPath: () => undefined,
  isGuid: (s: string) => typeof s === 'string' && s.includes('-'),
  resolveRef: (g: string) => g,
  isExternalUrl: () => false,
  getAssetType: () => undefined,
  deriveGuid: (s: string) => `derived-${s}`,
  getAssetEntry: () => undefined,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));

const getEditor = () => import('../../src/editor/scene/prefab');
const getRuntime = () => import('../../src/runtime/loaders/loadSceneFile');

// Prefab: Root(1) → Branch(2, carries Rotate3D) → Leaf(3).
function makePrefab() {
  return {
    id: 'parity-prefab',
    rootLocalId: 1,
    entities: [
      { localId: 1, traits: { EntityAttributes: { name: 'Root', parentId: 0, guid: '' } } },
      { localId: 2, traits: { EntityAttributes: { name: 'Branch', parentId: 1, guid: '' }, Rotate3D: { axis: 'y', speed: 5 } } },
      { localId: 3, traits: { EntityAttributes: { name: 'Leaf', parentId: 2, guid: '' } } },
    ],
  };
}

/** Stamp a localToEcs map onto a koota world by spawning the prefab members and
 *  tagging them with PrefabInstance, mirroring what an instantiate produces. */
function instantiateInto(world: ReturnType<typeof createWorld>, source: string): Map<number, number> {
  const prefab = makePrefab();
  const localToEcs = new Map<number, number>();
  const handles = new Map<number, any>();
  for (const e of prefab.entities) {
    const ea = e.traits.EntityAttributes as any;
    const args: any[] = [EntityAttributes({ name: ea.name, parentId: 0, guid: '', sortOrder: 0 })];
    if ((e.traits as any).Rotate3D) args.push(Rotate3D((e.traits as any).Rotate3D));
    args.push(PrefabInstance({ source, localId: e.localId, rootInstanceId: 0 }));
    const h = world.spawn(...args);
    localToEcs.set(e.localId, h.id());
    handles.set(e.localId, h);
    index.set(h.id(), h); // keep the editor index warm (no-op for the runtime world)
  }
  // Patch parentId + rootInstanceId now that ids exist.
  const rootId = localToEcs.get(1)!;
  for (const e of prefab.entities) {
    const ea = e.traits.EntityAttributes as any;
    const h = handles.get(e.localId)!;
    h.set(EntityAttributes, { ...h.get(EntityAttributes), parentId: ea.parentId === 0 ? 0 : localToEcs.get(ea.parentId)! });
    h.set(PrefabInstance, { ...h.get(PrefabInstance), rootInstanceId: rootId });
  }
  return localToEcs;
}

/** Normalize a world's entity tree to a comparable shape: name → {parent name,
 *  sorted trait set minus PrefabInstance, rotate speed}. Ids and PrefabInstance
 *  tags (which the two paths set differently for the seed members) are excluded so
 *  the diff is purely about the STRUCTURE the apply produced. */
function shape(world: ReturnType<typeof createWorld>): Record<string, unknown> {
  const byId = new Map<number, any>();
  for (const e of world.entities as any) if (e.has(EntityAttributes)) byId.set(e.id(), e);
  const nameOf = (id: number) => (byId.has(id) ? byId.get(id).get(EntityAttributes).name : (id === 0 ? '<root>' : `<gone:${id}>`));
  const out: Record<string, unknown> = {};
  for (const e of byId.values()) {
    const ea = e.get(EntityAttributes);
    out[ea.name] = {
      parent: nameOf(ea.parentId),
      guid: ea.guid,
      traits: TRAITS.map((t) => t.name).filter((n) => n !== 'PrefabInstance' && e.has(TRAITS.find((x) => x.name === n)!.trait)).sort(),
      rotate: e.has(Rotate3D) ? e.get(Rotate3D).speed : undefined,
    };
  }
  return out;
}

// Each structure fixture, run identically through both entry points.
const fixtures: { label: string; structure: any }[] = [
  {
    label: 'added child under a member',
    structure: {
      added: [{
        parentLocalId: 2, guid: 'g-crown', name: 'Crown',
        traits: { EntityAttributes: { name: 'Crown', parentId: 0, guid: 'g-crown' }, Transform: { x: 7 } },
        children: [{
          parentLocalId: 0, guid: 'g-gem', name: 'Gem',
          traits: { EntityAttributes: { name: 'Gem', parentId: 0, guid: 'g-gem' } }, children: [],
        }],
      }],
    },
  },
  {
    label: 'removed member (cascades descendants)',
    structure: { removed: [2] },
  },
  {
    label: 'removed trait on a member',
    structure: { removedTraits: { 2: ['Rotate3D'] } },
  },
  {
    label: 'addition whose anchor was removed this pass is skipped',
    structure: {
      removed: [2],
      added: [{
        parentLocalId: 2, guid: 'g-x', name: 'Orphan',
        traits: { EntityAttributes: { name: 'Orphan', parentId: 0, guid: 'g-x' } }, children: [],
      }],
    },
  },
  {
    label: 'addition whose anchor is merely absent re-anchors to root',
    structure: {
      added: [{
        parentLocalId: 99, guid: 'g-y', name: 'Kept',
        traits: { EntityAttributes: { name: 'Kept', parentId: 0, guid: 'g-y' } }, children: [],
      }],
    },
  },
];

describe('editor↔runtime structural-apply parity (F7 — shared applyStructureCore)', () => {
  beforeEach(() => { editorWorld = createWorld(); index.clear(); });

  for (const { label, structure } of fixtures) {
    it(`produces identical structure: ${label}`, async () => {
      // ── editor path ──
      const { applyStructureByRootInstance } = await getEditor();
      const editorLocalToEcs = instantiateInto(editorWorld, 'src');
      const rootId = editorLocalToEcs.get(1)!;
      applyStructureByRootInstance(rootId, makePrefab() as any, structure);
      const editorShape = shape(editorWorld);

      // ── runtime path (independent fresh world) ──
      index.clear();
      const { applyStructureByLocalToEcs } = await getRuntime();
      const runtimeWorld = createWorld();
      const runtimeLocalToEcs = instantiateInto(runtimeWorld, 'src');
      applyStructureByLocalToEcs(runtimeWorld, runtimeLocalToEcs, makePrefab() as any, structure);
      const runtimeShape = shape(runtimeWorld);

      // The two implementations must produce the same tree, name-for-name.
      expect(runtimeShape).toEqual(editorShape);
    });
  }
});

// ── #1247: a removal that reaches a nested instance, through BOTH real instantiators ──────────────────────
//
// The fixtures above hand-build an instance; these run the instantiators themselves, because the defect is
// in the window between their two passes: a nested row's structure apply runs while the outer rows spawned
// so far wait for their parent remap. Each case asserts a LITERAL tree on both sides, not only parity — the
// two sides once agreed on a wrong tree.

const CHILD = 'child-prefab';
const childPrefab = {
  id: CHILD, version: 1 as const, name: 'Child', rootLocalId: 1,
  entities: [
    { localId: 1, traits: { EntityAttributes: { name: 'CRoot', parentId: 0, guid: '' } } },
    { localId: 2, traits: { EntityAttributes: { name: 'CMember', parentId: 1, guid: '' } } },
  ],
};

type Row = { localId: number; traits: Record<string, unknown>; prefab?: string; removed?: number[] };
const row = (localId: number, name: string, parentId: number, extra: Partial<Row> = {}): Row =>
  ({ localId, traits: { EntityAttributes: { name, parentId, guid: '' } }, ...extra });
const outerOf = (...entities: Row[]) => ({ id: 'outer-prefab', version: 1 as const, name: 'Outer', rootLocalId: 1, entities });

/** name → parent name, over every live entity. A parent id naming no live entity reads `<gone:id>`. */
function parents(world: ReturnType<typeof createWorld>): Record<string, string> {
  const byId = new Map<number, any>();
  for (const e of world.entities as any) if (e.has(EntityAttributes)) byId.set(e.id(), e);
  const out: Record<string, string> = {};
  for (const e of byId.values()) {
    const { name, parentId } = e.get(EntityAttributes);
    out[name] = parentId === 0 ? '<root>' : byId.has(parentId) ? byId.get(parentId).get(EntityAttributes).name : `<gone:${parentId}>`;
  }
  return out;
}

/** Run one outer prefab (+ an optional instance-level structure) through the editor, then the runtime, each
 *  in a fresh world prepared by `prepare`. Returns each side's tree and spawn log. */
async function throughBoth(outer: ReturnType<typeof outerOf>, structure: any, prepare: (w: ReturnType<typeof createWorld>) => void = () => {}) {
  const editor = await getEditor();
  const runtime = await getRuntime();
  const meshCache = await import('../../src/runtime/loaders/meshTemplateCache');
  vi.mocked(meshCache.getCachedPrefab).mockImplementation(((ref: string) => (ref === CHILD ? childPrefab : null)) as never);
  editor.setPrefabCache(CHILD, childPrefab as never);

  editorWorld = createWorld(); index.clear(); prepare(editorWorld); spawnLog.clear();
  const rootId = editor.instantiatePrefab(outer as never, 0);
  if (structure) editor.applyStructureByRootInstance(rootId, outer as never, structure);
  const editorSide = { tree: parents(editorWorld), log: new Map(spawnLog) };

  const world = createWorld(); index.clear(); prepare(world); spawnLog.clear();
  runtime.instantiatePrefabIntoWorld(world, outer as never, 0, undefined, 'outer-prefab', undefined, structure);
  const runtimeSide = { tree: parents(world), log: new Map(spawnLog) };
  // koota caps a process at 16 live worlds and this file creates one per F7 case too — free these, or the
  // next case added here fails at createWorld for a reason unrelated to what it tests.
  editorWorld.destroy(); world.destroy();
  return { editorSide, runtimeSide };
}

describe('#1247 — a removal reaching a nested instance (editor + runtime instantiators)', () => {
  beforeEach(() => { index.clear(); spawnLog.clear(); });

  // Mutation: restore the runtime's exact-ids delete (no cascade) — the runtime side keeps CMember under
  // `<gone:…>`. The editor side cascaded before the fix too, so it is the parity guard here.
  it('removing the outer member above a nested row takes the nested instance\'s members too', async () => {
    const outer = outerOf(row(1, 'Root', 0), row(2, 'Wing', 1), row(3, 'FlameRow', 2, { prefab: CHILD }));
    const { editorSide, runtimeSide } = await throughBoth(outer, { removed: [2] });
    expect(runtimeSide.tree).toEqual({ Root: '<root>' });
    expect(editorSide.tree).toEqual({ Root: '<root>' });
  });

  // Probe A from the issue. Mutation: spawn the first pass with the file's raw parentId (either side) — B's
  // raw parent 5 names CMember while the nested row's removal cascades, so B is destroyed on that side.
  it('a nested row\'s own removal does not take an outer row whose raw file parent collides with the removed id', async () => {
    const outer = outerOf(
      row(1, 'Root', 0), row(5, 'A', 1), row(90, 'B', 5),
      row(91, 'NestRow', 1, { prefab: CHILD, removed: [2] }),
    );
    const { editorSide, runtimeSide } = await throughBoth(outer, undefined);
    for (const side of [editorSide, runtimeSide]) {
      expect(side.log.get('CMember'), 'premise: the removed member holds B\'s raw file parent number').toBe(5);
      expect(side.tree).toEqual({ Root: '<root>', A: 'Root', B: 'A', CRoot: 'Root' });
    }
  });

  // Probe B: the same collision on a RECYCLED index, with the most common shape (an outer member whose file
  // parent is 1). Mutation: as above.
  it('holds when the removed member reclaims a freed index equal to an outer row\'s raw parent', async () => {
    const outer = outerOf(row(1, 'Root', 0), row(2, 'A', 1), row(3, 'NestRow', 1, { prefab: CHILD, removed: [2] }));
    // Free four indices so the instantiation's four spawns reclaim them; destroy order picks which lands on 1.
    const prepare = (w: ReturnType<typeof createWorld>) => {
      const fillers = [0, 1, 2, 3].map(() => w.spawn(EntityAttributes({ name: '', parentId: 0 })));
      const byId = new Map(fillers.map((f) => [f.id(), f]));
      for (const id of [...byId.keys()].sort((a, b) => a - b)) byId.get(id)!.destroy();
    };
    const { editorSide, runtimeSide } = await throughBoth(outer, undefined, prepare);
    for (const side of [editorSide, runtimeSide]) {
      expect(side.log.get('CMember'), 'premise: the removed member reclaimed index 1').toBe(1);
      expect(side.tree).toEqual({ Root: '<root>', A: 'Root', CRoot: 'Root' });
    }
  });
});
