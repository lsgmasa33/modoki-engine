/** instantiatePrefabIntoWorld — verify per-localId override application.
 *
 *  Builds a self-contained world + trait registry so we control field metadata
 *  for `meta.fields` membership checks inside applyOverridesByLocalToEcs. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({
  x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
});

const EntityAttributes = trait({
  name: '' as string,
  parentId: 0,
});

const PrefabInstance = trait({
  source: '' as string,
  localId: 0,
  rootInstanceId: 0,
});

const Renderable3D = trait({
  mesh: '' as string,
  material: '' as string,
  color: 0xffffff,
});

const Rotate3D = trait({
  axis: 'y' as 'x' | 'y' | 'z',
  speed: 1,
});

// Tag trait — no schema (koota tag).
const Disabled = trait();

// AoS (callback-form) trait mirroring AnimationLibrary: animSets/boneMaps are
// non-scalar live keys NOT declared in meta.fields (only `retarget` is). Exercises
// the AoS-aware override apply (bone-map-lost-on-reload fix).
const Library = trait(() => ({
  animSets: [] as string[],
  retarget: false as boolean,
  boneMaps: {} as Record<string, Record<string, string>>,
}));

let testWorld: ReturnType<typeof createWorld>;

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: vi.fn(),
  setStructureCallback: vi.fn(),
}));

vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: '', parentId: 0 } },
    { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: '', localId: 0, rootInstanceId: 0 } },
    { name: 'Renderable3D', trait: Renderable3D, category: 'component', fields: { mesh: '', material: '', color: 0 } },
    { name: 'Rotate3D', trait: Rotate3D, category: 'component', fields: { axis: 'y', speed: 1 } },
    { name: 'Disabled', trait: Disabled, category: 'tag', fields: {} },
    { name: 'Library', trait: Library, category: 'component', fields: { retarget: false } },
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find(t => t.name === name),
  };
});

vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  loadModelTemplates: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/runtime/ui/uiTreeStore', () => ({
  markUIDirty: vi.fn(),
}));

beforeEach(() => { testWorld = createWorld(); });
afterEach(() => { testWorld.destroy(); });

async function getLoader() {
  return import('../../src/runtime/loaders/loadSceneFile');
}

function findEntityByLocalId(world: ReturnType<typeof createWorld>, localId: number): { id(): number } | null {
  let found: { id(): number } | null = null;
  world.query(PrefabInstance).updateEach(([pi], entity) => {
    if (found) return;
    if ((pi as Record<string, unknown>).localId === localId) found = entity as unknown as { id(): number };
  });
  return found;
}

describe('instantiatePrefabIntoWorld with overrides', () => {
  it('applies per-localId field overrides after clean instantiation', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();

    const prefab = {
      rootLocalId: 1,
      entities: [
        { localId: 1, traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'Root', parentId: 0 } } },
        { localId: 2, traits: { Transform: { x: 5, y: 0, z: 0 }, EntityAttributes: { name: 'Child', parentId: 1 } } },
      ],
    };

    const overrides = {
      2: { Transform: { x: 99, y: 42 } },
    };

    instantiatePrefabIntoWorld(testWorld, prefab, 0, undefined, 'pkg/test.prefab.json', overrides);

    const child = findEntityByLocalId(testWorld, 2);
    expect(child).not.toBeNull();
    const tf = (child as unknown as { get(t: unknown): Record<string, unknown> }).get(Transform);
    expect(tf.x).toBe(99);
    expect(tf.y).toBe(42);
    expect(tf.z).toBe(0); // not overridden
  });

  it('writes overrides AFTER rootTransform so root-Transform overrides win', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();

    const prefab = {
      rootLocalId: 1,
      entities: [
        { localId: 1, traits: { Transform: { x: 0, y: 0, z: 0 }, EntityAttributes: { name: 'Root', parentId: 0 } } },
      ],
    };

    instantiatePrefabIntoWorld(
      testWorld,
      prefab,
      0,
      { x: 10, y: 20, z: 30 },
      'pkg/test.prefab.json',
      { 1: { Transform: { x: 999 } } },
    );

    const root = findEntityByLocalId(testWorld, 1);
    const tf = (root as unknown as { get(t: unknown): Record<string, unknown> }).get(Transform);
    expect(tf.x).toBe(999); // override wins over rootTransform
    expect(tf.y).toBe(20);  // not in override, rootTransform applies
    expect(tf.z).toBe(30);  // not in override, rootTransform applies
  });

  it('skips overrides with unknown localId/trait/field without throwing', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();

    const prefab = {
      rootLocalId: 1,
      entities: [
        { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Root', parentId: 0 } } },
      ],
    };

    expect(() => {
      instantiatePrefabIntoWorld(testWorld, prefab, 0, undefined, 'pkg/test.prefab.json', {
        99: { Transform: { x: 1 } },        // unknown localId
        1: { NoSuchTrait: { x: 1 } },        // unknown trait
        // a known trait with a known field is verified by another test
      } as Record<number, Record<string, Record<string, unknown>>>);
    }).not.toThrow();

    const root = findEntityByLocalId(testWorld, 1);
    const tf = (root as unknown as { get(t: unknown): Record<string, unknown> }).get(Transform);
    expect(tf.x).toBe(0); // unchanged because both override entries were invalid
  });

  it('ADDS a trait the prefab child lacks (added-trait override on a child)', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();

    const prefab = {
      rootLocalId: 1,
      entities: [
        { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Root', parentId: 0 } } },
        { localId: 2, traits: { Transform: { x: 5 }, EntityAttributes: { name: 'Plane', parentId: 1 } } },
      ],
    };

    // The prefab's "Plane" child has no Rotate3D — the user added it on the instance.
    instantiatePrefabIntoWorld(testWorld, prefab, 0, undefined, 'pkg/test.prefab.json', {
      2: { Rotate3D: { axis: 'x', speed: 3 } },
    });

    const child = findEntityByLocalId(testWorld, 2) as unknown as {
      has(t: unknown): boolean; get(t: unknown): Record<string, unknown>;
    };
    expect(child.has(Rotate3D)).toBe(true);
    const r = child.get(Rotate3D);
    expect(r.axis).toBe('x');
    expect(r.speed).toBe(3);
  });

  // ── AoS override fields survive load (bone-map-lost-on-reload fix) ──
  it('applies an ADDED AoS trait override with non-scalar fields (animSets/boneMaps)', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();
    const prefab = {
      rootLocalId: 1,
      entities: [
        { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Rig', parentId: 0 } } },
      ],
    };
    // The prefab has no Library — the user added it (with a bone map) on the instance.
    instantiatePrefabIntoWorld(testWorld, prefab, 0, undefined, 'pkg/test.prefab.json', {
      1: { Library: { retarget: true, animSets: ['s1'], boneMaps: { s1: { joint0: 'bone0' } } } },
    });

    const root = findEntityByLocalId(testWorld, 1) as unknown as { has(t: unknown): boolean; get(t: unknown): Record<string, unknown> };
    expect(root.has(Library)).toBe(true);
    const lib = root.get(Library);
    expect(lib.retarget).toBe(true);
    expect(lib.animSets).toEqual(['s1']);                     // NOT dropped as "unknown field"
    expect(lib.boneMaps).toEqual({ s1: { joint0: 'bone0' } }); // the bone map survives the load
  });

  it('applies AoS non-scalar fields onto an EXISTING trait override', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();
    const prefab = {
      rootLocalId: 1,
      entities: [
        // The prefab DOES define Library (just retarget); the instance adds the bone map.
        { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Rig', parentId: 0 }, Library: { retarget: false } } },
      ],
    };
    instantiatePrefabIntoWorld(testWorld, prefab, 0, undefined, 'pkg/test.prefab.json', {
      1: { Library: { retarget: true, animSets: ['s1'], boneMaps: { s1: { joint1: 'bone1' } } } },
    });

    const root = findEntityByLocalId(testWorld, 1) as unknown as { get(t: unknown): Record<string, unknown> };
    const lib = root.get(Library);
    expect(lib.retarget).toBe(true);
    expect(lib.animSets).toEqual(['s1']);
    expect(lib.boneMaps).toEqual({ s1: { joint1: 'bone1' } });
  });

  it('ADDS a tag trait the prefab child lacks (added-tag override)', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();

    const prefab = {
      rootLocalId: 1,
      entities: [
        { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Root', parentId: 0 } } },
        { localId: 2, traits: { Transform: { x: 5 }, EntityAttributes: { name: 'Plane', parentId: 1 } } },
      ],
    };

    // The prefab's "Plane" child has no Disabled tag — the user added it on the instance.
    instantiatePrefabIntoWorld(testWorld, prefab, 0, undefined, 'pkg/test.prefab.json', {
      2: { Disabled: {} },
    });

    const child = findEntityByLocalId(testWorld, 2) as unknown as { has(t: unknown): boolean };
    expect(child.has(Disabled)).toBe(true);
  });

  it('emits no errors when overrides parameter is omitted (backwards compat)', async () => {
    const { instantiatePrefabIntoWorld } = await getLoader();
    const prefab = {
      rootLocalId: 1,
      entities: [
        { localId: 1, traits: { Transform: { x: 3, y: 4, z: 5 }, EntityAttributes: { name: 'Root', parentId: 0 } } },
      ],
    };
    expect(() => instantiatePrefabIntoWorld(testWorld, prefab, 0, undefined, 'p.json')).not.toThrow();
    const root = findEntityByLocalId(testWorld, 1);
    const tf = (root as unknown as { get(t: unknown): Record<string, unknown> }).get(Transform);
    expect(tf.x).toBe(3);
  });
});
