/** UINode rendering tests (F2/F3) — the CSS builder, text styling, image-variant
 *  resolution, anchor CSS, input/range branches, canvas2D branch, and uiVisualsHidden
 *  had ZERO coverage. This renders UINode into jsdom and asserts on the resulting
 *  DOM/style. Leaf deps (resolveDomImageUrl, applyBindings, resolveTemplate, Canvas2DMount)
 *  are mocked so the suite stays a single React instance and tests UINode in isolation. */
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';

// vi.mock is hoisted above imports — declare the spies via vi.hoisted so the factories
// can close over them without a TDZ error.
const h = vi.hoisted(() => ({
  resolveDomImageUrl: vi.fn((ref: string) => `variant:${ref}`),
  resolveSprite: vi.fn((_ref: string) => undefined as {
    border?: { l: number; r: number; t: number; b: number; scale?: number };
    url?: string; sheetW?: number; sheetH?: number; frame?: { x: number; y: number; w: number; h: number };
  } | undefined),
  applyBindings: vi.fn(),
  resolveTemplate: vi.fn((tpl: string, store: Record<string, unknown>) => `T(${tpl}|${store.score ?? ''})`),
  evalVisibility: vi.fn((_s: Record<string, unknown>, _f: string, _o: string, _v: string) => true),
}));

vi.mock('../../src/runtime/rendering/renderUtils', () => ({
  resolveDomImageUrl: (ref: string) => h.resolveDomImageUrl(ref),
  resolveSprite: (ref: string) => h.resolveSprite(ref),
}));
vi.mock('../../src/runtime/ui/bindings', () => ({
  applyBindings: (...a: unknown[]) => h.applyBindings(...a),
}));
vi.mock('../../src/runtime/ui/bindingResolver', () => ({
  resolveTemplate: (tpl: string, store: Record<string, unknown>) => h.resolveTemplate(tpl, store),
  evalVisibility: (s: Record<string, unknown>, f: string, o: string, v: string) => h.evalVisibility(s, f, o, v),
}));
vi.mock('../../src/runtime/rendering/Canvas2DMount', () => ({
  Canvas2DMount: ({ entityId }: { entityId: number }) =>
    React.createElement('div', { 'data-testid': 'canvas2dmount', 'data-entity-id': entityId }),
}));

import { UINode, cssVal, hexToRgba, hexToColor } from '../../src/runtime/ui/UINode';
import { NineSliceImage } from '../../src/runtime/ui/NineSliceImage';
import type { UINodeData } from '../../src/runtime/ui/uiTreeStore';

afterEach(() => {
  cleanup();
  h.resolveDomImageUrl.mockClear();
  h.resolveSprite.mockClear();
  h.resolveSprite.mockReturnValue(undefined);
  h.applyBindings.mockClear();
  h.resolveTemplate.mockClear();
  h.evalVisibility.mockClear();
  h.evalVisibility.mockReturnValue(true);
});

/** A complete UINodeData with neutral defaults; override per test. */
function makeNode(over: Partial<UINodeData> = {}): UINodeData {
  return {
    entityId: 1, guid: 'g1',
    width: 100, height: 40, widthUnit: 'px', heightUnit: 'px',
    flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'flex-start', alignItems: 'stretch',
    gap: 0, flexGrow: 0, flexShrink: 1,
    paddingTop: 0, paddingTopUnit: 'px', paddingLeft: 0, paddingLeftUnit: 'px',
    paddingRight: 0, paddingRightUnit: 'px', paddingBottom: 0, paddingBottomUnit: 'px',
    marginTop: 0, marginTopUnit: 'px', marginRight: 0, marginRightUnit: 'px',
    marginBottom: 0, marginBottomUnit: 'px', marginLeft: 0, marginLeftUnit: 'px',
    minWidth: 0, minWidthUnit: 'px', maxWidth: 0, maxWidthUnit: 'px',
    minHeight: 0, minHeightUnit: 'px', maxHeight: 0, maxHeightUnit: 'px',
    alignSelf: 'auto', zIndex: 0, overflow: 'visible', isVisible: true,
    backgroundColor: 0, backgroundOpacity: 0, borderRadius: 0, borderWidth: 0, borderColor: 0x333333, borderOpacity: 1, opacity: 1,
    text: '', fontFamily: '', fontSize: 16, fontWeight: 'normal', fontStyle: 'normal',
    textColor: 0xffffff, textOpacity: 1, textAlign: 'left', lineHeight: 0, letterSpacing: 0,
    textShadowColor: 0, textShadowOpacity: 1, textShadowOffsetX: 0, textShadowOffsetY: 0, textShadowBlur: 0,
    textStrokeColor: 0, textStrokeOpacity: 1, textStrokeWidth: 0, textOverflow: 'clip', maxLines: 0,
    imageSrc: '', imageMode: 'cover', elementType: 'div', placeholder: '',
    rangeMin: 0, rangeMax: 100, rangeStep: 1,
    children: [],
    ...over,
  };
}

