/** scene-loading.md Phase 12, M1 — `serializeScene({ scene })`
 *  serializes a NAMED loaded scene (a base) instead of the primary. Exercises the
 *  REAL serializer against a real koota world + real trait registry, mirroring
 *  baseSceneSerialize.test.ts's own pattern. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Transform } from '../../src/runtime/traits/Transform';
import { PrefabInstance } from '../../src/runtime/traits/PrefabInstance';
import { setCurrentWorld, registerEntity, indexEntityGuid } from '../../src/runtime/ecs/world';
import { registerTrait } from '../../src/runtime/ecs/traitRegistry';
import { serializeScene } from '../../src/editor/scene/serialize';
import { setRunMode } from '../../src/runtime/systems/playState';

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: {}, isActive: {}, sortOrder: {}, parentId: { entityId: { onMissing: 'root' } }, layer: {}, guid: {}, sourceScene: { hidden: true, runtimeOnly: true } },
  });
  registerTrait({
    name: 'Transform', trait: Transform, category: 'component',
    fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} },
  });
}

function freshWorld() {
  const w = createWorld();
  (globalThis as any).__w = w;
  setCurrentWorld(w);
  return w;
}
function spawn(...args: any[]) {
  const ent = (globalThis as any).__w.spawn(...args);
  registerEntity(ent);
  indexEntityGuid(ent);
  return ent;
}

beforeEach(() => { registerAll(); freshWorld(); });
afterEach(() => { setRunMode('playing', { advancing: true }); });

describe('serializeScene({ scene }) — target a named base (Phase 12, M1)', () => {
  it('default (no opts.scene) excludes every base-origin entity — byte-identical to Phase 6', async () => {
    spawn(EntityAttributes({ name: 'PrimaryEntity', guid: 'g-primary', sourceScene: '' }), Transform);
    spawn(EntityAttributes({ name: 'BaseEntity', guid: 'g-base', sourceScene: 'base-guid-1' }), Transform);
    const scene = await serializeScene();
    expect(scene.entities.map((e) => e.name)).toEqual(['PrimaryEntity']);
  });

  it('targeting a base includes ONLY that base\'s own entities, excluding the primary', async () => {
    spawn(EntityAttributes({ name: 'PrimaryEntity', guid: 'g-primary', sourceScene: '' }), Transform);
    spawn(EntityAttributes({ name: 'BaseEntity', guid: 'g-base', sourceScene: 'base-guid-1' }), Transform);
    spawn(EntityAttributes({ name: 'OtherBaseEntity', guid: 'g-other', sourceScene: 'base-guid-2' }), Transform);
    const scene = await serializeScene({ scene: { path: '/assets/scenes/Base.json', guid: 'base-guid-1' } });
    expect(scene.entities.map((e) => e.name)).toEqual(['BaseEntity']);
  });

  it('a targeted base\'s file id is its OWN guid, not a minted one', async () => {
    spawn(EntityAttributes({ name: 'BaseEntity', guid: 'g-base', sourceScene: 'base-guid-1' }), Transform);
    const scene = await serializeScene({ scene: { path: '/assets/scenes/Base.json', guid: 'base-guid-1' } });
    expect(scene.id).toBe('base-guid-1');
  });

  it('a subtree parented under a base entity stays with the base (subtree exclusion)', async () => {
    const root = spawn(EntityAttributes({ name: 'BaseRoot', guid: 'g-root', sourceScene: 'base-guid-1' }), Transform);
    spawn(EntityAttributes({ name: 'BaseChild', guid: 'g-child', parentId: root.id(), sourceScene: 'base-guid-1' }), Transform);
    const scene = await serializeScene({ scene: { path: '/assets/scenes/Base.json', guid: 'base-guid-1' } });
    expect(scene.entities.map((e) => e.name).sort()).toEqual(['BaseChild', 'BaseRoot']);
  });

  // This case is the INVERSE of the Phase 12 safety guard that used to live here.
  // The guard refused to serialize a targeted base containing any prefab instance,
  // because two separate defects could silently drop or misattribute that
  // instance's data on the carried-base-scene path: A8 (PrefabInstance.
  // rootInstanceId going stale across a respawn) and A9 (override marks wiped by a
  // chain load, and never carried across a world rebuild). BOTH are now fixed —
  // see loadSceneFile.test.ts's "PrefabInstance.rootInstanceId remapping (A8 fix)"
  // and "override-mark lifetime (A9 defect 1)" suites, plus
  // sceneManagerBaseSceneChain.test.ts's once-per-world-clear and mark-carry cases.
  // Removal was gated on a live acceptance run against sling's real Base.json
  // (27 entities, all 9 fish overrides intact and correctly attributed, cold AND
  // across a carry cycle, through the interactive Save All path), not merely on the
  // code landing. Keeping this as an explicit "now serializes" assertion means a
  // re-introduced guard — or a regression that makes a targeted base throw again —
  // fails loudly here rather than silently locking base saves.
  it('a targeted base containing a prefab instance now SERIALIZES (A8+A9 fixed; the Phase 12 guard is gone)', async () => {
    registerTrait({
      name: 'PrefabInstance', trait: PrefabInstance, category: 'component',
      fields: { source: {}, localId: {}, rootInstanceId: { entityId: { onMissing: 'stripTrait' } }, parentLocalId: {} },
    });
    const ent = spawn(
      EntityAttributes({ name: 'FishLike', guid: 'g-fish', sourceScene: 'base-guid-1' }),
      Transform,
      PrefabInstance({ source: 'some-prefab-guid', localId: 1, rootInstanceId: 0, parentLocalId: 0 }),
    );
    // rootInstanceId matches the entity's own id — what A8's fix guarantees on every
    // real load, and what makes this entity a top-level instance root.
    (ent as any).set(PrefabInstance, { source: 'some-prefab-guid', localId: 1, rootInstanceId: ent.id(), parentLocalId: 0 });
    const scene = await serializeScene({ scene: { path: '/assets/scenes/Base.json', guid: 'base-guid-1' } });
    expect(scene.id).toBe('base-guid-1');
    expect(scene.entities.map((e) => e.name)).toContain('FishLike');
  });

  // scene-loading.md, Phase 2: rootInstanceId — the last numeric
  // on-disk entity ref — is now written as the root's own stable GUID instead of
  // its raw live ecs id, so it no longer churns across the arrival-path-dependent
  // id assignment Phase 0/1 measured.
  it('a captured prefab root writes rootInstanceId as its OWN guid, not the raw ecs id', async () => {
    registerTrait({
      name: 'PrefabInstance', trait: PrefabInstance, category: 'component',
      fields: { source: {}, localId: {}, rootInstanceId: { entityId: { onMissing: 'stripTrait' } }, parentLocalId: {} },
    });
    const ent = spawn(
      EntityAttributes({ name: 'FishLike', guid: 'g-fish-root', sourceScene: 'base-guid-1' }),
      Transform,
      PrefabInstance({ source: 'some-prefab-guid', localId: 1, rootInstanceId: 0, parentLocalId: 0 }),
    );
    (ent as any).set(PrefabInstance, { source: 'some-prefab-guid', localId: 1, rootInstanceId: ent.id(), parentLocalId: 0 });
    const scene = await serializeScene({ scene: { path: '/assets/scenes/Base.json', guid: 'base-guid-1' } });
    const entry = scene.entities.find((e) => e.name === 'FishLike')!;
    const pi = entry.traits.PrefabInstance as Record<string, unknown>;
    expect(pi.rootInstanceId).toBe('g-fish-root');
    expect(pi.rootInstanceId).not.toBe(ent.id());
  });

  it('the default (no opts.scene) path is UNAFFECTED by the guard — a primary with a prefab instance still saves', async () => {
    registerTrait({
      name: 'PrefabInstance', trait: PrefabInstance, category: 'component',
      fields: { source: {}, localId: {}, rootInstanceId: { entityId: { onMissing: 'stripTrait' } }, parentLocalId: {} },
    });
    const ent = spawn(
      EntityAttributes({ name: 'FishLike', guid: 'g-fish', sourceScene: '' }),
      Transform,
      PrefabInstance({ source: 'some-prefab-guid', localId: 1, rootInstanceId: 0, parentLocalId: 0 }),
    );
    // rootInstanceId must match the entity's own id to be treated as a top-level root.
    (ent as any).set(PrefabInstance, { source: 'some-prefab-guid', localId: 1, rootInstanceId: ent.id(), parentLocalId: 0 });
    await expect(serializeScene()).resolves.toBeTruthy();
  });
});
