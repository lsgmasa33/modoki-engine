/** UIRenderer tests (missing-test #5) — empty-tree gating, viewport-var measurement
 *  (--ui-vw/vh/vmin/vmax from the container's measured size), and the ResizeObserver
 *  wired via a callback ref (so it survives the conditional null-render). UINode and
 *  useUIEntities are stubbed to isolate UIRenderer. */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ tree: { current: [] as Array<{ entityId: number }> } }));

vi.mock('../../src/runtime/ui/useUIEntities', () => ({
  useUIEntities: () => h.tree.current,
}));
vi.mock('../../src/runtime/ui/UINode', () => ({
  UINode: ({ node }: { node: { entityId: number } }) =>
    React.createElement('div', { 'data-testid': 'uinode', 'data-entity-id': node.entityId }),
}));

import { UIRenderer } from '../../src/runtime/ui/UIRenderer';
import { isPointerBlocked, clearPointerBlockers } from '../../src/runtime/core/pointerBlockers';
import { resetSafeAreaInsets } from '../../src/runtime/ui/safeArea';

// jsdom has no ResizeObserver — install a controllable fake that records instances.
class FakeRO {
  static instances: FakeRO[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  constructor(public cb: () => void) { FakeRO.instances.push(this); }
}

beforeEach(() => {
  h.tree.current = [];
  FakeRO.instances = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
});
afterEach(() => {
  cleanup();
  // UIRenderer registers its container with safeArea (module state), so an unmounted container
  // would otherwise stay registered across tests in this file.
  resetSafeAreaInsets();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  clearPointerBlockers();
});

function sizeDom(w: number, h: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => w });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => h });
}

