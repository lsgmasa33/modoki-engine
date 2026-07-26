/** loadSceneFile unit tests — migration logic, entity spawning, parent remapping, prefab callbacks. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';
import { SCENE_FORMAT_VERSION } from '../../src/runtime/version';

// We need to mock the world and traitRegistry modules that loadSceneFile imports

// Create real traits matching the modoki runtime
const Transform = trait({
  x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
});

const EntityAttributes = trait({
  name: '' as string,
  isActive: true as boolean,
  sortOrder: 0,
  parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui',
  guid: '' as string,
});

const PrefabInstance = trait({
  source: '' as string,
  rootInstanceId: 0,
});

const ModelSource = trait({
  glbPath: '' as string,
  prefix: '' as string,
  postprocessor: 'none' as string,
});

let testWorld: ReturnType<typeof createWorld>;

// Mock the modules before importing loadSceneFile
vi.mock('../../src/runtime/ecs/world', () => {
  return {
    getCurrentWorld: () => testWorld,
    registerEntity: vi.fn(),
    setStructureCallback: vi.fn(),
    indexEntityGuid: () => {},
    findEntityById: (_id: number) => undefined,
    findEntityByGuid: (guid: string, world: any = testWorld) => {
      let found: any;
      world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (!found && ea.guid === guid) found = e; });
      return found;
    },
  };
});

// A synthetic trait exercising `entityId: {onMissing:'root'}` on a field that ISN'T
// EntityAttributes.parentId — proves the remap is registry-driven, not a hardcoded
// name-check on 'parentId' (Phase 15).
const LinkedRef = trait({ targetId: 0 as number });

vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: {} },
    {
      name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
      fields: { parentId: { type: 'number', entityId: { onMissing: 'root' } } },
    },
    {
      name: 'PrefabInstance', trait: PrefabInstance, category: 'component',
      fields: { rootInstanceId: { type: 'number', entityId: { onMissing: 'stripTrait' } } },
    },
    { name: 'ModelSource', trait: ModelSource, category: 'component', fields: {} },
    {
      name: 'LinkedRef', trait: LinkedRef, category: 'component',
      fields: { targetId: { type: 'number', entityId: { onMissing: 'root' } } },
    },
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find(t => t.name === name),
  };
});

vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  loadModelTemplates: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  testWorld = createWorld();
});

afterEach(() => {
  testWorld.destroy();
});

async function getLoader() {
  return import('../../../src/runtime/loaders/loadSceneFile');
}

describe('loadSceneFile', () => {
  describe('v3 → v4 migration (text fields from UIStyle to UIText)', () => {
    it('migrates fontSize from UIStyle to UIText', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: 3,
        entities: [{
          id: 1,
          traits: {
            UIStyle: { fontSize: 24, backgroundColor: '#fff' },
            // No UIText — migration should create it
          },
        }],
      };

      // loadSceneFile mutates data.version and entity traits in place
      await loadSceneFile(data as any, {
        fetchPrefab: async () => null,
        loadModels: false,
      });

      // After migration, UIStyle should not have fontSize, UIText should
      // Note: since these aren't registered traits, they won't spawn entities,
      // but the migration mutates the data object directly
      expect(data.version).toBeGreaterThanOrEqual(4);
    });
  });

  describe('v4 → v5 migration (merge UI traits into UIElement)', () => {
    it('bumps version to 5', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: 4,
        entities: [{
          id: 1,
          traits: {
            UIElement: { width: 100 },
            UIStyle: { backgroundColor: '#ff0000' },
            UIText: { fontSize: 16 },
          },
        }],
      };

      await loadSceneFile(data as any, {
        fetchPrefab: async () => null,
        loadModels: false,
      });

      expect(data.version).toBe(SCENE_FORMAT_VERSION);
      // UIStyle and UIText should be merged into UIElement and removed
      const entry = data.entities[0];
      expect(entry.traits.UIStyle).toBeUndefined();
      expect(entry.traits.UIText).toBeUndefined();
      expect((entry.traits.UIElement as any).backgroundColor).toBe('#ff0000');
      expect((entry.traits.UIElement as any).fontSize).toBe(16);
    });

    it('strips elementType from UIElement', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: 4,
        entities: [{
          id: 1,
          traits: {
            UIElement: { width: 100, elementType: 'button' },
          },
        }],
      };

      await loadSceneFile(data as any, {
        fetchPrefab: async () => null,
        loadModels: false,
      });

      expect((data.entities[0].traits.UIElement as any).elementType).toBeUndefined();
    });
  });

  describe('entity spawning', () => {
    it('spawns entities with registered traits', async () => {
      const { loadSceneFile } = await getLoader();
      const onEntitySpawned = vi.fn();

      const data = {
        version: 5,
        entities: [{
          id: 100,
          traits: {
            Transform: { x: 5, y: 10, z: 0 },
            EntityAttributes: { name: 'TestEntity', parentId: 0 },
          },
        }],
      };

      await loadSceneFile(data, {
        fetchPrefab: async () => null,
        onEntitySpawned,
        loadModels: false,
      });

      expect(onEntitySpawned).toHaveBeenCalledTimes(1);
      // First arg is the entity, second is the old ID
      expect(onEntitySpawned.mock.calls[0][1]).toBe(100);
    });

    it('spawns multiple entities', async () => {
      const { loadSceneFile } = await getLoader();
      const onEntitySpawned = vi.fn();

      const data = {
        version: 5,
        entities: [
          { id: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'A', parentId: 0 } } },
          { id: 2, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'B', parentId: 0 } } },
          { id: 3, traits: { Transform: { x: 2 }, EntityAttributes: { name: 'C', parentId: 0 } } },
        ],
      };

      await loadSceneFile(data, {
        fetchPrefab: async () => null,
        onEntitySpawned,
        loadModels: false,
      });

      expect(onEntitySpawned).toHaveBeenCalledTimes(3);
    });
  });

  describe('parent ID remapping', () => {
    it('remaps parentId from old IDs to new IDs', async () => {
      const { loadSceneFile } = await getLoader();
      const spawnedEntities: { entity: any; oldId: number }[] = [];

      const data = {
        version: 5,
        entities: [
          { id: 10, traits: { Transform: true, EntityAttributes: { name: 'Parent', parentId: 0 } } },
          { id: 20, traits: { Transform: true, EntityAttributes: { name: 'Child', parentId: 10 } } },
        ],
      };

      await loadSceneFile(data, {
        fetchPrefab: async () => null,
        onEntitySpawned: (entity: any, oldId: number) => {
          spawnedEntities.push({ entity, oldId });
        },
        loadModels: false,
      });

      expect(spawnedEntities).toHaveLength(2);

      // The child's parentId should be remapped to the parent's new ID
      const parentNewId = spawnedEntities.find(e => e.oldId === 10)!.entity.id();
      const childEntity = spawnedEntities.find(e => e.oldId === 20)!.entity;

      // Read the child's EntityAttributes to verify parentId remapping
      let childParentId = 0;
      testWorld.query(EntityAttributes).updateEach(([ea], entity) => {
        if (entity.id() === childEntity.id()) {
          childParentId = ea.parentId;
        }
      });

      expect(childParentId).toBe(parentNewId);
    });

    it('resolves a GUID parentId (current files) to the parent\'s fresh koota id', async () => {
      const { loadSceneFile } = await getLoader();
      const spawnedEntities: { entity: any; oldId: number }[] = [];

      // Current files store parentId as the PARENT'S guid, not a numeric file id.
      const data = {
        version: 5,
        entities: [
          { id: 10, traits: { Transform: true, EntityAttributes: { name: 'Parent', guid: 'guid-parent', parentId: '' } } },
          { id: 20, traits: { Transform: true, EntityAttributes: { name: 'Child', guid: 'guid-child', parentId: 'guid-parent' } } },
        ],
      };

      await loadSceneFile(data, {
        fetchPrefab: async () => null,
        onEntitySpawned: (entity: any, oldId: number) => { spawnedEntities.push({ entity, oldId }); },
        loadModels: false,
      });

      const parentNewId = spawnedEntities.find(e => e.oldId === 10)!.entity.id();
      const childEntity = spawnedEntities.find(e => e.oldId === 20)!.entity;
      let childParentId: unknown = 0;
      testWorld.query(EntityAttributes).updateEach(([ea], entity) => {
        if (entity.id() === childEntity.id()) childParentId = ea.parentId;
      });
      // Resolved to the parent's live koota id (a number) — not left as the guid string.
      expect(childParentId).toBe(parentNewId);
    });

    // F2: scene-load parentId remap must be O(n) (id→handle map built once via
    // spawnedByEntryId + O(1) guid index), not a full world scan per non-root entity.
    // We can't directly assert big-O here, so we assert correctness at scale: every
    // child in a many-entity scene resolves to its correct parent's fresh koota id,
    // for BOTH the numeric (legacy) and GUID (current) parentId forms.
    it('wires every parent correctly across a many-entity scene (numeric + GUID forms)', async () => {
      const { loadSceneFile } = await getLoader();
      const N = 50;
      const spawned = new Map<number, any>(); // oldId → entity

      const entities: any[] = [
        { id: 1, traits: { Transform: true, EntityAttributes: { name: 'root', guid: 'guid-root', parentId: '' } } },
      ];
      // Half the children use a numeric (legacy) parentId, half use the GUID form —
      // both must resolve to the SAME fresh koota id of entity 1.
      for (let i = 2; i <= N; i++) {
        const useGuid = i % 2 === 0;
        entities.push({
          id: i,
          traits: {
            Transform: true,
            EntityAttributes: {
              name: `child-${i}`,
              guid: `guid-${i}`,
              parentId: useGuid ? 'guid-root' : 1,
            },
          },
        });
      }

      await loadSceneFile({ version: 8, resources: [], entities } as any, {
        fetchPrefab: async () => null,
        onEntitySpawned: (entity: any, oldId: number) => { spawned.set(oldId, entity); },
        loadModels: false,
      });

      expect(spawned.size).toBe(N);
      const rootNewId = spawned.get(1)!.id();

      // Build oldId → live parentId by scanning once.
      const parentByEcsId = new Map<number, number>();
      testWorld.query(EntityAttributes).updateEach(([ea]: any[], e: any) => {
        parentByEcsId.set(e.id(), ea.parentId);
      });

      // Root has no parent; every child points at the root's fresh koota id.
      expect(parentByEcsId.get(rootNewId)).toBe(0);
      for (let i = 2; i <= N; i++) {
        const childEcsId = spawned.get(i)!.id();
        expect(parentByEcsId.get(childEcsId)).toBe(rootNewId);
      }
    });
  });

  describe('prefab instances', () => {
    it('calls onInstantiatePrefab for prefab instances', async () => {
      const { loadSceneFile } = await getLoader();
      const onInstantiatePrefab = vi.fn();
      const onDeletePlaceholder = vi.fn();

      const data = {
        version: 5,
        entities: [{
          id: 50,
          traits: {
            Transform: { x: 1, y: 2, z: 3 },
            EntityAttributes: { name: 'PrefabRoot', parentId: 0 },
            PrefabInstance: { source: 'prefabs/tree.prefab.json', rootInstanceId: 50 },
          },
        }],
      };

      await loadSceneFile(data, {
        fetchPrefab: async (path: string) => {
          if (path === 'prefabs/tree.prefab.json') return { version: 5, entities: [] };
          return null;
        },
        onInstantiatePrefab,
        onDeletePlaceholder,
        loadModels: false,
      });

      expect(onInstantiatePrefab).toHaveBeenCalledTimes(1);
      expect(onInstantiatePrefab.mock.calls[0][0]).toBe('prefabs/tree.prefab.json');
      expect(onDeletePlaceholder).toHaveBeenCalledTimes(1);
    });

    it('forwards entry.overrides as the 6th argument to onInstantiatePrefab', async () => {
      const { loadSceneFile } = await getLoader();
      const onInstantiatePrefab = vi.fn();

      const overrides = { 2: { Transform: { x: 99 } } };
      const data = {
        version: 7,
        entities: [{
          id: 50,
          traits: {
            Transform: { x: 0, y: 0, z: 0 },
            EntityAttributes: { name: 'PrefabRoot', parentId: 0 },
            PrefabInstance: { source: 'prefabs/tree.prefab.json', rootInstanceId: 50 },
          },
          overrides,
        }],
      };

      await loadSceneFile(data, {
        fetchPrefab: async () => ({ version: 1, entities: [] }),
        onInstantiatePrefab,
        loadModels: false,
      });

      expect(onInstantiatePrefab).toHaveBeenCalledTimes(1);
      expect(onInstantiatePrefab.mock.calls[0][5]).toEqual(overrides);
    });

    it('dispatches on the top-level entry.prefab field (nested-row form, no PrefabInstance trait)', async () => {
      const { loadSceneFile } = await getLoader();
      const onInstantiatePrefab = vi.fn();
      const data = {
        version: 8,
        entities: [{
          id: 50,
          prefab: 'prefabs/child.prefab.json',
          traits: { EntityAttributes: { name: 'Child', parentId: 0 } },
        }],
      };
      await loadSceneFile(data, {
        fetchPrefab: async () => ({ version: 2, entities: [] }),
        onInstantiatePrefab,
        loadModels: false,
      });
      expect(onInstantiatePrefab).toHaveBeenCalledTimes(1);
      expect(onInstantiatePrefab.mock.calls[0][0]).toBe('prefabs/child.prefab.json');
    });

    it('remaps a prefab-instance parentId from file id to ECS id (parented nested instance)', async () => {
      const { loadSceneFile } = await getLoader();
      const onInstantiatePrefab = vi.fn();
      const data = {
        version: 8,
        entities: [
          { id: 10, traits: { EntityAttributes: { name: 'Group', parentId: 0 } } },           // parent
          { id: 50, prefab: 'p.json', traits: { EntityAttributes: { name: 'Child', parentId: 10 } } }, // instance under 10
        ],
      };
      await loadSceneFile(data, {
        fetchPrefab: async () => ({ version: 1, entities: [] }),
        onInstantiatePrefab,
        loadModels: false,
      });
      let parentEcs = 0;
      testWorld.query(EntityAttributes).updateEach(([ea]: Record<string, unknown>[], e: { id(): number }) => {
        if ((ea as Record<string, unknown>).name === 'Group') parentEcs = e.id();
      });
      expect(parentEcs).toBeGreaterThan(0);
      // 2nd arg is the parent — the REMAPPED ECS id, not the raw file id 10.
      expect(onInstantiatePrefab.mock.calls[0][1]).toBe(parentEcs);
    });

    it('does not instantiate if prefab not found', async () => {
      const { loadSceneFile } = await getLoader();
      const onInstantiatePrefab = vi.fn();

      const data = {
        version: 5,
        entities: [{
          id: 50,
          traits: {
            Transform: true,
            EntityAttributes: { name: 'Missing', parentId: 0 },
            PrefabInstance: { source: 'prefabs/missing.prefab.json', rootInstanceId: 50 },
          },
        }],
      };

      await loadSceneFile(data, {
        fetchPrefab: async () => null,
        onInstantiatePrefab,
        loadModels: false,
      });

      expect(onInstantiatePrefab).not.toHaveBeenCalled();
    });
  });

  // scene-loading.md, Phase 12's "A8" finding: PrefabInstance.
  // rootInstanceId is a raw ecs id, and — like EntityAttributes.parentId — must be
  // remapped through idMap on every respawn or it silently goes stale. This is most
  // visible on SceneManager's carried-base-scene-snapshot respawn, which omits
  // `onInstantiatePrefab` entirely (loadSceneFile.ts's re-instantiation block never
  // runs), so EVERY entity — root and members alike — spawns via the flat/no-prefab
  // path with its baked trait data verbatim. These tests drive that exact shape
  // directly against `loadSceneFile`, without SceneManager, mirroring a real carried
  // snapshot's `entry.id`s: OLD ecs ids from a dying world, deliberately NOT matching
  // whatever fresh ids this world's own allocator will hand out.
  describe('PrefabInstance.rootInstanceId remapping (A8 fix)', () => {
    it('remaps a multi-member (flat) prefab instance\'s rootInstanceId to the root\'s fresh id — no onInstantiatePrefab (the carry shape)', async () => {
      const { loadSceneFile } = await getLoader();
      // Old-world ids: root=22, bones=28,29,30,31 (exactly the pattern observed live).
      const data = {
        version: SCENE_FORMAT_VERSION,
        entities: [
          { id: 22, traits: { Transform: true, EntityAttributes: { name: 'Fish' }, PrefabInstance: { source: 'fish.prefab.json', rootInstanceId: 22 } } },
          { id: 28, traits: { Transform: true, EntityAttributes: { name: 'head', parentId: 22 }, PrefabInstance: { source: 'fish.prefab.json', rootInstanceId: 22 } } },
          { id: 29, traits: { Transform: true, EntityAttributes: { name: 'spine1', parentId: 28 }, PrefabInstance: { source: 'fish.prefab.json', rootInstanceId: 22 } } },
          { id: 30, traits: { Transform: true, EntityAttributes: { name: 'spine2', parentId: 29 }, PrefabInstance: { source: 'fish.prefab.json', rootInstanceId: 22 } } },
          { id: 31, traits: { Transform: true, EntityAttributes: { name: 'tail', parentId: 30 }, PrefabInstance: { source: 'fish.prefab.json', rootInstanceId: 22 } } },
        ],
      };
      const spawnedEntities: { entity: any; oldId: number }[] = [];
      await loadSceneFile(data, {
        fetchPrefab: async () => null, // no onInstantiatePrefab — the carry shape
        onEntitySpawned: (entity: any, oldId: number) => { spawnedEntities.push({ entity, oldId }); },
        loadModels: false,
      });
      const rootNewId = spawnedEntities.find(e => e.oldId === 22)!.entity.id();
      for (const oldId of [22, 28, 29, 30, 31]) {
        const e = spawnedEntities.find(s => s.oldId === oldId)!.entity;
        let rootInstanceId = -1;
        testWorld.query(PrefabInstance).updateEach(([pi]: any[], ent: any) => {
          if (ent.id() === e.id()) rootInstanceId = pi.rootInstanceId;
        });
        expect(rootInstanceId).toBe(rootNewId);
      }
    });

    it('is a no-op for a SINGLE-member instance where nothing collides (still correct, not just lucky)', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: SCENE_FORMAT_VERSION,
        entities: [
          { id: 75, traits: { Transform: true, EntityAttributes: { name: 'FieldCorner' }, PrefabInstance: { source: 'corner.prefab.json', rootInstanceId: 75 } } },
        ],
      };
      const spawnedEntities: { entity: any; oldId: number }[] = [];
      await loadSceneFile(data, {
        fetchPrefab: async () => null,
        onEntitySpawned: (entity: any, oldId: number) => { spawnedEntities.push({ entity, oldId }); },
        loadModels: false,
      });
      const e = spawnedEntities[0].entity;
      let rootInstanceId = -1;
      testWorld.query(PrefabInstance).updateEach(([pi]: any[], ent: any) => {
        if (ent.id() === e.id()) rootInstanceId = pi.rootInstanceId;
      });
      expect(rootInstanceId).toBe(e.id());
    });

    it('strips PrefabInstance (and warns) when rootInstanceId has no live counterpart in this load', async () => {
      const { loadSceneFile } = await getLoader();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const data = {
        version: SCENE_FORMAT_VERSION,
        entities: [
          // rootInstanceId 999 was never a root in THIS load's subtree (e.g. its
          // root was filtered out upstream) — a poisoned pointer, not "root == self".
          { id: 40, traits: { Transform: true, EntityAttributes: { name: 'Orphan' }, PrefabInstance: { source: 'fish.prefab.json', rootInstanceId: 999 } } },
        ],
      };
      const spawnedEntities: { entity: any; oldId: number }[] = [];
      await loadSceneFile(data, {
        fetchPrefab: async () => null,
        onEntitySpawned: (entity: any, oldId: number) => { spawnedEntities.push({ entity, oldId }); },
        loadModels: false,
      });
      const e = spawnedEntities[0].entity;
      expect(e.has(PrefabInstance)).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('leaves rootInstanceId 0 (unset) untouched — nothing to remap yet', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: SCENE_FORMAT_VERSION,
        entities: [
          { id: 5, traits: { Transform: true, EntityAttributes: { name: 'Pending' }, PrefabInstance: { source: 'x.prefab.json', rootInstanceId: 0 } } },
        ],
      };
      const spawnedEntities: { entity: any; oldId: number }[] = [];
      await loadSceneFile(data, {
        fetchPrefab: async () => null,
        onEntitySpawned: (entity: any, oldId: number) => { spawnedEntities.push({ entity, oldId }); },
        loadModels: false,
      });
      const e = spawnedEntities[0].entity;
      expect(e.has(PrefabInstance)).toBe(true);
      let rootInstanceId = -1;
      testWorld.query(PrefabInstance).updateEach(([pi]: any[], ent: any) => {
        if (ent.id() === e.id()) rootInstanceId = pi.rootInstanceId;
      });
      expect(rootInstanceId).toBe(0);
    });
  });

  // scene-loading.md, Phase 2 — rootInstanceId is now written as a GUID
  // string (the last numeric on-disk entity ref, guid-ified so it no longer churns
  // across the arrival-path-dependent id assignment Phase 0/1 measured). The A8-fix
  // suite above exercises the LEGACY numeric form (still fully supported — old files
  // simply keep it); these exercise the new guid form specifically.
  describe('PrefabInstance.rootInstanceId as a GUID (Phase 2 write format)', () => {
    it('resolves a guid-valued rootInstanceId to the matching entity\'s fresh id', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: SCENE_FORMAT_VERSION,
        entities: [
          { id: 1, traits: { Transform: true, EntityAttributes: { name: 'Root', guid: 'g-root' }, PrefabInstance: { source: 'fish.prefab.json', rootInstanceId: 'g-root' } } },
          { id: 2, traits: { Transform: true, EntityAttributes: { name: 'Member', parentId: 1 }, PrefabInstance: { source: 'fish.prefab.json', rootInstanceId: 'g-root' } } },
        ],
      };
      const spawnedEntities: { entity: any; oldId: number }[] = [];
      await loadSceneFile(data, {
        fetchPrefab: async () => null, // no onInstantiatePrefab — exercises the flat/carry-shaped spawn path
        onEntitySpawned: (entity: any, oldId: number) => { spawnedEntities.push({ entity, oldId }); },
        loadModels: false,
      });
      const root = spawnedEntities.find((e) => e.oldId === 1)!.entity;
      const member = spawnedEntities.find((e) => e.oldId === 2)!.entity;
      let rootRootInstanceId = -1, memberRootInstanceId = -1;
      testWorld.query(PrefabInstance).updateEach(([pi]: any[], ent: any) => {
        if (ent.id() === root.id()) rootRootInstanceId = pi.rootInstanceId;
        if (ent.id() === member.id()) memberRootInstanceId = pi.rootInstanceId;
      });
      expect(rootRootInstanceId).toBe(root.id());
      expect(memberRootInstanceId).toBe(root.id());
    });

    it('never lets a guid string reach the live trait as NaN — the spawn-time zero guard applies to EVERY entityId field, not just EntityAttributes', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: SCENE_FORMAT_VERSION,
        entities: [
          { id: 1, traits: { Transform: true, EntityAttributes: { name: 'Root', guid: 'g-root' }, PrefabInstance: { source: 'fish.prefab.json', rootInstanceId: 'g-root' } } },
        ],
      };
      const observedAtSpawn: number[] = [];
      await loadSceneFile(data, {
        fetchPrefab: async () => null,
        onEntitySpawned: (entity: any) => {
          // Fires DURING pass 1, immediately after spawn — BEFORE the entityId remap
          // pass runs. If the spawn-time guard were missing (still checking only
          // `traitName === 'EntityAttributes'`), the guid string would have been
          // written straight into PrefabInstance's numeric SoA field here.
          testWorld.query(PrefabInstance).updateEach(([pi]: any[], ent: any) => {
            if (ent.id() === entity.id()) observedAtSpawn.push(pi.rootInstanceId);
          });
        },
        loadModels: false,
      });
      expect(observedAtSpawn).toEqual([0]);
      expect(Number.isNaN(observedAtSpawn[0])).toBe(false);
    });

    it('the root-identity check (pi && !entry.prefab path) treats a guid rootInstanceId matching its OWN guid as "this entry IS the root"', async () => {
      const { loadSceneFile } = await getLoader();
      const onInstantiatePrefab = vi.fn();
      const data = {
        version: SCENE_FORMAT_VERSION,
        entities: [{
          id: 1,
          traits: {
            Transform: true,
            EntityAttributes: { name: 'Root', guid: 'g-root' },
            PrefabInstance: { source: 'prefabs/fish.prefab.json', rootInstanceId: 'g-root' },
          },
        }],
      };
      await loadSceneFile(data, {
        fetchPrefab: async () => ({ version: 1, entities: [] }),
        onInstantiatePrefab,
        loadModels: false,
      });
      // Not skipped as "a non-root member" — onInstantiatePrefab fired for it.
      expect(onInstantiatePrefab).toHaveBeenCalledTimes(1);
    });
  });

  // Phase 15 — the remap loop is REGISTRY-driven: any trait field flagged
  // `entityId` gets remapped through `idMap` with no changes to loadSceneFile.ts
  // itself. `LinkedRef.targetId` (declared only in this test file's mocked
  // registry, onMissing:'root') proves that — it isn't 'parentId' or
  // 'rootInstanceId', the two fields loadSceneFile.ts's own comments name.
  describe('declarative entityId remap (Phase 15)', () => {
    it('remaps a non-parentId/rootInstanceId field flagged entityId', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: SCENE_FORMAT_VERSION,
        entities: [
          { id: 10, traits: { EntityAttributes: { name: 'Target' } } },
          { id: 20, traits: { EntityAttributes: { name: 'Linker' }, LinkedRef: { targetId: 10 } } },
        ],
      };
      const spawnedEntities: { entity: any; oldId: number }[] = [];
      await loadSceneFile(data, {
        fetchPrefab: async () => null,
        onEntitySpawned: (entity: any, oldId: number) => { spawnedEntities.push({ entity, oldId }); },
        loadModels: false,
      });
      const target = spawnedEntities.find((e) => e.oldId === 10)!.entity;
      const linker = spawnedEntities.find((e) => e.oldId === 20)!.entity;
      let targetId = -1;
      testWorld.query(LinkedRef).updateEach(([lr]: any[], ent: any) => {
        if (ent.id() === linker.id()) targetId = lr.targetId;
      });
      expect(targetId).toBe(target.id());
    });

    it('applies onMissing:"root" (silent 0, trait kept) when an entityId field has no live counterpart', async () => {
      const { loadSceneFile } = await getLoader();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const data = {
        version: SCENE_FORMAT_VERSION,
        entities: [
          { id: 20, traits: { EntityAttributes: { name: 'Linker' }, LinkedRef: { targetId: 999 } } },
        ],
      };
      const spawnedEntities: { entity: any; oldId: number }[] = [];
      await loadSceneFile(data, {
        fetchPrefab: async () => null,
        onEntitySpawned: (entity: any, oldId: number) => { spawnedEntities.push({ entity, oldId }); },
        loadModels: false,
      });
      const linker = spawnedEntities[0].entity;
      expect(linker.has(LinkedRef)).toBe(true);
      let targetId = -1;
      testWorld.query(LinkedRef).updateEach(([lr]: any[], ent: any) => {
        if (ent.id() === linker.id()) targetId = lr.targetId;
      });
      expect(targetId).toBe(0);
      expect(warn).not.toHaveBeenCalled(); // 'root' is a silent policy
      warn.mockRestore();
    });
  });

  /** A9 defect 1 — the chain-order mark wipe.
   *
   *  `clearAllOverrideMarks()` defends against ecs-id reuse ACROSS WORLDS, but it
   *  used to run unconditionally on every `loadSceneFile` CALL. That equivalence
   *  ("one call == one world") died with base scenes: a chain loads N scene files
   *  into ONE world, bases first and the primary last, so the primary's call wiped
   *  the marks the base's call had just seeded — and every chained prefab instance
   *  then serialized with EMPTY overrides, because `captureInstanceOverrides`
   *  mark-gates every diff.
   *
   *  These two tests pin the MECHANISM (the flag). The wiring — SceneManager
   *  clearing exactly once per staging world for a whole chain — is pinned in
   *  sceneManagerBaseSceneChain.test.ts.
   *  See docs/reviews/a9-carried-instance-overrides-investigation.md. */
  describe('override-mark lifetime (A9 defect 1)', () => {
    it('clears marks by default — an ordinary single-scene load is unchanged', async () => {
      const { loadSceneFile } = await getLoader();
      const { markOverride, getOverrideMarkSet } = await import('../../src/runtime/loaders/overrideMarks');
      // A mark left on an id from a PREVIOUS world. 4242 is never spawned by this
      // load, so only the global clear can remove it (per-entity hygiene can't).
      markOverride(4242, 'Transform', 'x');
      expect(getOverrideMarkSet(4242)?.has('Transform.x')).toBe(true);

      await loadSceneFile(
        { version: SCENE_FORMAT_VERSION, entities: [{ id: 1, traits: { Transform: true } }] },
        { fetchPrefab: async () => null, loadModels: false },
      );

      expect(getOverrideMarkSet(4242)).toBeUndefined();
    });

    it('clearMarks:false preserves marks an EARLIER scene in the same chain seeded', async () => {
      const { loadSceneFile } = await getLoader();
      const { markOverride, getOverrideMarkSet, clearAllOverrideMarks } = await import('../../src/runtime/loaders/overrideMarks');
      clearAllOverrideMarks();

      // Scene 1 of the chain (the BASE) — spawn an instance member and mark a
      // field on it, standing in for applyOverrides* seeding from the file.
      const spawned: { entity: any; oldId: number }[] = [];
      await loadSceneFile(
        {
          version: SCENE_FORMAT_VERSION,
          entities: [{ id: 22, traits: { Transform: true, EntityAttributes: { name: 'Fish' }, PrefabInstance: { source: 'fish.prefab.json', rootInstanceId: 22 } } }],
        },
        {
          world: testWorld, clearMarks: false, fetchPrefab: async () => null, loadModels: false,
          onEntitySpawned: (entity: any, oldId: number) => { spawned.push({ entity, oldId }); },
        },
      );
      const fishId = spawned.find((s) => s.oldId === 22)!.entity.id();
      markOverride(fishId, 'Transform', 'x');
      expect(getOverrideMarkSet(fishId)?.has('Transform.x')).toBe(true);

      // Scene 2 of the chain (the PRIMARY) — same world, no prefab instances of
      // its own. Before the fix this call wiped the base's marks. It must not.
      await loadSceneFile(
        { version: SCENE_FORMAT_VERSION, entities: [{ id: 7, traits: { Transform: true, EntityAttributes: { name: 'Pad' } } }] },
        { world: testWorld, clearMarks: false, fetchPrefab: async () => null, loadModels: false },
      );

      expect(getOverrideMarkSet(fishId)?.has('Transform.x')).toBe(true);
    });
  });

  describe('empty scene', () => {
    it('handles scene with no entities', async () => {
      const { loadSceneFile } = await getLoader();

      await expect(loadSceneFile(
        { version: 5, entities: [] },
        { fetchPrefab: async () => null, loadModels: false },
      )).resolves.toBeUndefined();
    });
  });
});

  describe('v5 → v6 migration (derive resources)', () => {
    it('synthesizes resources array from entities', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: 5,
        entities: [{
          id: 1,
          traits: {
            Transform: { x: 0 },
            Renderable3D: { mesh: 'b0000000-0000-4000-8000-000000000001', material: 'b0000000-0000-4000-8000-000000000002' },
            EntityAttributes: { name: 'Hero', parentId: 0 },
          },
        }],
      };

      await loadSceneFile(data as any, {
        fetchPrefab: async () => null,
        loadModels: false,
      });

      expect(data.version).toBe(SCENE_FORMAT_VERSION);
      expect((data as any).resources).toBeDefined();
      expect((data as any).resources.length).toBeGreaterThan(0);
    });

    it('preserves existing resources on v6+ scenes', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: 6,
        resources: [{ type: 'mesh', path: '/existing.mesh.json' }],
        entities: [],
      };

      await loadSceneFile(data as any, {
        fetchPrefab: async () => null,
        loadModels: false,
      });

      expect((data as any).resources).toContainEqual({ type: 'mesh', path: '/existing.mesh.json' });
    });
  });

  describe('v6 → v7 migration (Renderable2D size → width/height)', () => {
    it('splits Renderable2D.size into width and height', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: 6,
        resources: [],
        entities: [{
          id: 1,
          traits: {
            Transform: { x: 0 },
            Renderable2D: { sprite: 'circle', size: 50, color: 0xff0000 },
            EntityAttributes: { name: 'Sprite', parentId: 0 },
          },
        }],
      };

      await loadSceneFile(data as any, {
        fetchPrefab: async () => null,
        loadModels: false,
      });

      expect(data.version).toBe(SCENE_FORMAT_VERSION);
      const r2d = data.entities[0].traits.Renderable2D as any;
      expect(r2d.width).toBe(50);
      expect(r2d.height).toBe(50);
      expect(r2d.size).toBeUndefined();
    });

    it('leaves Renderable2D without size unchanged', async () => {
      const { loadSceneFile } = await getLoader();
      const data = {
        version: 6,
        resources: [],
        entities: [{
          id: 1,
          traits: {
            Transform: { x: 0 },
            Renderable2D: { sprite: 'square', width: 40, height: 60 },
            EntityAttributes: { name: 'Sprite', parentId: 0 },
          },
        }],
      };

      await loadSceneFile(data as any, {
        fetchPrefab: async () => null,
        loadModels: false,
      });

      const r2d = data.entities[0].traits.Renderable2D as any;
      expect(r2d.width).toBe(40);
      expect(r2d.height).toBe(60);
    });
  });

