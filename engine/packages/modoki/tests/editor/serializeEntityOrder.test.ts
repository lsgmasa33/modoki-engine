/** QA-HIER-0002 — `serializeScene` writes entities in a STABLE order.
 *
 *  It used to write them in live-world iteration order, which follows runtime ECS
 *  ids. A delete+undo respawns the entity at a new id, and a duplicate+delete
 *  reassigns them, so the next save re-emitted byte-identical data in a different
 *  ARRAY ORDER — measured on `games/anim-bug` as a `main.scene.json` that stayed
 *  MODIFIED after a case restored its exact baseline: same guid set, zero entities
 *  whose content differed, one entity moved within the array.
 *
 *  The order is now the Hierarchy's: parents before children, siblings by
 *  `sortOrder`, guid as the tiebreak. These tests drive the REAL serializer against
 *  a real koota world (mirrors baseSceneSerialize.test.ts). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { setCurrentWorld, registerEntity, indexEntityGuid } from '../../src/runtime/core/ecs/world';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { serializeScene, setCurrentBaseScene } from '../../src/editor/scene/serialize';
import { setRunMode } from '../../src/runtime/core/playState';

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'enum' }, guid: { type: 'string' } },
  });
  registerTrait({
    name: 'Transform', trait: Transform, category: 'component',
    fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' } },
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
const spawnEntity = (name: string, guid: string, sortOrder: number, parentId = 0) =>
  spawn(EntityAttributes({ name, guid, sortOrder, parentId }), Transform);

const names = (scene: { entities: { name: string }[] }) => scene.entities.map((e) => e.name);

beforeEach(() => { registerAll(); freshWorld(); setCurrentBaseScene(undefined); });
afterEach(() => { setRunMode('playing', { advancing: true }); setCurrentBaseScene(undefined); });

describe('serializeScene entity order', () => {
  it('writes siblings by sortOrder, not by spawn/ECS-id order', async () => {
    spawnEntity('Third', 'g-3', 30);
    spawnEntity('First', 'g-1', 10);
    spawnEntity('Second', 'g-2', 20);
    expect(names(await serializeScene())).toEqual(['First', 'Second', 'Third']);
  });

  it('writes a parent immediately before its own subtree, depth-first', async () => {
    const a = spawnEntity('A', 'g-a', 10);
    const b = spawnEntity('B', 'g-b', 20);
    spawnEntity('B-child', 'g-bc', 0, b.id());
    spawnEntity('A-child', 'g-ac', 0, a.id());
    expect(names(await serializeScene())).toEqual(['A', 'A-child', 'B', 'B-child']);
  });

  it('breaks a sortOrder TIE on guid — not on the ecs id, which is what churned', async () => {
    // Colliding sortOrders are ordinary (legacy entities all sit at 0). Spawned in
    // descending guid order so an id tiebreak would produce the opposite result.
    spawnEntity('Zed', 'g-z', 0);
    spawnEntity('Mid', 'g-m', 0);
    spawnEntity('Ann', 'g-a', 0);
    expect(names(await serializeScene())).toEqual(['Ann', 'Mid', 'Zed']);
  });

  it('is INDEPENDENT of ecs ids: the same scene rebuilt in another spawn order serializes identically', async () => {
    // This is the actual regression — a delete+undo / duplicate+delete cycle reassigns
    // ids, and the file must not notice.
    const build = (order: number[]) => {
      const rows = [
        { name: 'HUD', guid: 'g-hud', sort: 20 },
        { name: 'Sphere', guid: 'g-sphere', sort: 10 },
        { name: 'Title', guid: 'g-title', sort: 30 },
      ];
      for (const i of order) spawnEntity(rows[i].name, rows[i].guid, rows[i].sort);
    };

    build([0, 1, 2]);
    const first = names(await serializeScene());

    freshWorld();
    build([2, 0, 1]); // same scene, entities respawned in a different order
    const second = names(await serializeScene());

    expect(second).toEqual(first);
    expect(first).toEqual(['Sphere', 'HUD', 'Title']);
  });
});
