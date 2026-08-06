/** Tests for the prefab system. */

import { describe, it, expect } from 'vitest';
import { getCurrentWorld, spawnEntity } from '@modoki/engine/runtime';
import { Transform, Renderable3D, PrefabInstance, EntityAttributes } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getEntityTraits, readTraitData, getAllEntities } from '@modoki/engine/runtime';
import { getTraitByName } from '@modoki/engine/runtime';
import { serializePrefab, instantiatePrefab, type PrefabFile } from '@modoki/engine/editor';
import {
  buildPrefabEditScene,
  PREFAB_EDIT_ROOT_GUID,
  PREFAB_EDIT_LOCAL_GUID_PREFIX,
  collectPreservedLocalIds,
} from '../../packages/modoki/src/editor/scene/prefabEdit';

registerAllTraits();

describe('PrefabInstance trait', () => {
  it('is registered in the trait registry', () => {
    const meta = getTraitByName('PrefabInstance');
    expect(meta).toBeDefined();
    expect(meta!.category).toBe('component');
    expect(meta!.fields['source'].type).toBe('string');
    expect(meta!.fields['source'].readOnly).toBe(true);
    expect(meta!.fields['localId'].type).toBe('number');
    expect(meta!.fields['rootInstanceId'].type).toBe('number');
  });

  it('can be spawned on an entity', () => {
    const entity = spawnEntity(getCurrentWorld(), 
      Transform({ x: 5, y: 0, z: 0 }),
      Renderable3D({ mesh: 'prefab-test' }),
      EntityAttributes({ name: 'prefab-test', layer: '3d' }),
      PrefabInstance({ source: 'prefabs/boat.prefab.json', localId: 1, rootInstanceId: 0 }),
    );

    const traits = getEntityTraits(entity.id());
    const names = traits.map((t) => t.name);
    expect(names).toContain('PrefabInstance');
    expect(names).toContain('Transform');
    expect(names).toContain('Renderable3D');
  });

  it('reads PrefabInstance data via introspect', () => {
    const entity = spawnEntity(getCurrentWorld(), 
      Transform({ x: 0, y: 0, z: 0 }),
      PrefabInstance({ source: 'prefabs/test.prefab.json', localId: 3, rootInstanceId: 42 }),
    );

    const meta = getTraitByName('PrefabInstance')!;
    const data = readTraitData(entity.id(), meta);
    expect(data).not.toBeNull();
    expect(data!['source']).toBe('prefabs/test.prefab.json');
    expect(data!['localId']).toBe(3);
    expect(data!['rootInstanceId']).toBe(42);
  });

  it('PrefabInstance fields are readOnly', () => {
    const meta = getTraitByName('PrefabInstance')!;
    expect(meta.fields['source'].readOnly).toBe(true);
    expect(meta.fields['localId'].readOnly).toBe(true);
    expect(meta.fields['rootInstanceId'].readOnly).toBe(true);
  });

  it('rootInstanceId links children to root', () => {
    const root = spawnEntity(getCurrentWorld(), 
      Transform({ x: 0, y: 0, z: 0 }),
      PrefabInstance({ source: 'prefabs/boat.prefab.json', localId: 1, rootInstanceId: 0 }),
    );
    // Set rootInstanceId to self
    const rootId = root.id();

    const child = spawnEntity(getCurrentWorld(), 
      Transform({ x: 1, y: 0, z: 0 }),
      EntityAttributes({ parentId: rootId }),
      PrefabInstance({ source: 'prefabs/boat.prefab.json', localId: 2, rootInstanceId: rootId }),
    );

    const meta = getTraitByName('PrefabInstance')!;
    const childData = readTraitData(child.id(), meta);
    expect(childData!['rootInstanceId']).toBe(rootId);
    expect(childData!['localId']).toBe(2);
  });
});

