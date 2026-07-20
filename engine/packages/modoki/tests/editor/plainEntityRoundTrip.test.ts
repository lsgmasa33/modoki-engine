/** Plain-entity (non-prefab) serialize → load round-trip through the REAL
 *  `serializeScene` + REAL `loadSceneFile`, against a real koota world + real
 *  trait registry — no mocks. The serialize HALF is covered by
 *  `runtimeOnlyFields.test.ts`; this closes the loop and proves the file a SAVE
 *  produces reconstructs the SAME world a LOAD consumes:
 *    - field-value fidelity across number/string/boolean/color types,
 *    - GUID-based parent rewiring that survives a full world rebuild (the live
 *      koota ids on reload differ from the originals — only the guids carry over),
 *    - parent resolved by guid regardless of spawn order (child authored first),
 *    - `runtimeOnly` fields dropped on save and re-defaulted by the loader,
 *    - tag traits surviving as `true`,
 *    - a blank guid minted by serialize and carried into the reloaded world.
 *  (T6 backfill — the last named net-new suite.) */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld, trait } from 'koota';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Transform } from '../../src/runtime/traits/Transform';
import { setCurrentWorld, registerEntity, indexEntityGuid } from '../../src/runtime/ecs/world';
import { registerTrait } from '../../src/runtime/ecs/traitRegistry';
import { getAllEntities, findEntity } from '../../src/runtime/ecs/entityUtils';
import { serializeScene } from '../../src/editor/scene/serialize';
import { loadSceneFile } from '../../src/runtime/loaders/loadSceneFile';

// A plain component exercising every persisted field type the serializer enumerates
// from the koota schema (number, string, boolean, color).
const Health = trait({ hp: 100, max: 100, regen: 1.5, label: 'grunt', alive: true, tint: 0xff0000 });
// A component with a runtimeOnly accumulator that must NOT round-trip (it re-defaults).
const Mover = trait({ speed: 2, _accum: 0 });
// A tag trait — serializes as `true`, reloads via meta.trait() with no args.
const Frozen = trait();

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: {}, isActive: {}, sortOrder: {}, parentId: {}, layer: {}, guid: {} },
  });
  registerTrait({
    name: 'Transform', trait: Transform, category: 'component',
    fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} },
  });
  registerTrait({
    name: 'Health', trait: Health, category: 'component',
    fields: { hp: {}, max: {}, regen: {}, label: {}, alive: {}, tint: { type: 'color' } },
  });
  registerTrait({
    name: 'Mover', trait: Mover, category: 'component',
    fields: { speed: {}, _accum: { runtimeOnly: true } },
  });
  registerTrait({ name: 'Frozen', trait: Frozen, category: 'tag', fields: {} });
}

/** Spawn an entity in the current world, wiring it into the entity + guid index
 *  exactly as production spawn paths do. */
function spawn(...args: any[]) {
  const ent = (globalThis as any).__w.spawn(...args);
  registerEntity(ent);
  indexEntityGuid(ent);
  return ent;
}

function freshWorld() {
  const w = createWorld();
  (globalThis as any).__w = w;
  setCurrentWorld(w);
  return w;
}

/** Round-trip: serialize the CURRENT world, rebuild a fresh world, load the file
 *  into it. Returns the serialized SceneFile for white-box assertions on the wire form. */
async function roundTrip() {
  const scene = await serializeScene();
  freshWorld();
  await loadSceneFile(scene as any, { fetchPrefab: async () => null, loadModels: false });
  return scene;
}

beforeEach(() => {
  registerAll();
  freshWorld();
});

