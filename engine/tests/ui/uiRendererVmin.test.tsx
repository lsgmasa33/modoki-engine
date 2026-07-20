/** UIRenderer viewport-var publishing — the vmin/vmax bug behind editor previews.
 *
 *  UIRenderer sets CSS custom props (--ui-vw/vh/vmin/vmax) on its container so
 *  viewport-relative UI units resolve against THIS preview (the simulated device
 *  in GameView/SceneView), not the browser window. The container is CONDITIONALLY
 *  rendered (returns null while the UI tree is empty), so the original
 *  `useEffect([])` ran once with no element and never re-ran when the entities
 *  finally loaded and the div mounted — leaving the vars unset and every `vmin`
 *  falling back to the real window (wrong in a device-sized preview). The fix is a
 *  callback ref that fires exactly when the div mounts. These tests guard that:
 *  the vars are (a) derived from the CONTAINER size, not the window, and (b) get
 *  set even when the tree starts empty and the div mounts on a later render. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// Controllable UI tree (the projection the renderer reads). vi.hoisted so the
// mock factory can close over it; tests flip it to simulate entities loading.
const state = vi.hoisted(() => ({ tree: [] as unknown[] }));
vi.mock('../../packages/modoki/src/runtime/ui/useUIEntities', () => ({
  useUIEntities: () => state.tree,
}));
// Isolate the container/vmin logic — don't render real UI nodes (heavy + needs a
// full UINodeData). A trivial child stands in for the tree's content.
vi.mock('../../packages/modoki/src/runtime/ui/UINode', () => ({
  UINode: () => null,
}));

import { UIRenderer } from '../../packages/modoki/src/runtime/ui/UIRenderer';

const node = () => ({ id: 1, children: [] } as unknown);

// jsdom has neither ResizeObserver nor non-zero client sizes. Stub a 400×800
// container (→ vw 4, vh 8, vmin 4, vmax 8) so the published values are knowable
// and distinct from jsdom's default 1024×768 window (which would give vmin 7.68).
let restoreW: () => void, restoreH: () => void;
function defineClient(prop: 'clientWidth' | 'clientHeight', value: number): () => void {
  const prev = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  return () => { if (prev) Object.defineProperty(HTMLElement.prototype, prop, prev); };
}

beforeEach(() => {
  state.tree = [];
  (globalThis as any).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  restoreW = defineClient('clientWidth', 400);
  restoreH = defineClient('clientHeight', 800);
});
afterEach(() => { restoreW(); restoreH(); delete (globalThis as any).ResizeObserver; });

const vmin = (el: Element | null) => (el as HTMLElement | null)?.style.getPropertyValue('--ui-vmin');

describe('UIRenderer viewport vars', () => {
  it('publishes vmin/vmax from the CONTAINER size, not the window', async () => {
    state.tree = [node()];
    const { container } = render(<UIRenderer storeState={{}} />);
    const root = container.firstElementChild;
    await waitFor(() => expect(vmin(root)).toBe('4px')); // min(400/100, 800/100)
    expect((root as HTMLElement).style.getPropertyValue('--ui-vmax')).toBe('8px');
    expect((root as HTMLElement).style.getPropertyValue('--ui-vw')).toBe('4px');
    // Proves it's the container, not jsdom's 1024×768 window (which → vmin 7.68px).
    expect(vmin(root)).not.toBe('7.68px');
  });

  it('sets the vars when the tree starts EMPTY and the div mounts on a later render', async () => {
    // The exact regression: useEffect([]) would have run here (no div) and never
    // re-fired. The callback ref must wire up when the div finally mounts.
    const { container, rerender } = render(<UIRenderer storeState={{}} />);
    expect(container.firstElementChild).toBeNull(); // empty tree → no container yet

    state.tree = [node()];
    rerender(<UIRenderer storeState={{}} />);
    await waitFor(() => expect(vmin(container.firstElementChild)).toBe('4px'));
  });
});