describe('serializePrefab', () => {
  it('serializes an entity tree with localIds', () => {
    const parent = spawnEntity(getCurrentWorld(), 
      Transform({ x: 10, y: 0, z: 0 }),
      Renderable3D({ mesh: 'prefab-root' }),
      EntityAttributes({ name: 'prefab-root', layer: '3d' }),
    );
    spawnEntity(getCurrentWorld(), 
      Transform({ x: 11, y: 0, z: 0 }),
      Renderable3D({ mesh: 'prefab-child' }),
      EntityAttributes({ name: 'prefab-child', layer: '3d', parentId: parent.id() }),
    );

    const prefab = serializePrefab(parent.id());
    expect(prefab).not.toBeNull();
    expect(prefab!.version).toBe(1);
    expect(prefab!.entities.length).toBe(2);
    expect(prefab!.rootLocalId).toBe(1);

    // Root has localId 1
    const root = prefab!.entities.find((e) => e.localId === 1)!;
    expect(root.name).toBeDefined();

    // Child has localId 2, parentId remapped to 1 (in EntityAttributes)
    const ch = prefab!.entities.find((e) => e.localId === 2)!;
    const chEa = ch.traits['EntityAttributes'] as Record<string, unknown>;
    expect(chEa.parentId).toBe(1); // remapped from ECS ID to localId
  });

  it('returns null for non-existent entity', () => {
    expect(serializePrefab(999999)).toBeNull();
  });
});

describe('instantiatePrefab', () => {
  it('spawns entities from a prefab and adds PrefabInstance trait', () => {
    const prefab: PrefabFile = {
      version: 1,
      name: 'TestPrefab',
      rootLocalId: 1,
      entities: [
        { localId: 1, name: 'Root', traits: { Transform: { x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }, Renderable3D: { mesh: 'inst-root', color: 0xff0000, size: 1, isActive: true }, EntityAttributes: { name: 'Root', parentId: 0, layer: '3d' } } },
        { localId: 2, name: 'Child', traits: { Transform: { x: 6, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }, Renderable3D: { mesh: 'inst-child', color: 0x00ff00, size: 0.5, isActive: true }, EntityAttributes: { name: 'Child', parentId: 1, layer: '3d' } } },
      ],
    };

    const rootId = instantiatePrefab(prefab);
    expect(rootId).toBeGreaterThan(0);

    // Root entity should have PrefabInstance
    const traits = getEntityTraits(rootId);
    expect(traits.map((t) => t.name)).toContain('PrefabInstance');

    // Check PrefabInstance data
    const piMeta = getTraitByName('PrefabInstance')!;
    const piData = readTraitData(rootId, piMeta);
    expect(piData!['localId']).toBe(1);
    expect(piData!['rootInstanceId']).toBe(rootId);
  });

  it('remaps parentIds from localIds to ECS IDs', () => {
    const prefab: PrefabFile = {
      version: 1,
      name: 'ParentTest',
      rootLocalId: 1,
      entities: [
        { localId: 1, name: 'Root', traits: { Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }, EntityAttributes: { name: 'Root', parentId: 0 } } },
        { localId: 2, name: 'Child', traits: { Transform: { x: 1, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }, EntityAttributes: { name: 'Child', parentId: 1 } } },
      ],
    };

    const rootId = instantiatePrefab(prefab);

    // Find the child entity
    const all = getAllEntities();
    const piMeta = getTraitByName('PrefabInstance')!;
    let childId = 0;
    for (const e of all) {
      const pi = readTraitData(e.id, piMeta);
      if (pi && pi['rootInstanceId'] === rootId && pi['localId'] === 2) {
        childId = e.id;
        break;
      }
    }
    expect(childId).toBeGreaterThan(0);

    // Child's parentId should be the root's ECS ID, not localId 1
    const eaMeta = getTraitByName('EntityAttributes')!;
    const childEa = readTraitData(childId, eaMeta);
    expect(childEa!['parentId']).toBe(rootId);
  });
});

