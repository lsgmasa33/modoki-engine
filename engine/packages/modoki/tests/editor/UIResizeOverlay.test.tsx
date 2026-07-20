// @vitest-environment jsdom
/** UIResizeOverlay — integration guard for the device-simulation regressions that
 *  pure math couldn't catch: the selection box must (a) measure the full device for
 *  a stretch element, and (b) RE-MEASURE when the device preset changes (the stale
 *  gameViewSize dep bug). Mounts the real component with mocked ECS/store/DOM and
 *  asserts the rendered selection rect.
 *
 *  The component reads the live DOM (preview frame + entity rects), the editor store
 *  (gameViewSize), the UI tree store, and ECS (findEntity/getAllTraits) — all mocked
 *  here so the test is hermetic. The pure conversion is separately covered in
 *  uiResizeMath.test.ts (frameToLogicalRect); this verifies the WIRING. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

// ── Mutable mock state (driven by the test) ──────────────
const mockEditor: { gameViewSize: { width: number; height: number } } = {
  gameViewSize: { width: 834, height: 1194 }, // iPad Pro 11 logical
};
const mockTree = { tree: 0 };

// ── Module mocks (paths resolve to the same modules the component imports) ──
vi.mock('../../src/editor/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockEditor) => unknown) => selector(mockEditor),
}));
vi.mock('../../src/runtime/ui/uiTreeStore', () => ({
  useUITreeStore: (selector: (s: typeof mockTree) => unknown) => selector(mockTree),
  markUIDirty: () => {},
  onEditorDirty: () => () => {}, // returns an unsubscribe
}));
vi.mock('../../src/editor/undo/undoManager', () => ({ pushAction: () => {} }));
vi.mock('../../src/editor/undo/entityRef', () => ({ entityRef: () => ({ resolve: () => null }) }));
vi.mock('../../src/editor/animation/recording', () => ({ notifyFieldEdited: () => {} }));

// ── Fake ECS: a single stretch, root-level (no parent) UI entity (id 2) ──
const traitData: Record<string, Record<string, unknown>> = {
  UIElement: {
    width: 100, widthUnit: '%', height: 100, heightUnit: '%',
    marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
    marginTopUnit: 'px', marginRightUnit: 'px', marginBottomUnit: 'px', marginLeftUnit: 'px',
  },
  UIAnchor: {
    anchor: 'stretch', pivotX: 0, pivotY: 0,
    top: 0, topUnit: 'px', left: 0, leftUnit: 'px', right: 0, rightUnit: 'px', bottom: 0, bottomUnit: 'px',
  },
  EntityAttributes: { parentId: 0 },
};
const fakeEntity = {
  has: (t: string) => t in traitData,
  get: (t: string) => traitData[t],
  set: () => {},
  id: () => 2,
  name: '2D Canvas',
};
vi.mock('../../src/runtime/ecs/entityUtils', () => ({
  findEntity: (id: number) => (id === 2 ? fakeEntity : null),
}));
vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getAllTraits: () => [
    { name: 'UIElement', trait: 'UIElement' },
    { name: 'UIAnchor', trait: 'UIAnchor' },
    { name: 'EntityAttributes', trait: 'EntityAttributes' },
  ],
}));

import { UIResizeOverlay } from '../../src/editor/panels/UIResizeOverlay';

// ── DOM helpers ──────────────────────────────────────────
function rectStub(left: number, top: number, width: number, height: number): () => DOMRect {
  return () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
    toJSON() { return this; },
  } as DOMRect);
}

/** Build the SceneView preview frame containing the selected entity element, both
 *  with stubbed on-screen rects. For a stretch element, el rect === frame rect. */
function mountPreviewFrame(frame: { left: number; top: number; width: number; height: number }) {
  const frameEl = document.createElement('div');
  frameEl.setAttribute('data-ui-preview-frame', '');
  frameEl.getBoundingClientRect = rectStub(frame.left, frame.top, frame.width, frame.height);
  const entityEl = document.createElement('div');
  entityEl.setAttribute('data-entity-id', '2');
  entityEl.getBoundingClientRect = rectStub(frame.left, frame.top, frame.width, frame.height); // stretch → fills frame
  frameEl.appendChild(entityEl);
  document.body.appendChild(frameEl);
  return frameEl;
}

function selectionBox() {
  const el = screen.getByTestId('ui-resize-selection') as HTMLElement;
  return { left: parseFloat(el.style.left), top: parseFloat(el.style.top), width: parseFloat(el.style.width), height: parseFloat(el.style.height) };
}

beforeEach(() => {
  // jsdom lacks ResizeObserver + rAF; the component references both.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
  mockEditor.gameViewSize = { width: 834, height: 1194 };
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('UIResizeOverlay — device simulation wiring', () => {
  it('measures the FULL device for a stretch element (frame an exact 0.5× of iPad 834×1194)', async () => {
    // Frame letterboxed to an exact half-scale on screen (417×597) → uiScale 0.5.
    mountPreviewFrame({ left: 100, top: 50, width: 417, height: 597 });
    render(<UIResizeOverlay entityId={2} />);
    await screen.findByTestId('ui-resize-selection');

    const box = selectionBox();
    // Stretch element → full logical device: 834 × 1194, at the frame origin (0,0).
    expect(box.left).toBeCloseTo(0, 1);
    expect(box.top).toBeCloseTo(0, 1);
    expect(box.width).toBeCloseTo(834, 0);
    expect(box.height).toBeCloseTo(1194, 0);
  });

  it('RE-MEASURES when the device preset changes (regression: stale gameViewSize dep)', async () => {
    // Hold the on-screen frame constant and switch ONLY the device logical width
    // (834 → 375). For a stretch element the box WIDTH equals the device width
    // regardless of frame size, so it must track the CURRENT device — not the one
    // active at first select. With the stale-dep bug the width stayed at 834.
    mountPreviewFrame({ left: 100, top: 50, width: 417, height: 597 });
    const { rerender } = render(<UIResizeOverlay entityId={2} />);
    await screen.findByTestId('ui-resize-selection');
    expect(selectionBox().width).toBeCloseTo(834, 0);

    mockEditor.gameViewSize = { width: 375, height: 667 }; // switch to iPhone SE logical
    rerender(<UIResizeOverlay entityId={2} />);

    expect(selectionBox().width).toBeCloseTo(375, 0); // ← would stay 834 with the bug
  });

  it('renders nothing when the entity has no preview-frame DOM node', () => {
    // No frame mounted → update() bails, overlay stays null.
    render(<UIResizeOverlay entityId={2} />);
    expect(screen.queryByTestId('ui-resize-selection')).toBeNull();
  });
});
