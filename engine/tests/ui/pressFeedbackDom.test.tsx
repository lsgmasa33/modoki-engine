// @vitest-environment jsdom
/** Press feedback (#2011) — the trait → projection → DOM wiring.
 *
 *  `pressFeedback.test.ts` (package suite) covers the resolver and the pointer tracker; this file
 *  covers the two seams between them: `uiTreeStore` resolving `UIAction.pressScale` against the
 *  scene's `UISettings`, and `UINode` stamping the result only on a runtime BUTTON. Same harness
 *  shape as `touchControlDom.test.tsx`. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

beforeEach(() => { vi.resetModules(); });

const RUI = { id: 'RenderableUI' };
const UIEL = { id: 'UIElement' };
const ATTR = { id: 'EntityAttributes' };
const ACTION = { id: 'UIAction' };

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
  textOverflow: 'clip', maxLines: 0, imageSrc: '', imageMode: 'cover', imageAlign: 'center',
  elementType: 'div', placeholder: '', rangeMin: 0, rangeMax: 100, rangeStep: 1,
};

const CLICK = [{ event: 'click', kind: 'call', action: 'game.go' }];

interface Fixture {
  action?: Record<string, unknown> | null;
  settings?: Record<string, unknown>;
  ui?: Record<string, unknown>;
}

function makeWorld({ action, settings, ui }: Fixture, uiSettingsTrait: unknown) {
  return {
    // Answers ONLY for the real `UISettings` trait (the instance the projection imported), so a
    // build that read the wrong trait would get nothing. `undefined` = the scene has none.
    queryFirst: (t: unknown) => (settings && t === uiSettingsTrait ? { get: () => settings } : undefined),
    query: () => ({
      updateEach: (cb: (data: unknown[], entity: unknown) => void) => {
        const data = new Map<unknown, unknown>();
        data.set(UIEL, { ...UI_DEFAULTS, ...ui });
        data.set(ATTR, { parentId: 0, sortOrder: 0, guid: 'g1' });
        if (action) data.set(ACTION, action);
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
  vi.doMock('../../packages/modoki/src/runtime/core/ecs/entityUtils', () => ({ addDirtyListener: vi.fn(), onStructureDirty: vi.fn() }));
  vi.doMock('../../packages/modoki/src/runtime/core/ecs/traitRegistry', () => ({
    getAllTraits: () => [
      { name: 'RenderableUI', trait: RUI, category: 'component', fields: {} },
      { name: 'UIElement', trait: UIEL, category: 'component', fields: {} },
      { name: 'EntityAttributes', trait: ATTR, category: 'component', fields: {} },
      { name: 'UIAction', trait: ACTION, category: 'component', fields: {} },
    ],
  }));
}

async function renderFromTraits(f: Fixture, opts: { editor?: boolean } = {}): Promise<HTMLElement> {
  vi.resetModules();
  mockDeps();
  const { uiTreeProjection, useUITreeStore } = await import('../../packages/modoki/src/runtime/ui/uiTreeStore');
  const { UINode } = await import('../../packages/modoki/src/runtime/ui/UINode');
  const { UISettings } = await import('../../packages/modoki/src/runtime/traits/UISettings');
  uiTreeProjection(makeWorld(f, UISettings));
  const tree = useUITreeStore.getState().tree;
  expect(tree).toHaveLength(1);
  const props: Record<string, unknown> = { node: tree[0], storeState: {} };
  if (opts.editor) props.onSelectEntity = () => {};
  const { container } = render(React.createElement(UINode, props as never));
  return container.firstElementChild as HTMLElement;
}

const scaleOf = (el: HTMLElement) => el.getAttribute('data-press-scale');
const msOf = (el: HTMLElement) => el.getAttribute('data-press-ms');

describe('press feedback: UIAction + UISettings → projection → DOM', () => {
  it('a button in a scene with no UISettings gets the engine default (on)', async () => {
    const el = await renderFromTraits({ action: { bindings: CLICK } });
    expect(scaleOf(el)).toBe('1.08');
    expect(msOf(el)).toBe('90');
  });

  it('the scene-wide UISettings values reach the button', async () => {
    const el = await renderFromTraits({
      action: { bindings: CLICK }, settings: { pressScale: 1.2, pressDurationMs: 50 },
    });
    expect(scaleOf(el)).toBe('1.2');
    expect(msOf(el)).toBe('50');
  });

  it('a per-button 0 (what the Inspector shows for an absent value) inherits', async () => {
    const el = await renderFromTraits({ action: { bindings: CLICK, pressScale: 0 } });
    expect(scaleOf(el)).toBe('1.08');
  });

  it('a per-button pressScale of 1 opts a button out', async () => {
    const el = await renderFromTraits({ action: { bindings: CLICK, pressScale: 1 } });
    expect(el.hasAttribute('data-press-scale')).toBe(false);
  });

  it('a per-button value turns it on in a scene that turned it off', async () => {
    const el = await renderFromTraits({
      action: { bindings: CLICK, pressScale: 1.3 }, settings: { pressScale: 1, pressDurationMs: 90 },
    });
    expect(scaleOf(el)).toBe('1.3');
  });

  it('a UIAction with no click binding is not a button', async () => {
    const el = await renderFromTraits({ action: { bindings: [{ event: 'change', kind: 'call', action: 'game.x' }] } });
    expect(el.hasAttribute('data-press-scale')).toBe(false);
  });

  it('a swallowClicks panel is not a button, even with a resolved press', async () => {
    // A UIAction with only a non-click binding still RESOLVES a press in the projection, so this
    // is the input that tells "takes the click" (a swallow does) from "is a button" (it is not).
    const el = await renderFromTraits({
      action: { bindings: [{ event: 'change', kind: 'call', action: 'game.x' }] },
      ui: { swallowClicks: true },
    });
    expect(el.hasAttribute('data-press-origin')).toBe(true);   // it does take the click
    expect(el.hasAttribute('data-press-scale')).toBe(false);
  });

  it('the editor preview never stamps it — a click there selects, it does not press', async () => {
    const el = await renderFromTraits({ action: { bindings: CLICK } }, { editor: true });
    expect(el.hasAttribute('data-press-scale')).toBe(false);
  });

  it('a press change alone makes the node unequal, so a retune re-renders', async () => {
    vi.resetModules();
    mockDeps();
    const { uiTreeProjection, useUITreeStore, nodesEqual } = await import('../../packages/modoki/src/runtime/ui/uiTreeStore');
    const { UISettings } = await import('../../packages/modoki/src/runtime/traits/UISettings');
    uiTreeProjection(makeWorld({ action: { bindings: CLICK } }, UISettings));
    const node = useUITreeStore.getState().tree[0];
    // By VALUE: every rebuild allocates a fresh `press` object, and a reference compare would
    // re-render every button on every rebuild (the projection built `node` first, so a missing
    // `_nestedKeys` entry makes `press` a by-reference "scalar" key).
    expect(nodesEqual(node, { ...node, press: { ...node.press! } })).toBe(true);
    expect(nodesEqual(node, { ...node, press: { scale: 1.2, ms: 90 } })).toBe(false);
  });
});
