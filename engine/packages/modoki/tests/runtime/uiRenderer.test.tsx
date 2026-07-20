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
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
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
    expect(root.style.inset).toBe('0');
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

  it('observes the container on mount and disconnects on unmount (callback-ref lifecycle)', () => {
    h.tree.current = [{ entityId: 1 }];
    const { unmount } = render(<UIRenderer />);
    expect(FakeRO.instances).toHaveLength(1);
    expect(FakeRO.instances[0].observe).toHaveBeenCalledTimes(1);
    unmount();
    expect(FakeRO.instances[0].disconnect).toHaveBeenCalled();
  });
});
