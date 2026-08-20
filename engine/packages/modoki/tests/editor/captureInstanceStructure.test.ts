/** captureInstanceStructure — structural diff of a live prefab instance vs its
 *  source: added child entities, removed prefab members, removed components.
 *  (Added components are covered by getOverrideValues; not retested here.)
 *
 *  Real koota world + traits; world/entityUtils/traitRegistry mocked to inject
 *  the test world, mirroring tagEntityTreeAsInstance.test.ts. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';
import { Transient } from '../../src/runtime/core/traits/Transient';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '' as string, isActive: true, sortOrder: 0, parentId: 0, guid: '' as string, layer: '' as '' | '3d' | '2d' | 'ui' });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });
const Rotate3D = trait({ axis: 'y' as string, speed: 1 });
const Light = trait(); // tag
// AoS (callback) trait with a non-scalar `slots` field DELIBERATELY absent from the
// curated `fields` — stands in for SkinnedMeshRenderer.materials / AnimationLibrary.
// animSets. snapshotAddedTraits must fall back to live-data keys (not meta.fields) or
// it silently drops the non-scalar field on a user-added prefab child.
const AudioBank = trait(() => ({ node: '' as string, slots: {} as Record<string, string> }));

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, isActive: 0, sortOrder: 0, parentId: 0, guid: 0, layer: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0 } },
  { name: 'Rotate3D', trait: Rotate3D, category: 'component', fields: { axis: 0, speed: 0 } },
  { name: 'Light', trait: Light, category: 'tag', fields: {} },
  { name: 'AudioBank', trait: AudioBank, category: 'component', fields: { node: 0 } },
] as const;

let testWorld: ReturnType<typeof createWorld>;
const entityIndex = new Map<number, any>();
let entityInfos: { id: number; name: string; parentId: number; sortOrder: number; traits: string[] }[] = [];

vi.mock('../../src/runtime/core/ecs/world', () => ({
  onWorldSwap: () => () => {},
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => entityIndex.set(e.id(), e),
  unregisterEntity: (e: any) => entityIndex.delete(e.id()),
  destroyEntity: (e: any) => { ((e: any) => entityIndex.delete(e.id()))(e); e.destroy(); },
}));

vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => entityInfos,
  findEntity: (id: number) => entityIndex.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: vi.fn(),
  readTraitData: vi.fn(),
  // Mirrors the real readTraitDataFull: the keys a trait PERSISTS — its koota
  // schema for a SoA trait, the live object's own keys for AoS — NOT the
  // meta.fields Inspector subset that readTraitData reads.
  readTraitDataFull: (id: number, meta: any) => {
    const e: any = entityIndex.get(id);
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
  // Real semantics: root + all descendants by parentId (used by the Transient exclusion).
  subtreeIds: (flat: { id: number; parentId: number }[], rootId: number) => {
    const out = [rootId];
    const walk = (p: number) => { for (const c of flat) if (c.parentId === p) { out.push(c.id); walk(c.id); } };
    walk(rootId);
    return out;
  },
}));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
  getAllTraits: () => TRAITS,
}));

async function getModule() {
  return import('../../src/editor/scene/prefab');
}

const ROOT = 1000; // rootInstanceId

/** Spawn a tagged prefab member. */
function spawnMember(localId: number, parentId: number, name: string, extra: any[] = []): number {
  const e = testWorld.spawn(
    EntityAttributes({ name, parentId, guid: `guid-${name}` }),
    PrefabInstance({ source: 'src', localId, rootInstanceId: ROOT }),
    ...extra,
  );
  entityIndex.set(e.id(), e);
  entityInfos.push({ id: e.id(), name, parentId, sortOrder: 0, traits: ['EntityAttributes', 'PrefabInstance', ...extra.map(traitName)] });
  return e.id();
}

/** Spawn a plain (non-member) entity — i.e. a user-added child. */
function spawnPlain(parentId: number, name: string, guid: string, extra: any[] = []): number {
  const e = testWorld.spawn(
    EntityAttributes({ name, parentId, guid }),
    Transform({ x: 1 }),
    ...extra,
  );
  entityIndex.set(e.id(), e);
  entityInfos.push({ id: e.id(), name, parentId, sortOrder: 0, traits: ['EntityAttributes', 'Transform', ...extra.map(traitName)] });
  return e.id();
}

