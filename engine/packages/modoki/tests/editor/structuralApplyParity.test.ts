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

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => editorWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  unregisterEntity: (e: any) => index.delete(e.id()),
}));
vi.mock('../../src/runtime/ecs/entityUtils', () => ({
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
  // Cascade like the real deleteEntities (delete the subtree under each id).
  deleteEntities: (ids: number[]) => {
    const toDelete = new Set<number>();
    const visit = (id: number) => {
      if (toDelete.has(id)) return;
      toDelete.add(id);
      editorWorld.query(EntityAttributes).updateEach(([ea], e) => {
        if ((ea as any).parentId === id) visit(e.id());
      });
    };
    for (const id of ids) visit(id);
    for (const id of toDelete) { const e = index.get(id); if (e) { e.destroy(); index.delete(id); } }
  },
  readTraitData: vi.fn(),
  writeTraitField: vi.fn(),
}));
vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => TRAITS.find((t) => t.name === n),
  getAllTraits: () => TRAITS,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  invalidatePrefab: vi.fn(),
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
