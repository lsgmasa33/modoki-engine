/** #124 write-site integration: `writeTraitField` (entityUtils.ts) calls
 *  `noteIfAuthoredWriteWhileStopped`, which records a write only when ALL THREE hold —
 *  `inSystemTick()`, `!isSimRunning()`, and the entity is NOT `Transient`. This exercises that
 *  gate directly against a real koota world + the real pipeline flag (`beginSystemTick`/
 *  `endSystemTick`), mirroring the setup in `entityIndexIntegrity.test.ts` (real `spawnEntity`/
 *  `setCurrentWorld`, no mocks) rather than `entityUtils.test.ts`'s mocked-module style. The
 *  recorder's own bookkeeping (dedupe/cap) is covered separately in authoredWrites.test.ts —
 *  this file only proves the CONDITION at the call site. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';
import { setCurrentWorld, spawnEntity } from '../../src/runtime/core/ecs/world';
import { writeTraitField } from '../../src/runtime/core/ecs/entityUtils';
import type { TraitMeta } from '../../src/runtime/core/ecs/traitRegistry';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Transient } from '../../src/runtime/core/traits/Transient';
import { setPlayState } from '../../src/runtime/core/playState';
import { beginSystemTick, endSystemTick } from '../../src/runtime/core/systemTick';
import { getAuthoredWritesWhileStopped, clearAuthoredWritesWhileStopped } from '../../src/runtime/core/ecs/authoredWrites';

// A throwaway component trait — writeTraitField only reads `meta.category`/`meta.trait`/
// `meta.name` off the TraitMeta passed in, so this doesn't need to go through registerTrait.
const Health = trait({ hp: 100 as number });
const healthMeta: TraitMeta = {
  name: 'Health',
  trait: Health,
  category: 'component',
  fields: { hp: { type: 'number' } },
};

describe('writeTraitField — authored-write-while-stopped probe', () => {
  beforeEach(() => {
    setCurrentWorld(createWorld());
    clearAuthoredWritesWhileStopped();
  });

  afterEach(() => {
    endSystemTick(); // safety net in case a test throws before its own endSystemTick()
    setPlayState('playing'); // restore the module-level default so it can't leak to other files
    clearAuthoredWritesWhileStopped();
  });

  it('records when: in a system tick + sim stopped + entity is NOT Transient', () => {
    const world = createWorld();
    setCurrentWorld(world);
    setPlayState('stopped');
    const entity = spawnEntity(world, EntityAttributes({ name: 'Boss' }), Health({ hp: 100 }));

    beginSystemTick();
    writeTraitField(entity.id(), healthMeta, 'hp', 50);
    endSystemTick();

    const { records } = getAuthoredWritesWhileStopped();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ entityId: entity.id(), name: 'Boss', trait: 'Health', field: 'hp', count: 1 });
  });

  it('does NOT record outside a system tick (a human inspector/gizmo edit)', () => {
    const world = createWorld();
    setCurrentWorld(world);
    setPlayState('stopped');
    const entity = spawnEntity(world, EntityAttributes({ name: 'Boss' }), Health({ hp: 100 }));

    // No beginSystemTick() — this is a direct write, as the Inspector makes.
    writeTraitField(entity.id(), healthMeta, 'hp', 50);

    expect(getAuthoredWritesWhileStopped().records).toHaveLength(0);
  });

  it('does NOT record while the sim is running (Play)', () => {
    const world = createWorld();
    setCurrentWorld(world);
    setPlayState('playing');
    const entity = spawnEntity(world, EntityAttributes({ name: 'Boss' }), Health({ hp: 100 }));

    beginSystemTick();
    writeTraitField(entity.id(), healthMeta, 'hp', 50);
    endSystemTick();

    expect(getAuthoredWritesWhileStopped().records).toHaveLength(0);
  });

  it('does NOT record a write to a Transient (system-spawned) entity', () => {
    const world = createWorld();
    setCurrentWorld(world);
    setPlayState('stopped');
    const entity = spawnEntity(world, EntityAttributes({ name: 'Ghost' }), Health({ hp: 100 }), Transient);

    beginSystemTick();
    writeTraitField(entity.id(), healthMeta, 'hp', 50);
    endSystemTick();

    expect(getAuthoredWritesWhileStopped().records).toHaveLength(0);
  });

  it('uses the entity\'s EntityAttributes.name as the record label', () => {
    const world = createWorld();
    setCurrentWorld(world);
    setPlayState('stopped');
    const entity = spawnEntity(world, EntityAttributes({ name: 'Named Entity' }), Health({ hp: 100 }));

    beginSystemTick();
    writeTraitField(entity.id(), healthMeta, 'hp', 1);
    endSystemTick();

    const { records } = getAuthoredWritesWhileStopped();
    expect(records[0].name).toBe('Named Entity');
  });

  it('falls back to "#<id>" when the entity has no EntityAttributes', () => {
    const world = createWorld();
    setCurrentWorld(world);
    setPlayState('stopped');
    const entity = spawnEntity(world, Health({ hp: 100 })); // no EntityAttributes

    beginSystemTick();
    writeTraitField(entity.id(), healthMeta, 'hp', 1);
    endSystemTick();

    const { records } = getAuthoredWritesWhileStopped();
    expect(records[0].name).toBe(`#${entity.id()}`);
  });
});