/** Create Prefab (`serializePrefab`) must write what a trait PERSISTS — the koota
 *  schema — not the `meta.fields` Inspector subset. Real trait registry, so a
 *  field a custom Inspector section owns (Animator.clips/clip) is genuinely
 *  outside meta.fields here rather than by a mock's say-so.
 *
 *  Two rules pull in opposite directions and both are asserted: a persistent
 *  field belongs in the template, but a SCENE-only one does not. See
 *  runtime/core/ecs/traitSchema.ts and docs/prefabs.md. */
describe('serializePrefab — what reaches the template', () => {
  const BANK = JSON.stringify([{ name: 'skin', clip: 'f1cc3b85-2c23-457b-938a-3470ada21b36' }]);

  function spawnAuthoredEntity(extra: Record<string, unknown> = {}) {
    const animator = getTraitByName('Animator')!;
    return spawnEntity(getCurrentWorld(), 
      Transform({ x: 1, y: 2, z: 3 }),
      EntityAttributes({ name: 'Rigged', layer: '3d', editorFolder: 'Enemies/Ranged', ...extra }),
      animator.trait({ clips: BANK, clip: 'skin', speed: 1 }),
    );
  }

  it('KEEPS a schema field that has no Inspector row (the clip bank)', () => {
    const e = spawnAuthoredEntity();
    const prefab = serializePrefab(e.id())!;
    const root = prefab.entities.find((x) => x.name === 'Rigged')!;
    const animator = root.traits.Animator as Record<string, unknown>;
    expect(animator.clips).toBe(BANK);   // pre-fix: '[]' — Create Prefab emptied the bank
    expect(animator.clip).toBe('skin');
  });

  it('DROPS EntityAttributes.editorFolder — a template must not inherit one scene\'s Hierarchy folder', () => {
    const e = spawnAuthoredEntity();
    const prefab = serializePrefab(e.id())!;
    const root = prefab.entities.find((x) => x.name === 'Rigged')!;
    expect(root.traits.EntityAttributes as Record<string, unknown>).not.toHaveProperty('editorFolder');
  });

  it('DROPS runtimeOnly read-back, so an animating entity bakes no frame in', () => {
    const animator = getTraitByName('Animator')!;
    const e = spawnAuthoredEntity();
    // Mid-crossfade state, as a live entity would carry.
    getCurrentWorld().entities.find((x) => x.id() === e.id())!
      .set(animator.trait, { ...(e.get(animator.trait) as object), activeClip: 'skin', fadeElapsed: 0.4 });
    const prefab = serializePrefab(e.id())!;
    const bag = (prefab.entities.find((x) => x.name === 'Rigged')!.traits.Animator) as Record<string, unknown>;
    expect(bag).not.toHaveProperty('activeClip');
    expect(bag).not.toHaveProperty('fadeElapsed');
  });
});

/** `serializePrefab`'s `opts.preserveLocalIds` / `opts.name`, and `buildPrefabEditScene`'s
 *  sentinel-guid stamping — added so a prefab-edit RE-SAVE keeps each member's existing
 *  localId (the address space a scene's prefab-instance `overrides`/`removed`/
 *  `removedTraits` are keyed in) instead of renumbering positionally, and keeps the
 *  prefab's own `name` instead of taking it from the root entity. Without this, a prefab
 *  authored with a gap in its numbering (a deleted member) silently compacted on the next
 *  save and repointed/dropped every instance override — measured on sling's
 *  `FieldCorner.prefab.json` (`drip` 4 → 2) and `cover-enemy.prefab.json` /
 *  `green-enemy.prefab.json` (both renamed to "Enemy", the root entity's name). See
 *  prefab.ts `serializePrefab` and prefabEdit.ts. */
