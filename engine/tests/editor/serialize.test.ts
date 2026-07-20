/** Tests for generic scene serialization. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { getCurrentWorld, loadSceneFile } from '@modoki/engine/runtime';
import { Transform, Renderable3D, Renderable3DPrimitive, EntityAttributes, Time, Paused, Transient, PrefabInstance } from '@modoki/engine/runtime';
import { RenderableUI, UIElement, UIBinding, UIAction } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { TestPhase, registerTestGameTraits } from './_fixtures/testGame';
import { serializeScene } from '@modoki/engine/editor';

// Ensure traits are registered (idempotent — registerTrait overwrites)
registerAllTraits();
registerTestGameTraits();

// References are GUID-only — fixtures reference meshes by GUID.
const HERO_MESH_GUID = 'c0000000-0000-4000-8000-000000000001';
const PAUSED_MESH_GUID = 'c0000000-0000-4000-8000-000000000002';

describe('serializeScene', () => {
  beforeEach(() => {
    // Spawn some test entities
    getCurrentWorld().spawn(Time());
    getCurrentWorld().spawn(TestPhase({ phase: 'game' }));
    getCurrentWorld().spawn(
      Transform({ x: 5, y: 10, z: 15 }),
      Renderable3D({ mesh: HERO_MESH_GUID }),
      EntityAttributes({ name: 'hero', isActive: true }),
    );
    getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      Renderable3DPrimitive({ mesh: 'cube', color: 0x00ff00, size: 2 }),
      EntityAttributes({ name: 'prim', isActive: true }),
    );
  });

  it('serializes all entities with current version format', async () => {
    const scene = await serializeScene();
    expect(scene.version).toBe(9);
    expect(scene.createdAt).toBeDefined();
    expect(scene.resources).toBeDefined();
    expect(Array.isArray(scene.resources)).toBe(true);
    expect(scene.entities.length).toBeGreaterThanOrEqual(3);
  });

  it('includes referenced mesh GUIDs in the resources manifest', async () => {
    const scene = await serializeScene();
    const meshRefs = scene.resources.filter(r => r.type === 'mesh').map(r => r.path);
    expect(meshRefs).toContain(HERO_MESH_GUID);
  });

  it('serializes Transform trait data correctly', async () => {
    const scene = await serializeScene();
    const hero = scene.entities.find((e) => e.name === 'hero');
    expect(hero).toBeDefined();
    expect(hero!.traits['Transform']).toBeDefined();

    const tf = hero!.traits['Transform'] as Record<string, number>;
    expect(tf.x).toBe(5);
    expect(tf.y).toBe(10);
    expect(tf.z).toBe(15);
  });

  it('serializes Renderable3D trait data', async () => {
    const scene = await serializeScene();
    const hero = scene.entities.find((e) => e.name === 'hero');
    const rend = hero!.traits['Renderable3D'] as Record<string, unknown>;
    expect(rend.mesh).toBe(HERO_MESH_GUID);
    expect(rend.isVisible).toBe(true);
  });

  it('serializes Renderable3DPrimitive trait data', async () => {
    const scene = await serializeScene();
    const prim = scene.entities.find((e) => e.name === 'prim');
    const rend = prim!.traits['Renderable3DPrimitive'] as Record<string, unknown>;
    expect(rend.mesh).toBe('cube');
    expect(rend.color).toBe(0x00ff00);
    expect(rend.size).toBe(2);
  });

  it('serializes resource entities', async () => {
    const scene = await serializeScene();
    const gp = scene.entities.find((e) => e.name === 'TestPhase (resource)');
    expect(gp).toBeDefined();
    const gpData = gp!.traits['TestPhase'] as Record<string, unknown>;
    expect(gpData.phase).toBe('game');
  });

  // Transient marks runtime-generated content (e.g. sling's arena tiles regenerated
  // from a painted .level.json). serializeScene must skip a Transient entity AND its
  // whole subtree so a Cmd+S / Play snapshot never bakes it into the scene file.
  it('skips a Transient entity and its entire subtree', async () => {
    const genRoot = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'generated-field', isActive: true }),
    );
    genRoot.add(Transient);
    // A child of the transient root (parented) — must also be skipped.
    getCurrentWorld().spawn(
      Transform({ x: 1, y: 0, z: 0 }),
      Renderable3DPrimitive({ mesh: 'box', color: 0xffffff, size: 1 }),
      EntityAttributes({ name: 'generated-tile', isActive: true, parentId: genRoot.id() }),
    );
    // A normal sibling that must still serialize.
    getCurrentWorld().spawn(
      Transform({ x: 9, y: 0, z: 0 }),
      EntityAttributes({ name: 'authored-keeper', isActive: true }),
    );

    const scene = await serializeScene();
    expect(scene.entities.find((e) => e.name === 'generated-field')).toBeUndefined();
    expect(scene.entities.find((e) => e.name === 'generated-tile')).toBeUndefined();
    expect(scene.entities.find((e) => e.name === 'authored-keeper')).toBeDefined();
  });

  // The PRODUCTION shape: sling's generated tiles are prefab-INSTANCE roots tagged Transient
  // (rebuildField spawnPrefabInstance + .add(Transient)). serialize has a dedicated
  // prefab-instance pre-pass that must ALSO honour the transient skip — otherwise a Cmd+S bakes
  // the tiles in as `prefab`/`overrides`/`added` nodes even though the plain-entity branch skips.
  it('skips a Transient PREFAB-INSTANCE subtree (root + members)', async () => {
    // A transient prefab-instance root (GUID source, uncached — the transient skip runs BEFORE
    // any prefab resolution) plus a member child. This is what rebuildField produces.
    const KIT_SRC = 'aaaa2222-2222-4222-8222-222222222222';
    const genInst = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      PrefabInstance({ source: KIT_SRC, localId: 0 }),
      EntityAttributes({ name: 'gen-tile', isActive: true }),
    );
    genInst.set(PrefabInstance, { ...(genInst.get(PrefabInstance) as object), rootInstanceId: genInst.id() });
    genInst.add(Transient);
    getCurrentWorld().spawn(
      Transform({ x: 0.5, y: 0, z: 0 }),
      PrefabInstance({ source: KIT_SRC, localId: 2, rootInstanceId: genInst.id() }),
      EntityAttributes({ name: 'gen-tile-member', isActive: true, parentId: genInst.id() }),
    );

    const scene = await serializeScene();
    // The transient instance + its member are gone entirely — no entity, no prefab/override node
    // (the prefab-instance pre-pass honours the transient skip, not just the plain-entity branch).
    expect(scene.entities.find((e) => e.name === 'gen-tile')).toBeUndefined();
    expect(scene.entities.find((e) => e.name === 'gen-tile-member')).toBeUndefined();
    // And the transient root's live guid was never minted/committed (no guid churn into
    // generated content — the guid pre-pass skips transient ids).
    expect((genInst.get(EntityAttributes) as { guid: string }).guid).toBe('');
  });

  it('serializes tag traits as boolean true', async () => {
    // Spawn entity with Paused tag
    const entity = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      Renderable3D({ mesh: PAUSED_MESH_GUID }),
      EntityAttributes({ name: 'paused-entity', isActive: true }),
    );
    entity.add(Paused);

    const scene = await serializeScene();
    const paused = scene.entities.find((e) => e.name === 'paused-entity');
    expect(paused!.traits['Paused']).toBe(true);
  });

  it('uses generic traits bag (no typed fields)', async () => {
    const scene = await serializeScene();
    const hero = scene.entities.find((e) => e.name === 'hero');
    // Should use traits bag, not top-level typed fields
    expect(hero!.traits).toBeDefined();
    expect(typeof hero!.traits).toBe('object');
    // Old v1 fields should not exist
    expect((hero as any).transform).toBeUndefined();
    expect((hero as any).renderable).toBeUndefined();
  });

  it('assigns a stable UUID to the scene file itself', async () => {
    const scene = await serializeScene();
    expect(scene.id).toBeDefined();
    expect(scene.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('assigns a guid to the hero entity (lazy on save)', async () => {
    const scene = await serializeScene();
    const hero = scene.entities.find((e) => e.name === 'hero');
    const ea = hero!.traits.EntityAttributes as { guid?: string };
    expect(ea.guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  // Regression (engine-review serialize F3): serializeScene is reused verbatim by
  // enterPlay() to snapshot the authored world. Pressing Play must NOT mint guids
  // into the LIVE world — that silently rewrites authored identity on a "look,
  // don't touch" path and makes two worktrees Playing the same scene diverge. The
  // guid must appear in the OUTPUT (snapshot needs stable identity) but the world
  // entity must stay untouched until an explicit { assignGuids: true } save.
  it('snapshot path (no opts) mints a guid into the output but NOT the live world', async () => {
    const entity = getCurrentWorld().spawn(
      Transform({ x: 1, y: 1, z: 1 }),
      EntityAttributes({ name: 'fresh-unsaved', isActive: true }),
    );
    // Precondition: a freshly-spawned entity has an empty guid.
    expect((entity.get(EntityAttributes) as { guid: string }).guid).toBe('');

    const scene = await serializeScene(); // snapshot path — Play uses exactly this
    const out = scene.entities.find((e) => e.name === 'fresh-unsaved');
    const ea = out!.traits.EntityAttributes as { guid?: string };
    // Output carries a stable guid…
    expect(ea.guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // …but the live world was NOT mutated (the F3 bug was this writing back).
    expect((entity.get(EntityAttributes) as { guid: string }).guid).toBe('');
  });

  it('save path ({ assignGuids: true }) commits the minted guid to the live world', async () => {
    const entity = getCurrentWorld().spawn(
      Transform({ x: 2, y: 2, z: 2 }),
      EntityAttributes({ name: 'fresh-tosave', isActive: true }),
    );
    expect((entity.get(EntityAttributes) as { guid: string }).guid).toBe('');

    const scene = await serializeScene({ assignGuids: true });
    const out = scene.entities.find((e) => e.name === 'fresh-tosave');
    const outGuid = (out!.traits.EntityAttributes as { guid?: string }).guid!;
    expect(outGuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // The live world now carries the SAME guid that was serialized — persisted.
    expect((entity.get(EntityAttributes) as { guid: string }).guid).toBe(outGuid);
  });

  it('serializes GUID refs unchanged (no silent healing, no warning)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scene = await serializeScene();
    const hero = scene.entities.find((e) => e.name === 'hero');
    const r3d = hero!.traits.Renderable3D as { mesh: string };
    expect(r3d.mesh).toBe(HERO_MESH_GUID);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('flags a stray internal asset path ref on save (GUID-only guard) without rewriting it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    getCurrentWorld().spawn(
      Transform({ x: 2, y: 2, z: 2 }),
      Renderable3D({ mesh: '/models/stray.mesh.json' }),
      EntityAttributes({ name: 'stray', isActive: true }),
    );

    const scene = await serializeScene();
    const stray = scene.entities.find((e) => e.name === 'stray');
    const r3d = stray!.traits.Renderable3D as { mesh: string };
    // Not silently healed — left as-is so the bad ref is visible…
    expect(r3d.mesh).toBe('/models/stray.mesh.json');
    // …and flagged loudly.
    expect(err).toHaveBeenCalled();
    expect(err.mock.calls.some(c => String(c[0]).includes('Renderable3D.mesh'))).toBe(true);
    err.mockRestore();
  });

  // Regression guard: serialization must emit EVERY field a trait defines in its
  // schema, not just the curated Inspector fields (meta.fields). A re-serialization
  // that only wrote meta.fields silently dropped the chat-input wiring
  // (elementType/inputBinding/onChange/onSubmit) from the llm/chess scenes.
  it('serializes the full trait schema, not just curated Inspector fields', async () => {
    getCurrentWorld().spawn(
      RenderableUI(),
      EntityAttributes({ name: 'chat-input', isActive: true, layer: 'ui' }),
      UIElement({ elementType: 'input', placeholder: 'Type a message...' }),
      UIBinding({ inputBinding: 'inputText' }),
      UIAction({ onChange: 'llm.setInputText', onSubmit: 'llm.sendMessage' }),
    );

    const scene = await serializeScene();
    const node = scene.entities.find((e) => e.name === 'chat-input');
    expect(node).toBeDefined();

    // Every UIElement schema field must be present in the serialized output —
    // this fails if the serializer only writes the curated meta.fields subset.
    const schemaKeys = Object.keys((UIElement as unknown as { schema: object }).schema).sort();
    const serializedKeys = Object.keys(node!.traits.UIElement as object).sort();
    expect(serializedKeys).toEqual(schemaKeys);

    // …and the input wiring round-trips with the right values.
    const ui = node!.traits.UIElement as Record<string, unknown>;
    const bind = node!.traits.UIBinding as Record<string, unknown>;
    const act = node!.traits.UIAction as Record<string, unknown>;
    expect(ui.elementType).toBe('input');
    expect(ui.placeholder).toBe('Type a message...');
    expect(bind.inputBinding).toBe('inputText');
    expect(act.onChange).toBe('llm.setInputText');
    expect(act.onSubmit).toBe('llm.sendMessage');
  });
});

// Missing-Test #1 (engine-review serialize/model-import): the single biggest
// coverage hole was that NO test took a plain (non-prefab) entity all the way
// through serialize → loadSceneFile → reload and asserted that EVERY field on
// EVERY trait survives. The serialize-only tests above prove the JSON is written;
// this proves the inverse loader reconstructs it. It exercises the generic
// schema-key trait loop, the GUID/parentId pre-pass, and parent-chain remapping —
// the exact machinery a future serialize/load regression would slip through.
describe('plain-entity full round-trip (serialize → loadSceneFile)', () => {
  // Fixed guids so the round-trip is fully deterministic (nothing minted) and the
  // guid field itself is part of the field-by-field comparison.
  const PARENT_GUID = 'd0000000-0000-4000-8000-0000000000a1';
  const CHILD_GUID = 'd0000000-0000-4000-8000-0000000000a2';
  const UI_GUID = 'd0000000-0000-4000-8000-0000000000a3';
  const MESH_GUID = 'd0000000-0000-4000-8000-0000000000b1';
  const MAT_GUID = 'd0000000-0000-4000-8000-0000000000b2';

  /** Assert every schema field of `Trait` matches between the source-world entity
   *  and the reloaded entity. `skip` excludes fields that legitimately differ
   *  (parentId is remapped from file id → fresh-world ECS id). */
  function expectTraitMatch(Trait: unknown, srcEntity: any, dstEntity: any, skip: string[] = []) {
    const srcT = srcEntity.get(Trait);
    const dstT = dstEntity.get(Trait);
    expect(dstT, 'trait missing on reloaded entity').toBeDefined();
    for (const key of Object.keys((Trait as { schema: Record<string, unknown> }).schema)) {
      if (skip.includes(key)) continue;
      expect(dstT[key], `field "${key}" did not round-trip`).toEqual(srcT[key]);
    }
  }

  it('reloads every trait field on plain entities, with the parent chain remapped', async () => {
    const src = getCurrentWorld();
    const parent = src.spawn(
      Transform({ x: 1, y: 2, z: 3, rx: 0.1, ry: 0.2, rz: 0.3, sx: 4, sy: 5, sz: 6 }),
      EntityAttributes({ name: 'rt-parent', isActive: false, sortOrder: 3, layer: '3d', guid: PARENT_GUID }),
    );
    const child = src.spawn(
      Transform({ x: 7, y: 8, z: 9, rx: 1, ry: 1.1, rz: 1.2, sx: 0.5, sy: 0.6, sz: 0.7 }),
      Renderable3D({ mesh: MESH_GUID, material: MAT_GUID, isVisible: false }),
      EntityAttributes({ name: 'rt-child', isActive: true, sortOrder: 7, parentId: parent.id(), layer: '3d', guid: CHILD_GUID }),
    );
    // A spread of UIElement fields including ones ABSENT from the curated
    // Inspector meta.fields (letterSpacing, textShadowBlur, maxLines, *Unit, …) —
    // the values most likely to be dropped by a serializer that only writes the
    // curated subset.
    const ui = src.spawn(
      RenderableUI(),
      UIElement({
        width: 320, height: 240, widthUnit: 'px', heightUnit: 'px',
        flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center',
        gap: 12, paddingTop: 8, paddingTopUnit: 'px', marginLeft: 4, zIndex: 5, overflow: 'hidden', isVisible: false,
        backgroundColor: 0x112233, backgroundOpacity: 0.5, borderWidth: 2, borderColor: 0xff00ff, opacity: 0.75,
        text: 'Hello', fontSize: 22, fontWeight: 'bold', fontStyle: 'italic', textColor: 0x00ff00,
        textAlign: 'center', letterSpacing: 1.5, textShadowBlur: 3, maxLines: 2, textOverflow: 'ellipsis',
        elementType: 'input', placeholder: 'Type…', rangeMin: 10, rangeMax: 90,
      }),
      EntityAttributes({ name: 'rt-ui', isActive: true, sortOrder: 1, layer: 'ui', guid: UI_GUID }),
    );

    const scene = await serializeScene();

    // Reload into an isolated fresh world (not the source) so we compare a true
    // serialize→load reconstruction, not the live world.
    const dst = createWorld();
    await loadSceneFile(scene as never, { fetchPrefab: async () => null, loadModels: false, world: dst as never });

    const byName = new Map<string, any>();
    dst.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { byName.set(ea.name, e); });
    const rParent = byName.get('rt-parent');
    const rChild = byName.get('rt-child');
    const rUi = byName.get('rt-ui');
    expect(rParent, 'rt-parent reloaded').toBeDefined();
    expect(rChild, 'rt-child reloaded').toBeDefined();
    expect(rUi, 'rt-ui reloaded').toBeDefined();

    expectTraitMatch(Transform, parent, rParent);
    expectTraitMatch(EntityAttributes, parent, rParent, ['parentId']);
    expectTraitMatch(Transform, child, rChild);
    expectTraitMatch(Renderable3D, child, rChild);
    expectTraitMatch(EntityAttributes, child, rChild, ['parentId']);
    expectTraitMatch(UIElement, ui, rUi);
    expectTraitMatch(EntityAttributes, ui, rUi, ['parentId']);

    // The parent chain survived the file-id → fresh-ECS-id remap…
    expect(rChild.get(EntityAttributes).parentId).toBe(rParent.id());
    // …and roots stay unparented.
    expect(rParent.get(EntityAttributes).parentId).toBe(0);
  });
});