describe('plain-entity serialize → load round-trip (real serialize + real loader)', () => {
  it('reconstructs field values across every type (number/string/boolean/color)', async () => {
    spawn(
      EntityAttributes({ name: 'Enemy', guid: 'enemy-guid', parentId: 0, sortOrder: 3, isActive: true, layer: '' }),
      Transform({ x: 1, y: -2.5, z: 3, rx: 0.1, sx: 2, sy: 2, sz: 2 }),
      Health({ hp: 42, max: 80, regen: 0.25, label: 'boss', alive: true, tint: 0x00ff88 }),
    );

    await roundTrip();

    const infos = getAllEntities();
    const info = infos.find((e) => e.name === 'Enemy')!;
    expect(info).toBeDefined();
    const e = findEntity(info.id)!;

    const h = e.get(Health) as Record<string, unknown>;
    expect(h.hp).toBe(42);
    expect(h.max).toBe(80);
    expect(h.regen).toBe(0.25);
    expect(h.label).toBe('boss');
    expect(h.alive).toBe(true);
    expect(h.tint).toBe(0x00ff88);

    const t = e.get(Transform) as Record<string, unknown>;
    expect(t.x).toBe(1);
    expect(t.y).toBe(-2.5);
    expect(t.z).toBe(3);
    expect(t.rx).toBeCloseTo(0.1);
    expect(t.sx).toBe(2);

    const ea = e.get(EntityAttributes) as Record<string, unknown>;
    expect(ea.name).toBe('Enemy');
    expect(ea.sortOrder).toBe(3);
    expect(ea.guid).toBe('enemy-guid');
  });

  it('rewires parent→child by GUID across a world rebuild (new koota ids, guid is the only link)', async () => {
    const parent = spawn(
      EntityAttributes({ name: 'Parent', guid: 'p-guid', parentId: 0, sortOrder: 0, isActive: true, layer: '' }),
    );
    spawn(
      EntityAttributes({ name: 'Child', guid: 'c-guid', parentId: parent.id(), sortOrder: 0, isActive: true, layer: '' }),
    );

    await roundTrip();

    const infos = getAllEntities();
    const pInfo = infos.find((e) => e.name === 'Parent')!;
    const cInfo = infos.find((e) => e.name === 'Child')!;
    const reloadedParent = findEntity(pInfo.id)!;
    const reloadedChild = findEntity(cInfo.id)!;

    // Guids survive; the live koota id of the child now points at the parent's NEW id.
    const cEa = reloadedChild.get(EntityAttributes) as Record<string, unknown>;
    const pEa = reloadedParent.get(EntityAttributes) as Record<string, unknown>;
    expect(pEa.guid).toBe('p-guid');
    expect(cEa.guid).toBe('c-guid');
    expect(cEa.parentId).toBe(reloadedParent.id());
    // Root's parentId resolves to 0 (no parent).
    expect(pEa.parentId).toBe(0);
  });

  it('resolves the parent guid even when the child is authored BEFORE the parent', async () => {
    // Spawn order: child first. serialize writes parentId as the parent's guid;
    // the loader resolves it via the self-healing guid index regardless of order.
    const child = spawn(
      EntityAttributes({ name: 'EarlyChild', guid: 'ec-guid', parentId: 0, sortOrder: 0, isActive: true, layer: '' }),
    );
    const parent = spawn(
      EntityAttributes({ name: 'LateParent', guid: 'lp-guid', parentId: 0, sortOrder: 0, isActive: true, layer: '' }),
    );
    // Point child at parent after both exist.
    child.set(EntityAttributes, { ...(child.get(EntityAttributes) as object), parentId: parent.id() });

    await roundTrip();

    const infos = getAllEntities();
    const reloadedChild = findEntity(infos.find((e) => e.name === 'EarlyChild')!.id)!;
    const reloadedParent = findEntity(infos.find((e) => e.name === 'LateParent')!.id)!;
    expect((reloadedChild.get(EntityAttributes) as Record<string, unknown>).parentId).toBe(reloadedParent.id());
  });

  it('drops runtimeOnly fields on save and re-defaults them on load (no scene churn)', async () => {
    spawn(
      EntityAttributes({ name: 'Runner', guid: 'r-guid', parentId: 0, sortOrder: 0, isActive: true, layer: '' }),
      Mover({ speed: 7, _accum: 999 }),
    );

    const scene = await roundTrip();

    // Wire form: the authored knob persists, the accumulator is absent entirely.
    const entry = scene.entities.find((x) => x.name === 'Runner')!;
    const mWire = entry.traits.Mover as Record<string, unknown>;
    expect(mWire.speed).toBe(7);
    expect(mWire).not.toHaveProperty('_accum');

    // Reloaded world: speed restored, accumulator back at the schema default (0).
    const info = getAllEntities().find((e) => e.name === 'Runner')!;
    const m = findEntity(info.id)!.get(Mover) as Record<string, unknown>;
    expect(m.speed).toBe(7);
    expect(m._accum).toBe(0);
  });

  it('round-trips a tag trait as a bare component (true → meta.trait())', async () => {
    spawn(
      EntityAttributes({ name: 'Statue', guid: 's-guid', parentId: 0, sortOrder: 0, isActive: true, layer: '' }),
      Frozen(),
    );

    const scene = await roundTrip();
    const entry = scene.entities.find((x) => x.name === 'Statue')!;
    expect(entry.traits.Frozen).toBe(true);

    const info = getAllEntities().find((e) => e.name === 'Statue')!;
    expect(findEntity(info.id)!.has(Frozen)).toBe(true);
  });

  it('mints a guid for a blank-guid entity and carries it into the reloaded world', async () => {
    spawn(
      EntityAttributes({ name: 'Nameless', guid: '', parentId: 0, sortOrder: 0, isActive: true, layer: '' }),
    );

    const scene = await roundTrip();
    const entry = scene.entities.find((x) => x.name === 'Nameless')!;
    const wireGuid = (entry.traits.EntityAttributes as Record<string, unknown>).guid as string;
    expect(wireGuid).toBeTruthy();
    expect(wireGuid).not.toBe('');

    const info = getAllEntities().find((e) => e.name === 'Nameless')!;
    const ea = findEntity(info.id)!.get(EntityAttributes) as Record<string, unknown>;
    expect(ea.guid).toBe(wireGuid);
  });

  it('preserves entity count and names for a mixed multi-entity scene', async () => {
    const root = spawn(EntityAttributes({ name: 'Root', guid: 'root-g', parentId: 0, sortOrder: 0, isActive: true, layer: '' }));
    spawn(
      EntityAttributes({ name: 'A', guid: 'a-g', parentId: root.id(), sortOrder: 1, isActive: true, layer: '' }),
      Health({ hp: 10 }),
    );
    spawn(
      EntityAttributes({ name: 'B', guid: 'b-g', parentId: root.id(), sortOrder: 2, isActive: false, layer: '' }),
      Mover({ speed: 3 }), Frozen(),
    );

    await roundTrip();

    const names = getAllEntities().map((e) => e.name).sort();
    expect(names).toEqual(['A', 'B', 'Root']);

    // isActive=false round-trips on B.
    const bInfo = getAllEntities().find((e) => e.name === 'B')!;
    expect((findEntity(bInfo.id)!.get(EntityAttributes) as Record<string, unknown>).isActive).toBe(false);
  });

  // F7: SceneFile.id is a REQUIRED, always-populated field (serializeScene never
  // emits an empty id), and the decorative top-level entry.name is just a mirror
  // of the canonical EntityAttributes.name — the two must not diverge at save time.
  it('always emits a non-empty scene id and mirrors EntityAttributes.name into entry.name (F7)', async () => {
    spawn(EntityAttributes({ name: 'Hero', guid: 'hero-g', parentId: 0, sortOrder: 0, isActive: true, layer: '' }));

    const scene = await serializeScene();
    // id is required + always populated (no empty/undefined).
    expect(typeof scene.id).toBe('string');
    expect(scene.id).toBeTruthy();

    const entry = scene.entities.find((x) => x.name === 'Hero')!;
    expect(entry).toBeDefined();
    // top-level name === EntityAttributes.name (canonical source of truth).
    expect(entry.name).toBe((entry.traits.EntityAttributes as Record<string, unknown>).name);
  });
});
