/** A parked scroll-view entry must read as DESTROYED to the agent surface (owner, 2026-08-21).
 *
 *  `getAllEntities` is the single choke point the whole agent surface runs through —
 *  get_scene_state, entity aiming, diagnose, layout bounds, live mutate — so the rule is
 *  enforced there once rather than in each consumer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { UIEntry } from '../../src/runtime/traits/UIEntry';
import { UIElement } from '../../src/runtime/traits/UIElement';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';

let testWorld: ReturnType<typeof createWorld>;
const idIndex = new Map<number, any>();

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  findEntityById: (id: number) => idIndex.get(id),
  destroyEntity: () => {},
  setStructureCallback: () => {},
}));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {} },
    { name: 'UIElement', trait: UIElement, category: 'component', fields: {} },
    { name: 'UIEntry', trait: UIEntry, category: 'component', fields: {} },
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (n: string) => traits.find(t => t.name === n),
    transformName: (n: string) => n,
  };
});

function spawn(traits: any[], name: string, parentId = 0) {
  const e = testWorld.spawn(EntityAttributes({ name, parentId, guid: name }), ...traits);
  idIndex.set(e.id(), e);
  return e;
}

beforeEach(() => { testWorld = createWorld(); idIndex.clear(); });

describe('parked entries and the agent surface', () => {
  it('lists a LIVE entry and its members', async () => {
    const { getAllEntities } = await import('../../src/runtime/core/ecs/entityUtils');
    const row = spawn([UIElement({}), UIEntry({ live: true, index: 4, slot: 0 })], 'LiveRow');
    spawn([UIElement({})], 'LiveLabel', row.id());
    const names = getAllEntities().map(e => e.name);
    expect(names).toContain('LiveRow');
    expect(names).toContain('LiveLabel');
  });

  it('DROPS a parked entry — it reads as destroyed, not as hidden', async () => {
    const { getAllEntities } = await import('../../src/runtime/core/ecs/entityUtils');
    spawn([UIElement({}), UIEntry({ live: false, index: -1, slot: 3 })], 'ParkedRow');
    expect(getAllEntities().map(e => e.name)).not.toContain('ParkedRow');
  });

  it('drops the parked entry\'s WHOLE SUBTREE — members are what an aim would land on', async () => {
    const { getAllEntities } = await import('../../src/runtime/core/ecs/entityUtils');
    const row = spawn([UIElement({}), UIEntry({ live: false, index: -1, slot: 3 })], 'ParkedRow');
    const face = spawn([UIElement({})], 'ParkedFace', row.id());
    spawn([UIElement({})], 'ParkedNum', face.id());
    const names = getAllEntities().map(e => e.name);
    expect(names).not.toContain('ParkedFace');
    expect(names).not.toContain('ParkedNum');
  });

  it('does NOT drop a merely hidden entity — hiding is not a claim of non-existence', async () => {
    // The distinction the owner drew: isVisible:false stays addressable, and must.
    const { getAllEntities } = await import('../../src/runtime/core/ecs/entityUtils');
    spawn([UIElement({ isVisible: false })], 'HiddenButReal');
    expect(getAllEntities().map(e => e.name)).toContain('HiddenButReal');
  });

  it('leaves ordinary entities alone when nothing is parked', async () => {
    const { getAllEntities } = await import('../../src/runtime/core/ecs/entityUtils');
    spawn([UIElement({})], 'Plain');
    expect(getAllEntities().map(e => e.name)).toContain('Plain');
  });
});