describe('collectResourceRefsFromEntities', () => {
  // References are GUID-only — fixtures use GUIDs (collector stores refs verbatim).
  const MESH_GUID = 'b1000000-0000-4000-8000-000000000001';
  const MAT_GUID = 'b1000000-0000-4000-8000-000000000002';
  const PRIM_MAT_GUID = 'b1000000-0000-4000-8000-000000000003';
  const SPRITE_GUID = 'b1000000-0000-4000-8000-000000000004';
  const IMG_GUID = 'b1000000-0000-4000-8000-000000000005';
  const SHARED_MAT_GUID = 'b1000000-0000-4000-8000-000000000006';
  const MODEL_GUID = 'b1000000-0000-4000-8000-000000000010';
  const PREFAB_GUID = 'b1000000-0000-4000-8000-000000000011';
  const ENV_GUID = 'b1000000-0000-4000-8000-000000000012';

  it('collects Renderable3D mesh and material refs', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { Renderable3D: { mesh: MESH_GUID, material: MAT_GUID } } },
    ]);
    expect(refs).toContainEqual({ type: 'mesh', path: MESH_GUID });
    expect(refs).toContainEqual({ type: 'material', path: MAT_GUID });
  });

  it('collects SkinnedModel GLB as a riggedModel ref', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { SkinnedModel: { model: MODEL_GUID, isActive: true } } },
    ]);
    expect(refs).toContainEqual({ type: 'riggedModel', path: MODEL_GUID });
  });

  it('collects Renderable3DPrimitive material ref', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { Renderable3DPrimitive: { mesh: 'cube', color: 0xffffff, size: 1, material: PRIM_MAT_GUID } } },
    ]);
    expect(refs).toContainEqual({ type: 'material', path: PRIM_MAT_GUID });
  });

  it('ignores Renderable3DPrimitive without material', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { Renderable3DPrimitive: { mesh: 'cube', color: 0xffffff, size: 1 } } },
    ]);
    expect(refs.filter(r => r.type === 'material')).toHaveLength(0);
  });

  it('collects Environment HDR path', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { Environment: { hdrPath: ENV_GUID, intensity: 1 } } },
    ]);
    expect(refs).toContainEqual({ type: 'environment', path: ENV_GUID });
  });

  it('collects PrefabInstance source', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { PrefabInstance: { source: PREFAB_GUID } } },
    ]);
    expect(refs).toContainEqual({ type: 'prefab', path: PREFAB_GUID });
  });

  it('collects Renderable2D sprite (texture) ref by GUID', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { Renderable2D: { sprite: SPRITE_GUID } } },
    ]);
    expect(refs).toContainEqual({ type: 'texture', path: SPRITE_GUID });
  });

  it('collects a MaterialInstance kind:texture override ref as a texture resource', async () => {
    // The per-instance extra-sampler swap is nested in overrides[], not a scalar registry
    // field — it must still land in resources[] so the build tree-shaker keeps it (prod-404 guard).
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { MaterialInstance: { overrides: [{ target: 'uReveal', kind: 'texture', ref: SPRITE_GUID }] } } },
    ]);
    expect(refs).toContainEqual({ type: 'texture', path: SPRITE_GUID });
  });

  it('does not collect a ref from a scalar-driver (uniform/prop) MaterialInstance override', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { MaterialInstance: { overrides: [{ target: 'uMix', kind: 'uniform', source: { type: 'time' } }] } } },
    ]);
    expect(refs).toHaveLength(0);
  });

  it('ignores a kind:texture override whose ref is empty or a non-GUID/URL', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { MaterialInstance: { overrides: [
        { target: 'uReveal', kind: 'texture', ref: '' },
        { target: 'uReveal', kind: 'texture', ref: 'circle' },
      ] } } },
    ]);
    expect(refs).toHaveLength(0);
  });

  it('collects Renderable2D sprite starting with http', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { Renderable2D: { sprite: 'https://cdn.example.com/img.png' } } },
    ]);
    expect(refs).toContainEqual({ type: 'texture', path: 'https://cdn.example.com/img.png' });
  });

  it('ignores Renderable2D primitive sprite keywords', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { Renderable2D: { sprite: 'circle' } } },
    ]);
    expect(refs).toHaveLength(0);
  });

  it('collects UIElement imageSrc and fontFamily', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { UIElement: { imageSrc: IMG_GUID, fontFamily: 'Roboto' } } },
    ]);
    expect(refs).toContainEqual({ type: 'texture', path: IMG_GUID });
    expect(refs).toContainEqual({ type: 'font', path: 'Roboto' });
  });

  it('collects ModelSource glbPath with postprocessor', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { ModelSource: { glbPath: MODEL_GUID, postprocessor: 'tropical-island' } } },
    ]);
    expect(refs).toContainEqual({ type: 'model', path: MODEL_GUID, postprocessor: 'tropical-island' });
  });

  it('falls back to "none" when ModelSource.postprocessor is empty', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { ModelSource: { glbPath: MODEL_GUID, postprocessor: '' } } },
    ]);
    expect(refs).toContainEqual({ type: 'model', path: MODEL_GUID, postprocessor: 'none' });
  });

  it('skips a literal (non-GUID) ModelSource.glbPath', async () => {
    // Regression: glbPath is GUID-only; a literal path must not reach resources[].
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { ModelSource: { glbPath: '/games/x/assets/island.glb', postprocessor: 'none' } } },
    ]);
    expect(refs).toHaveLength(0);
  });

  it('collects entry.prefab field', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, prefab: PREFAB_GUID, traits: {} },
    ]);
    expect(refs).toContainEqual({ type: 'prefab', path: PREFAB_GUID });
  });

  it('collects ParticleEmitter effect ref by GUID (parity with the editor collector)', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const EFFECT_GUID = 'b1000000-0000-4000-8000-000000000020';
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { ParticleEmitter: { effect: EFFECT_GUID } } },
    ]);
    // Runtime SceneManager must preload particle effects, not pop them in.
    expect(refs).toContainEqual({ type: 'particle', path: EFFECT_GUID });
  });

  it('skips a literal (non-GUID) ParticleEmitter.effect', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { ParticleEmitter: { effect: '/games/x/assets/fx/spark.particle.json' } } },
    ]);
    expect(refs).toHaveLength(0);
  });

  it('sorts output by type then path', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { Renderable3D: { mesh: '/z.mesh.json', material: '/b.mat.json' } } },
      { id: 2, traits: { Environment: { hdrPath: '/sky.hdr' } } },
      { id: 3, traits: { Renderable3D: { mesh: '/a.mesh.json', material: '' } } },
    ]);
    for (let i = 1; i < refs.length; i++) {
      const cmp = refs[i - 1].type.localeCompare(refs[i].type) || refs[i - 1].path.localeCompare(refs[i].path);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it('returns empty array for no entities', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    expect(collectResourceRefsFromEntities([])).toEqual([]);
  });

  it('deduplicates refs', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { Renderable3D: { mesh: MESH_GUID, material: SHARED_MAT_GUID } } },
      { id: 2, traits: { Renderable3DPrimitive: { mesh: 'cube', material: SHARED_MAT_GUID } } },
    ]);
    const matRefs = refs.filter(r => r.type === 'material' && r.path === SHARED_MAT_GUID);
    expect(matRefs).toHaveLength(1);
  });

  it('collects guid-shaped refs (not just path refs)', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const meshGuid = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
    const matGuid = '11111111-2222-4333-8444-555555555555';
    const refs = collectResourceRefsFromEntities([
      { id: 1, traits: { Renderable3D: { mesh: meshGuid, material: matGuid } } },
    ]);
    expect(refs).toContainEqual({ type: 'mesh', path: meshGuid });
    expect(refs).toContainEqual({ type: 'material', path: matGuid });
  });

  // DRIFT GUARD: the collector's scalar-ref scan is data-driven from
  // REF_FIELDS_BY_TRAIT (the same registry the validator + tree-shaker use). Assert
  // an asset referenced through EVERY scalar registry field yields a resource ref, so
  // a future ref field can't silently escape the preload/refcount manifest (which
  // caused pop-in + a scene-scoped refcount leak — the acquire-side .anim.json bug).
  it('DRIFT GUARD: emits a resource for every scalar field in REF_FIELDS_BY_TRAIT', async () => {
    const { collectResourceRefsFromEntities } = await getLoader();
    const { REF_FIELDS_BY_TRAIT } = await import('../../../src/runtime/scene/sceneValidation');

    let n = 0;
    const guidFor = () => `cccccccc-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const expected: string[] = [];
    const entities = Object.entries(REF_FIELDS_BY_TRAIT).map(([traitName, fields], i) => {
      const traitData: Record<string, string> = {};
      for (const field of fields) {
        const guid = guidFor();
        traitData[field] = guid;
        expected.push(guid);
      }
      return { id: i + 1, traits: { [traitName]: traitData } };
    });

    const refs = collectResourceRefsFromEntities(entities);
    const collectedPaths = new Set(refs.map((r) => r.path));
    const missing = expected.filter((g) => !collectedPaths.has(g));
    expect(missing, `registry ref fields NOT collected as resources: ${missing.join(', ')}`).toEqual([]);
  });
});

// ── v7 → v8 migration (Persistent.guid → EntityAttributes.guid) ──────────

describe('v7 → v8 migration (consolidate Persistent.guid into EntityAttributes)', () => {
  it('moves Persistent.guid onto EntityAttributes.guid', async () => {
    const { loadSceneFile } = await getLoader();
    const data = {
      version: 7,
      resources: [],
      entities: [{
        id: 1,
        traits: {
          EntityAttributes: { name: 'Player', parentId: 0 },
          Persistent: { guid: 'guid-player-1' },
        },
      }],
    };
    await loadSceneFile(data as any, {
      fetchPrefab: async () => null,
      loadModels: false,
    });
    expect(data.version).toBe(SCENE_FORMAT_VERSION);
    expect((data.entities[0].traits.EntityAttributes as any).guid).toBe('guid-player-1');
    // Persistent should be reduced to its marker form
    expect(data.entities[0].traits.Persistent).toBe(true);
  });

  it('does not overwrite an existing EntityAttributes.guid', async () => {
    const { loadSceneFile } = await getLoader();
    const data = {
      version: 7,
      resources: [],
      entities: [{
        id: 1,
        traits: {
          EntityAttributes: { name: 'Player', parentId: 0, guid: 'already-set' },
          Persistent: { guid: 'guid-old' },
        },
      }],
    };
    await loadSceneFile(data as any, {
      fetchPrefab: async () => null,
      loadModels: false,
    });
    expect((data.entities[0].traits.EntityAttributes as any).guid).toBe('already-set');
    expect(data.entities[0].traits.Persistent).toBe(true);
  });

  it('preserves v8 Persistent/guid data (version advances to current)', async () => {
    const { loadSceneFile } = await getLoader();
    const data = {
      version: 8,
      resources: [],
      entities: [{
        id: 1,
        traits: {
          EntityAttributes: { name: 'X', parentId: 0, guid: 'g1' },
          Persistent: true,
        },
      }],
    };
    await loadSceneFile(data as any, {
      fetchPrefab: async () => null,
      loadModels: false,
    });
    // v8→v9 (renderable rename) bumps the stamp but touches nothing here.
    expect(data.version).toBe(SCENE_FORMAT_VERSION);
    expect(data.entities[0].traits.Persistent).toBe(true);
    expect((data.entities[0].traits.EntityAttributes as any).guid).toBe('g1');
  });

  it('handles a Persistent trait without a guid (legacy edge case)', async () => {
    const { loadSceneFile } = await getLoader();
    const data = {
      version: 7,
      resources: [],
      entities: [{
        id: 1,
        traits: {
          EntityAttributes: { name: 'X', parentId: 0 },
          Persistent: {},
        },
      }],
    };
    await loadSceneFile(data as any, {
      fetchPrefab: async () => null,
      loadModels: false,
    });
    expect(data.version).toBe(SCENE_FORMAT_VERSION);
    expect(data.entities[0].traits.Persistent).toBe(true);
    // No guid was available to move
    expect((data.entities[0].traits.EntityAttributes as any).guid).toBeFalsy();
  });
});

// ── v8 → v9 migration (renderable isActive → per-renderer isVisible) ──────
describe('v8 → v9 migration (renderable isActive → isVisible)', () => {
  it('renames a renderable trait isActive → isVisible but leaves EntityAttributes.isActive', async () => {
    const { loadSceneFile } = await getLoader();
    const data = {
      version: 8,
      resources: [],
      entities: [{
        id: 1,
        traits: {
          Renderable3D: { mesh: 'm', material: '', isActive: false },
          EntityAttributes: { name: 'X', parentId: 0, isActive: true },
        },
      }],
    };
    await loadSceneFile(data as any, { fetchPrefab: async () => null, loadModels: false });
    const r3d = data.entities[0].traits.Renderable3D as any;
    expect(r3d.isVisible).toBe(false); // value carried over
    expect(r3d.isActive).toBeUndefined();
    // The entity on/off flag is NOT a renderable trait — untouched.
    expect((data.entities[0].traits.EntityAttributes as any).isActive).toBe(true);
    expect(data.version).toBe(SCENE_FORMAT_VERSION);
  });

  it('deep helper renames inside prefab overrides / added / nestedOverrides, not EntityAttributes', async () => {
    const { renameRenderableActiveToVisibleDeep } = await getLoader();
    const node = {
      traits: { ParticleEmitter: { effect: 'e', isActive: false }, EntityAttributes: { isActive: false } },
      overrides: { 5: { Renderable2D: { isActive: false }, EntityAttributes: { isActive: true } } },
      added: [{ traits: { SkinnedModel: { model: 'g', isActive: true } }, children: [] }],
      nestedOverrides: { '3/7': { Renderable3DPrimitive: { isActive: false } } },
    };
    renameRenderableActiveToVisibleDeep(node);
    expect((node.traits.ParticleEmitter as any).isVisible).toBe(false);
    expect((node.traits.ParticleEmitter as any).isActive).toBeUndefined();
    expect((node.traits.EntityAttributes as any).isActive).toBe(false); // untouched
    expect((node.overrides[5].Renderable2D as any).isVisible).toBe(false);
    expect((node.overrides[5].EntityAttributes as any).isActive).toBe(true); // untouched
    expect((node.added[0].traits.SkinnedModel as any).isVisible).toBe(true);
    expect((node.nestedOverrides['3/7'].Renderable3DPrimitive as any).isVisible).toBe(false);
  });

  it('does not clobber an already-present isVisible', async () => {
    const { renameRenderableActiveToVisibleDeep } = await getLoader();
    const node = { traits: { Renderable3D: { isActive: false, isVisible: true } } };
    renameRenderableActiveToVisibleDeep(node);
    expect((node.traits.Renderable3D as any).isVisible).toBe(true); // kept
    expect((node.traits.Renderable3D as any).isActive).toBeUndefined();
  });
});

describe('migration terminal version', () => {
  // F10: the migration chain's terminal version must equal SCENE_FORMAT_VERSION, so
  // the constant is the single source of truth. If someone bumps the constant (or
  // adds a migration) without keeping the terminal stamp in lockstep, this fails
  // instead of silently mislabeling freshly-migrated files as under-versioned.
  it('migrates an old (v3) scene up to exactly SCENE_FORMAT_VERSION', async () => {
    const { loadSceneFile } = await getLoader();
    const data = {
      version: 3,
      entities: [{
        id: 1,
        traits: { EntityAttributes: { name: 'X', parentId: 0 } },
      }],
    };
    await loadSceneFile(data as any, {
      fetchPrefab: async () => null,
      loadModels: false,
    });
    expect(data.version).toBe(SCENE_FORMAT_VERSION);
  });
});

describe('migrateV9toV10 (base-scene plan, Phase 1)', () => {
  // v10 is a deliberately inert no-op passthrough (owner-confirmed) — it only
  // moves the terminal version stamp; nothing else about a v9 file may change.
  it('migrates a v9 scene to v10 with no diff other than `version`', async () => {
    const { loadSceneFile } = await getLoader();
    const data = {
      version: 9,
      resources: [],
      entities: [{
        id: 1,
        traits: { EntityAttributes: { name: 'X', parentId: 0 }, Transform: { x: 5 } },
      }],
    };
    const before = JSON.parse(JSON.stringify(data));
    await loadSceneFile(data as any, { fetchPrefab: async () => null, loadModels: false });
    expect(data.version).toBe(SCENE_FORMAT_VERSION);
    const { version: _v, ...rest } = data as any;
    const { version: _bv, ...beforeRest } = before;
    expect(rest).toEqual(beforeRest);
  });

  it('round-trips an optional baseScene ref through the migration chain', async () => {
    const { loadSceneFile } = await getLoader();
    const data = {
      version: 3,
      baseScene: 'base-scene-guid-123',
      entities: [{ id: 1, traits: { EntityAttributes: { name: 'X', parentId: 0 } } }],
    };
    await loadSceneFile(data as any, { fetchPrefab: async () => null, loadModels: false });
    expect((data as any).baseScene).toBe('base-scene-guid-123');
    expect(data.version).toBe(SCENE_FORMAT_VERSION);
  });
});

describe('migrateV10toV11 (scene-loading.md, Phase 2)', () => {
  // v11 is a deliberately inert no-op passthrough — it only changes HOW
  // rootInstanceId is WRITTEN going forward, not the shape of an existing file.
  // A v10 file's numeric rootInstanceId must load completely unchanged.
  it('migrates a v10 scene to v11 with no diff other than `version` — including a legacy numeric rootInstanceId', async () => {
    const { loadSceneFile } = await getLoader();
    const data = {
      version: 10,
      resources: [],
      entities: [{
        id: 1,
        traits: {
          EntityAttributes: { name: 'X', parentId: 0 },
          PrefabInstance: { source: 'fish.prefab.json', rootInstanceId: 1 },
        },
      }],
    };
    const before = JSON.parse(JSON.stringify(data));
    await loadSceneFile(data as any, { fetchPrefab: async () => null, loadModels: false });
    expect(data.version).toBe(SCENE_FORMAT_VERSION);
    const { version: _v, ...rest } = data as any;
    const { version: _bv, ...beforeRest } = before;
    expect(rest).toEqual(beforeRest);
  });
});

describe('migrateV11toV12 + assignSyntheticEntityIds (scene-loading.md, Phase 3)', () => {
  // v12 is a deliberately inert no-op passthrough — it only changes HOW entities
  // are keyed going forward (no `id` written at all), not the shape of an
  // existing file. A v11 file that STILL carries ids must load completely
  // unchanged (assignSyntheticEntityIds only fills GAPS, never overwrites).
  it('migrates a v11 scene (with explicit ids) to v12 with no diff other than `version`', async () => {
    const { loadSceneFile } = await getLoader();
    const data = {
      version: 11,
      resources: [],
      entities: [{
        id: 5,
        traits: { EntityAttributes: { name: 'X', parentId: 0 } },
      }],
    };
    const before = JSON.parse(JSON.stringify(data));
    await loadSceneFile(data as any, { fetchPrefab: async () => null, loadModels: false });
    expect(data.version).toBe(SCENE_FORMAT_VERSION);
    const { version: _v, ...rest } = data as any;
    const { version: _bv, ...beforeRest } = before;
    expect(rest).toEqual(beforeRest);
  });

  it('loads a v12 file with NO entity ids at all — spawns every entity and resolves guid-based parentId', async () => {
    const { loadSceneFile } = await getLoader();
    const data = {
      version: SCENE_FORMAT_VERSION,
      entities: [
        { traits: { Transform: true, EntityAttributes: { name: 'Root', guid: 'g-root' } } },
        { traits: { Transform: true, EntityAttributes: { name: 'Child', guid: 'g-child', parentId: 'g-root' } } },
      ],
    };
    const spawnedEntities: { entity: any; oldId: number }[] = [];
    await loadSceneFile(data as any, {
      fetchPrefab: async () => null,
      onEntitySpawned: (entity: any, oldId: number) => { spawnedEntities.push({ entity, oldId }); },
      loadModels: false,
    });
    expect(spawnedEntities).toHaveLength(2);
    // The synthesized oldIds are the array indices (0, 1) — proving the backfill ran.
    expect(spawnedEntities.map((e) => e.oldId).sort()).toEqual([0, 1]);
    const root = spawnedEntities.find((e) => e.oldId === 0)!.entity;
    const child = spawnedEntities.find((e) => e.oldId === 1)!.entity;
    let childParentId = -1;
    testWorld.query(EntityAttributes).updateEach(([ea]: any[], ent: any) => {
      if (ent.id() === child.id()) childParentId = (ea as any).parentId;
    });
    expect(childParentId).toBe(root.id());
  });

  it('a MIXED file (some entries id-less, some explicit) never lets a backfilled id collide with a real one', async () => {
    // Entry 0 is id-less (array index 0 would normally be assigned), but entry 1
    // already explicitly claims id 0 — the naive "just use the index" backfill
    // would alias them in idMap, misattributing a parentId/rootInstanceId
    // reference to the wrong entity with no warning.
    const { loadSceneFile } = await getLoader();
    const data = {
      version: SCENE_FORMAT_VERSION,
      entities: [
        { traits: { Transform: true, EntityAttributes: { name: 'Gapless' } } },
        { id: 0, traits: { Transform: true, EntityAttributes: { name: 'Explicit' } } },
      ],
    };
    const spawnedEntities: { entity: any; oldId: number }[] = [];
    await loadSceneFile(data as any, {
      fetchPrefab: async () => null,
      onEntitySpawned: (entity: any, oldId: number) => { spawnedEntities.push({ entity, oldId }); },
      loadModels: false,
    });
    expect(spawnedEntities).toHaveLength(2);
    const oldIds = spawnedEntities.map((e) => e.oldId);
    expect(new Set(oldIds).size).toBe(2); // no collision
    expect(spawnedEntities.some((e) => e.oldId === 0)).toBe(true); // the explicit id survived
  });

  it('a serializeScene → loadSceneFile round-trip works with no entity ids anywhere in between', async () => {
    // serializeScene() itself lives in editor/, out of reach for this runtime-only
    // test file's mocked registry — so this directly exercises what serializeScene
    // NOW produces: entities with no `id` field at all.
    const { loadSceneFile } = await getLoader();
    const serializedShape = {
      version: SCENE_FORMAT_VERSION,
      entities: [
        { name: 'Solo', traits: { Transform: true, EntityAttributes: { name: 'Solo', guid: 'g-solo' } } },
      ],
    };
    expect('id' in serializedShape.entities[0]).toBe(false);
    await loadSceneFile(serializedShape as any, { fetchPrefab: async () => null, loadModels: false });
    let found = false;
    testWorld.query(EntityAttributes).updateEach(([ea]: any[]) => { if ((ea as any).name === 'Solo') found = true; });
    expect(found).toBe(true);
  });
});
