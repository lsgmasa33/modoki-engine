/** moveEntityToScene + serializeScene round-trip — base-scene-and-persistence-
 *  plan.md Phase 14's actual proof: a promote/demote must be reflected by the
 *  REAL serializer (both the default primary-targeted call and the Phase 12
 *  named-base-targeted call), and undo must return both to their pre-move
 *  contents. Real world + real trait registry + real entityActions.ts + real
 *  serialize.ts — no mocks (mirrors baseSceneTargetSerialize.test.ts). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Transform } from '../../src/runtime/traits/Transform';
import { setCurrentWorld, registerEntity, indexEntityGuid } from '../../src/runtime/ecs/world';
import { registerTrait } from '../../src/runtime/ecs/traitRegistry';
import { serializeScene } from '../../src/editor/scene/serialize';
import { moveEntityToScene, setActionCallback } from '../../src/editor/undo/entityActions';
import { setRunMode } from '../../src/runtime/systems/playState';

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: {}, isActive: {}, sortOrder: {}, parentId: { entityId: { onMissing: 'root' } }, layer: {}, guid: {}, sourceScene: { hidden: true, runtimeOnly: true } },
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

let pushed: { undo: () => void; redo: () => void }[] = [];

beforeEach(() => {
  registerAll();
  freshWorld();
  pushed = [];
  setActionCallback((a: any) => pushed.push(a));
});
afterEach(() => { setRunMode('playing', { advancing: true }); });

const BASE = 'base-guid-1';

describe('moveEntityToScene + serializeScene round-trip (Phase 14)', () => {
  it('after promote, serializeScene({scene: base}) contains the subtree', async () => {
    const root = spawn(EntityAttributes({ name: 'HeartsRoot', guid: 'g-hearts', sourceScene: '' }), Transform);
    spawn(EntityAttributes({ name: 'PrimaryOther', guid: 'g-other', sourceScene: '' }), Transform);

    moveEntityToScene(root.id(), BASE);

    const baseScene = await serializeScene({ scene: { path: '/assets/scenes/Base.json', guid: BASE } });
    expect(baseScene.entities.map((e) => e.name)).toEqual(['HeartsRoot']);
  });

  it('after promote, the default serializeScene() (primary) no longer contains it', async () => {
    const root = spawn(EntityAttributes({ name: 'HeartsRoot', guid: 'g-hearts', sourceScene: '' }), Transform);
    spawn(EntityAttributes({ name: 'PrimaryOther', guid: 'g-other', sourceScene: '' }), Transform);

    moveEntityToScene(root.id(), BASE);

    const primary = await serializeScene();
    expect(primary.entities.map((e) => e.name)).toEqual(['PrimaryOther']);
  });

  it('undo returns both serializations to their pre-move contents', async () => {
    const root = spawn(EntityAttributes({ name: 'HeartsRoot', guid: 'g-hearts', sourceScene: '' }), Transform);
    spawn(EntityAttributes({ name: 'PrimaryOther', guid: 'g-other', sourceScene: '' }), Transform);

    moveEntityToScene(root.id(), BASE);
    pushed[0].undo();

    const primary = await serializeScene();
    expect(primary.entities.map((e) => e.name).sort()).toEqual(['HeartsRoot', 'PrimaryOther']);
    const baseScene = await serializeScene({ scene: { path: '/assets/scenes/Base.json', guid: BASE } });
    expect(baseScene.entities).toEqual([]);
  });

  it('demote is the mirror for both serializations', async () => {
    const root = spawn(EntityAttributes({ name: 'BaseThing', guid: 'g-bt', sourceScene: BASE }), Transform);

    moveEntityToScene(root.id(), '');

    const primary = await serializeScene();
    expect(primary.entities.map((e) => e.name)).toEqual(['BaseThing']);
    const baseScene = await serializeScene({ scene: { path: '/assets/scenes/Base.json', guid: BASE } });
    expect(baseScene.entities).toEqual([]);
  });
});