describe('serializePrefab — preserveLocalIds / name (prefab-edit re-save)', () => {
  /** root + two children, in spawn order (root, child1, child2) — matches the order
   *  `collectTree`'s BFS walk over `getAllEntities()` will produce. */
  function spawnTree() {
    const root = spawnEntity(getCurrentWorld(),
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'PLRoot', layer: '3d' }),
    );
    const child1 = spawnEntity(getCurrentWorld(),
      Transform({ x: 1, y: 0, z: 0 }),
      EntityAttributes({ name: 'PLChildUnmapped', layer: '3d', parentId: root.id() }),
    );
    const child2 = spawnEntity(getCurrentWorld(),
      Transform({ x: 2, y: 0, z: 0 }),
      EntityAttributes({ name: 'PLChildGapped', layer: '3d', parentId: root.id() }),
    );
    return { root, child1, child2 };
  }

  it('with NO opts, numbers positionally from 1 with rootLocalId 1 (regression guard)', () => {
    const { root } = spawnTree();
    const prefab = serializePrefab(root.id())!;
    expect(prefab.rootLocalId).toBe(1);
    const localIds = prefab.entities.map((e) => e.localId).sort((a, b) => a - b);
    expect(localIds).toEqual([1, 2, 3]);
  });

  it('with preserveLocalIds, keeps a gapped id intact and allocates the unmapped member ABOVE the highest preserved id', () => {
    const { root, child2 } = spawnTree();
    // child2 keeps its original gapped id (4, as if localId 2-3 were deleted since
    // the file was last saved); child1 is left out of the map (added during the edit).
    const preserve = new Map<number, number>([[root.id(), 1], [child2.id(), 4]]);
    const prefab = serializePrefab(root.id(), undefined, { preserveLocalIds: preserve })!;

    const rootEntry = prefab.entities.find((e) => e.name === 'PLRoot')!;
    const gapped = prefab.entities.find((e) => e.name === 'PLChildGapped')!;
    const unmapped = prefab.entities.find((e) => e.name === 'PLChildUnmapped')!;

    expect(rootEntry.localId).toBe(1);
    expect(gapped.localId).toBe(4); // NOT compacted to 2
    expect(unmapped.localId).toBe(5); // allocated above 4, not into the freed gap (2 or 3)
  });

  it('rootLocalId follows the preserved root id when it is not 1', () => {
    const { root } = spawnTree();
    const preserve = new Map<number, number>([[root.id(), 3]]);
    const prefab = serializePrefab(root.id(), undefined, { preserveLocalIds: preserve })!;

    expect(prefab.rootLocalId).toBe(3);
    const rootEntry = prefab.entities.find((e) => e.name === 'PLRoot')!;
    expect(rootEntry.localId).toBe(3);
    // The unmapped children are allocated above the preserved root id.
    const others = prefab.entities.filter((e) => e.name !== 'PLRoot').map((e) => e.localId).sort((a, b) => a - b);
    expect(others).toEqual([4, 5]);
  });

  it('opts.name overrides the prefab name; without it, the root entity name is used', () => {
    const { root } = spawnTree();
    const named = serializePrefab(root.id(), undefined, { name: 'Custom Prefab Name' })!;
    expect(named.name).toBe('Custom Prefab Name');

    const unnamed = serializePrefab(root.id())!;
    expect(unnamed.name).toBe('PLRoot'); // falls back to the root entity's name
  });
});

/** `buildPrefabEditScene` stamps a sentinel guid on every entity of the synthetic
 *  prefab-edit scene so `savePrefabEdit` can read back each member's ORIGINAL localId
 *  after the loader reassigns dense ECS ids (see `collectPreservedLocalIds` in
 *  prefabEdit.ts). Pure data transform — no live world / ECS ids involved. */