/** Render a UINode and return its root element. */
function renderNode(node: UINodeData, props: Partial<React.ComponentProps<typeof UINode>> = {}) {
  const { container } = render(
    <UINode node={node} storeState={props.storeState ?? {}} {...props} />,
  );
  return container.firstElementChild as HTMLElement;
}

const styleAttr = (el: Element) => el.getAttribute('style') ?? '';

// ── Pure helpers ──
describe('UINode CSS helpers', () => {
  it('cssVal: 0/falsy → undefined; px → number; % and viewport units → strings', () => {
    expect(cssVal(0, 'px')).toBeUndefined();
    expect(cssVal(100, 'px')).toBe(100);              // px → bare number (React adds 'px')
    expect(cssVal(50, '%')).toBe('50%');
    expect(cssVal(10, 'vw')).toBe('calc(10 * var(--ui-vw, 1vw))');
    expect(cssVal(10, 'vh')).toBe('calc(10 * var(--ui-vh, 1vh))');
    expect(cssVal(10, 'vmin')).toBe('calc(10 * var(--ui-vmin, 1vmin))');
    expect(cssVal(10, 'vmax')).toBe('calc(10 * var(--ui-vmax, 1vmax))');
  });

  it('hexToRgba composes channels + opacity', () => {
    expect(hexToRgba(0xff8040, 0.5)).toBe('rgba(255,128,64,0.5)');
    expect(hexToRgba(0x000000, 1)).toBe('rgba(0,0,0,1)');
  });

  it('hexToColor zero-pads to 6 hex digits', () => {
    expect(hexToColor(0xffffff)).toBe('#ffffff');
    expect(hexToColor(0x0000ff)).toBe('#0000ff');
    expect(hexToColor(0)).toBe('#000000');
  });
});

// ── Box visuals ──
describe('UINode box rendering', () => {
  it('renders nothing when not visible', () => {
    const { container } = render(<UINode node={makeNode({ isVisible: false })} storeState={{}} />);
    expect(container.firstElementChild).toBeNull();
  });

  it('a visibility binding hides the element when evalVisibility is false (and shows it when true)', () => {
    const node = makeNode({ text: 'Over', binding: { textBinding: '', inputBinding: '', visibleBinding: 'gameOver', visibleOp: '', visibleValue: '' } });
    // false → not rendered; evalVisibility called with the store + binding fields.
    h.evalVisibility.mockReturnValueOnce(false);
    const { container: c1 } = render(<UINode node={node} storeState={{ gameOver: false }} />);
    expect(c1.firstElementChild).toBeNull();
    expect(h.evalVisibility).toHaveBeenCalledWith({ gameOver: false }, 'gameOver', '', '');
    cleanup();
    // true → rendered.
    h.evalVisibility.mockReturnValueOnce(true);
    const { container: c2 } = render(<UINode node={node} storeState={{ gameOver: true }} />);
    expect(c2.firstElementChild).not.toBeNull();
  });

  it('no visibility binding ⇒ evalVisibility is not consulted', () => {
    render(<UINode node={makeNode({ text: 'x' })} storeState={{}} />);
    expect(h.evalVisibility).not.toHaveBeenCalled();
  });

  it('editor authoring mode (onSelectEntity) IGNORES the visibility binding — element stays authorable', () => {
    const node = makeNode({ text: 'Over', binding: { textBinding: '', inputBinding: '', visibleBinding: 'gameOver', visibleOp: '', visibleValue: '' } });
    h.evalVisibility.mockReturnValue(false);   // would hide at play time
    const { container } = render(<UINode node={node} storeState={{ gameOver: false }} onSelectEntity={() => {}} />);
    expect(container.firstElementChild).not.toBeNull();   // still rendered (selectable/resizable in editor)
    expect(h.evalVisibility).not.toHaveBeenCalled();      // gate skipped in editor mode
  });

  it('applies background (rgba) only when opacity > 0, border, and opacity', () => {
    const el = renderNode(makeNode({
      backgroundColor: 0xff8040, backgroundOpacity: 0.5,
      borderWidth: 2, borderColor: 0x112233, opacity: 0.25,
    }));
    expect(el.style.backgroundColor).toMatch(/255,\s*128,\s*64/);
    expect(el.style.borderStyle).toBe('solid');
    expect(styleAttr(el)).toMatch(/border-width:\s*2px/);
    expect(el.style.opacity).toBe('0.25');
    // Base flex box invariants
    expect(el.style.boxSizing).toBe('border-box');
    expect(el.style.display).toBe('flex');
  });

  it('omits background entirely when opacity is 0', () => {
    const el = renderNode(makeNode({ backgroundColor: 0xff0000, backgroundOpacity: 0 }));
    expect(el.style.backgroundColor).toBe('');
  });

  it('maps overflow:scroll → auto and makes the container pointer-interactive', () => {
    const el = renderNode(makeNode({ overflow: 'scroll' }));
    expect(el.style.overflow).toBe('auto');
    expect(el.style.pointerEvents).toBe('auto');
  });

  it('disables pointer events on a non-interactive leaf', () => {
    const el = renderNode(makeNode({ children: [] }));
    expect(el.style.pointerEvents).toBe('none');
  });
});

