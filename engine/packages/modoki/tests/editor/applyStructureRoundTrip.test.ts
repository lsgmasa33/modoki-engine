/** Runtime re-expand: instantiatePrefabIntoWorld + applyStructureByLocalToEcs.
 *  Validates that structural overrides (added/removed entities, removed traits)
 *  captured at save time are reproduced on load — i.e. an added child survives a
 *  reload instead of orphaning (the bug this feature fixes).
 *
 *  Real koota world; world/traitRegistry mocked to inject the trait set. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '' as string, isActive: true, sortOrder: 0, parentId: 0, guid: '' as string, layer: '' as '' | '3d' | '2d' | 'ui' });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });
const Rotate3D = trait({ axis: 'y' as string, speed: 1 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, isActive: 0, sortOrder: 0, parentId: 0, guid: 0, layer: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0 } },
  { name: 'Rotate3D', trait: Rotate3D, category: 'component', fields: { axis: 0, speed: 0 } },
] as const;

vi.mock('../../src/runtime/ecs/world', () => ({
  onWorldSwap: () => () => {},
  getCurrentWorld: () => createWorld(),
  registerEntity: vi.fn(),
  unregisterEntity: vi.fn(),
  setStructureCallback: vi.fn(),
}));

vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getAllTraits: () => TRAITS,
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
}));

async function getModule() {
  return import('../../src/runtime/loaders/loadSceneFile');
}

/** Read live entities (id, name, parentId, trait set) from a world. */
function dump(world: ReturnType<typeof createWorld>) {
  const out: { name: string; parentId: number; traits: string[]; rotate?: number }[] = [];
  for (const e of world.entities as any) {
    if (!e.has(EntityAttributes)) continue;
    const ea = e.get(EntityAttributes);
    out.push({
      name: ea.name,
      parentId: ea.parentId,
      traits: TRAITS.filter((t) => e.has(t.trait)).map((t) => t.name),
      rotate: e.has(Rotate3D) ? e.get(Rotate3D).speed : undefined,
    });
  }
  return out;
}

// Prefab: Root(1) → Branch(2). Branch carries Rotate3D.
function makePrefab() {
  return {
    rootLocalId: 1,
    entities: [
      { localId: 1, traits: { EntityAttributes: { name: 'Root', parentId: 0 } } },
      { localId: 2, traits: { EntityAttributes: { name: 'Branch', parentId: 1 }, Rotate3D: { axis: 'y', speed: 5 } } },
    ],
  };
}

describe('instantiatePrefabIntoWorld + structural overrides', () => {
  let world: ReturnType<typeof createWorld>;
  beforeEach(() => { world = createWorld(); });

  it('re-spawns an added child under the right member parent (survives reload)', async () => {
    const { instantiatePrefabIntoWorld } = await getModule();
    const added = [{
      parentLocalId: 2, guid: 'g-crown', name: 'Crown',
      traits: { EntityAttributes: { name: 'Crown', parentId: 0, guid: 'g-crown' }, Transform: { x: 7 } },
      children: [],
    }];

    instantiatePrefabIntoWorld(world, makePrefab(), 0, undefined, 'src', undefined, { added });

    const ents = dump(world);
    const root = ents.find((e) => e.name === 'Root')!;
    const crown = ents.find((e) => e.name === 'Crown')!;
    expect(crown).toBeTruthy();
    // Crown is parented to Branch's live ECS id (not a stale/zero id).
    const branchEnt = [...(world.entities as any)].find((e: any) => e.has(EntityAttributes) && e.get(EntityAttributes).name === 'Branch');
    const crownEnt = [...(world.entities as any)].find((e: any) => e.has(EntityAttributes) && e.get(EntityAttributes).name === 'Crown');
    expect(crownEnt.get(EntityAttributes).parentId).toBe(branchEnt.id());
    expect(crownEnt.get(EntityAttributes).guid).toBe('g-crown'); // stable identity restored
    expect(crownEnt.get(Transform).x).toBe(7);
    expect(crownEnt.has(PrefabInstance)).toBe(false); // added entities are NOT tagged
    expect(root.parentId).toBe(0);
  });

  it('deletes a removed prefab member (and cascades descendants)', async () => {
    const { instantiatePrefabIntoWorld } = await getModule();
    instantiatePrefabIntoWorld(world, makePrefab(), 0, undefined, 'src', undefined, { removed: [2] });

    const names = dump(world).map((e) => e.name).sort();
    expect(names).toEqual(['Root']); // Branch gone
  });

  it('removes a named component from a member', async () => {
    const { instantiatePrefabIntoWorld } = await getModule();
    instantiatePrefabIntoWorld(world, makePrefab(), 0, undefined, 'src', undefined, { removedTraits: { 2: ['Rotate3D'] } });

    const branch = dump(world).find((e) => e.name === 'Branch')!;
    expect(branch.traits).not.toContain('Rotate3D');
  });

  it('skips an addition whose anchor localId was removed in the same pass', async () => {
    const { instantiatePrefabIntoWorld } = await getModule();
    const added = [{
      parentLocalId: 2, guid: 'g-x', name: 'Orphan',
      traits: { EntityAttributes: { name: 'Orphan', parentId: 0, guid: 'g-x' } },
      children: [],
    }];
    // Branch (localId 2) removed first, so the anchor is gone → addition skipped.
    instantiatePrefabIntoWorld(world, makePrefab(), 0, undefined, 'src', undefined, { removed: [2], added });

    const names = dump(world).map((e) => e.name).sort();
    expect(names).toEqual(['Root']);
  });

  it('re-anchors an addition whose anchor localId is absent (prefab changed) to the root', async () => {
    // C3: anchor missing but NOT removed this pass → keep the addition under the
    // instance root rather than dropping it. Matches the editor side
    // (applyStructureByRootInstance), removing the prior editor↔runtime divergence.
    const { instantiatePrefabIntoWorld } = await getModule();
    const added = [{
      parentLocalId: 99, guid: 'g-y', name: 'Kept', // localId 99 doesn't exist
      traits: { EntityAttributes: { name: 'Kept', parentId: 0, guid: 'g-y' } },
      children: [],
    }];
    instantiatePrefabIntoWorld(world, makePrefab(), 0, undefined, 'src', undefined, { added });

    const kept = [...(world.entities as any)].find((e: any) => e.has(EntityAttributes) && e.get(EntityAttributes).name === 'Kept');
    const root = [...(world.entities as any)].find((e: any) => e.has(EntityAttributes) && e.get(EntityAttributes).name === 'Root');
    expect(kept).toBeTruthy();
    expect(kept.get(EntityAttributes).parentId).toBe(root.id());
  });
});
