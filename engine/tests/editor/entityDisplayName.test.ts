/** entityDisplayName — the name an undo label reads (#1138).
 *
 *  The defect was six label sites reading `findEntity(id)?.name`, a property the koota handle
 *  does not have, so every label fell back to the runtime id. Each case here spawns an entity
 *  whose name comes from a different rung of the resolution order, and checks the label agrees
 *  with the Hierarchy's own row (getAllEntities) — the promise the helper makes. */

import { describe, it, expect } from 'vitest';
import {
  getCurrentWorld, Transform, Renderable3D, Camera, EntityAttributes,
  getAllEntities, entityDisplayName,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { TestPhase, registerTestGameTraits } from './_fixtures/testGame';

registerAllTraits();
registerTestGameTraits();

const hierarchyName = (id: number) => getAllEntities().find((e) => e.id === id)!.name;

describe('entityDisplayName', () => {
  it('reads EntityAttributes.name — the authored name, not the runtime id', () => {
    const e = getCurrentWorld().spawn(Transform(), EntityAttributes({ name: 'Sun', layer: '3d' }));
    expect(entityDisplayName(e.id())).toBe('Sun');
    expect(entityDisplayName(e.id())).toBe(hierarchyName(e.id()));
  });

  it('agrees with the Hierarchy for an unnamed camera, resource and string-field entity', () => {
    const world = getCurrentWorld();
    const camera = world.spawn(Transform(), Camera(), Renderable3D({ mesh: 'camera' }));
    const resource = world.spawn(TestPhase({ phase: 'game' }));
    const meshNamed = world.spawn(Transform(), Renderable3D({ mesh: 'my-custom-mesh' }));
    expect(entityDisplayName(camera.id())).toBe('Game Camera');
    expect(entityDisplayName(resource.id())).toContain('(resource)');
    expect(entityDisplayName(meshNamed.id())).toBe('my-custom-mesh');
    for (const e of [camera, resource, meshNamed]) {
      expect(entityDisplayName(e.id())).toBe(hierarchyName(e.id()));
    }
  });

  it('falls back to the GUID, not the runtime id, when nothing names the entity', () => {
    const guid = 'a1b2c3d4-0000-4000-8000-000000001138';
    const e = getCurrentWorld().spawn(Transform(), EntityAttributes({ guid, layer: '3d' }));
    expect(entityDisplayName(e.id())).toBe(`Entity ${guid}`);
  });

  it('falls back to the runtime id only when there is no GUID either', () => {
    const e = getCurrentWorld().spawn(Transform());
    expect(entityDisplayName(e.id())).toBe(`Entity ${e.id()}`);
  });
});
