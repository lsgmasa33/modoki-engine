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
  getCurrentWorld, setCurrentWorld, getAllEntities, readTraitData, readTraitDataFull,
  findEntity, getTraitByName,
  writeTraitField, deleteEntity, loadSceneFile, instantiatePrefabIntoWorld, markOverride, type SceneData,
  SCENE_FORMAT_VERSION,
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
  swapInFreshWorld();
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

/** koota caps a process at 16 live worlds, and each test here builds at least one
 *  (a reload builds a second). Release the outgoing world instead of leaking it,
 *  or adding a test to this file starts failing UNRELATED tests with "Too many
 *  worlds created" — a cap failure reads nothing like the test that tripped it. */
function swapInFreshWorld() {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
}

beforeEach(() => {
  swapInFreshWorld();
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
    expect(scene.version).toBe(SCENE_FORMAT_VERSION);

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

  /** End-to-end reproduction of the `skinned-test.json` data loss (2026-07-31): a
   *  prefab instance carrying an ADDED `Animator` lost its `clips` bank and active
   *  `clip` on a load→save, because both persistence directions keyed on the
   *  Inspector's `meta.fields` — which omits those two by design (AnimatorClipsSection
   *  owns them) — instead of the koota schema.
   *
   *  TWO hops on purpose. The bug hid behind one: with only the write side fixed, hop
   *  one still looked right and hop two came back EMPTY, which is exactly how the live
   *  run caught the read side. A single serialize→assert would pass over half a fix. */
  it('an added Animator keeps its clips bank + active clip across TWO save→load hops', async () => {
    const BANK = '[{"name":"skin","clip":"f1cc3b85-2c23-457b-938a-3470ada21b36"}]';
    const rootId = instantiatePrefab(makePrefab());
    setPrefabSource(rootId, SOURCE);

    // The prefab defines no Animator at localId 1 → this is an added-trait override.
    findEntity(rootId)!.add(getTraitByName('Animator')!.trait({ clips: BANK, clip: 'skin' }));

    const scene1 = await serializeScene();
    expect(scene1.entities.find(e => e.name === 'PRoot')!.overrides?.[1]?.Animator)
      .toMatchObject({ clips: BANK, clip: 'skin' });

    await reloadInFreshWorld(scene1, async (s) => (s === SOURCE ? makePrefab() : null));

    // Live state after the load — the half the write-only fix left broken.
    const reloaded = idByName('PRoot')!;
    const live = readTraitDataFull(reloaded, getTraitByName('Animator')!)!;
    expect(live.clips).toBe(BANK);
    expect(live.clip).toBe('skin');

    // …and it still serializes, so the value is stable rather than decaying per save.
    setPrefabSource(reloaded, SOURCE);
    const scene2 = await serializeScene();
    expect(scene2.entities.find(e => e.name === 'PRoot')!.overrides?.[1]?.Animator)
      .toMatchObject({ clips: BANK, clip: 'skin' });
  });
});

/** INTEGRATION — the real trait registry, the real loader, the real serializer.
 *
 *  Every unit test around prefab overrides mocks `entityUtils` and the trait
 *  registry, which is exactly how this defect survived: the mocks encoded the
 *  same wrong belief as the code (`meta.fields` == the fields a trait persists),
 *  so both agreed and both were wrong. `Animator.clips`/`clip` are koota-schema
 *  fields deliberately ABSENT from `meta.fields` because AnimatorClipsSection
 *  renders them, and nothing below is stubbed — the registration is the real one
 *  from `registerAllTraits()`, so if someone "tidies" those fields back into a
 *  mock's shape this still fails.
 *
 *  Reproduces the reported loss on skinned-test.json: a populated clip bank
 *  naming a real guid disappeared from the file on a load→save, and the instance
 *  came up with an EMPTY bank at runtime. See docs/prefabs.md. */
