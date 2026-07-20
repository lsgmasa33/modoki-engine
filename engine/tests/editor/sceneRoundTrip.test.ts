/** Phase 1 — Prefab & serialization round-trip fidelity.
 *
 *  scene.json is the editor's source of truth. These tests build a world in
 *  memory, serialize it, swap to a fresh world, load the serialized data back,
 *  and assert the reconstructed world matches — for both plain entity trees and
 *  prefab instances with per-field overrides. No fixture file: the input world
 *  is built in code so it can't drift from the current schema. */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import {
  getCurrentWorld, setCurrentWorld, getAllEntities, readTraitData, getTraitByName,
  writeTraitField, deleteEntity, loadSceneFile, instantiatePrefabIntoWorld, markOverride, type SceneData,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import {
  serializeScene, instantiatePrefab, setPrefabSource, setPrefabCache, type PrefabFile,
} from '@modoki/engine/editor';

registerAllTraits();

/** Reload a serialized scene into a fresh world (no real assets/prefabs). */
async function reloadInFreshWorld(
  scene: unknown,
  fetchPrefab: (source: string) => Promise<PrefabFile | null> = async () => null,
) {
  setCurrentWorld(createWorld());
  // Deep clone — loadSceneFile mutates the data (migrations) in place.
  const data = JSON.parse(JSON.stringify(scene)) as SceneData;
  await loadSceneFile(data, {
    fetchPrefab,
    loadModels: false,
    // Prefab re-instantiation is delegated to the caller (editor vs runtime).
    // Serialize strips the prefab's own traits from the root, so without this the
    // named entities never reappear — they're rebuilt from the prefab here.
    onDeletePlaceholder: (id) => deleteEntity(id),
    onInstantiatePrefab: async (source, parentId, rootTf, _placeholderId, _rootExtra, overrides) => {
      const prefab = await fetchPrefab(source);
      if (!prefab) return;
      instantiatePrefabIntoWorld(getCurrentWorld(), prefab, parentId, rootTf, source, overrides);
    },
  });
}

/** Find a loaded entity id by its EntityAttributes name. */
function idByName(name: string): number | undefined {
  return getAllEntities().find(e => e.name === name)?.id;
}

beforeEach(() => {
  setCurrentWorld(createWorld());
});

describe('scene serialization round-trip', () => {
  it('preserves trait values, hierarchy, and layers across serialize → load', async () => {
    const root = getCurrentWorld().spawn(
      getTraitByName('Transform')!.trait({ x: 1, y: 2, z: 3 }),
      getTraitByName('EntityAttributes')!.trait({ name: 'Root', layer: '3d' }),
    );
    getCurrentWorld().spawn(
      getTraitByName('Transform')!.trait({ x: 4, y: 5, z: 6 }),
      getTraitByName('Renderable3DPrimitive')!.trait({ mesh: 'cube', color: 0x00ff00, size: 2 }),
      getTraitByName('EntityAttributes')!.trait({ name: 'Child', parentId: root.id(), layer: '3d' }),
    );

    const scene = await serializeScene();
    expect(scene.version).toBe(9);

    await reloadInFreshWorld(scene);

    const rootId = idByName('Root');
    const childId = idByName('Child');
    expect(rootId).toBeDefined();
    expect(childId).toBeDefined();

    // Transform values survive.
    const tf = readTraitData(childId!, getTraitByName('Transform')!)!;
    expect(tf.x).toBe(4);
    expect(tf.y).toBe(5);
    expect(tf.z).toBe(6);

    // Primitive trait data survives.
    const prim = readTraitData(childId!, getTraitByName('Renderable3DPrimitive')!)!;
    expect(prim.mesh).toBe('cube');
    expect(prim.color).toBe(0x00ff00);
    expect(prim.size).toBe(2);

    // Parent reference is remapped to the new root id, not the old one.
    const childAttrs = readTraitData(childId!, getTraitByName('EntityAttributes')!)!;
    expect(childAttrs.parentId).toBe(rootId);
    expect(childAttrs.layer).toBe('3d');
  });

  it('round-trips a 2D entity and a UI element', async () => {
    getCurrentWorld().spawn(
      getTraitByName('Transform')!.trait({ x: 10, y: 20 }),
      getTraitByName('Renderable2D')!.trait({ sprite: 'circle', width: 30, height: 40, color: 0x3498db }),
      getTraitByName('EntityAttributes')!.trait({ name: 'Sprite2D', layer: '2d' }),
    );
    getCurrentWorld().spawn(
      getTraitByName('RenderableUI')!.trait(),
      getTraitByName('UIElement')!.trait({ width: 120, height: 40, text: 'Hello', fontSize: 14 }),
      getTraitByName('EntityAttributes')!.trait({ name: 'UIButton', layer: 'ui' }),
    );

    const scene = await serializeScene();
    await reloadInFreshWorld(scene);

    const r2d = readTraitData(idByName('Sprite2D')!, getTraitByName('Renderable2D')!)!;
    expect(r2d.sprite).toBe('circle');
    expect(r2d.width).toBe(30);
    expect(r2d.color).toBe(0x3498db);

    const ui = readTraitData(idByName('UIButton')!, getTraitByName('UIElement')!)!;
    expect(ui.text).toBe('Hello');
    expect(ui.width).toBe(120);
    expect(ui.fontSize).toBe(14);
  });
});

describe('prefab instance round-trip', () => {
  const SOURCE = 'test://round-trip.prefab.json';

  function makePrefab(): PrefabFile {
    return {
      version: 1,
      name: 'round-trip',
      rootLocalId: 1,
      entities: [
        { localId: 1, name: 'PRoot', traits: {
          Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
          EntityAttributes: { name: 'PRoot', parentId: 0, layer: '3d' },
        } },
        { localId: 2, name: 'PChild', traits: {
          Transform: { x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
          Renderable3D: { mesh: 'child.mesh.json', material: '', isVisible: true },
          EntityAttributes: { name: 'PChild', parentId: 1, layer: '3d' },
        } },
      ],
    };
  }

  /** Find the instance child (localId 2) under a given instance root. */
  function childOfRoot(rootId: number): number {
    const piMeta = getTraitByName('PrefabInstance')!;
    let id = 0;
    getCurrentWorld().query(piMeta.trait).updateEach(([pi], entity) => {
      const d = pi as Record<string, unknown>;
      if (d.rootInstanceId === rootId && d.localId === 2) id = entity.id();
    });
    return id;
  }

  beforeEach(() => {
    setPrefabCache(SOURCE, makePrefab()); // so serialize's getPrefabSource resolves without fetch
  });

  it('serializes a prefab instance as a source ref plus only the changed fields', async () => {
    const rootId = instantiatePrefab(makePrefab());
    setPrefabSource(rootId, SOURCE);

    // Override the child's x (prefab base is 5) — mark it as the editor does.
    const childId = childOfRoot(rootId);
    writeTraitField(childId, getTraitByName('Transform')!, 'x', 99);
    markOverride(childId, 'Transform', 'x');

    const scene = await serializeScene();
    const rootEntry = scene.entities.find(e => e.name === 'PRoot');
    expect(rootEntry).toBeDefined();
    // Stored as a prefab ref, not an expanded entity tree.
    expect(rootEntry!.prefab).toBe(SOURCE);
    // Child is not serialized as its own entity — it's re-instantiated from the prefab.
    expect(scene.entities.find(e => e.name === 'PChild')).toBeUndefined();
    // Only the changed field is captured as an override on localId 2.
    expect(rootEntry!.overrides?.[2]?.Transform?.x).toBe(99);
  });

  it('a prefab instance REPARENTED under a plain entity keeps its instance link + parent on reload', async () => {
    // Regression: a captured prefab root writes no EntityAttributes, so its placement
    // parentId used to be dropped — a reparented instance re-spawned at the scene ROOT.
    const holder = getCurrentWorld().spawn(
      getTraitByName('Transform')!.trait({ x: 0, y: 0, z: 0 }),
      getTraitByName('EntityAttributes')!.trait({ name: 'Holder', layer: '3d' }),
    );
    const rootId = instantiatePrefab(makePrefab());
    setPrefabSource(rootId, SOURCE);
    // Drag the instance root under the plain Holder.
    writeTraitField(rootId, getTraitByName('EntityAttributes')!, 'parentId', holder.id());

    const scene = await serializeScene();
    const rootEntry = scene.entities.find(e => e.prefab === SOURCE)!;
    const holderEntry = scene.entities.find(e => e.name === 'Holder')!;
    const holderGuid = (holderEntry.traits.EntityAttributes as Record<string, unknown>).guid;
    // The reparented root persists its placement parent (the holder's stable guid).
    expect(rootEntry.prefab).toBe(SOURCE);
    expect((rootEntry.traits.EntityAttributes as Record<string, unknown> | undefined)?.parentId).toBe(holderGuid);

    await reloadInFreshWorld(scene, async (s) => (s === SOURCE ? makePrefab() : null));

    const holderId = idByName('Holder')!;
    const newRoot = idByName('PRoot')!;
    // Still a prefab instance…
    expect(readTraitData(newRoot, getTraitByName('PrefabInstance')!)).not.toBeNull();
    // …and still parented under the Holder (not detached to the scene root).
    expect(readTraitData(newRoot, getTraitByName('EntityAttributes')!)!.parentId).toBe(holderId);
  });

  it('reload re-instantiates the prefab and re-applies overrides', async () => {
    const rootId = instantiatePrefab(makePrefab());
    setPrefabSource(rootId, SOURCE);
    const childId = childOfRoot(rootId);
    writeTraitField(childId, getTraitByName('Transform')!, 'x', 99);
    markOverride(childId, 'Transform', 'x');

    const scene = await serializeScene();
    await reloadInFreshWorld(scene, async (s) => (s === SOURCE ? makePrefab() : null));

    // The instance is rebuilt; the overridden child keeps x=99, the rest its prefab base.
    const newRoot = idByName('PRoot');
    expect(newRoot).toBeDefined();
    const newChild = childOfRoot(newRoot!);
    expect(newChild).toBeGreaterThan(0);
    const tf = readTraitData(newChild, getTraitByName('Transform')!)!;
    expect(tf.x).toBe(99);   // overridden
    expect(tf.y).toBe(0);    // from prefab base
  });
});
