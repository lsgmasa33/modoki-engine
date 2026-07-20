/** Entity active-flag cascade — INTEGRATION test.
 *
 *  Exercises the WHOLE UI pipeline end-to-end against a real koota world, not a
 *  mock: real EntityAttributes/RenderableUI/UIElement traits → the real
 *  transformPropagationSystem (which computes the deactivatedEntities parent-chain
 *  cascade) → the real uiTreeProjection (buildTree) → the Zustand uiTreeStore →
 *  useUIEntities → the real UIRenderer → the real UINode → the actual DOM.
 *
 *  The contract under test: toggling EntityAttributes.isActive=false on a parent
 *  drops the parent AND its whole descendant subtree (child + grandchild) from the
 *  rendered DOM, while unrelated sibling roots keep rendering; reactivating restores
 *  the subtree. This is the DOM-level twin of the buildTree unit tests in
 *  uiTreeStore.test.ts. Only the leaf side-effect deps of UINode (image-variant URL
 *  resolution, store bindings) are stubbed — the same isolation uiNode.test.tsx uses
 *  — so nothing in the active-flag path is mocked away.
 */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { vi } from 'vitest';

// Leaf deps of UINode — stubbed exactly as uiNode.test.tsx does. None of these touch
// the active-flag / cascade logic; they only keep the render hermetic (no asset URL
// resolution, no real Zustand game store, no Canvas2D mount).
vi.mock('../../src/runtime/rendering/renderUtils', () => ({
  resolveDomImageUrl: (ref: string) => `variant:${ref}`,
  resolveSprite: () => undefined,
}));
vi.mock('../../src/runtime/ui/bindings', () => ({ applyBindings: () => {} }));
vi.mock('../../src/runtime/ui/bindingResolver', () => ({ resolveTemplate: (t: string) => t }));
vi.mock('../../src/runtime/rendering/Canvas2DMount', () => ({
  Canvas2DMount: ({ entityId }: { entityId: number }) =>
    React.createElement('div', { 'data-testid': 'canvas2dmount', 'data-entity-id': entityId }),
}));

import { createWorld } from 'koota';
import { Transform, EntityAttributes, RenderableUI, UIElement } from '../../src/runtime/traits';
import { registerTrait } from '../../src/runtime/ecs/traitRegistry';
import { setCurrentWorld } from '../../src/runtime/ecs/world';
import { transformPropagationSystem, deactivatedEntities } from '../../src/three/systems/transformPropagationSystem';
import { uiTreeProjection, markUIDirty } from '../../src/runtime/ui/uiTreeStore';
import { UIRenderer } from '../../src/runtime/ui/UIRenderer';

// jsdom lacks ResizeObserver (UIRenderer observes its container). Minimal no-op stub.
class NoopRO { observe() {} disconnect() {} unobserve() {} }

// Register the real traits so buildTree's name→meta lookup resolves to the SAME koota
// trait objects transformPropagationSystem imports directly. Once per file is enough.
registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: {} } as any);
registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {} } as any);
registerTrait({ name: 'RenderableUI', trait: RenderableUI, category: 'component', fields: {} } as any);
registerTrait({ name: 'UIElement', trait: UIElement, category: 'component', fields: {} } as any);

let world: ReturnType<typeof createWorld>;

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopRO;
  world = createWorld();
  setCurrentWorld(world);
});

afterEach(() => {
  cleanup();
  world.destroy();
  deactivatedEntities.clear();
});

/** Spawn a UI entity (root or child). parentId is the NUMERIC parent entity id
 *  (0 = root) — the same form the loader resolves GUIDs into at load time. */
function spawnUI(name: string, parentId: number, text: string) {
  return world.spawn(
    RenderableUI,
    UIElement({ text, width: 100, height: 40 }),
    EntityAttributes({ name, parentId, isActive: true, layer: 'ui' }),
  );
}

