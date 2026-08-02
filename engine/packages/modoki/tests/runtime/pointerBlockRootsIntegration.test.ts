/** Pointer-block roots — REAL pointerSource + REAL consumer components, wired together.
 *
 *  Every other test proves one half of this: `pointerSource.test.ts`'s block-root suite
 *  proves the source respects a manually-registered plain `<div>`; `uiRenderer.test.tsx` and
 *  `debugMenu.test.tsx` (engine/tests/ui/) prove each component calls `registerPointerBlocker`
 *  at the right lifecycle moment, via the `isPointerBlocked` predicate directly. Neither proves
 *  the two halves actually work TOGETHER — that a real `pointerdown` dispatched on the real
 *  rendered DOM these components produce is actually swallowed by the real, attached
 *  `pointerSource`. Only the e2e suite (`game-view-pointer-block.spec.ts`) exercises that full
 *  path today, and only for `UIRenderer`; this file gets the same proof, for `UIRenderer` AND
 *  `DebugMenu`, at unit-test speed. */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { pointerSource } from '../../src/runtime/input/pointerSource';
import { createInputFrame, computePointerEdge, type InputFrame } from '../../src/runtime/core/inputActions';
import { clearPointerBlockers, registerPointerPassthrough } from '../../src/runtime/core/pointerBlockers';

const h = vi.hoisted(() => ({ tree: [{ entityId: 1 }] as Array<{ entityId: number }> }));
vi.mock('../../src/runtime/ui/useUIEntities', () => ({
  useUIEntities: () => h.tree,
}));
vi.mock('../../src/runtime/ui/UINode', () => ({
  UINode: ({ node }: { node: { entityId: number } }) =>
    React.createElement('button', { 'data-testid': 'uinode', 'data-entity-id': node.entityId }, 'Click'),
}));

import { UIRenderer } from '../../src/runtime/ui/UIRenderer';
import { DebugMenu } from '../../src/runtime/debug/DebugMenu';
import { __resetDebugMenuRegistry } from '../../src/runtime/debug/debugMenuRegistry';

function firePointerDown(target: EventTarget, x: number, y: number, pointerId = 1): void {
  const ev = new MouseEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }) as MouseEvent & { pointerId: number };
  (ev as { pointerId: number }).pointerId = pointerId;
  target.dispatchEvent(ev);
}

/** Sample the real pointerSource into a fresh frame and derive the down-edge, exactly as
 *  inputSystem does — proves against the actual `Input` contract, not a stand-in. */
function sample(): InputFrame {
  const frame = createInputFrame();
  pointerSource.sample(frame);
  computePointerEdge(frame, { down: false });
  return frame;
}

// jsdom has no ResizeObserver — UIRenderer's viewport-var measurement needs a stand-in.
class FakeRO {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}

beforeEach(() => {
  pointerSource.attach();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
});
afterEach(() => {
  cleanup();
  pointerSource.detach();
  clearPointerBlockers();
});

describe('UIRenderer + the real pointerSource', () => {
  it('a real pointerdown on the rendered UI button never reaches the game — a press elsewhere does', () => {
    const { container } = render(React.createElement(UIRenderer));
    const button = container.querySelector('[data-testid="uinode"]') as HTMLElement;
    expect(button).not.toBeNull();

    act(() => { firePointerDown(button, 50, 50); });
    expect(sample().pointer.down).toBe(false);

    act(() => { firePointerDown(document.body, 900, 900); });
    expect(sample().pointer.down).toBe(true);
  });

  it('a pointerdown on the GAME CANVAS inside the UI root DOES reach the game (the regression)', () => {
    // THE bug this pair of assertions exists for. `UIRenderer` registers its whole UI root, and the
    // standard 2D scene shape puts `Canvas2D` on a `UIElement` — so the game's own <canvas> is a
    // DESCENDANT of that root, and containment alone judged every board press to be a press on
    // chrome. Result: ALL pointer input dead in every 2D project (19 scenes, 10 projects, both
    // published demos), for a day, with a green suite — because the only assertions anyone had
    // written were about the BLOCK direction. A one-directional guard passes by blocking everything.
    const { container } = render(React.createElement(UIRenderer));
    const button = container.querySelector('[data-testid="uinode"]') as HTMLElement;
    expect(button).not.toBeNull();
    // Inside the UI root, exactly where a Canvas2D host's canvas really sits.
    const canvas = document.createElement('canvas');
    button.parentElement!.appendChild(canvas);

    // Unregistered: blocked. This is the bug, reproduced.
    act(() => { firePointerDown(canvas, 50, 50); });
    expect(sample().pointer.down, 'reproduces the bug without the exemption').toBe(false);

    // Registered as the game's own surface (what `canvas2DPool.createSlot` now does): it passes.
    const dispose = registerPointerPassthrough(canvas);
    pointerSource.reset!();
    act(() => { firePointerDown(canvas, 50, 50); });
    expect(sample().pointer.down, 'the game gets its own canvas press').toBe(true);

    // ...and the requirement the exemption must NOT break: UI over the canvas still wins.
    // "If UI picks the click, the pointer event should not go to the canvas/2D Pixi layer or 3D."
    pointerSource.reset!();
    act(() => { firePointerDown(button, 50, 50); });
    expect(sample().pointer.down, 'a UI press must still never reach the game').toBe(false);

    dispose();
    pointerSource.reset!();
    act(() => { firePointerDown(canvas, 50, 50); });
    expect(sample().pointer.down, 'a destroyed canvas keeps no stale exemption').toBe(false);
  });

  it('an editor SceneView preview instance (onSelectEntity set) does NOT block — a press on it still reaches the game', () => {
    const { container } = render(React.createElement(UIRenderer, { onSelectEntity: () => {} }));
    const button = container.querySelector('[data-testid="uinode"]') as HTMLElement;
    expect(button).not.toBeNull();

    act(() => { firePointerDown(button, 50, 50); });
    expect(sample().pointer.down).toBe(true);
  });
});

describe('DebugMenu + the real pointerSource', () => {
  beforeEach(() => __resetDebugMenuRegistry());

  it('a real pointerdown on the open debug panel never reaches the game — closing it un-blocks the same spot', () => {
    const { container } = render(React.createElement(DebugMenu));

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12' })); });
    const panel = container.querySelector('[data-debug-menu]') as HTMLElement;
    expect(panel).not.toBeNull();

    act(() => { firePointerDown(panel, 200, 200); });
    expect(sample().pointer.down).toBe(false);

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12' })); }); // close
    act(() => { firePointerDown(document.body, 200, 200); }); // same spot, panel gone
    expect(sample().pointer.down).toBe(true);
  });
});