function traitName(instance: any): string {
  // koota trait instances aren't introspectable by name here; tests pass the
  // names explicitly via spawn helpers, so this is only reached for extras we tag.
  return instance?.__name ?? 'Light';
}

function makePrefab(entities: { localId: number; name: string; traits: Record<string, any> }[]) {
  return { name: 'p', version: 1 as const, rootLocalId: 1, entities };
}

describe('captureInstanceStructure', () => {
  beforeEach(() => {
    testWorld = createWorld();
    entityIndex.clear();
    entityInfos = [];
  });

  /** ── added children are COMPACTED, like any top-level entity ──────────────────
   *
   *  `snapshotAddedTraits` used to copy every schema key unconditionally, while its own comment
   *  claimed to "Mirror serialize.ts EXACTLY" — which skips a field still holding its default.
   *  The result was churn: the written subtree tracked whatever fields the trait schema happened
   *  to have on the day it was saved, so `skinned-test.scene.json` grew `castShadow`/`receiveShadow`
   *  on a re-save years later (bug `kxcE2EBsVmrbbHpBzXMb`).
   *
   *  Omitting is lossless here because an added child has NO prefab base: `spawnNode` rebuilds it
   *  with `meta.trait(d)` and koota refills every absent key from the same schema. */
  describe('added-child trait compaction', () => {
    it('omits a field still holding its schema default', async () => {
      const { captureInstanceStructure } = await getModule();
      const prefab = makePrefab([{ localId: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }]);
      const rootId = spawnMember(1, 0, 'Root');
      spawnPlain(rootId, 'Crown', 'guid-crown');   // Transform({x:1}) — y/z/rx../sz all default

      const t = captureInstanceStructure(ROOT, prefab as any).added[0].traits.Transform as Record<string, unknown>;
      expect(t.x).toBe(1);                          // the authored value survives
      expect(Object.keys(t)).toEqual(['x']);        // ...and nothing else is written
    });

    it('keeps a non-default value on every field that has one', async () => {
      const { captureInstanceStructure } = await getModule();
      const prefab = makePrefab([{ localId: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }]);
      const rootId = spawnMember(1, 0, 'Root');
      const e = testWorld.spawn(EntityAttributes({ name: 'Tilted', parentId: rootId, guid: 'g-t' }), Transform({ x: 1, ry: 0.5, sz: 2 }));
      entityIndex.set(e.id(), e);
      entityInfos.push({ id: e.id(), name: 'Tilted', parentId: rootId, sortOrder: 0, traits: ['EntityAttributes', 'Transform'] });

      const t = captureInstanceStructure(ROOT, prefab as any).added[0].traits.Transform as Record<string, unknown>;
      expect(t).toEqual({ x: 1, ry: 0.5, sz: 2 });
    });

    /** AoS traits expose a FUNCTION schema, so there is no per-key default to compare against —
     *  they stay full. This is the fidelity case the surrounding comment exists for: reading the
     *  curated `meta.fields` here once dropped `slots`-shaped non-scalars on a save. */
    it('leaves an AoS trait FULL, including a field absent from meta.fields', async () => {
      const { captureInstanceStructure } = await getModule();
      const prefab = makePrefab([{ localId: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }]);
      const rootId = spawnMember(1, 0, 'Root');
      const e = testWorld.spawn(
        EntityAttributes({ name: 'Speaker', parentId: rootId, guid: 'g-s' }),
        Transform({ x: 1 }),
        AudioBank({ node: '', slots: { a: 'x' } }),   // `node` IS its default — must still survive
      );
      entityIndex.set(e.id(), e);
      entityInfos.push({ id: e.id(), name: 'Speaker', parentId: rootId, sortOrder: 0, traits: ['EntityAttributes', 'Transform', 'AudioBank'] });

      const bag = captureInstanceStructure(ROOT, prefab as any).added[0].traits.AudioBank as Record<string, unknown>;
      expect(bag).toEqual({ node: '', slots: { a: 'x' } });
    });

    /** A trait whose every field is default still appears — compaction removes FIELDS, never a
     *  whole trait. ApplyPrefabDialog counts trait NAMES off this bag, so dropping one would
     *  silently shrink what the dialog offers to apply. */
    it('keeps an all-default trait as an empty bag, so the trait itself is not lost', async () => {
      const { captureInstanceStructure } = await getModule();
      const prefab = makePrefab([{ localId: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }]);
      const rootId = spawnMember(1, 0, 'Root');
      const e = testWorld.spawn(EntityAttributes({ name: 'Plain', parentId: rootId, guid: 'g-p' }), Transform(), Rotate3D());
      entityIndex.set(e.id(), e);
      entityInfos.push({ id: e.id(), name: 'Plain', parentId: rootId, sortOrder: 0, traits: ['EntityAttributes', 'Transform', 'Rotate3D'] });

      const traits = captureInstanceStructure(ROOT, prefab as any).added[0].traits;
      expect(Object.keys(traits).sort()).toEqual(['EntityAttributes', 'Rotate3D', 'Transform']);
      expect(traits.Rotate3D).toEqual({});          // present, and empty
    });
  });

  it('captures a user-added child as an added subtree anchored to its member parent', async () => {
    const { captureInstanceStructure } = await getModule();
    const prefab = makePrefab([{ localId: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }]);

    const rootId = spawnMember(1, 0, 'Root');
    const addedId = spawnPlain(rootId, 'Crown', 'guid-crown');

    const s = captureInstanceStructure(ROOT, prefab as any);

    expect(s.added).toHaveLength(1);
    expect(s.added[0].parentLocalId).toBe(1);
    expect(s.added[0].guid).toBe('guid-crown');
    expect(s.added[0].name).toBe('Crown');
    expect(Object.keys(s.added[0].traits).sort()).toEqual(['EntityAttributes', 'Transform']);
    expect(s.added[0].children).toEqual([]);
    expect(s.consumedEcsIds.has(addedId)).toBe(true);
    expect(s.removed).toEqual([]);
    expect(s.removedTraits).toEqual({});
  });

  it('EXCLUDES a Transient child (scrub/preview spawn) AND its subtree from `added` (review H2)', async () => {
    // A control-track prefab spawned under an authored prefab-instance member during scrub/preview
    // is tagged Transient. The structural-capture pass must skip it (and its subtree) exactly like
    // serializeScene does — else it bakes into the instance's `added` overrides and leaks to disk.
    const { captureInstanceStructure } = await getModule();
    const prefab = makePrefab([{ localId: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }]);
    const rootId = spawnMember(1, 0, 'Root');

    // A genuine user-added child (must survive) …
    const crownId = spawnPlain(rootId, 'Crown', 'guid-crown');
    // … and a Transient scrub-spawn under the same member, with a nested child of its own.
    const spawnRoot = testWorld.spawn(EntityAttributes({ name: 'FxSpawn', parentId: rootId, guid: 'guid-fx' }), Transform({ x: 1 }), Transient);
    entityIndex.set(spawnRoot.id(), spawnRoot);
    entityInfos.push({ id: spawnRoot.id(), name: 'FxSpawn', parentId: rootId, sortOrder: 0, traits: ['EntityAttributes', 'Transform'] });
    const spawnChild = testWorld.spawn(EntityAttributes({ name: 'FxSpark', parentId: spawnRoot.id(), guid: 'guid-fxc' }), Transform({ x: 2 }));
    entityIndex.set(spawnChild.id(), spawnChild);
    entityInfos.push({ id: spawnChild.id(), name: 'FxSpark', parentId: spawnRoot.id(), sortOrder: 0, traits: ['EntityAttributes', 'Transform'] });

    const s = captureInstanceStructure(ROOT, prefab as any);

    const names = s.added.map((a) => a.name);
    expect(names).toContain('Crown');    // authored add survives
    expect(names).not.toContain('FxSpawn');   // Transient root excluded
    expect(names).not.toContain('FxSpark');   // and its subtree
    expect(s.added).toHaveLength(1);
    expect(s.consumedEcsIds.has(crownId)).toBe(true);
    expect(s.consumedEcsIds.has(spawnRoot.id())).toBe(false);
  });

  it('keeps a non-scalar AoS field on an added child — data-key fallback', async () => {
    // Regression: an added entity carrying a non-scalar AoS field (like
    // SkinnedMeshRenderer.materials) must survive capture. meta.fields omits the
    // field, so a meta.fields fallback would silently drop it.
    const { captureInstanceStructure } = await getModule();
    const prefab = makePrefab([{ localId: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }]);
    const rootId = spawnMember(1, 0, 'Root');

    const slots = { head: 'guid-mat-a', body: 'guid-mat-b' };
    const e = testWorld.spawn(
      EntityAttributes({ name: 'Mesh', parentId: rootId, guid: 'guid-mesh' }),
      AudioBank({ node: 'n', slots }),
    );
    entityIndex.set(e.id(), e);
    entityInfos.push({ id: e.id(), name: 'Mesh', parentId: rootId, sortOrder: 0, traits: ['EntityAttributes', 'AudioBank'] });

    const s = captureInstanceStructure(ROOT, prefab as any);
    expect(s.added).toHaveLength(1);
    const captured = s.added[0].traits.AudioBank as Record<string, unknown>;
    expect(captured.slots).toEqual(slots);
  });

  it('nests an added-under-added child via children, not a second top-level entry', async () => {
    const { captureInstanceStructure } = await getModule();
    const prefab = makePrefab([{ localId: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 } } }]);

    const rootId = spawnMember(1, 0, 'Root');
    const aId = spawnPlain(rootId, 'A', 'guid-a');
    spawnPlain(aId, 'B', 'guid-b');

    const s = captureInstanceStructure(ROOT, prefab as any);

    expect(s.added).toHaveLength(1);
    expect(s.added[0].guid).toBe('guid-a');
    expect(s.added[0].children).toHaveLength(1);
    expect(s.added[0].children[0].guid).toBe('guid-b');
    expect(s.consumedEcsIds.size).toBe(2);
  });

  it('reports a deleted prefab member as removed (top-most only)', async () => {
    const { captureInstanceStructure } = await getModule();
    // Prefab: Root(1) → Branch(2) → Leaf(3). Instance deleted Branch (and Leaf).
    const prefab = makePrefab([
      { localId: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 } } },
      { localId: 2, name: 'Branch', traits: { EntityAttributes: { name: 'Branch', parentId: 1 } } },
      { localId: 3, name: 'Leaf', traits: { EntityAttributes: { name: 'Leaf', parentId: 2 } } },
    ]);

    spawnMember(1, 0, 'Root'); // only the root member survives

    const s = captureInstanceStructure(ROOT, prefab as any);
    expect(s.removed).toEqual([2]); // 3 cascades under 2, not listed separately
    expect(s.added).toEqual([]);
  });

  it('reports a deleted component on a surviving member as removedTraits', async () => {
    const { captureInstanceStructure } = await getModule();
    // Prefab root has Rotate3D + Light; the live instance dropped both.
    const prefab = makePrefab([
      { localId: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 }, Rotate3D: { axis: 'y', speed: 1 }, Light: true } },
    ]);

    spawnMember(1, 0, 'Root'); // spawned WITHOUT Rotate3D / Light

    const s = captureInstanceStructure(ROOT, prefab as any);
    expect(s.removedTraits[1].sort()).toEqual(['Light', 'Rotate3D']);
    expect(s.removed).toEqual([]);
    expect(s.added).toEqual([]);
  });

  it('returns empty diffs for an unmodified instance', async () => {
    const { captureInstanceStructure } = await getModule();
    const prefab = makePrefab([
      { localId: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 } } },
      { localId: 2, name: 'Child', traits: { EntityAttributes: { name: 'Child', parentId: 1 } } },
    ]);

    const rootId = spawnMember(1, 0, 'Root');
    spawnMember(2, rootId, 'Child');

    const s = captureInstanceStructure(ROOT, prefab as any);
    expect(s.added).toEqual([]);
    expect(s.removed).toEqual([]);
    expect(s.removedTraits).toEqual({});
  });
});
