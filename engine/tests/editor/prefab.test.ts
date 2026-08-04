/** Tests for the prefab system. */

import { describe, it, expect } from 'vitest';
import { getCurrentWorld, spawnEntity } from '@modoki/engine/runtime';
import { Transform, Renderable3D, PrefabInstance, EntityAttributes } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getEntityTraits, readTraitData, getAllEntities } from '@modoki/engine/runtime';
import { getTraitByName } from '@modoki/engine/runtime';
import { serializePrefab, instantiatePrefab, type PrefabFile } from '@modoki/engine/editor';

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
