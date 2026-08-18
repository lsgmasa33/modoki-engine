/** Integration: undo→redo of a prefab instantiate restores the ORIGINAL guids (QA-ASSET-0018).
 *
 *  Measured on games/anim-bug: dropping a probe prefab onto the Hierarchy spawned guid
 *  45cd77c4-…, undo removed it, and redo brought back a visually identical Cube under
 *  b0b3c186-… — a different identity. Redo re-runs the ordinary instantiate path, which
 *  mints a fresh guid per entity, so under the GUID-only-refs design every reference minted
 *  against the entity between the instantiate and the undo is silently orphaned by a plain
 *  undo+redo, with nothing on screen to show for it.
 *
 *  Mocks only world/traitRegistry (as undoSurvivesPlayStop.test.ts does) and drives the REAL
 *  action, with a `respawn` that mints fresh guids exactly like instantiatePrefabAsync. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const EntityAttributes = trait({ name: '' as string, isActive: true, sortOrder: 0, parentId: 0, guid: '' as string, layer: '' as string });

let testWorld: ReturnType<typeof createWorld>;
const entityIndex = new Map<number, unknown>();

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  findEntityById: (id: number) => entityIndex.get(id),
  registerEntity: (e: { id(): number }) => entityIndex.set(e.id(), e),
  spawnEntity: (world: { spawn: (...t: unknown[]) => { id(): number } }, ...traits: unknown[]) => {
    const e = world.spawn(...traits); entityIndex.set(e.id(), e); return e;
  },
  unregisterEntity: (e: { id(): number }) => entityIndex.delete(e.id()),
  destroyEntity: (e: { id(): number; destroy(): void }) => { entityIndex.delete(e.id()); e.destroy(); },
  setStructureCallback: vi.fn(),
  findEntityByGuid: (guid: string) => {
    let found: unknown;
    testWorld.query(EntityAttributes).updateEach(([ea]: [{ guid: string }], e: unknown) => {
      if (!found && ea.guid === guid) found = e;
    });
    return found;
  },
  indexEntityGuid: () => {},
  getGuidIndex: () => {
    const m = new Map<string, unknown>();
    testWorld.query(EntityAttributes).updateEach(([ea]: [{ guid: string }], e: unknown) => {
      if (ea.guid && !m.has(ea.guid)) m.set(ea.guid, e);
    });
    return m;
  },
  rebuildGuidIndexSync: () => {},
}));

const traitDefs = [
  {
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component' as const,
    fields: {
      name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' },
      parentId: { type: 'number', entityId: { onMissing: 'root' } }, guid: { type: 'string' },
      layer: { type: 'string' },
    },
  },
];

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getAllTraits: () => traitDefs,
  getTraitByName: (name: string) => traitDefs.find((t) => t.name === name),
  transformName: (n: string) => n,
}));

vi.mock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({ worldTransforms: new Map() }));
vi.mock('../../src/editor/animation/recording', () => ({ notifyFieldEdited: vi.fn() }));

import { makePrefabInstantiateAction } from '../../src/editor/undo/prefabInstantiateUndo';
import { readTraitData, getAllEntities } from '../../src/runtime/core/ecs/entityUtils';

const eaMeta = traitDefs[0];

let guidSeq = 0;
const freshGuid = () => `guid-${++guidSeq}`;

/** One prefab instantiation: a root "Cube" with two children, each with a NEWLY minted guid —
 *  the behaviour that makes redo lose the identity. */
function instantiate(): number {
  const root = testWorld.spawn(EntityAttributes({ name: 'Cube', guid: freshGuid(), parentId: 0 }));
  entityIndex.set(root.id(), root);
  for (const [i, name] of ['Arm', 'Leg'].entries()) {
    const child = testWorld.spawn(EntityAttributes({ name, guid: freshGuid(), parentId: root.id(), sortOrder: i }));
    entityIndex.set(child.id(), child);
  }
  return root.id();
}

function destroySubtree(rootId: number): void {
  const flat = getAllEntities();
  const ids = [rootId, ...flat.filter((e) => e.parentId === rootId).map((e) => e.id)];
  for (const id of ids) {
    const e = entityIndex.get(id) as { destroy(): void } | undefined;
    if (e) { e.destroy(); entityIndex.delete(id); }
  }
}

function guidsByName(rootId: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of getAllEntities()) {
    if (e.id === rootId || e.parentId === rootId) {
      out[e.name] = (readTraitData(e.id, eaMeta as never)!.guid as string);
    }
  }
  return out;
}

function makeAction(initialId: number) {
  let live = initialId;
  return makePrefabInstantiateAction({
    label: 'Instantiate "Cube"',
    initialId,
    respawn: async () => { live = instantiate(); return live; },
    remove: (id) => destroySubtree(id),
  });
}

beforeEach(() => {
  testWorld = createWorld();
  entityIndex.clear();
  guidSeq = 0;
});

describe('prefab instantiate undo→redo keeps the entity identity', () => {
  it('redo restores the original root AND child guids, not freshly minted ones', async () => {
    const rootId = instantiate();
    const before = guidsByName(rootId);
    expect(Object.keys(before).sort()).toEqual(['Arm', 'Cube', 'Leg']);

    const action = makeAction(rootId);
    await action.undo();
    expect(getAllEntities()).toHaveLength(0);

    await action.redo();
    const newRoot = getAllEntities().find((e) => e.parentId === 0)!.id;
    // The respawn minted guid-4/5/6; the action must have stamped guid-1/2/3 back.
    expect(guidsByName(newRoot)).toEqual(before);
  });

  it('survives repeated cycles — the identity does not drift on the second redo', async () => {
    const rootId = instantiate();
    const before = guidsByName(rootId);
    const action = makeAction(rootId);

    await action.undo();
    await action.redo();
    await action.undo();
    await action.redo();

    const newRoot = getAllEntities().find((e) => e.parentId === 0)!.id;
    expect(guidsByName(newRoot)).toEqual(before);
  });

  it('a later undo still tears down the live respawned subtree (prefab F3 stays fixed)', async () => {
    const rootId = instantiate();
    const action = makeAction(rootId);

    await action.undo();
    await action.redo();
    await action.undo();

    // Restoring the guid also means the ref resolves — the wrong subtree surviving here
    // would be the F3 orphan the shared helper exists to prevent.
    expect(getAllEntities()).toHaveLength(0);
  });

  it('does not steal a guid another live entity still holds', async () => {
    const rootId = instantiate();
    const before = guidsByName(rootId);
    const action = makeAction(rootId);

    await action.undo();
    // Something else claims the old root guid while the instance is gone.
    const squatter = testWorld.spawn(EntityAttributes({ name: 'Squatter', guid: before.Cube }));
    entityIndex.set(squatter.id(), squatter);

    await action.redo();
    const newRoot = getAllEntities().find((e) => e.parentId === 0 && e.name === 'Cube')!.id;
    // Two entities under one identity is worse than the fresh guid the respawn gave it.
    expect(readTraitData(newRoot, eaMeta as never)!.guid).not.toBe(before.Cube);
    expect(readTraitData(squatter.id(), eaMeta as never)!.guid).toBe(before.Cube);
    // The children are uncontested, so they still come back under their original guids.
    expect(guidsByName(newRoot).Arm).toBe(before.Arm);
  });
});