// ── Text ──
describe('UINode text rendering', () => {
  it('renders text and emits lineHeight as explicit px (not a unitless multiplier)', () => {
    const el = renderNode(makeNode({ text: 'Hello', lineHeight: 20, fontSize: 14 }));
    expect(el.textContent).toBe('Hello');
    expect(el.style.lineHeight).toBe('20px');
  });

  it('resolves a text binding through resolveTemplate', () => {
    const el = renderNode(
      makeNode({ text: '{{score}}', binding: { textBinding: 'score', inputBinding: '' } }),
      { storeState: { score: 42 } },
    );
    expect(h.resolveTemplate).toHaveBeenCalledWith('{{score}}', { score: 42 });
    expect(el.textContent).toBe('T({{score}}|42)');
  });

  it('emits -webkit-text-stroke for a text stroke', () => {
    const el = renderNode(makeNode({ text: 'X', textStrokeWidth: 3, textStrokeColor: 0xff0000 }));
    expect(styleAttr(el)).toMatch(/-webkit-text-stroke:\s*3px\s*rgba\(255,\s*0,\s*0,\s*1\)/);
    // NOTE: UINode also sets `paint-order: stroke fill`, but jsdom's CSSOM drops that
    // non-standard property on serialization so it can't be asserted here — the stroke
    // width/color above is the observable signal that the stroke branch ran.
  });

  it('single-line ellipsis: overflow hidden + nowrap + text-overflow ellipsis', () => {
    const el = renderNode(makeNode({ text: 'long', textOverflow: 'ellipsis', maxLines: 0 }));
    expect(el.style.overflow).toBe('hidden');
    expect(el.style.whiteSpace).toBe('nowrap');
    expect(el.style.textOverflow).toBe('ellipsis');
  });

  it('multi-line clamp: -webkit-line-clamp + display:-webkit-box', () => {
    const el = renderNode(makeNode({ text: 'long', maxLines: 3, textOverflow: 'ellipsis' }));
    expect(el.style.display).toBe('-webkit-box');
    expect(styleAttr(el)).toMatch(/-webkit-line-clamp:\s*3/);
    expect(el.style.overflow).toBe('hidden');
    // (`-webkit-box-orient: vertical` is also set but jsdom drops it on serialization.)
  });
});

