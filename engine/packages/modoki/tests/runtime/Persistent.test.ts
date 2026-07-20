/** markPersistent unit tests (ecs-core P2) — the root-only + guid-assignment invariants
 *  that SceneManager.filterPersistentDuplicates and editor selection-restore depend on.
 *  Mocks ONLY the trait registry (so markPersistent resolves a test-local EntityAttributes)
 *  and uses a single koota world to stay well under koota's 16-world cap. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string });

vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (name: string) =>
    name === 'EntityAttributes' ? { name, trait: EntityAttributes } : undefined,
}));

let world: ReturnType<typeof createWorld>;
beforeEach(() => { world = createWorld(); });
afterEach(() => { world.destroy(); });

async function getMod() { return import('../../src/runtime/traits/Persistent'); }

describe('markPersistent', () => {
  it('throws on a non-root entity (parentId !== 0)', async () => {
    const { markPersistent } = await getMod();
    const e = world.spawn(Transform(), EntityAttributes({ name: 'Child', parentId: 5 }));
    expect(() => markPersistent(e)).toThrow(/only root entities/);
  });

  it('throws when the entity has no EntityAttributes', async () => {
    const { markPersistent } = await getMod();
    const e = world.spawn(Transform());
    expect(() => markPersistent(e)).toThrow(/no EntityAttributes/);
  });

  it('assigns a fresh guid when missing, adds the Persistent tag, and returns the guid', async () => {
    const { markPersistent, Persistent } = await getMod();
    const e = world.spawn(Transform(), EntityAttributes({ name: 'Root', parentId: 0 }));
    const guid = markPersistent(e);
    expect(guid).toBeTruthy();
    expect(e.get(EntityAttributes)!.guid).toBe(guid); // written back
    expect(e.has(Persistent)).toBe(true);
  });

  it('preserves an existing guid', async () => {
    const { markPersistent } = await getMod();
    const e = world.spawn(Transform(), EntityAttributes({ name: 'Keep', parentId: 0, guid: 'existing-guid' }));
    expect(markPersistent(e)).toBe('existing-guid');
  });

  it('an explicit guid argument overrides the existing guid', async () => {
    const { markPersistent } = await getMod();
    const e = world.spawn(Transform(), EntityAttributes({ name: 'Forced', parentId: 0, guid: 'old' }));
    expect(markPersistent(e, 'explicit-guid')).toBe('explicit-guid');
    expect(e.get(EntityAttributes)!.guid).toBe('explicit-guid');
  });
});
