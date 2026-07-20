/** C2 regression — a prefab instance the user DRAGS under another instance's
 *  member (so it carries no `parentLocalId`, because it didn't expand from the
 *  parent prefab) must round-trip under its EXACT parent member. It is captured as
 *  a reference `added` node on the owning top-level instance (not dropped, and not
 *  re-anchored to the scene root). On reload it re-expands under the same member. */

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

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  unregisterEntity: (e: any) => index.delete(e.id()),
  findEntityById: (id: number) => index.get(id),
  findEntityByGuid: (guid: string, world: any = testWorld) => {
    let found: any;
    world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (!found && ea.guid === guid) found = e; });
    return found;
  },
  indexEntityGuid: () => {},
  getGuidIndex: (world: any = testWorld) => {
    const m = new Map<string, any>();
    world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { const g = ea.guid; if (g && !m.has(g)) m.set(g, e); });
    return m;
  },
  rebuildGuidIndexSync: () => {},
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
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn(), getCachedPrefab: vi.fn(() => null) }));
let guidN = 0;
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  newGuid: () => `guid-${++guidN}`,
  registerAsset: vi.fn(),
  getGuidForPath: () => undefined,
  getAssetType: () => 'prefab',
  isGuid: (s: string) => typeof s === 'string' && s.includes('-'),
  isExternalUrl: () => false,
  isInternalAssetPath: () => false,
  resolveRef: (g: string) => `/__prefabs__/${g}.json`,
  deriveGuid: (seed: string) => `derived-${seed}`,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));
vi.mock('../../src/runtime/scene/SceneManager', () => ({ sceneManager: { loadScene: vi.fn() } }));
vi.mock('../../src/editor/undo/undoManager', () => ({ clearHistory: vi.fn() }));

beforeEach(async () => {
  testWorld = createWorld(); index.clear(); guidN = 0;
  const { clearAllOverrideMarks } = await import('../../src/runtime/loaders/overrideMarks');
  clearAllOverrideMarks();
});

const P = 'ffffffff-0000-4000-8000-00000000000p';
const Q = 'ffffffff-0000-4000-8000-00000000000q';

// P: root P1(1) + member child P2(2). Q: a separate single-entity prefab.
const pPrefab = { id: P, version: 1 as const, name: 'P', rootLocalId: 1, entities: [
  { localId: 1, name: 'P1', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'P1', parentId: 0, guid: '' } } },
  { localId: 2, name: 'P2', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'P2', parentId: 1, guid: '' } } },
] };
const qPrefab = { id: Q, version: 1 as const, name: 'Q', rootLocalId: 1, entities: [
  { localId: 1, name: 'Q1', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Q1', parentId: 0, guid: '' } } },
] };

const findByName = (name: string): number => {
  let id = 0;
  testWorld.query(EntityAttributes).updateEach(([ea], e) => { if ((ea as any).name === name) id = e.id(); });
  return id;
};

/** Reparent helper: drop entity `id` under `parentEcs` (mirrors a Hierarchy drag). */
function reparent(id: number, parentEcs: number) {
  const ea = index.get(id).get(EntityAttributes) as Record<string, unknown>;
  index.get(id).set(EntityAttributes, { ...ea, parentId: parentEcs });
}

describe('user-dragged nested instance (no parentLocalId) round-trips under its member', () => {
  it('captures it as a reference `added` node on the owner (not a stray top-level entry)', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource } = await import('../../src/editor/scene/prefab');
    const { serializeScene } = await import('../../src/editor/scene/serialize');
    setPrefabCache(P, pPrefab as any);
    setPrefabCache(Q, qPrefab as any);

    const pRoot = instantiatePrefab(pPrefab as any); setPrefabSource(pRoot, P);
    const p2 = findByName('P2');

    // User drags Q under P2 (a member of P). instantiatePrefab does NOT stamp
    // parentLocalId, so Q's root has parentLocalId === 0 (user-added).
    const qRoot = instantiatePrefab(qPrefab as any); setPrefabSource(qRoot, Q);
    reparent(qRoot, p2);
    expect((index.get(qRoot).get(PrefabInstance) as any).parentLocalId).toBe(0);

    const scene = await serializeScene();

    // NOT written as a standalone top-level entry…
    expect(scene.entities.filter((e) => e.prefab === Q)).toHaveLength(0);
    // …but folded into the P instance's `added` as a reference node anchored at
    // P2's localId (2), carrying Q's source.
    const pEntry = scene.entities.find((e) => e.prefab === P)!;
    expect(pEntry.added).toBeTruthy();
    const ref = pEntry.added!.find((n) => n.prefab === Q)!;
    expect(ref).toBeTruthy();
    expect(ref.parentLocalId).toBe(2); // P2's localId
  });

  it('re-expands the dragged instance under the SAME member on reload (exact placement)', async () => {
    const { instantiatePrefab, instantiatePrefabAsync, setPrefabCache, setPrefabSource } = await import('../../src/editor/scene/prefab');
    const { serializeScene } = await import('../../src/editor/scene/serialize');
    setPrefabCache(P, pPrefab as any);
    setPrefabCache(Q, qPrefab as any);

    const pRoot = instantiatePrefab(pPrefab as any); setPrefabSource(pRoot, P);
    reparent(instantiatePrefabSetSource(instantiatePrefab, setPrefabSource, qPrefab, Q), findByName('P2'));

    const scene = await serializeScene();
    const pEntry = scene.entities.find((e) => e.prefab === P)!;
    const struct = { added: pEntry.added, removed: pEntry.removed, removedTraits: pEntry.removedTraits };

    // Reload into a fresh world: re-instantiate P, then re-apply its structure
    // (mirrors the runtime load path, editor side).
    testWorld = createWorld(); index.clear();
    const { applyStructureByRootInstance } = await import('../../src/editor/scene/prefab');
    const pRoot2 = await instantiatePrefabAsync(pPrefab as any); setPrefabSource(pRoot2, P);
    applyStructureByRootInstance(pRoot2, pPrefab as any, struct as any);

    // The dragged Q instance exists again, parented under the live P2 member.
    const q1 = findByName('Q1');
    expect(q1).toBeGreaterThan(0);
    const qParent = (index.get(q1).get(EntityAttributes) as any).parentId;
    const p2New = findByName('P2');
    expect(qParent).toBe(p2New);
  });

  it('mints a guid on a freshly instantiated prefab root so it is referenceable on drop', async () => {
    const { instantiatePrefabAsync, setPrefabCache } = await import('../../src/editor/scene/prefab');
    setPrefabCache(P, pPrefab as any);

    // The prefab template carries an EMPTY guid (templates have no per-instance
    // identity). Before the fix the root stayed empty-guid until the next scene
    // save, so an entity-ref field (e.g. BoneAttachment.target) silently no-op'd
    // when this instance was dropped onto it. Now the root gets a guid immediately.
    const root = await instantiatePrefabAsync(pPrefab as any);
    const rootGuid = (index.get(root).get(EntityAttributes) as any).guid;
    expect(rootGuid).toBeTruthy();
    expect(rootGuid).toMatch(/^guid-/); // from the mocked newGuid()
  });
});

/** tiny helper: instantiate Q and stamp its source, returning the root id. */
function instantiatePrefabSetSource(inst: any, setSrc: any, prefab: any, src: string): number {
  const root = inst(prefab); setSrc(root, src); return root;
}
