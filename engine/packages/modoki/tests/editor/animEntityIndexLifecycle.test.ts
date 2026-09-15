/** #1220 sibling — the Animation Editor's entity index is memoized on the structure version, and its
 *  docblock says that version bumps on entity "add/remove". Before #1220 a destroy did not bump it,
 *  so after a runtime destroy the index still resolved the dead entity's name-path.
 *
 *  Unlike animEntityIndex.test.ts this uses the REAL entityUtils and world: that suite mocks
 *  `getStructureVersion`, so it cannot see whether a destroy moves it. */

import { it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { setCurrentWorld, spawnEntity, destroyEntity } from '../../src/runtime/core/ecs/world';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { getAnimEntityIndex, clearAnimEntityIndex, resolvePathToEntityId } from '../../src/editor/animation/entityIndex';

beforeEach(() => {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: { type: 'string' }, sortOrder: { type: 'number' }, parentId: { type: 'number' } },
  });
  clearAnimEntityIndex();
});

it('a runtime destroy drops the dead entity\'s name-path from the index (#1220)', () => {
  const w = createWorld();
  setCurrentWorld(w);
  const root = spawnEntity(w, EntityAttributes({ name: 'Root', parentId: 0 }));
  const arm = spawnEntity(w, EntityAttributes({ name: 'Arm', parentId: root.id() }));
  expect(resolvePathToEntityId(getAnimEntityIndex(), root.id(), 'Arm')).toBe(arm.id());

  destroyEntity(arm, w);

  expect(resolvePathToEntityId(getAnimEntityIndex(), root.id(), 'Arm')).toBeNull();
});
