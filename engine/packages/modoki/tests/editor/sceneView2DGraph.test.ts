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
import { Text2D } from '../../src/runtime/traits/Text2D';
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
  // Registered because the real editor registers it and exposes orderInLayer in the Inspector
  // (registerTraits.ts) — which is what made #1228 authorable from the UI. Note the routing build
  // does NOT reach Text2D through this registry: `collectOrderInLayer` imports the trait directly.
  registerTrait({
    name: 'Text2D', trait: Text2D, category: 'component',
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

describe('sceneView2DGraph — Text2D.orderInLayer is honoured, matching the runtime (#1228)', () => {
  /** The defect: SceneView collected orderInLayer from Renderable2D ONLY, while the runtime
   *  collected it from Renderable2D AND Text2D. Both fed the same computePaintOrder, so the
   *  divergence lived entirely in the two private collections. The visible symptom was the pick:
   *  SceneView ranks overlapping candidates by this map, so a label the game draws on top lost
   *  the click to the sprite underneath.
   *
   *  These drive the REAL editor entry point (`getPaintOrder()`, through its real memo) rather
   *  than re-deriving the order from the shared helper — comparing the helper against itself
   *  would be a constant-vs-constant assertion that stays green with the fix removed. */

  it('a label ordered above a sprite via Text2D.orderInLayer outranks it, though the sprite is LATER in the hierarchy', () => {
    const w = freshWorld();
    // The exact pair from the issue. Hierarchy alone puts the sprite on top (sortOrder 1 > 0); only
    // the Text2D.orderInLayer override can invert that, so this cannot pass on tree position.
    const label = spawnEntity(w, EntityAttributes({ name: 'label', sortOrder: 0 }), Text2D({ orderInLayer: 5 }));
    const sprite = spawnEntity(w, EntityAttributes({ name: 'sprite', sortOrder: 1 }), Renderable2D({ orderInLayer: 0 }));

    expect(
      getPaintOrder().get(label.id())!,
      'the Text2D label must outrank the sprite — this is the rank SceneView\'s 2D pick uses to '
      + 'choose between overlapping candidates, so a lower one hands the click to the sprite',
    ).toBeGreaterThan(getPaintOrder().get(sprite.id())!);
  });

  it('without the override, hierarchy order still decides — the re-rank is not unconditional', () => {
    // The accept side. A guard that inverted every pair would pass the test above; this pins that
    // an unset orderInLayer leaves the pure-hierarchy order alone.
    const w = freshWorld();
    const label = spawnEntity(w, EntityAttributes({ name: 'label', sortOrder: 0 }), Text2D({ orderInLayer: 0 }));
    const sprite = spawnEntity(w, EntityAttributes({ name: 'sprite', sortOrder: 1 }), Renderable2D({ orderInLayer: 0 }));

    expect(getPaintOrder().get(label.id())!).toBeLessThan(getPaintOrder().get(sprite.id())!);
  });

  it('an Inspector-style Text2D.orderInLayer write re-ranks the paint order (the memo key covers it)', () => {
    // The Text2D twin of the Renderable2D case above. #1228 predicted the memo key already covers
    // this because ensureCanvas2DListeners subscribes a GENERIC dirty listener rather than a
    // field-specific one; this is what pins that prediction rather than assuming it.
    const w = freshWorld();
    const back = spawnEntity(w, EntityAttributes({ name: 'back', sortOrder: 0 }), Text2D());
    const front = spawnEntity(w, EntityAttributes({ name: 'front', sortOrder: 1 }), Renderable2D());
    expect(getPaintOrder().get(back.id())!).toBeLessThan(getPaintOrder().get(front.id())!);

    const t2d = getAllTraits().find(m => m.name === 'Text2D')!;
    writeTraitField(back.id(), t2d, 'orderInLayer', 5);

    expect(getPaintOrder().get(back.id())!).toBeGreaterThan(getPaintOrder().get(front.id())!);
  });
});
