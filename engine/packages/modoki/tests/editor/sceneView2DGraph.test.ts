/** #1220 — SceneView's 2D graph memos (routing maps + paint order) must not serve a dead entity's row
 *  to the entity koota spawns next on the same index.
 *
 *  Real koota world, real `spawnEntity`/`destroyEntity`, real version counters: the defect was that
 *  NOTHING the memo keyed on moved across a spawn or a destroy, so a mock of any of those would pass
 *  with the defect in place. The 2D dirty listeners are wired as the editor wires them
 *  (`ensureCanvas2DListeners`) so the tests run against the real key, not a quieter one. */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { setCurrentWorld, spawnEntity, destroyEntity } from '../../src/runtime/core/ecs/world';
import { registerTrait, getAllTraits } from '../../src/runtime/core/ecs/traitRegistry';
import { writeTraitField } from '../../src/runtime/core/ecs/entityUtils';
import { Renderable2D } from '../../src/runtime/traits/Renderable2D';
import { ensureCanvas2DListeners } from '../../src/editor/store/canvas2DDirty';
import { getCanvas2DRouting, getPaintOrder, _resetSceneView2DGraph } from '../../src/editor/panels/sceneView2DGraph';

function freshWorld() {
  const w = createWorld();
  setCurrentWorld(w);
  return w;
}

beforeEach(() => {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: { type: 'string' }, sortOrder: { type: 'number' }, parentId: { type: 'number' } },
  });
  registerTrait({
    name: 'Renderable2D', trait: Renderable2D, category: 'component',
    fields: { orderInLayer: { type: 'number' } },
  });
  ensureCanvas2DListeners();
  _resetSceneView2DGraph();
});

describe('sceneView2DGraph — recycled koota index (#1220)', () => {
  it('a respawn on a recycled index reads the NEWCOMER\'s parent and paint rank, not the dead entity\'s', () => {
    const w = freshWorld();
    const anchor = spawnEntity(w, EntityAttributes({ name: 'anchor', sortOrder: 0, parentId: 0 }));
    const dead = spawnEntity(w, EntityAttributes({ name: 'dead', sortOrder: 5, parentId: 0 }));
    const deadId = dead.id();

    // Warm both memos: dead paints AFTER anchor (sortOrder 5 > 0) under the root.
    expect(getCanvas2DRouting().parentOf.get(deadId)).toBe(0);
    expect(getPaintOrder().get(deadId)!).toBeGreaterThan(getPaintOrder().get(anchor.id())!);

    destroyEntity(dead, w);
    // The newcomer takes the same index with sortOrder -5, so it paints BEFORE anchor.
    const newcomer = spawnEntity(w, EntityAttributes({ name: 'newcomer', sortOrder: -5, parentId: 0 }));
    expect(newcomer.id()).toBe(deadId); // the premise: koota recycled the index

    const routing = getCanvas2DRouting();
    expect(routing.sortOrderOf.get(deadId)).toBe(-5);
    expect(getPaintOrder().get(deadId)!).toBeLessThan(getPaintOrder().get(anchor.id())!);
  });

  it('a respawn on a recycled index reads the newcomer\'s PARENT', () => {
    const w = freshWorld();
    const root = spawnEntity(w, EntityAttributes({ name: 'root', parentId: 0 }));
    const dead = spawnEntity(w, EntityAttributes({ name: 'dead', parentId: 0 }));
    const deadId = dead.id();
    expect(getCanvas2DRouting().parentOf.get(deadId)).toBe(0);

    destroyEntity(dead, w);
    const newcomer = spawnEntity(w, EntityAttributes({ name: 'newcomer', parentId: root.id() }));
    expect(newcomer.id()).toBe(deadId);

    expect(getCanvas2DRouting().parentOf.get(deadId)).toBe(root.id());
  });

  it('a destroy with no respawn drops the dead entity\'s row', () => {
    const w = freshWorld();
    spawnEntity(w, EntityAttributes({ name: 'stays' }));
    const dead = spawnEntity(w, EntityAttributes({ name: 'dead', parentId: 0 }));
    const deadId = dead.id();
    expect(getCanvas2DRouting().parentOf.has(deadId)).toBe(true);
    expect(getPaintOrder().has(deadId)).toBe(true);

    destroyEntity(dead, w);

    expect(getCanvas2DRouting().parentOf.has(deadId)).toBe(false);
    expect(getPaintOrder().has(deadId)).toBe(false);
  });

  it('a static scene reuses one build (the memo still memoizes)', () => {
    const w = freshWorld();
    spawnEntity(w, EntityAttributes({ name: 'a' }));
    const routing = getCanvas2DRouting();
    const order = getPaintOrder();
    expect(getCanvas2DRouting()).toBe(routing);
    expect(getPaintOrder()).toBe(order);
  });

  it('a world swap rebuilds, though it spawns and destroys nothing (the 2D dirty half of the key)', () => {
    // A swap back to an existing world registers nothing, so the structure version stays put; only the
    // swap listener ensureCanvas2DListeners wires moves the key.
    const a = freshWorld();
    const onlyInA = spawnEntity(a, EntityAttributes({ name: 'onlyInA', sortOrder: 3 }));
    const b = createWorld();
    const onlyInB = spawnEntity(b, EntityAttributes({ name: 'onlyInB', sortOrder: 7 }));
    spawnEntity(b, EntityAttributes({ name: 'secondInB', sortOrder: 8 }));
    // Each world's first entity: the ids can coincide, so only a VALUE tells the worlds apart — the
    // sortOrder for routing, and the entry count for paint order (A has one entity, B has two).
    // Stamp both memos from world A AFTER every spawn, so the structure version is final.
    expect(getCanvas2DRouting().sortOrderOf.get(onlyInA.id())).toBe(3);
    expect(getPaintOrder().size).toBe(1);

    setCurrentWorld(b);

    expect(getCanvas2DRouting().sortOrderOf.get(onlyInB.id())).toBe(7);
    expect(getPaintOrder().size).toBe(2);
  });

  it('an Inspector-style orderInLayer write re-ranks the paint order (a 2D-dirty bump, no structure bump)', () => {
    // writeTraitField on Renderable2D fires the dirty listeners but is not an EntityAttributes
    // structure field, so ONLY the 2D dirty version moves — the half of the key this test pins for
    // paint order (the swap test pins it for routing).
    const w = freshWorld();
    const back = spawnEntity(w, EntityAttributes({ name: 'back', sortOrder: 0 }), Renderable2D());
    const front = spawnEntity(w, EntityAttributes({ name: 'front', sortOrder: 1 }), Renderable2D());
    expect(getPaintOrder().get(back.id())!).toBeLessThan(getPaintOrder().get(front.id())!);

    const r2d = getAllTraits().find(m => m.name === 'Renderable2D')!;
    writeTraitField(back.id(), r2d, 'orderInLayer', 5);

    expect(getPaintOrder().get(back.id())!).toBeGreaterThan(getPaintOrder().get(front.id())!);
  });
});
