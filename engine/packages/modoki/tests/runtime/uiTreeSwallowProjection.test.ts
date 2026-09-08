/** The projection seam for `UIElement.swallowClicks` / `pointerThrough` (#728).
 *
 *  `uiTreeStore.ts`'s buildTree carries both fields across the ECS → projection boundary with
 *  a single coercing line each (`ui.swallowClicks === true`, `ui.pointerThrough === true`).
 *  Every existing `UINode` test constructs a `UINodeData` literal directly and never goes
 *  through `buildTree`, and the two games' `sceneChrome.test.ts` files read raw scene JSON
 *  without building a world — so nothing in `verify` exercised this line: renaming its source
 *  field (`ui.swallowClicks` → `ui.swallowClick`) would silently drop the swallow from all
 *  thirteen dialogs migrated off the old no-op-binding workaround, with every test still green.
 *
 *  Modeled on `uiActiveCascade.integration.test.tsx`: a REAL koota world, real traits, the real
 *  `uiTreeProjection` (buildTree) — no hand-rolled mock world. Unlike that file this one reads
 *  the projected node straight off `useUITreeStore`, since the field under test is data on the
 *  node, not a DOM/rendering concern — no React render needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes, RenderableUI, UIElement } from '../../src/runtime/traits';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { uiTreeProjection, useUITreeStore, markUIDirty } from '../../src/runtime/ui/uiTreeStore';
import { deactivatedEntities } from '../../src/runtime/core/ecs/transformPropagationSystem';

// Register the real traits so buildTree's name→meta lookup resolves to the SAME koota trait
// objects this file spawns entities with. Once per file is enough.
registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {} } as any);
registerTrait({ name: 'RenderableUI', trait: RenderableUI, category: 'component', fields: {} } as any);
registerTrait({ name: 'UIElement', trait: UIElement, category: 'component', fields: {} } as any);

let world: ReturnType<typeof createWorld>;

beforeEach(() => {
  world = createWorld();
  setCurrentWorld(world);
});

afterEach(() => {
  world.destroy();
  deactivatedEntities.clear();
});

/** Spawn a root UI entity, optionally authoring swallowClicks/pointerThrough. A UI entity
 *  needs the RenderableUI tag or it renders nothing — see uiActiveCascade's spawnUI. */
function spawnUI(name: string, ui: Record<string, unknown> = {}) {
  return world.spawn(
    RenderableUI,
    UIElement({ text: name, width: 100, height: 40, ...ui }),
    EntityAttributes({ name, parentId: 0, isActive: true, layer: 'ui' }),
  );
}

/** Run the real projection and hand back the projected node for the given entity. */
function projectNode(entityId: number) {
  markUIDirty();
  uiTreeProjection(world as any);
  return useUITreeStore.getState().tree.find((n: any) => n.entityId === entityId) as any;
}

describe('uiTreeStore projection seam — swallowClicks / pointerThrough (#728)', () => {
  it('carries an authored swallowClicks:true through to the projected node', () => {
    const e = spawnUI('Backdrop', { swallowClicks: true });
    const node = projectNode(e.id());
    expect(node, 'projection produced no node for the spawned entity').toBeTruthy();
    expect(node.swallowClicks).toBe(true);
  });

  it('carries an authored pointerThrough:true through to the projected node', () => {
    const e = spawnUI('Decorative', { pointerThrough: true });
    const node = projectNode(e.id());
    expect(node.pointerThrough).toBe(true);
  });

  it('defaults BOTH fields to false (not undefined) when neither is authored', () => {
    // The common case in production: a scene save strips default-valued fields, so most UI
    // entities reach buildTree with neither field present on the trait at all.
    const e = spawnUI('Plain');
    const node = projectNode(e.id());
    expect(node.swallowClicks).toBe(false);
    expect(node.pointerThrough).toBe(false);
  });
});