describe('buildPrefabEditScene — sentinel guid stamping', () => {
  it('stamps the root with PREFAB_EDIT_ROOT_GUID and non-root members with the prefix + their localId, including a rootLocalId that is not 1 and a gap in numbering', () => {
    const prefab: PrefabFile = {
      version: 1,
      name: 'EditFixture',
      rootLocalId: 3,
      entities: [
        { localId: 1, name: 'Leaf', traits: { EntityAttributes: { name: 'Leaf', parentId: 3 } } },
        { localId: 3, name: 'Root', traits: { EntityAttributes: { name: 'Root', parentId: 0 } } },
        // gap: no localId 2 or 4 — a member was deleted since the last save.
        { localId: 5, name: 'Gappy', traits: { EntityAttributes: { name: 'Gappy', parentId: 3 } } },
      ],
    };

    const scene = buildPrefabEditScene(prefab);
    const byId = new Map(scene.entities.map((e) => [e.id, e]));

    const rootGuid = (byId.get(3)!.traits.EntityAttributes as Record<string, unknown>).guid;
    const leafGuid = (byId.get(1)!.traits.EntityAttributes as Record<string, unknown>).guid;
    const gapGuid = (byId.get(5)!.traits.EntityAttributes as Record<string, unknown>).guid;

    expect(rootGuid).toBe(PREFAB_EDIT_ROOT_GUID);
    expect(leafGuid).toBe(`${PREFAB_EDIT_LOCAL_GUID_PREFIX}1`);
    expect(gapGuid).toBe(`${PREFAB_EDIT_LOCAL_GUID_PREFIX}5`);
  });
});

/** `collectPreservedLocalIds` — the READ-BACK half of the localId-preservation fix, and the
 *  half that production alone exercises: `buildPrefabEditScene` writes the sentinel guids, a
 *  real scene load reassigns the ECS ids densely, and only then is this called. Nothing but a
 *  live editor round-trip covered it, which is exactly the seam the sweep found bugs in. The
 *  ECS-id reassignment is simulated here by spawning in an order that does NOT match the
 *  localIds — the whole point is that the two spaces are independent. */
describe('collectPreservedLocalIds — sentinel read-back', () => {
  it('maps ecsId → original localId, takes the root from rootLocalId, and ignores non-members', () => {
    const world = getCurrentWorld();
    // Spawned in an order unrelated to their localIds (4 before 2), as a real load would.
    const root = spawnEntity(world, EntityAttributes({ name: 'CPRoot', guid: PREFAB_EDIT_ROOT_GUID }));
    const gapped = spawnEntity(world, EntityAttributes({ name: 'CPGapped', guid: `${PREFAB_EDIT_LOCAL_GUID_PREFIX}4` }));
    const mid = spawnEntity(world, EntityAttributes({ name: 'CPMid', guid: `${PREFAB_EDIT_LOCAL_GUID_PREFIX}2` }));
    // A member the user ADDED during the edit: no sentinel, so it must be ABSENT from the map
    // (serializePrefab then allocates it above the preserved ids rather than into a gap).
    const added = spawnEntity(world, EntityAttributes({ name: 'CPAdded', guid: '' }));
    // Scaffolding / an unrelated entity carrying a guid that is not a sentinel — must be ignored.
    const scaffold = spawnEntity(world, EntityAttributes({ name: 'CPScaffold', guid: 'not-a-sentinel' }));

    const map = collectPreservedLocalIds(7, root.id());

    expect(map.get(root.id())).toBe(7);   // root's localId comes from rootLocalId, not its guid
    expect(map.get(gapped.id())).toBe(4);
    expect(map.get(mid.id())).toBe(2);
    expect(map.has(added.id())).toBe(false);
    expect(map.has(scaffold.id())).toBe(false);
  });

  it('a malformed sentinel is ignored rather than mapped to NaN/0', () => {
    const world = getCurrentWorld();
    const bad = spawnEntity(world, EntityAttributes({ name: 'CPBad', guid: `${PREFAB_EDIT_LOCAL_GUID_PREFIX}abc` }));
    const zero = spawnEntity(world, EntityAttributes({ name: 'CPZero', guid: `${PREFAB_EDIT_LOCAL_GUID_PREFIX}0` }));

    const map = collectPreservedLocalIds(1, 0);

    // A NaN or 0 entry would collide in serializePrefab's allocator and silently renumber.
    expect(map.has(bad.id())).toBe(false);
    expect(map.has(zero.id())).toBe(false);
  });
});