/** Drive one full engine frame's worth of the UI pipeline: recompute the
 *  deactivation cascade, then rebuild the projected tree. markUIDirty forces the
 *  rebuild (an isActive edit dirties the tree in the real app the same way). Wrapped
 *  in act() so the resulting Zustand store update flushes into the rendered DOM (the
 *  real app re-renders on the same store change; in tests React must be told to). */
function pump() {
  act(() => {
    transformPropagationSystem(world);
    markUIDirty();
    uiTreeProjection(world);
  });
}

/** entityIds present in the rendered DOM (every UINode stamps data-entity-id). */
function renderedIds(container: HTMLElement): Set<number> {
  return new Set(
    Array.from(container.querySelectorAll('[data-entity-id]')).map(
      (el) => Number((el as HTMLElement).dataset.entityId),
    ),
  );
}

describe('entity active-flag cascade (integration: ECS → transform → projection → DOM)', () => {
  it('deactivating a parent drops its child + grandchild from the DOM; siblings stay', () => {
    const panel = spawnUI('Panel', 0, 'Panel');          // root
    const row = spawnUI('Row', panel.id(), 'Row');        // child of Panel
    const label = spawnUI('Label', row.id(), 'Label');    // grandchild
    const other = spawnUI('Other', 0, 'Other');           // unrelated sibling root

    pump();
    const { container } = render(<UIRenderer />);

    // Baseline: the whole tree renders.
    let ids = renderedIds(container);
    expect(ids.has(panel.id())).toBe(true);
    expect(ids.has(row.id())).toBe(true);
    expect(ids.has(label.id())).toBe(true);
    expect(ids.has(other.id())).toBe(true);

    // Deactivate the PARENT.
    panel.set(EntityAttributes, { ...panel.get(EntityAttributes)!, isActive: false });
    pump();

    // The cascade must put the parent AND every descendant into deactivatedEntities…
    expect(deactivatedEntities.has(panel.id())).toBe(true);
    expect(deactivatedEntities.has(row.id())).toBe(true);
    expect(deactivatedEntities.has(label.id())).toBe(true);
    expect(deactivatedEntities.has(other.id())).toBe(false);

    // …and they must all be gone from the DOM, sibling untouched.
    ids = renderedIds(container);
    expect(ids.has(panel.id())).toBe(false);
    expect(ids.has(row.id())).toBe(false);
    expect(ids.has(label.id())).toBe(false);
    expect(ids.has(other.id())).toBe(true);
  });

  it('reactivating the parent restores the whole subtree in the DOM', () => {
    const panel = spawnUI('Panel', 0, 'Panel');
    const row = spawnUI('Row', panel.id(), 'Row');
    const label = spawnUI('Label', row.id(), 'Label');

    panel.set(EntityAttributes, { ...panel.get(EntityAttributes)!, isActive: false });
    pump();
    const { container } = render(<UIRenderer />);
    expect(renderedIds(container).size).toBe(0); // whole tree hidden

    panel.set(EntityAttributes, { ...panel.get(EntityAttributes)!, isActive: true });
    pump();

    const ids = renderedIds(container);
    expect(ids.has(panel.id())).toBe(true);
    expect(ids.has(row.id())).toBe(true);
    expect(ids.has(label.id())).toBe(true);
  });

  it('deactivating a leaf grandchild removes only it; parent + child remain', () => {
    const panel = spawnUI('Panel', 0, 'Panel');
    const row = spawnUI('Row', panel.id(), 'Row');
    const label = spawnUI('Label', row.id(), 'Label');

    pump();
    const { container } = render(<UIRenderer />);
    expect(renderedIds(container).has(label.id())).toBe(true);

    label.set(EntityAttributes, { ...label.get(EntityAttributes)!, isActive: false });
    pump();

    const ids = renderedIds(container);
    expect(ids.has(panel.id())).toBe(true);
    expect(ids.has(row.id())).toBe(true);
    expect(ids.has(label.id())).toBe(false);
  });
});