describe('UIRenderer', () => {
  it('renders null (no container) when the tree is empty', () => {
    h.tree.current = [];
    const { container } = render(<UIRenderer />);
    expect(container.firstElementChild).toBeNull();
  });

  it('renders a non-interactive overlay container with one node per root', () => {
    h.tree.current = [{ entityId: 1 }, { entityId: 2 }];
    const { container } = render(<UIRenderer />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.style.position).toBe('absolute');
    // jsdom 30 normalizes a zero <length> to '0px'; jsdom 26 echoed '0'. The assertion is that
    // the overlay is pinned to all four edges, not how the environment stringifies zero.
    expect(root.style.inset).toMatch(/^0(px)?$/);
    expect(root.style.pointerEvents).toBe('none'); // root passes events through to nodes
    expect(root.style.overflow).toBe('hidden');
    expect(root.querySelectorAll('[data-testid=uinode]').length).toBe(2);
  });

  it('publishes viewport custom props from the measured container size', () => {
    sizeDom(400, 800); // vw=4, vh=8, vmin=4, vmax=8
    h.tree.current = [{ entityId: 1 }];
    const { container } = render(<UIRenderer />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue('--ui-vw')).toBe('4px');
    expect(root.style.getPropertyValue('--ui-vh')).toBe('8px');
    expect(root.style.getPropertyValue('--ui-vmin')).toBe('4px');
    expect(root.style.getPropertyValue('--ui-vmax')).toBe('8px');
  });

  it('does not publish vars when the container measures 0 (still-laying-out)', () => {
    sizeDom(0, 0);
    h.tree.current = [{ entityId: 1 }];
    const { container } = render(<UIRenderer />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue('--ui-vw')).toBe('');
  });

  /**
   * ⚠️ TWO observers exist on this container's mount, and picking the right one matters.
   * `safeArea.ts` constructs its own (on two inset-sized probes it appends inside this
   * container, #612) from inside `update()`, which runs BEFORE this component's own
   * `ro.observe(el)` — so it is `instances[0]`, and an index-based assertion here silently
   * asserts about the wrong module. Identify UIRenderer's by the fact that it observes the
   * CONTAINER itself; the safe-area one only ever observes probes.
   */
  const containerObserver = (root: HTMLElement) =>
    FakeRO.instances.filter((ro) => ro.observe.mock.calls.some(([t]) => t === root));

  it('observes the container on mount and disconnects on unmount (callback-ref lifecycle)', () => {
    h.tree.current = [{ entityId: 1 }];
    const { container, unmount } = render(<UIRenderer />);
    const root = container.firstElementChild as HTMLElement;
    const own = containerObserver(root);
    expect(own, 'exactly one observer watches the container itself').toHaveLength(1);
    expect(own[0].observe).toHaveBeenCalledTimes(1);
    unmount();
    expect(own[0].disconnect).toHaveBeenCalled();
  });

  /**
   * ⚠️ **The producer→consumer seam, and until this existed nothing covered it.** `safeArea.ts`
   * has exactly one production caller — the `measureSafeAreaInsets(el)` inside this component's
   * `update()` — and its own suite calls that function directly, so **deleting the call from
   * UIRenderer left the entire repo green** while `getSafeAreaInsets()` returned zeros forever in
   * a shipped game. `games/court/tests/boardSafeAreaBudget.test.ts` used to be the only thing
   * mounting a real UIRenderer and reading through to the real accessor; it was deleted with the
   * poll it tested, taking this cover with it.
   *
   * Asserting on the PROBES rather than on a spy is deliberate: it proves the registration
   * actually reached the module and did its work in this container's cascade, which a mock call
   * count would not.
   */
  /**
   * ⚠️ **The other half of the same guard, and it had no cover at all.** `safeArea.ts` refuses a
   * detached element defensively; this component is supposed to stop one being sent in the first
   * place, by cancelling the queued frame when its callback ref tears down. Nothing in either
   * suite ever FIRED this component's ResizeObserver callback, so the whole rAF path — the
   * `frameRef`, the cancel, the null-out — was exercised by nothing and deleting the cancel left
   * the repo green.
   *
   * The scenario: the observer's initial observation queues `update()`; the container unmounts
   * before that frame runs (a scene swap's empty-tree beat, an editor panel closing mid-resize);
   * the frame then re-enters `update()` and registers a removed node with `safeArea`.
   */
  it('cancels its queued measure frame on unmount, so a dead container is never registered', () => {
    const queued: Array<() => void> = [];
    const cancelled: number[] = [];
    const realRaf = globalThis.requestAnimationFrame;
    const realCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queued.push(() => cb(0));
      return queued.length; // id is 1-based index
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => { cancelled.push(id); }) as typeof globalThis.cancelAnimationFrame;
    try {
      h.tree.current = [{ entityId: 1 }];
      const { container, unmount } = render(<UIRenderer />);
      const root = container.firstElementChild as HTMLElement;
      const own = containerObserver(root)[0];

      own.cb();                                   // the observer fires -> a frame is queued
      expect(queued, 'the observer defers its measure to a frame').toHaveLength(1);

      unmount();                                  // ...and the container goes away first
      expect(cancelled, 'the queued frame must be cancelled, not left to run').toContain(1);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
    }
  });

  it('registers its container with safeArea, so the insets have a producer at all', () => {
    h.tree.current = [{ entityId: 1 }];
    const { container, unmount } = render(<UIRenderer />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.querySelectorAll('[data-modoki-safe-area-probe]'),
      'safeArea must have registered this container and appended its probes').toHaveLength(2);
    // Both observers exist: this component's (on the container) and safeArea's (on the probes).
    expect(FakeRO.instances.length).toBeGreaterThanOrEqual(2);
    unmount();
    resetSafeAreaInsets();
  });

  describe('pointer-block registration', () => {
    it('registers its root as a pointer-block root in runtime mode (no onSelectEntity)', () => {
      h.tree.current = [{ entityId: 1 }];
      const { container } = render(<UIRenderer />);
      const root = container.firstElementChild as HTMLElement;
      expect(isPointerBlocked(root)).toBe(true);
    });

    it('does NOT register when onSelectEntity is set — the editor SceneView preview must never claim the running game pointer', () => {
      h.tree.current = [{ entityId: 1 }];
      const { container } = render(<UIRenderer onSelectEntity={() => {}} />);
      const root = container.firstElementChild as HTMLElement;
      expect(isPointerBlocked(root)).toBe(false);
    });

    it('unregisters on unmount', () => {
      h.tree.current = [{ entityId: 1 }];
      const { container, unmount } = render(<UIRenderer />);
      const root = container.firstElementChild as HTMLElement;
      expect(isPointerBlocked(root)).toBe(true);
      unmount();
      expect(isPointerBlocked(root)).toBe(false);
    });
  });
});
