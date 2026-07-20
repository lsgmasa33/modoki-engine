/** preview-mode-refactor Phase 2 — TRANSIENCE. Entities SPAWNED while the run-mode is not
 *  `stopped` (a scrub/preview/play spawn) are marked `Transient`; the REAL `serializeScene` must
 *  drop such an entity AND its whole subtree so a preview/scrub mutation never reaches disk.
 *
 *  This exercises the actual serializer against a real koota world + real trait registry (mirrors
 *  plainEntityRoundTrip.test.ts): authored entities survive; a Transient root and its child are
 *  both absent from the wire form — proving the leak is closed structurally, not by vigilance. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Transform } from '../../src/runtime/traits/Transform';
import { Transient } from '../../src/runtime/traits/Transient';
import { setCurrentWorld, registerEntity, indexEntityGuid } from '../../src/runtime/ecs/world';
import { registerTrait } from '../../src/runtime/ecs/traitRegistry';
import { serializeScene } from '../../src/editor/scene/serialize';
import { setRunMode } from '../../src/runtime/systems/playState';

const Health = trait({ hp: 100 });

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: {}, isActive: {}, sortOrder: {}, parentId: {}, layer: {}, guid: {} },
  });
  registerTrait({
    name: 'Transform', trait: Transform, category: 'component',
    fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} },
  });
  registerTrait({ name: 'Health', trait: Health, category: 'component', fields: { hp: {} } });
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

beforeEach(() => { registerAll(); freshWorld(); });
afterEach(() => { setRunMode('playing', { advancing: true }); }); // restore runtime default

describe('serializeScene skips Transient subtrees (Phase 2)', () => {
  it('drops a Transient root AND its child; keeps authored entities', async () => {
    const authored = spawn(EntityAttributes({ name: 'Authored', guid: 'g-authored' }), Transform, Health({ hp: 42 }));

    // A control-track spawn during scrub: a root marked Transient + a child under it (parented by
    // the root's live id, the way spawnPrefabInstance builds a subtree).
    const tRoot = spawn(EntityAttributes({ name: 'ScrubSpawn', guid: 'g-troot' }), Transform, Transient);
    spawn(EntityAttributes({ name: 'ScrubSpawnChild', guid: 'g-tchild', parentId: tRoot.id() }), Transform);

    const scene = await serializeScene();
    const names = scene.entities.map((e) => e.name);
    expect(names).toContain('Authored');
    expect(names).not.toContain('ScrubSpawn');      // Transient root dropped
    expect(names).not.toContain('ScrubSpawnChild'); // and its whole subtree
    expect(scene.entities).toHaveLength(1);
  });

  it('with no Transient entities, serialization is unchanged (all authored entities present)', async () => {
    spawn(EntityAttributes({ name: 'A', guid: 'g-a' }), Transform);
    spawn(EntityAttributes({ name: 'B', guid: 'g-b' }), Transform);
    const scene = await serializeScene();
    expect(scene.entities.map((e) => e.name).sort()).toEqual(['A', 'B']);
  });
});
