/** Integration: editor undo actions survive a world rebuild (Play→Stop revert).
 *
 *  A Play→Stop revert reloads the pre-Play snapshot into a FRESH koota world, so
 *  every entity gets a new id. Undo actions now capture a guid-based EntityRef and
 *  resolve it at apply-time, so the stack stays valid across the rebuild. This test
 *  simulates the rebuild by reassigning the mocked current world to a new world
 *  whose entities carry the SAME guids (exactly what loadScene({preloaded}) does).
 *
 *  Uses the REAL undoManager + entityActions + entityRef (only world/traitRegistry/
 *  recording are mocked), so it exercises the actual undo/redo path. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '' as string, isActive: true, sortOrder: 0, parentId: 0, guid: '' as string, layer: '' as string });

let testWorld: ReturnType<typeof createWorld>;
const entityIndex = new Map<number, any>();

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  findEntityById: (id: number) => entityIndex.get(id),
  registerEntity: (e: any) => entityIndex.set(e.id(), e),
  unregisterEntity: (e: any) => entityIndex.delete(e.id()),
  setStructureCallback: vi.fn(),
  findEntityByGuid: (guid: string, world: any = testWorld) => {
    let found: any;
    world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (!found && ea.guid === guid) found = e; });
    return found;
  },
  indexEntityGuid: () => {},
  getGuidIndex: (world: any = testWorld) => {
    const m = new Map<string, any>();
    world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { const g = ea.guid; if (g && !m.has(g)) m.set(g, e); });
    return m;
  },
  rebuildGuidIndexSync: () => {},
}));

const traitDefs = [
  { name: 'Transform', trait: Transform, category: 'component' as const, fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' } } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component' as const, fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number' }, guid: { type: 'string' }, layer: { type: 'string' } } },
];

vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getAllTraits: () => traitDefs,
  getTraitByName: (name: string) => traitDefs.find(t => t.name === name),
  transformName: (n: string) => n,
}));

vi.mock('../../src/three/systems/transformPropagationSystem', () => ({ worldTransforms: new Map() }));
vi.mock('../../src/editor/animation/recording', () => ({ notifyFieldEdited: vi.fn() }));

import { writeTraitFieldWithUndo, deleteEntityWithUndo, createEntityWithUndo } from '../../src/editor/undo/entityActions';
import { undo, redo, clearHistory, undoDepth } from '../../src/editor/undo/undoManager';
import { readTraitData } from '../../src/runtime/ecs/entityUtils';

const eaMeta = traitDefs[1];
const tfMeta = traitDefs[0];

function spawn(world: ReturnType<typeof createWorld>, guid: string, x: number, name = 'E') {
  const e = world.spawn(Transform({ x }), EntityAttributes({ name, guid }));
  entityIndex.set(e.id(), e);
  return e;
}

/** Simulate the Play→Stop revert: build a fresh world with the given entities
 *  (same guids, new ids) and make it current. Returns the new entities by guid. */
function rebuildWorldWith(entities: { guid: string; x: number; name?: string }[]) {
  const next = createWorld();
  entityIndex.clear();
  // spawn a decoy first so new ids differ from the originals
  next.spawn(Transform({ x: -1 }), EntityAttributes({ name: 'decoy', guid: 'decoy' }));
  const byGuid = new Map<string, any>();
  for (const e of entities) byGuid.set(e.guid, spawn(next, e.guid, e.x, e.name));
  testWorld = next;
  return byGuid;
}

beforeEach(() => {
  testWorld = createWorld();
  entityIndex.clear();
  clearHistory();
});

describe('undo survives a Play→Stop world rebuild', () => {
  it('field-edit undo/redo resolve the rebuilt entity by guid', async () => {
    const e = spawn(testWorld, '', 0); // guid-less, like a never-saved entity
    const id = e.id();

    writeTraitFieldWithUndo(id, tfMeta as any, 'x', 5);
    expect(readTraitData(id, tfMeta as any)!.x).toBe(5);
    // ensureGuid minted a stable guid (the load-bearing bit for surviving Stop)
    const guid = readTraitData(id, eaMeta as any)!.guid as string;
    expect(guid).toBeTruthy();

    // Play→Stop: rebuild the world; the entity returns with the same guid, new id.
    const byGuid = rebuildWorldWith([{ guid, x: 5 }]);
    const newId = byGuid.get(guid)!.id();
    expect(newId).not.toBe(id);

    await undo();
    expect(readTraitData(newId, tfMeta as any)!.x).toBe(0); // restored on the REBUILT entity
    await redo();
    expect(readTraitData(newId, tfMeta as any)!.x).toBe(5);
  });

  it('delete redo deletes the correct rebuilt entity by root guid', async () => {
    const e = spawn(testWorld, '', 0);
    const id = e.id();

    deleteEntityWithUndo(id); // ensureGuid ran BEFORE the snapshot
    // snapshot carries a guid even though the entity was guid-less when targeted
    // (we can't read it off the deleted entity; assert via the undo round-trip below)

    // undo respawns it into the CURRENT world; read its guid back
    await undo();
    let restored: any;
    testWorld.query(EntityAttributes).updateEach(([ea]: any[], en: any) => { if (ea.name === 'E') restored = en; });
    const guid = (restored.get(EntityAttributes) as any).guid as string;
    expect(guid).toBeTruthy();
    entityIndex.set(restored.id(), restored);

    // Play→Stop rebuild: entity returns with same guid, new id
    const byGuid = rebuildWorldWith([{ guid, x: 0 }]);
    const newId = byGuid.get(guid)!.id();

    await redo(); // must delete the REBUILT entity (by guid), not a stale id
    void newId;
    let found = 0;
    testWorld.query(EntityAttributes).updateEach(([ea]: any[]) => { if (ea.guid === guid) found++; });
    expect(found).toBe(0); // the rebuilt entity was deleted
  });

  it('createEntityWithUndo gives the new entity a guid so undo finds it after rebuild', async () => {
    const selected: (number | null)[] = [];
    const id = createEntityWithUndo('Create', 0, [
      { name: 'EntityAttributes', data: { name: 'E' } },
      { name: 'Transform' },
    ], (x) => selected.push(x))!;
    const guid = readTraitData(id, eaMeta as any)!.guid as string;
    expect(guid).toBeTruthy(); // pre-snapshot ensureGuid ran

    // Play→Stop rebuild: the created entity returns with the same guid, new id
    const byGuid = rebuildWorldWith([{ guid, x: 0 }]);
    const newId = byGuid.get(guid)!.id();

    await undo(); // deletes the created entity, resolved by guid on the rebuilt world
    void newId;
    let found = 0;
    testWorld.query(EntityAttributes).updateEach(([ea]: any[]) => { if (ea.guid === guid) found++; });
    expect(found).toBe(0);
  });
});
