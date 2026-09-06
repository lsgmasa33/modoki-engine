/** UIAnchor end-to-end: the UIAnchor TRAIT → uiTreeProjection → UINode → real DOM.
 *
 *  Scope is deliberately narrow — this covers only the SEAM, which nothing else did.
 *  The neighbouring suites each own one link of the chain and stop there:
 *    - uiTreeReuse.test.ts    traits → projection (node identity/reuse)
 *    - uiNode.test.tsx        a hand-built UINodeData → DOM (per-mode CSS detail)
 *    - anchorCss.test.ts      the CSSProperties object applyAnchorStyle returns
 *    - uiAnchorParity.test.ts that object vs. the pixel path, via a CSS oracle
 *  So an anchor could be dropped or mangled BETWEEN the trait and the DOM — the
 *  projection failing to carry `UIAnchor`, say — with every one of those still green.
 *  Detailed per-mode assertions belong in uiNode.test.tsx; don't duplicate them here.
 *
 *  jsdom caveat: it does not expand shorthands into longhand getters (with `inset: 0`
 *  set, `el.style.top` reads ''). applyAnchorStyle emits four longhands for `stretch`
 *  precisely so it never depends on shorthand resolution, which is what keeps these
 *  assertions meaningful rather than jsdom-specific. Real-browser behaviour was
 *  confirmed separately and live: games/court's NarrationBand measured x=5%, w=90%. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

beforeEach(() => { vi.resetModules(); });

// ── Trait identity objects (what the projection passes to entity.has/get) ──
const RUI = { id: 'RenderableUI' };
const UIEL = { id: 'UIElement' };
const ATTR = { id: 'EntityAttributes' };
const ANC = { id: 'UIAnchor' };

const UI_DEFAULTS = {
  width: 100, height: 40, widthUnit: 'px', heightUnit: 'px',
  flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'flex-start', alignItems: 'stretch',
  gap: 0, flexGrow: 0, flexShrink: 1,
  paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
  marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
  minWidth: 0, maxWidth: 0, minHeight: 0, maxHeight: 0,
  alignSelf: 'auto', zIndex: 0, overflow: 'visible', isVisible: true,
  backgroundColor: 0, backgroundOpacity: 0, borderRadius: 0, borderWidth: 0,
  borderColor: 0x333333, borderOpacity: 1, opacity: 1,
  text: '', fontFamily: '', fontSize: 16, fontWeight: 'normal', fontStyle: 'normal',
  textColor: 0xffffff, textOpacity: 1, textAlign: 'left', lineHeight: 0, letterSpacing: 0,
  textShadowColor: 0, textShadowOpacity: 1, textShadowOffsetX: 0, textShadowOffsetY: 0,
  textShadowBlur: 0, textStrokeColor: 0, textStrokeOpacity: 1, textStrokeWidth: 0,
  textOverflow: 'clip', maxLines: 0, imageSrc: '', imageMode: 'cover',
  elementType: 'div', placeholder: '', rangeMin: 0, rangeMax: 100, rangeStep: 1,
};

const ANCHOR_DEFAULTS = {
  anchor: 'center', top: 0, topUnit: 'px', right: 0, rightUnit: 'px',
  bottom: 0, bottomUnit: 'px', left: 0, leftUnit: 'px',
  pivotX: 0, pivotY: 0, safeArea: false,
};

function makeWorld(ui: Record<string, unknown>, anchor: Record<string, unknown> | null) {
  return {
    // No `UISettings` entity: `uiTreeProjection` reads the scene-wide default font through
    // `queryFirst` (#803), so this fake must answer it. `undefined` = no default authored,
    // which is what these fixtures assert against.
    queryFirst: () => undefined,
    query: () => ({
      updateEach: (cb: (data: unknown[], entity: unknown) => void) => {
        const data = new Map<unknown, unknown>();
        data.set(UIEL, { ...UI_DEFAULTS, ...ui });
        data.set(ATTR, { parentId: 0, sortOrder: 0, guid: 'g1' });
        if (anchor) data.set(ANC, { ...ANCHOR_DEFAULTS, ...anchor });
        const entity = { id: () => 1, has: (t: unknown) => data.has(t), get: (t: unknown) => data.get(t), generation: () => 0 };
        cb([data.get(UIEL)], entity);
      },
    }),
  } as never;
}

function mockDeps() {
  vi.doMock('../../packages/modoki/src/runtime/core/ecs/world', () => ({
    getCurrentWorld: vi.fn(), onWorldSwap: vi.fn(),
  }));
  vi.doMock('../../packages/modoki/src/runtime/core/ecs/entityUtils', () => ({ addDirtyListener: vi.fn() }));
  vi.doMock('../../packages/modoki/src/runtime/core/ecs/traitRegistry', () => ({
    getAllTraits: () => [
      { name: 'RenderableUI', trait: RUI, category: 'component', fields: {} },
      { name: 'UIElement', trait: UIEL, category: 'component', fields: {} },
      { name: 'EntityAttributes', trait: ATTR, category: 'component', fields: {} },
      { name: 'UIAnchor', trait: ANC, category: 'component', fields: {} },
    ],
  }));
}

/** Project the traits into a UINodeData, render the real UINode, return its element. */
async function renderFromTraits(
  anchor: Record<string, unknown> | null, ui: Record<string, unknown> = {},
): Promise<HTMLElement> {
  mockDeps();
  const { uiTreeProjection, useUITreeStore } = await import('../../packages/modoki/src/runtime/ui/uiTreeStore');
  const { UINode } = await import('../../packages/modoki/src/runtime/ui/UINode');

  uiTreeProjection(makeWorld(ui, anchor));
  const tree = useUITreeStore.getState().tree;
  expect(tree).toHaveLength(1); // the projection carried the entity through at all

  const { container } = render(React.createElement(UINode, { node: tree[0], storeState: {} }));
  return container.firstElementChild as HTMLElement;
}

describe('UIAnchor trait → projection → DOM', () => {
  it('an anchored entity reaches the DOM absolutely positioned', async () => {
    const el = await renderFromTraits({ anchor: 'center' });
    expect(el).toBeTruthy();
    expect(el.style.position).toBe('absolute');
  });

  it('an entity with NO UIAnchor trait stays in flow (position: relative)', async () => {
    // Control: pins that the absolute positioning above is caused by the TRAIT, not
    // by a UINode default. `relative` is UINode's own baseline for an unanchored node.
    const el = await renderFromTraits(null);
    expect(el.style.position).toBe('relative');
  });

  it('stretched-axis offsets survive the whole chain as two independent edges', async () => {
    // The games/court NarrationBand case, end to end. Pre-fix this reached the DOM as
    // left: calc(5% - 5%) with no `right` at all — a full-bleed box.
    const el = await renderFromTraits(
      { anchor: 'bottom-stretch', left: 5, leftUnit: '%', right: 5, rightUnit: '%' },
    );
    expect(el.style.left).toBe('5%');
    expect(el.style.right).toBe('5%');
  });

  it('an authored UIElement.width loses to the stretched axis all the way to the DOM', async () => {
    // NarrationBand also carries width:90%, which the anchor clears — so the offsets
    // are the only thing sizing that axis. See docs/ui-system.md (inert width/height).
    const el = await renderFromTraits(
      { anchor: 'bottom-stretch', left: 5, leftUnit: '%', right: 5, rightUnit: '%' },
      { width: 90, widthUnit: '%' },
    );
    expect(el.style.width).toBe('');
    expect(el.style.left).toBe('5%');
    // Guard against over-clearing: bottom-stretch stretches X only, so height stands.
    expect(el.style.height).toBe('40px');
  });
});
