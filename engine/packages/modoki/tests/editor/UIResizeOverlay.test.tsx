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
vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  findEntity: (id: number) => (id === 2 ? fakeEntity : null),
  guidOfEntityId: () => undefined,
}));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getAllTraits: () => [
    { name: 'UIElement', trait: 'UIElement' },
    { name: 'UIAnchor', trait: 'UIAnchor' },
    { name: 'EntityAttributes', trait: 'EntityAttributes' },
  ],
}));

import { UIResizeOverlay } from '../../src/editor/panels/UIResizeOverlay';
import { collectHandles } from '../../src/runtime/rendering/interactionHandles';

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
  frameEl.style.overflow = 'hidden'; // as SceneView's frame is: it is what clips a handle past the device edge
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

  // #1726. Each handle's owner is its own grab div, because that is what a press must land on, and
  // `computeHandles` hit-tests and clips against the owner. The frame would count the overlay's own
  // move arrows (drawn over small elements' handles) as clean. The entity element would count every
  // grab div as a cover. The aim is the centre of the div's part inside the frame.
  /** Render the overlay INSIDE the frame, where SceneView mounts it; the provider looks there. */
  const renderInFrame = (frameEl: HTMLElement) => render(<UIResizeOverlay entityId={2} />, { container: frameEl.appendChild(document.createElement('div')) });
  const grabDivs = () => [...document.querySelectorAll<HTMLElement>('[data-ui-resize-handle]')];
  /** jsdom has no layout: give each grab div an on-screen box of `size` centred on its geometric point. */
  function stubGrabDivs(el: { left: number; top: number; width: number; height: number }, size: number) {
    for (const div of grabDivs()) {
      const h = collectHandles({ editor: 'ui-resize', ids: [`ui:${div.dataset.uiResizeHandle}`] })[0];
      const cx = el.left + el.width * (h.meta!.fx as number), cy = el.top + el.height * (h.meta!.fy as number);
      div.getBoundingClientRect = rectStub(cx - size / 2, cy - size / 2, size, size);
    }
  }

  it('names each resize handle\'s own GRAB DIV as its owner — not the frame, not the entity element', () => {
    renderInFrame(mountPreviewFrame({ left: 10, top: 20, width: 417, height: 597 }));
    const handles = collectHandles({ editor: 'ui-resize' });
    expect(handles).toHaveLength(8);
    for (const h of handles) {
      expect((h.owner as HTMLElement).dataset.uiResizeHandle, h.id).toBe(h.meta!.handle);
    }
  });

  it.each([
    ['at scale 1 (an 8px grab div)', 8],
    ['at scale 0.5 (a 4px grab div), below where a fixed inset stops fitting', 4],
    ['at scale 0.25 (a 2px grab div)', 2],
  ])('aims a handle ON the frame edge at the visible half of its grab div, %s', (_label, size) => {
    const box = { left: 10, top: 20, width: 417, height: 597 }; // the element fills the frame
    renderInFrame(mountPreviewFrame(box));
    stubGrabDivs(box, size);
    for (const h of collectHandles({ editor: 'ui-resize' })) {
      const gx = box.left + box.width * (h.meta!.fx as number), gy = box.top + box.height * (h.meta!.fy as number);
      expect(h.x, h.id).toBeGreaterThan(box.left); expect(h.x, h.id).toBeLessThan(box.left + box.width);
      expect(h.y, h.id).toBeGreaterThan(box.top); expect(h.y, h.id).toBeLessThan(box.top + box.height);
      expect(Math.abs(h.x - gx), h.id).toBeLessThan(size / 2); // still on the div
      expect(Math.abs(h.y - gy), h.id).toBeLessThan(size / 2);
    }
  });

  it('leaves a handle whose grab div lies wholly outside the frame at its true point, so it is refused', () => {
    const frameEl = mountPreviewFrame({ left: 10, top: 20, width: 417, height: 597 });
    const el = { left: 10, top: 20, width: 834, height: 716 }; // 200% × 120%
    (frameEl.querySelector('[data-entity-id="2"]') as HTMLElement).getBoundingClientRect = rectStub(el.left, el.top, el.width, el.height);
    renderInFrame(frameEl);
    stubGrabDivs(el, 8);
    const br = collectHandles({ editor: 'ui-resize', ids: ['ui:resize-br'] })[0];
    expect({ x: br.x, y: br.y }).toEqual({ x: 844, y: 736 });
  });

  it('aims inside a tighter clip ABOVE the frame too — the zoomed Scene viewport, not only the frame', () => {
    const box = { left: 10, top: 20, width: 417, height: 597 };
    const frameEl = mountPreviewFrame(box);
    const viewport = document.createElement('div');
    viewport.style.overflow = 'hidden';
    viewport.getBoundingClientRect = rectStub(10, 20, 415, 597); // cuts the frame 2px short on the right
    document.body.appendChild(viewport);
    viewport.appendChild(frameEl);
    renderInFrame(frameEl);
    stubGrabDivs(box, 8); // resize-r's div spans x 423..431; the viewport shows 423..425
    const r = collectHandles({ editor: 'ui-resize', ids: ['ui:resize-r'] })[0];
    expect(r.x).toBe(424);
  });

  it('lists no handle whose grab div is not drawn — there is nothing there to press', () => {
    renderInFrame(mountPreviewFrame({ left: 10, top: 20, width: 417, height: 597 }));
    expect(collectHandles({ editor: 'ui-resize' })).toHaveLength(8);
    for (const div of grabDivs()) div.removeAttribute('data-ui-resize-handle'); // React owns the node; untag it
    expect(collectHandles({ editor: 'ui-resize' })).toEqual([]);
  });

  it('draws only the handles on an auto-sized axis as disabled, matching meta.disabled', () => {
    const ui = traitData.UIElement as Record<string, unknown>;
    const width = ui.width;
    ui.width = 0; // auto width, fixed height
    try {
      renderInFrame(mountPreviewFrame({ left: 10, top: 20, width: 417, height: 597 }));
      for (const div of grabDivs()) {
        const h = collectHandles({ editor: 'ui-resize', ids: [`ui:${div.dataset.uiResizeHandle}`] })[0];
        expect(div.style.border.includes('dashed'), h.id).toBe(h.meta!.disabled);
      }
      expect(grabDivs().filter((d) => d.style.border.includes('dashed')).map((d) => d.dataset.uiResizeHandle).sort())
        .toEqual(['resize-bl', 'resize-br', 'resize-l', 'resize-r', 'resize-tl', 'resize-tr']);
    } finally {
      ui.width = width;
    }
  });

  it('renders nothing when the entity has no preview-frame DOM node', () => {
    // No frame mounted → update() bails, overlay stays null.
    render(<UIResizeOverlay entityId={2} />);
    expect(screen.queryByTestId('ui-resize-selection')).toBeNull();
  });
});
