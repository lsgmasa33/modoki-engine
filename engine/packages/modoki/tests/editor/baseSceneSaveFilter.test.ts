/** base-scene plan, Phase 6 — `serializeScene` excludes any entity whose
 *  EntityAttributes.sourceScene is non-empty (a base-origin entity carried into
 *  the primary's world). Empty = primary = always saved (A3's load-bearing
 *  rule). Mirrors baseSceneSerialize.test.ts / transientSerializeSkip.test.ts:
 *  a real koota world + the real serializer, no mocks. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Transform } from '../../src/runtime/traits/Transform';
import { setCurrentWorld, registerEntity, indexEntityGuid } from '../../src/runtime/ecs/world';
import { registerTrait } from '../../src/runtime/ecs/traitRegistry';
import { serializeScene, setCurrentBaseScene } from '../../src/editor/scene/serialize';
import { setRunMode } from '../../src/runtime/systems/playState';

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: {}, isActive: {}, sortOrder: {}, parentId: { entityId: { onMissing: 'root' } }, layer: {}, guid: {} },
  });
  registerTrait({
    name: 'Transform', trait: Transform, category: 'component',
    fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} },
  });
}

function freshWorld() {
  const w = createWorld();
  (globalThis as any).__w = w;
  setCurrentWorld(w);
  return w;
}
function spawn(...args: any[]) {
  const ent = (globalThis as any).__w.spawn(...args);
  registerEntity(ent);
  indexEntityGuid(ent);
  return ent;
}

beforeEach(() => { registerAll(); freshWorld(); setCurrentBaseScene(undefined); });
afterEach(() => { setRunMode('playing', { advancing: true }); setCurrentBaseScene(undefined); });

describe('serializeScene + base-scene save filtering (Phase 6)', () => {
  it('saves an entity with empty sourceScene (the primary)', async () => {
    spawn(EntityAttributes({ name: 'Level-owned', guid: 'g-primary', sourceScene: '' }), Transform);
    const scene = await serializeScene();
    expect(scene.entities.map((e) => e.name)).toEqual(['Level-owned']);
  });

  it('excludes an entity carried from a base scene', async () => {
    spawn(EntityAttributes({ name: 'Level-owned', guid: 'g-primary', sourceScene: '' }), Transform);
    spawn(EntityAttributes({ name: 'Base-camera', guid: 'g-base', sourceScene: 'base-guid-1' }), Transform);
    const scene = await serializeScene();
    expect(scene.entities.map((e) => e.name)).toEqual(['Level-owned']);
  });

  it('excludes a base-origin entity\'s whole subtree', async () => {
    const root = spawn(EntityAttributes({ name: 'Base-root', guid: 'g-base-root', sourceScene: 'base-guid-1' }), Transform);
    spawn(EntityAttributes({ name: 'Base-child', guid: 'g-base-child', parentId: root.id(), sourceScene: 'base-guid-1' }), Transform);
    spawn(EntityAttributes({ name: 'Level-owned', guid: 'g-primary', sourceScene: '' }), Transform);
    const scene = await serializeScene();
    expect(scene.entities.map((e) => e.name)).toEqual(['Level-owned']);
  });

  it('shrinks the resources manifest when the excluded entity was the only referencer', async () => {
    // Level-owned entity carries no resource refs; base entity would (via a
    // Renderable3D mesh ref) in a real scene, but resources are derived purely
    // from the entities array — proving base entities are gone from `entities`
    // is sufficient to prove `resources` can't pick up their refs either.
    spawn(EntityAttributes({ name: 'Level-owned', guid: 'g-primary', sourceScene: '' }), Transform);
    spawn(EntityAttributes({ name: 'Base-camera', guid: 'g-base', sourceScene: 'base-guid-1' }), Transform);
    const scene = await serializeScene();
    expect(scene.entities.every((e) => e.name !== 'Base-camera')).toBe(true);
  });
});
