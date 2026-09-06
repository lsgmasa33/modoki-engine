/** TouchControl end-to-end: the TRAIT → uiTreeProjection → UINode → real DOM (#297).
 *
 *  This covers the seam the input source depends on and nothing else tests. The source's own
 *  suite (packages/modoki/tests/runtime/touchControlSource.test.ts) starts from a DOM that
 *  ALREADY carries `data-modoki-touch` — so if the projection dropped the trait, or UINode
 *  stopped stamping it, every one of those tests would still be green and the d-pad would be
 *  dead on the device. That is the failure this file exists to catch.
 *
 *  Two properties beyond the attribute itself, both of which were real bugs waiting to happen:
 *   - a control is a LEAF, and UINode's leaf default is `pointer-events: none` — a d-pad that
 *     looks perfect and receives nothing;
 *   - the editor's authoring tree must render the control (you cannot position what you cannot
 *     see) while never stamping the attribute that makes it drive the game. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

beforeEach(() => { vi.resetModules(); });

const RUI = { id: 'RenderableUI' };
const UIEL = { id: 'UIElement' };
const ATTR = { id: 'EntityAttributes' };
const TOUCH = { id: 'TouchControl' };

const UI_DEFAULTS = {
  width: 100, height: 100, widthUnit: 'px', heightUnit: 'px',
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

const TOUCH_DEFAULTS = { action: 'moveLeft', showOn: 'touch', pressedOpacity: 0.6 };

function makeWorld(touch: Record<string, unknown> | null, ui?: Record<string, unknown>) {
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
        if (touch) data.set(TOUCH, { ...TOUCH_DEFAULTS, ...touch });
        const entity = { id: () => 1, has: (t: unknown) => data.has(t), get: (t: unknown) => data.get(t), generation: () => 0 };
        cb([data.get(UIEL)], entity);
      },
    }),
  } as never;
}

function mockDeps(isTouch: boolean) {
  vi.doMock('../../packages/modoki/src/runtime/core/ecs/world', () => ({
    getCurrentWorld: vi.fn(), onWorldSwap: vi.fn(),
  }));
  vi.doMock('../../packages/modoki/src/runtime/core/ecs/entityUtils', () => ({ addDirtyListener: vi.fn() }));
  vi.doMock('../../packages/modoki/src/runtime/core/ecs/traitRegistry', () => ({
    getAllTraits: () => [
      { name: 'RenderableUI', trait: RUI, category: 'component', fields: {} },
      { name: 'UIElement', trait: UIEL, category: 'component', fields: {} },
      { name: 'EntityAttributes', trait: ATTR, category: 'component', fields: {} },
      { name: 'TouchControl', trait: TOUCH, category: 'component', fields: {} },
    ],
  }));
  // The host answer is mocked rather than inferred: jsdom has no matchMedia and no
  // userAgentData, so the real readFormFactor falls through to 'mobile' — which would make the
  // desktop case untestable and the touch case pass for the wrong reason.
  vi.doMock('../../packages/modoki/src/runtime/core/formFactor', () => ({
    isTouchDevice: () => isTouch,
    readFormFactor: () => (isTouch ? 'mobile' : 'desktop'),
    readPlatform: () => 'web',
  }));
}

async function renderFromTraits(
  touch: Record<string, unknown> | null,
  opts: { isTouch?: boolean; editor?: boolean; ui?: Record<string, unknown> } = {},
): Promise<HTMLElement | null> {
  const { isTouch = true, editor = false, ui } = opts;
  // Per CALL, not per test: several cases render twice with different hosts, and a module
  // graph cached from the first render would silently answer the second with the first's mock.
  vi.resetModules();
  mockDeps(isTouch);
  const { uiTreeProjection, useUITreeStore } = await import('../../packages/modoki/src/runtime/ui/uiTreeStore');
  const { UINode } = await import('../../packages/modoki/src/runtime/ui/UINode');

  uiTreeProjection(makeWorld(touch, ui));
  const tree = useUITreeStore.getState().tree;
  expect(tree).toHaveLength(1); // the projection carried the entity through at all

  const props: Record<string, unknown> = { node: tree[0], storeState: {} };
  if (editor) props.onSelectEntity = () => {};
  const { container } = render(React.createElement(UINode, props as never));
  return container.firstElementChild as HTMLElement | null;
}

describe('TouchControl trait → projection → DOM', () => {
  it('stamps the action onto the element the input source resolves controls by', async () => {
    const el = await renderFromTraits({ action: 'moveForward' });
    expect(el).toBeTruthy();
    expect(el!.getAttribute('data-modoki-touch')).toBe('moveForward');
    expect(el!.getAttribute('data-modoki-touch-opacity')).toBe('0.6');
  });

  it('a control RECEIVES pointer events even though it is a leaf', async () => {
    // UINode's leaf default is `pointer-events: none`. Without TouchControl outranking it the
    // pad would render perfectly and swallow nothing — the same shape as the pointer-blocker
    // passthrough bug.
    const el = await renderFromTraits({});
    expect(el!.style.pointerEvents).toBe('auto');
    // And the browser must not turn a thumb-hold into a scroll or a text selection.
    expect(el!.style.touchAction).toBe('none');
  });

  it('an author-declared pointerThrough does NOT disarm a touch control', async () => {
    vi.resetModules();
    mockDeps(true);
    const { uiTreeProjection, useUITreeStore } = await import('../../packages/modoki/src/runtime/ui/uiTreeStore');
    const { UINode } = await import('../../packages/modoki/src/runtime/ui/UINode');
    uiTreeProjection(makeWorld({}));
    const node = { ...useUITreeStore.getState().tree[0], pointerThrough: true };
    const { container } = render(React.createElement(UINode, { node, storeState: {} } as never));
    expect((container.firstElementChild as HTMLElement).style.pointerEvents).toBe('auto');
  });

  it("showOn:'touch' mounts on a handheld and NOT on a desktop", async () => {
    expect(await renderFromTraits({ showOn: 'touch' }, { isTouch: true })).toBeTruthy();
    expect(await renderFromTraits({ showOn: 'touch' }, { isTouch: false })).toBeNull();
  });

  it("showOn:'always' mounts on a desktop; showOn:'never' mounts nowhere", async () => {
    expect(await renderFromTraits({ showOn: 'always' }, { isTouch: false })).toBeTruthy();
    expect(await renderFromTraits({ showOn: 'never' }, { isTouch: true })).toBeNull();
  });

  it('the EDITOR renders the control on a desktop but never stamps the attribute', async () => {
    // Both halves matter: an invisible control cannot be positioned, and a stamped one in the
    // authoring preview would let a click meant to SELECT the pad also walk the character.
    const el = await renderFromTraits({ showOn: 'touch' }, { isTouch: false, editor: true });
    expect(el).toBeTruthy();
    expect(el!.hasAttribute('data-modoki-touch')).toBe(false);
  });

  it('a TouchControl on a non-div element is NOT half-armed, and DEV says why', async () => {
    // `touchAttrs` is spread only into the two <div> returns; the input/range/UIToggle branches
    // return earlier. Before this gate, such an element got the touch STYLES (suppressing
    // scroll, selection and the tap highlight) but never the attribute the input source resolves
    // controls by — armed-looking and completely inert, with nothing said. Fourth instance of
    // the class UINode already warns about three times.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const el = await renderFromTraits({ action: 'moveLeft' }, { ui: { elementType: 'input' } });
      expect(el!.hasAttribute('data-modoki-touch')).toBe(false);
      expect(el!.style.touchAction).toBe('');   // not half-armed
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('will NOT drive input here'));
    } finally { warn.mockRestore(); }
  });

  it('an element with no TouchControl trait is untouched', async () => {
    const el = await renderFromTraits(null);
    expect(el!.hasAttribute('data-modoki-touch')).toBe(false);
    expect(el!.style.touchAction).toBe('');
  });
});
