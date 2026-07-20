/** entityRef unit tests — ensureGuid (mint+persist, idempotent, un-guidable),
 *  EntityRef.resolve across a simulated world swap, buildGuidIndex/resolveRefs. */

import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string });
const Bare = trait({ v: 0 }); // an entity carrying this but NOT EntityAttributes is un-guidable

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
  { name: 'Transform', trait: Transform, category: 'component' as const, fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component' as const, fields: { name: { type: 'string' }, parentId: { type: 'number' }, guid: { type: 'string' } } },
  { name: 'Bare', trait: Bare, category: 'component' as const, fields: { v: { type: 'number' } } },
];

vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getAllTraits: () => traitDefs,
  getTraitByName: (name: string) => traitDefs.find(t => t.name === name),
  transformName: (n: string) => n,
}));

import { ensureGuid, entityRef, buildGuidIndex, resolveRefs } from '../../src/editor/undo/entityRef';
import { readTraitData } from '../../src/runtime/ecs/entityUtils';

function spawn(world: ReturnType<typeof createWorld>, guid: string, name = '') {
  const e = world.spawn(Transform({ x: 1 }), EntityAttributes({ name, guid }));
  entityIndex.set(e.id(), e);
  return e;
}

beforeEach(() => {
  testWorld = createWorld();
  entityIndex.clear();
});

describe('ensureGuid', () => {
  it('mints + writes a guid to the live world when empty', () => {
    const e = spawn(testWorld, '');
    const g = ensureGuid(e.id());
    expect(g).toBeTruthy();
    // persisted to the LIVE entity (the load-bearing part for Play snapshot)
    expect(readTraitData(e.id(), traitDefs[1])!.guid).toBe(g);
  });

  it('is idempotent — returns the existing guid, does not re-mint', () => {
    const e = spawn(testWorld, 'existing-guid');
    expect(ensureGuid(e.id())).toBe('existing-guid');
    expect(ensureGuid(e.id())).toBe('existing-guid');
    expect(readTraitData(e.id(), traitDefs[1])!.guid).toBe('existing-guid');
  });

  it("returns '' for an entity with no EntityAttributes (un-guidable)", () => {
    const e = testWorld.spawn(Bare({ v: 5 }));
    entityIndex.set(e.id(), e);
    expect(ensureGuid(e.id())).toBe('');
  });
});

describe('EntityRef.resolve', () => {
  it('re-finds the entity by guid after a world swap (new id, same guid)', () => {
    const a = spawn(testWorld, '', 'Ship');
    const ref = entityRef(a.id());
    expect(ref.guid).toBeTruthy();
    expect(ref.resolve()).toBe(a.id());

    // Simulate Play→Stop: a fresh world where a DIFFERENT id carries the same guid.
    const worldB = createWorld();
    entityIndex.clear();
    // spawn some decoys first so the new id differs from the old one
    spawn(worldB, 'decoy-1');
    const b = spawn(worldB, ref.guid, 'Ship');
    testWorld = worldB;

    expect(b.id()).not.toBe(a.id());
    expect(ref.resolve()).toBe(b.id());
  });

  it('falls back to raw id for an un-guidable entity, null after swap', () => {
    const e = testWorld.spawn(Bare({ v: 1 }));
    entityIndex.set(e.id(), e);
    const ref = entityRef(e.id());
    expect(ref.guid).toBe('');
    expect(ref.resolve()).toBe(e.id()); // same world → raw fallback works

    testWorld = createWorld();
    entityIndex.clear();
    expect(ref.resolve()).toBeNull(); // gone in the new world
  });
});

describe('buildGuidIndex / resolveRefs', () => {
  it('resolves a batch of refs in one pass', () => {
    const a = spawn(testWorld, 'g-a');
    const b = spawn(testWorld, 'g-b');
    const refs = [entityRef(a.id()), entityRef(b.id())];
    const idx = buildGuidIndex();
    expect(resolveRefs(refs, idx)).toEqual([a.id(), b.id()]);
  });

  it('drops refs that no longer resolve', () => {
    const a = spawn(testWorld, 'g-a');
    const ref = entityRef(a.id());
    testWorld = createWorld(); // a is gone
    entityIndex.clear();
    expect(resolveRefs([ref])).toEqual([]);
  });

  it('first wins when two entities share a guid', () => {
    const a = spawn(testWorld, 'dup');
    spawn(testWorld, 'dup');
    const idx = buildGuidIndex();
    expect(idx.get('dup')).toBe(a.id());
  });
});