// ── Image (F3) — the production-only-breakage guard ──
describe('UINode image path (F3)', () => {
  it('routes imageSrc through resolveDomImageUrl (WebP variant), NOT a raw path resolver', () => {
    const el = renderNode(makeNode({ imageSrc: 'tex-guid-123', imageMode: 'cover' }));
    // The hard CLAUDE.md rule: DOM images must resolve via resolveDomImageUrl.
    expect(h.resolveDomImageUrl).toHaveBeenCalledWith('tex-guid-123');
    expect(el.style.backgroundImage).toMatch(/url\(["']?variant:tex-guid-123["']?\)/);
    expect(el.style.backgroundPosition).toBe('center');
    expect(el.style.backgroundRepeat).toBe('no-repeat');
  });

  it('backgroundSize maps imageMode: fill → 100% 100%, none → auto, cover → cover', () => {
    expect(renderNode(makeNode({ imageSrc: 'g', imageMode: 'fill' })).style.backgroundSize).toBe('100% 100%');
    expect(renderNode(makeNode({ imageSrc: 'g', imageMode: 'none' })).style.backgroundSize).toBe('auto');
    expect(renderNode(makeNode({ imageSrc: 'g', imageMode: 'cover' })).style.backgroundSize).toBe('cover');
  });

  it('skips the background when resolveDomImageUrl returns nothing (unresolved guid)', () => {
    h.resolveDomImageUrl.mockReturnValueOnce(undefined as unknown as string);
    const el = renderNode(makeNode({ imageSrc: 'missing' }));
    expect(el.style.backgroundImage).toBe('');
  });

  it('9-slice: a bordered UI sprite renders a 9-cell overlay (NOT border-image / whole-image bg)', () => {
    const GUID = '11111111-1111-4111-8111-111111111111';
    h.resolveSprite.mockReturnValue({ border: { l: 8, r: 8, t: 12, b: 4 }, sheetW: 100, sheetH: 60, frame: { x: 0, y: 0, w: 100, h: 60 } });
    const el = renderNode(makeNode({ imageSrc: GUID, imageMode: 'fill' }));
    const overlay = el.firstElementChild as HTMLElement;        // the injected 9-slice layer
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.style.display).toBe('grid');
    expect(overlay.style.gridTemplateColumns).toBe('8px 1fr 8px');   // l 1fr r (scale 1)
    expect(overlay.style.gridTemplateRows).toBe('12px 1fr 4px');     // t 1fr b
    const inners = Array.from(overlay.querySelectorAll('div')).filter((d) => (d as HTMLElement).style.backgroundImage);
    expect(inners).toHaveLength(9);                             // one background div per slice
    expect((inners[0] as HTMLElement).style.backgroundImage).toMatch(/url\(["']?variant:/);
    expect(el.style.isolation).toBe('isolate');                // overlay stays behind content
    expect(el.style.borderImageSource).toBe('');               // NOT border-image
    expect(el.style.backgroundImage).toBe('');                 // NOT a whole-image background
  });

  it('9-slice edge scale multiplies the fixed corner tracks (grid px)', () => {
    const GUID = '11111111-1111-4111-8111-111111111111';
    h.resolveSprite.mockReturnValue({ border: { l: 8, r: 8, t: 12, b: 4, scale: 0.5 }, sheetW: 100, sheetH: 60, frame: { x: 0, y: 0, w: 100, h: 60 } });
    const el = renderNode(makeNode({ imageSrc: GUID }));
    const overlay = el.firstElementChild as HTMLElement;
    expect(overlay.style.gridTemplateColumns).toBe('4px 1fr 4px');   // 8 × 0.5
    expect(overlay.style.gridTemplateRows).toBe('6px 1fr 2px');      // 12 × 0.5, 4 × 0.5
  });

  it('9-slice falls back to a plain background when the sprite has no source dims (atlas member)', () => {
    const GUID = '11111111-1111-4111-8111-111111111111';
    h.resolveSprite.mockReturnValue({ border: { l: 8, r: 8, t: 12, b: 4 } }); // no sheetW/H/frame
    const el = renderNode(makeNode({ imageSrc: GUID, imageMode: 'fill' }));
    expect(el.firstElementChild).toBeNull();                   // no overlay
    expect(el.style.backgroundImage).toMatch(/url\(["']?variant:/);
  });

  it('a border of all-zero insets falls back to plain background-image', () => {
    const GUID = '11111111-1111-4111-8111-111111111111';
    h.resolveSprite.mockReturnValue({ border: { l: 0, r: 0, t: 0, b: 0 } });
    const el = renderNode(makeNode({ imageSrc: GUID }));
    expect(el.style.borderImageSource).toBe('');
    expect(el.style.backgroundImage).toMatch(/url\(/);
  });
});

// ── Anchor CSS (overlaps F4; full parity test lives in uiAnchorParity) ──
describe('UINode anchor CSS', () => {
  it('center: absolute, top/left 50%, translate(-50%,-50%)', () => {
    const el = renderNode(makeNode({ anchor: anchor({ anchor: 'center', pivotX: 0.5, pivotY: 0.5 }) }));
    expect(el.style.position).toBe('absolute');
    expect(el.style.top).toBe('50%');
    expect(el.style.left).toBe('50%');
    expect(el.style.transform).toBe('translate(-50%, -50%)');
  });

  it('top-left with pivot 0: top/left 0, no transform', () => {
    const el = renderNode(makeNode({ anchor: anchor({ anchor: 'top-left', pivotX: 0, pivotY: 0 }) }));
    expect(el.style.top).toBe('0px');
    expect(el.style.left).toBe('0px');
    expect(el.style.transform).toBe('');
  });

  it('stretch: inset 0, width/height cleared', () => {
    const el = renderNode(makeNode({ width: 100, height: 40, anchor: anchor({ anchor: 'stretch' }) }));
    expect(el.style.inset).toBe('0');   // jsdom serializes the unitless 0
    expect(el.style.width).toBe('');
    expect(el.style.height).toBe('');
  });

  it('offsets: plain value off a 0 base; calc(+/-) off a percentage base', () => {
    // top-left: base left = 0 (falsy) → the offset becomes the plain value.
    const tl = renderNode(makeNode({ anchor: anchor({ anchor: 'top-left', left: 12, leftUnit: 'px' }) }));
    expect(tl.style.left).toBe('12px');
    // 'top': base left = 50% → offset folds into calc(+).
    const top = renderNode(makeNode({ anchor: anchor({ anchor: 'top', left: 12, leftUnit: 'px' }) }));
    expect(top.style.left).toMatch(/calc\(50% \+ 12px\)/);
    // 'right': base left = 100% + a right offset → subtracted (push inward).
    const right = renderNode(makeNode({ anchor: anchor({ anchor: 'right', right: 8, rightUnit: 'px' }) }));
    expect(right.style.left).toMatch(/calc\(100% - 8px\)/);
  });

  // safeArea is STRETCH-GATED + EDGE-AWARE: padding insets a stretched container's
  // children from the notch/home-indicator, so it's emitted only for the edges the
  // element actually reaches, and not at all on a non-stretched element (where it
  // would just inflate the element — the tall-button footgun on a notched iPhone).
  const safeAreaStyle = (a: string) =>
    styleAttr(renderNode(makeNode({ anchor: anchor({ anchor: a as 'stretch', safeArea: true }) })));

  it('safeArea: stretch → all four insets', () => {
    const s = safeAreaStyle('stretch');
    for (const e of ['top', 'bottom', 'left', 'right']) expect(s).toContain(`env(safe-area-inset-${e})`);
    expect(s).toMatch(/max\(0px,\s*env\(safe-area-inset-top\)\)/);
  });
  it('safeArea: v-stretch (full height) → top + bottom only', () => {
    const s = safeAreaStyle('v-stretch');
    expect(s).toContain('env(safe-area-inset-top)');
    expect(s).toContain('env(safe-area-inset-bottom)');
    expect(s).not.toContain('env(safe-area-inset-left)');
    expect(s).not.toContain('env(safe-area-inset-right)');
  });
  it('safeArea: h-stretch (full width band) → left + right only', () => {
    const s = safeAreaStyle('h-stretch');
    expect(s).toContain('env(safe-area-inset-left)');
    expect(s).toContain('env(safe-area-inset-right)');
    expect(s).not.toContain('env(safe-area-inset-top)');
    expect(s).not.toContain('env(safe-area-inset-bottom)');
  });
  it('safeArea: top-stretch bar → top + left + right, NOT bottom', () => {
    const s = safeAreaStyle('top-stretch');
    expect(s).toContain('env(safe-area-inset-top)');
    expect(s).toContain('env(safe-area-inset-left)');
    expect(s).toContain('env(safe-area-inset-right)');
    expect(s).not.toContain('env(safe-area-inset-bottom)');
  });
  it('safeArea: center (non-stretch) → NO safe-area padding (the button footgun)', () => {
    expect(safeAreaStyle('center')).not.toContain('env(safe-area-inset');
  });
  it('safeArea: top-left (non-stretch corner) → NO safe-area padding', () => {
    expect(safeAreaStyle('top-left')).not.toContain('env(safe-area-inset');
  });
});

// ── input / range branches ──
describe('UINode input branch', () => {
  it('renders an <input> with value from inputBinding and dispatches change/submit', () => {
    const node = makeNode({
      elementType: 'input',
      binding: { textBinding: '', inputBinding: 'name' },
      action: { bindings: [{ event: 'change', kind: 'set' } as never] },
    });
    const { container } = render(<UINode node={node} storeState={{ name: 'Ada' }} />);
    const input = container.querySelector('input')!;
    expect(input.value).toBe('Ada');

    fireEvent.change(input, { target: { value: 'Bob' } });
    expect(h.applyBindings).toHaveBeenCalledWith(node.action!.bindings, 'change', { selfGuid: 'g1', eventValue: 'Bob' });

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(h.applyBindings).toHaveBeenCalledWith(node.action!.bindings, 'submit', expect.objectContaining({ selfGuid: 'g1' }));
  });

  it('editor mode (onSelectEntity): input is read-only and click selects the entity', () => {
    const onSelect = vi.fn();
    const node = makeNode({ entityId: 7, elementType: 'input', placeholder: 'type…' });
    const { container } = render(<UINode node={node} storeState={{}} onSelectEntity={onSelect} />);
    const input = container.querySelector('input')!;
    expect(input.readOnly).toBe(true);
    expect(input.placeholder).toBe('type…');
    fireEvent.click(input);
    expect(onSelect).toHaveBeenCalledWith(7);
  });
});

describe('UINode range branch', () => {
  it('renders <input type=range> with value from inputBinding and dispatches numeric change', () => {
    const node = makeNode({
      elementType: 'range', rangeMin: 0, rangeMax: 10, rangeStep: 2,
      binding: { textBinding: '', inputBinding: 'vol' },
      action: { bindings: [{ event: 'change' } as never] },
    });
    const { container } = render(<UINode node={node} storeState={{ vol: 6 }} />);
    const input = container.querySelector('input[type=range]') as HTMLInputElement;
    expect(input.value).toBe('6');
    expect(input.min).toBe('0');
    expect(input.max).toBe('10');
    expect(input.step).toBe('2');

    fireEvent.change(input, { target: { value: '8' } });
    expect(h.applyBindings).toHaveBeenCalledWith(node.action!.bindings, 'change', { selfGuid: 'g1', eventValue: 8 });
  });

  it('clamps a non-finite stored value to rangeMin', () => {
    const node = makeNode({
      elementType: 'range', rangeMin: 3, rangeMax: 10,
      binding: { textBinding: '', inputBinding: 'bad' },
    });
    const { container } = render(<UINode node={node} storeState={{ bad: 'not-a-number' }} />);
    const input = container.querySelector('input[type=range]') as HTMLInputElement;
    expect(input.value).toBe('3'); // Number('not-a-number') is NaN → clamps to rangeMin
  });
});

// ── canvas2D branch ──
describe('UINode canvas2D branch', () => {
  it('runtime mounts the pooled Canvas2DMount with the entityId', async () => {
    const node = makeNode({ entityId: 5, canvas2D: { referenceWidth: 1080, referenceHeight: 1920, scaleMode: 'fitH' } });
    // Canvas2DMount is a flag-gated lazy import (so a 3D-only build DCEs PixiJS), so it
    // mounts asynchronously via Suspense — await it rather than expecting it synchronously.
    const { findByTestId } = render(<UINode node={node} storeState={{}} />);
    const mount = await findByTestId('canvas2dmount');
    expect(mount.getAttribute('data-entity-id')).toBe('5');
  });

  it('dev-warns when Canvas2D coexists with a non-div elementType (F8 — canvas would not mount)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = makeNode({
      entityId: 12, elementType: 'input',
      canvas2D: { referenceWidth: 1, referenceHeight: 1, scaleMode: 'fitH' },
    });
    render(<UINode node={node} storeState={{}} />);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('entity 12'));
    expect(warn.mock.calls[0][0]).toMatch(/will NOT mount/);
    warn.mockRestore();
  });

  it('does NOT warn for a plain Canvas2D (elementType div)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = makeNode({ entityId: 13, canvas2D: { referenceWidth: 1, referenceHeight: 1, scaleMode: 'fitH' } });
    render(<UINode node={node} storeState={{}} />);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('editor uses the injected renderCanvas2D instead of Canvas2DMount', () => {
    const node = makeNode({ entityId: 9, canvas2D: { referenceWidth: 1, referenceHeight: 1, scaleMode: 'fitH' } });
    const renderCanvas2D = vi.fn((id: number) => <div data-testid="injected" data-id={id} />);
    const { getByTestId, queryByTestId } = render(
      <UINode node={node} storeState={{}} onSelectEntity={vi.fn()} renderCanvas2D={renderCanvas2D} />,
    );
    expect(getByTestId('injected').getAttribute('data-id')).toBe('9');
    expect(queryByTestId('canvas2dmount')).toBeNull();
    expect(renderCanvas2D).toHaveBeenCalledWith(9);
  });
});

// ── click + uiVisualsHidden ──
describe('UINode interaction + uiVisualsHidden', () => {
  it('a click-event binding dispatches applyBindings on click', () => {
    const node = makeNode({ action: { bindings: [{ event: 'click' } as never] } });
    const el = renderNode(node);
    expect(el.style.cursor).toBe('pointer');
    fireEvent.click(el);
    expect(h.applyBindings).toHaveBeenCalledWith(node.action!.bindings, 'click', { selfGuid: 'g1' });
  });

  it('uiVisualsHidden strips background/border/text but keeps the layout box', () => {
    const node = makeNode({
      text: 'hi', backgroundColor: 0xff0000, backgroundOpacity: 1, borderWidth: 2, imageSrc: 'g',
    });
    const { container } = render(<UINode node={node} storeState={{}} uiVisualsHidden />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.backgroundColor).toBe('');
    expect(el.style.backgroundImage).toBe('');
    expect(el.style.borderWidth).toBe('');
    expect(el.style.pointerEvents).toBe('none');
    expect(el.textContent).toBe(''); // text blanked
  });
});

/** Anchor block with neutral defaults; override per test. */
function anchor(over: Partial<NonNullable<UINodeData['anchor']>> = {}): NonNullable<UINodeData['anchor']> {
  return {
    anchor: 'center', top: 0, topUnit: 'px', right: 0, rightUnit: 'px',
    bottom: 0, bottomUnit: 'px', left: 0, leftUnit: 'px',
    pivotX: 0, pivotY: 0, safeArea: false, zIndex: 0, ...over,
  };
}

// @vitest-environment jsdom
describe('NineSliceImage — per-slice background math', () => {
  afterEach(cleanup);

  it('emits a 3×3 grid of 9 background cells, corners fixed at inset×scale', () => {
    const { container } = render(
      <NineSliceImage url="u" imgW={100} imgH={60} frame={{ x: 0, y: 0, w: 100, h: 60 }} l={8} r={8} t={12} b={4} scale={1} />,
    );
    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay.style.gridTemplateColumns).toBe('8px 1fr 8px');
    expect(overlay.style.gridTemplateRows).toBe('12px 1fr 4px');
    const inners = Array.from(overlay.querySelectorAll('div')).filter((d) => (d as HTMLElement).style.backgroundImage);
    expect(inners).toHaveLength(9);
  });

  it('positions each slice via the responsive-sprite %% trick (corner 0/0, center from insets)', () => {
    const { container } = render(
      <NineSliceImage url="u" imgW={100} imgH={60} frame={{ x: 0, y: 0, w: 100, h: 60 }} l={8} r={8} t={12} b={4} scale={1} />,
    );
    const overlay = container.firstElementChild as HTMLElement;
    const inners = Array.from(overlay.querySelectorAll('div')).filter((d) => (d as HTMLElement).style.backgroundImage) as HTMLElement[];
    // Order: tl tc tr ml mc mr bl bc br
    expect(inners[0].style.backgroundPosition).toBe('0% 0%');       // top-left corner
    // center: sx=8 sw=84 → 8/(100-84)=50%; sy=12 sh=44 → 12/(60-44)=75%
    expect(inners[4].style.backgroundPosition).toBe('50% 75%');
    // center size: 100/84 & 60/44 as %
    expect(inners[4].style.backgroundSize).toBe(`${(100 / 84) * 100}% ${(60 / 44) * 100}%`);
  });
});
