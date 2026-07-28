/** base-scene plan, Phase 1 — `serializeScene` emits the top-level `baseScene` ref
 *  it was told about via `setCurrentBaseScene` (A3: this is editor module state,
 *  like `_currentScenePath`, with no other path back into the serialized JSON —
 *  see `editor/scene/serialize.ts`). Exercises the REAL serializer against a real
 *  koota world + real trait registry (mirrors transientSerializeSkip.test.ts). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { setCurrentWorld, registerEntity, indexEntityGuid } from '../../src/runtime/core/ecs/world';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { serializeScene, setCurrentBaseScene, getCurrentBaseScene } from '../../src/editor/scene/serialize';
import { setRunMode } from '../../src/runtime/core/playState';

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

describe('serializeScene + baseScene tracking (Phase 1)', () => {
  it('omits baseScene entirely when none is set', async () => {
    spawn(EntityAttributes({ name: 'A', guid: 'g-a' }), Transform);
    const scene = await serializeScene();
    expect(scene.baseScene).toBeUndefined();
    expect('baseScene' in scene).toBe(false);
  });

  it('emits the base ref set via setCurrentBaseScene', async () => {
    spawn(EntityAttributes({ name: 'A', guid: 'g-a' }), Transform);
    setCurrentBaseScene('base-scene-guid-1');
    expect(getCurrentBaseScene()).toBe('base-scene-guid-1');
    const scene = await serializeScene();
    expect(scene.baseScene).toBe('base-scene-guid-1');
  });

  it('reverts to omitted after clearing the base ref', async () => {
    spawn(EntityAttributes({ name: 'A', guid: 'g-a' }), Transform);
    setCurrentBaseScene('base-scene-guid-1');
    setCurrentBaseScene(undefined);
    const scene = await serializeScene();
    expect('baseScene' in scene).toBe(false);
  });
});
