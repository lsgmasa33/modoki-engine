/** Tests for entity naming logic in getAllEntities. */

import { describe, it, expect } from 'vitest';
import { getCurrentWorld } from '@modoki/engine/runtime';
import { Transform, Renderable3D, Camera } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getAllEntities } from '@modoki/engine/runtime';
import { TestPhase, registerTestGameTraits } from './_fixtures/testGame';

registerAllTraits();
registerTestGameTraits();

describe('entity naming', () => {
  it('names camera entities "Game Camera"', () => {
    const entity = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      Camera(),
      Renderable3D({ mesh: 'camera', color: 0xff0000, size: 0.3 }),
    );
    const entities = getAllEntities();
    const found = entities.find((e) => e.id === entity.id());
    expect(found!.name).toBe('Game Camera');
  });

  it('names resource entities with "(resource)" suffix', () => {
    const entity = getCurrentWorld().spawn(TestPhase({ phase: 'game' }));
    const entities = getAllEntities();
    const found = entities.find((e) => e.id === entity.id());
    expect(found!.name).toContain('resource');
  });

  it('uses mesh name for renderable 3D entities', () => {
    const entity = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      Renderable3D({ mesh: 'my-custom-mesh', color: 0x00ff00, size: 1 }),
    );
    const entities = getAllEntities();
    const found = entities.find((e) => e.id === entity.id());
    expect(found!.name).toBe('my-custom-mesh');
  });

  it('falls back to "Entity {id}" when no string field', () => {
    const entity = getCurrentWorld().spawn(Transform({ x: 0, y: 0, z: 0 }));
    const entities = getAllEntities();
    const found = entities.find((e) => e.id === entity.id());
    expect(found!.name).toMatch(/Entity \d+/);
  });
});
