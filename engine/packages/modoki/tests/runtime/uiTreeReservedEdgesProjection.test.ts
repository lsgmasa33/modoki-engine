/** The projection seam for reserved edge bands (#1159).
 *
 *  `reservedEdges.test.tsx` feeds `resolveReservedEdges` hand-built `UINodeData`, so it cannot see
 *  the two coercing lines in `buildTree` that carry `UIAnchor.reservesEdge`/`clearsReservedEdges`
 *  across the ECS boundary, nor that `uiTreeProjection` actually publishes the result to the store
 *  `UIRenderer` reads. Renaming either field on the trait would drop every dialog's banner
 *  clearance with that file still green. Modeled on `uiTreeSwallowProjection.test.ts`: a REAL
 *  koota world, real traits, the real projection. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes, RenderableUI, UIAnchor, UIElement } from '../../src/runtime/traits';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { uiTreeProjection, useUITreeStore, markUIDirty } from '../../src/runtime/ui/uiTreeStore';
import { deactivatedEntities } from '../../src/runtime/core/ecs/transformPropagationSystem';

registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {} } as any);
registerTrait({ name: 'RenderableUI', trait: RenderableUI, category: 'component', fields: {} } as any);
registerTrait({ name: 'UIElement', trait: UIElement, category: 'component', fields: {} } as any);
registerTrait({ name: 'UIAnchor', trait: UIAnchor, category: 'component', fields: {} } as any);

let world: ReturnType<typeof createWorld>;

beforeEach(() => {
  world = createWorld();
  setCurrentWorld(world);
});

afterEach(() => {
  world.destroy();
  deactivatedEntities.clear();
  useUITreeStore.setState({ tree: [], reserveTop: '0px', reserveBottom: '0px' });
});

function spawnStrip(name: string, anchor: Record<string, unknown>, ui: Record<string, unknown> = {}) {
  return world.spawn(
    RenderableUI,
    UIElement({ width: 100, height: 9.1, ...ui }),
    UIAnchor({ safeArea: false, ...anchor } as any),
    EntityAttributes({ name, parentId: 0, isActive: true, layer: 'ui' }),
  );
}

function project() {
  markUIDirty();
  uiTreeProjection(world as any);
  return useUITreeStore.getState();
}

describe('uiTreeStore projection seam — reserved edge bands (#1159)', () => {
  it('a reservesEdge banner is published to the store as the bottom band', () => {
    spawnStrip('AdBannerSlot', { anchor: 'bottom-stretch', pivotY: 1, reservesEdge: true });
    const s = project();
    expect(s.reserveBottom).toBe('calc(9.1 * var(--ui-vh, 1vh))');
    expect(s.reserveTop).toBe('0px');
  });

  it('the same strip without the flag publishes nothing', () => {
    spawnStrip('AdBannerSlot', { anchor: 'bottom-stretch', pivotY: 1 });
    expect(project().reserveBottom).toBe('0px');
  });

  it('hiding the banner drops the band on the next rebuild', () => {
    const e = spawnStrip('AdBannerSlot', { anchor: 'bottom-stretch', pivotY: 1, reservesEdge: true });
    expect(project().reserveBottom).not.toBe('0px');
    e.set(UIElement, { ...e.get(UIElement)!, isVisible: false });
    expect(project().reserveBottom).toBe('0px');
  });

  it('carries clearsReservedEdges onto the projected anchor, where applyAnchorStyle reads it', () => {
    const dlg = spawnStrip('Dialog', { anchor: 'stretch', safeArea: true, clearsReservedEdges: true }, { height: 100 });
    const node = project().tree.find((n: any) => n.entityId === dlg.id()) as any;
    expect(node.anchor.clearsReservedEdges).toBe(true);
    expect(node.anchor.reservesEdge).toBe(false);
  });
});
