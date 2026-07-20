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

vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: {} },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {} },
    { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: {} },
    { name: 'ModelSource', trait: ModelSource, category: 'component', fields: {} },
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