describe('prefab override over a schema field with no Inspector row (integration)', () => {
  const SOURCE = 'test://animator-override.prefab.json';
  const BANK = JSON.stringify([{ name: 'skin', clip: 'f1cc3b85-2c23-457b-938a-3470ada21b36' }]);

  /** The prefab DEFINES an Animator with an empty bank, so the instance's populated
   *  bank is a genuine base-relative field override — the mark-gated path, not the
   *  "added trait, keep everything" shortcut that cone.prefab.json happened to take. */
  function makePrefab(): PrefabFile {
    return {
      version: 1, name: 'animator-override', rootLocalId: 1,
      entities: [{
        localId: 1, name: 'ARoot', traits: {
          Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
          EntityAttributes: { name: 'ARoot', parentId: 0, layer: '3d' },
          Animator: { clips: '[]', clip: '', speed: 1, playing: true, loop: true },
        },
      }],
    };
  }

  beforeEach(() => setPrefabCache(SOURCE, makePrefab()));

  /** Sanity: the premise. If Animator ever gains Inspector rows for these fields
   *  the tests below would pass for the WRONG reason — they'd no longer exercise
   *  a field outside meta.fields at all. */
  it('premise: Animator persists clips/clip but declares no Inspector field for them', () => {
    const meta = getTraitByName('Animator')!;
    const schema = (meta.trait as unknown as { schema: Record<string, unknown> }).schema;
    expect(Object.keys(schema)).toEqual(expect.arrayContaining(['clips', 'clip']));
    expect(meta.fields).not.toHaveProperty('clips');
    expect(meta.fields).not.toHaveProperty('clip');
  });

  it('CAPTURES a clips/clip override into the scene file', async () => {
    const rootId = instantiatePrefab(makePrefab());
    setPrefabSource(rootId, SOURCE);
    const animator = getTraitByName('Animator')!;
    writeTraitField(rootId, animator, 'clips', BANK);
    writeTraitField(rootId, animator, 'clip', 'skin');
    markOverride(rootId, 'Animator', 'clips');
    markOverride(rootId, 'Animator', 'clip');

    const scene = await serializeScene();
    const entry = scene.entities.find((e) => e.prefab === SOURCE);
    expect(entry?.overrides?.[1]?.Animator?.clips).toBe(BANK);
    expect(entry?.overrides?.[1]?.Animator?.clip).toBe('skin');
  });

  it('RE-APPLIES it on load — the instance comes up with the populated bank', async () => {
    const rootId = instantiatePrefab(makePrefab());
    setPrefabSource(rootId, SOURCE);
    const animator = getTraitByName('Animator')!;
    writeTraitField(rootId, animator, 'clips', BANK);
    writeTraitField(rootId, animator, 'clip', 'skin');
    markOverride(rootId, 'Animator', 'clips');
    markOverride(rootId, 'Animator', 'clip');

    const scene = await serializeScene();
    await reloadInFreshWorld(scene, async (s) => (s === SOURCE ? makePrefab() : null));

    const newRoot = idByName('ARoot');
    expect(newRoot).toBeDefined();
    const live = getCurrentWorld().entities.find((e) => e.id() === newRoot)!.get(animator.trait) as Record<string, unknown>;
    expect(live.clips).toBe(BANK);   // pre-fix: '[]' — the clip never played
    expect(live.clip).toBe('skin');
  });

  it('SURVIVES a second save — the load→save that deleted it from skinned-test.json', async () => {
    const rootId = instantiatePrefab(makePrefab());
    setPrefabSource(rootId, SOURCE);
    const animator = getTraitByName('Animator')!;
    writeTraitField(rootId, animator, 'clips', BANK);
    writeTraitField(rootId, animator, 'clip', 'skin');
    markOverride(rootId, 'Animator', 'clips');
    markOverride(rootId, 'Animator', 'clip');

    const once = await serializeScene();
    await reloadInFreshWorld(once, async (s) => (s === SOURCE ? makePrefab() : null));
    setPrefabCache(SOURCE, makePrefab());
    const twice = await serializeScene();

    const entry = twice.entities.find((e) => e.prefab === SOURCE);
    expect(entry?.overrides?.[1]?.Animator?.clips).toBe(BANK);
    expect(entry?.overrides?.[1]?.Animator?.clip).toBe('skin');
  });

  it('never writes a runtimeOnly read-back field into the file', async () => {
    const rootId = instantiatePrefab(makePrefab());
    setPrefabSource(rootId, SOURCE);
    const animator = getTraitByName('Animator')!;
    // What a frame of playback leaves behind, plus a stray mark to prove the
    // exclusion is at the READ and no later path can resurrect it.
    writeTraitField(rootId, animator, 'activeClip', 'skin');
    writeTraitField(rootId, animator, 'fadeElapsed', 0.25);
    markOverride(rootId, 'Animator', 'activeClip');
    markOverride(rootId, 'Animator', 'fadeElapsed');

    const scene = await serializeScene();
    const entry = scene.entities.find((e) => e.prefab === SOURCE);
    expect(entry?.overrides?.[1]?.Animator ?? {}).not.toHaveProperty('activeClip');
    expect(entry?.overrides?.[1]?.Animator ?? {}).not.toHaveProperty('fadeElapsed');
  });
});
