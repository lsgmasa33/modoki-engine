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

vi.mock('../../src/runtime/core/textureRefs', () => ({
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
  // Surfaces applyWebSizeMode so the runtime-vs-editor sizeMode contract (#38) is assertable.
  Canvas2DMount: ({ entityId, applyWebSizeMode }: { entityId: number; applyWebSizeMode?: boolean }) =>
    React.createElement('div', {
      'data-testid': 'canvas2dmount',
      'data-entity-id': entityId,
      'data-web-size-mode': String(!!applyWebSizeMode),
    }),
}));

vi.mock('../../src/runtime/video/UIVideoMount', () => ({
  // Surfaces `fit` and `priority` so the game-outranks-the-authoring-viewport rule is
  // assertable from the CALL SITE — UIVideoMount's own tests can only see what it is handed.
  UIVideoMount: ({ entityId, fit, priority }: { entityId: number; fit?: string; priority?: number }) =>
    React.createElement('div', {
      'data-testid': 'uivideomount',
      'data-entity-id': entityId,
      'data-fit': fit,
      'data-priority': String(priority),
    }),
}));

import { UINode, cssVal, hexToRgba, hexToColor } from '../../src/runtime/ui/UINode';
import { NineSliceImage } from '../../src/runtime/ui/NineSliceImage';
import { UI_PAINT_ATTR } from '../../src/runtime/ui/uiPaintMarker';
import { isPaintOpaque } from '../../src/editor/panels/uiPreviewPick';
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
    gap: 0, gapUnit: 'px', flexGrow: 0, flexShrink: 1,
    paddingTop: 0, paddingTopUnit: 'px', paddingLeft: 0, paddingLeftUnit: 'px',
    paddingRight: 0, paddingRightUnit: 'px', paddingBottom: 0, paddingBottomUnit: 'px',
    marginTop: 0, marginTopUnit: 'px', marginRight: 0, marginRightUnit: 'px',
    marginBottom: 0, marginBottomUnit: 'px', marginLeft: 0, marginLeftUnit: 'px',
    minWidth: 0, minWidthUnit: 'px', maxWidth: 0, maxWidthUnit: 'px',
    minHeight: 0, minHeightUnit: 'px', maxHeight: 0, maxHeightUnit: 'px',
    alignSelf: 'auto', zIndex: 0, rotation: 0, overflow: 'visible', isVisible: true, pointerThrough: false,
    scrollbarStyle: 'auto', scrollbarThumbColor: 0x888888, scrollbarTrackColor: 0xdddddd,
    backgroundColor: 0, backgroundOpacity: 0, borderRadius: 0, borderWidth: 0, borderColor: 0x333333, borderOpacity: 1, opacity: 1,
    text: '', fontFamily: '', fontSize: 16, fontSizeUnit: 'px', fontWeight: 'normal', fontStyle: 'normal',
    textColor: 0xffffff, textOpacity: 1, textAlign: 'left', lineHeight: 0, letterSpacing: 0, letterSpacingUnit: 'px',
    textShadowColor: 0, textShadowOpacity: 1, textShadowOffsetX: 0, textShadowOffsetY: 0, textShadowBlur: 0,
    textStrokeColor: 0, textStrokeOpacity: 1, textStrokeWidth: 0, textOverflow: 'clip', maxLines: 0,
    imageSrc: '', imageMode: 'cover', imageEpoch: 0, hasVideo: false, elementType: 'div', placeholder: '',
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

// ── Font family ──
describe('UINode fontFamily is emitted on containers, not only on text nodes', () => {
  /**
   * `font-family` inherits, so authoring it on a container is how a whole UI tree gets one
   * typeface from ONE field. It used to be written only inside the `if (text)` branch, which
   * silently dropped a container's authored family — and the only remaining way to restyle a
   * scene was to repeat the family on every text node (41 of them in Court).
   *
   * The regression is invisible without this test: the container still renders, the field is
   * still in the Inspector, and the text still has A font. Only the wrong one.
   */
  it('a container with no text still emits its authored family, so descendants inherit it', () => {
    const { container } = render(<UINode node={makeNode({ text: '', fontFamily: 'Varela Round' })} storeState={{}} />);
    expect((container.firstElementChild as HTMLElement).style.fontFamily).toContain('Varela Round');
  });

  it('a text node still emits its own family', () => {
    const { container } = render(<UINode node={makeNode({ text: 'hi', fontFamily: 'Varela Round' })} storeState={{}} />);
    expect((container.firstElementChild as HTMLElement).style.fontFamily).toContain('Varela Round');
  });

  it('an unauthored family is left alone, so the inherited one wins', () => {
    const { container } = render(<UINode node={makeNode({ text: 'hi', fontFamily: '' })} storeState={{}} />);
    expect((container.firstElementChild as HTMLElement).style.fontFamily).toBe('');
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

  /**
   * The scrollbar skin (#347). Only the STANDARDS properties exist here: these are inline styles,
   * and `::-webkit-scrollbar` is a pseudo-element that cannot be written inline at all — so
   * `scrollbar-color` / `scrollbar-width` is the whole surface. jsdom keeps both as plain CSS
   * strings, which is exactly what is being asserted: that the right declaration is emitted.
   */
  describe('scrollbarStyle', () => {
    it('emits nothing by default, so an untouched element keeps the platform bar', () => {
      const el = renderNode(makeNode({ overflow: 'scroll' }));
      expect(el.style.scrollbarWidth, 'auto must stay the platform default').toBe('');
      expect(el.style.scrollbarColor).toBe('');
    });

    it('tinted emits scrollbar-color as thumb-then-track, plus a thin bar', () => {
      const el = renderNode(makeNode({
        overflow: 'scroll', scrollbarStyle: 'tinted',
        scrollbarThumbColor: 0x8fa3b0, scrollbarTrackColor: 0xdfe7ec,
      }));
      expect(el.style.scrollbarWidth).toBe('thin');
      // Order is load-bearing: CSS reads `scrollbar-color: <thumb> <track>`, and swapping them
      // renders a dark track under a pale thumb — the exact inverse of the intent, and something
      // no screenshot-free check would otherwise catch.
      expect(el.style.scrollbarColor).toBe('#8fa3b0 #dfe7ec');
    });

    it('hidden removes the bar without disabling the scroll', () => {
      const el = renderNode(makeNode({ overflow: 'scroll', scrollbarStyle: 'hidden' }));
      expect(el.style.scrollbarWidth).toBe('none');
      expect(el.style.overflow, 'it must still be a scroll container').toBe('auto');
    });

    /**
     * ⚠️ The gate that keeps an authored value from being a lie. A tint on an element that never
     * scrolls would sit in the Inspector doing nothing — the "field nothing reads" trap — so the
     * skin is tied to the one property that causes a bar to exist.
     */
    it('is inert unless the element actually is a scroll container', () => {
      for (const overflow of ['visible', 'hidden']) {
        const el = renderNode(makeNode({
          overflow, scrollbarStyle: 'tinted', scrollbarThumbColor: 0x8fa3b0,
        }));
        expect(el.style.scrollbarColor, `overflow:${overflow} must not be skinned`).toBe('');
      }
    });
  });
});

// ── pointerThrough ──
// The field exists for ONE shape the structural rules cannot express: a decorative CONTAINER
// drawn over something that must stay tappable. Court's narration band is the worked example —
// a panel holding a Skip button, over a full-screen tap-catcher. Every test here is a way the
// field was silently doing nothing, or doing too much, when it first landed.
describe('UINode pointerThrough', () => {
  it('wins over the container default, so a decorative panel does not eat taps', () => {
    // A container (children.length > 0) is `auto` by default so events reach its children — which
    // is exactly what made the band swallow every tap meant for the catcher underneath it.
    const el = renderNode(makeNode({ pointerThrough: true, children: [makeNode({ entityId: 2 })] }));
    expect(el.style.pointerEvents).toBe('none');
  });

  it('wins over the overflow:scroll force, which is the case that motivated it', () => {
    // `overflow:'scroll'` pins an element to `auto` so it can be scrolled — and the band is a
    // scroll container. Without this precedence the field is inert on precisely the element it
    // was added for.
    const el = renderNode(makeNode({ pointerThrough: true, overflow: 'scroll' }));
    expect(el.style.pointerEvents).toBe('none');
  });

  it('clears the cursor, so nothing paints a finger over an element that cannot be clicked', () => {
    const el = renderNode(makeNode({
      pointerThrough: true,
      action: { bindings: [{ event: 'click', kind: 'call', action: 'x' }] },
    } as Partial<UINodeData>));
    expect(el.style.cursor).toBe('');
  });

  it('does NOT apply in the editor, or the element can only be selected from the hierarchy', () => {
    // `onSelectEntity` is the editor's click-to-select mode, and it deliberately makes every
    // element clickable so the author can pick it in the viewport. That is authoring, not
    // gameplay. Ungated, this made a decorative container unselectable in the SceneView — the
    // exact element type the field exists for.
    const el = renderNode(makeNode({ pointerThrough: true }), { onSelectEntity: () => {} });
    expect(el.style.pointerEvents).toBe('auto');
  });

  it('is not silently undone by an <input>, which re-enables the pointer after it', () => {
    // The input branch runs AFTER the pointerThrough block and used to set `auto` unconditionally,
    // so the field read as supported on an input and did nothing — the silent-no-op class.
    const el = renderNode(makeNode({ pointerThrough: true, elementType: 'input' } as Partial<UINodeData>));
    expect(el.style.pointerEvents).toBe('none');
  });

  it('is not silently undone by a range slider either', () => {
    const el = renderNode(makeNode({ pointerThrough: true, elementType: 'range' } as Partial<UINodeData>));
    expect(el.style.pointerEvents).toBe('none');
  });

  it('leaves everything alone when false — the default is the pre-existing behaviour', () => {
    expect(renderNode(makeNode({ overflow: 'scroll' })).style.pointerEvents).toBe('auto');
    expect(renderNode(makeNode({ elementType: 'input' } as Partial<UINodeData>)).style.pointerEvents).toBe('auto');
  });
});

// ── gapUnit ──
// `gap` was the only length on UIElement with no unit. A wrap-based grid whose ITEMS scale (vh)
// while its GAPS do not has a viewport size below which an item silently reflows onto the next
// row — which is how Court's 5x5 attack reference started drawing 4-wide and 7 rows deep.
describe('UINode gapUnit', () => {
  it('emits a viewport-unit gap through the UI container custom property', () => {
    const el = renderNode(makeNode({ gap: 1.5, gapUnit: 'vh' }));
    expect(el.style.gap).toBe('calc(1.5 * var(--ui-vh, 1vh))');
  });

  it('still emits a bare px gap when the unit is px, which every pre-existing scene relies on', () => {
    // Scene files authored before this field existed carry `gap` and no `gapUnit`; the trait
    // default fills it as 'px', so their rendered gap must not move.
    expect(renderNode(makeNode({ gap: 8, gapUnit: 'px' })).style.gap).toBe('8px');
  });

  it('emits nothing for a zero gap regardless of unit', () => {
    expect(renderNode(makeNode({ gap: 0, gapUnit: 'vh' })).style.gap).toBe('');
  });
});

// ── Text ──
describe('UINode text rendering', () => {
  it('renders text and emits lineHeight as explicit px (not a unitless multiplier)', () => {
    const el = renderNode(makeNode({ text: 'Hello', lineHeight: 20, fontSize: 14 }));
    expect(el.textContent).toBe('Hello');
    expect(el.style.lineHeight).toBe('20px');
  });

  /** #245 — text-sized content must be able to scale with the viewport, like every other length
   *  on UIElement already can. Court's main menu overflowed its percentage-height paper page below
   *  a ~975px window because three text-sized buttons could not shrink with it. */
  it('emits fontSize through the --ui-* custom properties when fontSizeUnit is not px', () => {
    const el = renderNode(makeNode({ text: 'Hello', fontSize: 4, fontSizeUnit: 'vmin' }));
    expect(el.style.fontSize).toBe('calc(4 * var(--ui-vmin, 1vmin))');
  });

  it('a px fontSize is emitted unchanged — the default cannot re-lay-out existing UI', () => {
    // The whole safety of #245 rests on this: `fontSizeUnit` defaults to 'px', and px must go out
    // as the bare number it always was. A regression here silently re-sizes every authored screen.
    const el = renderNode(makeNode({ text: 'Hello', fontSize: 14, fontSizeUnit: 'px' }));
    expect(el.style.fontSize).toBe('14px');
  });

  /** #245 sibling — tracking is only meaningful as a RATIO of the glyph size, so a px
   *  letterSpacing under a scaling fontSize says something different at every viewport. Court's
   *  menu title measured 0.130em of tracking at its reference size and 0.261em at a 480px window
   *  from the SAME authored 7px, because only the font shrank. */
  it('emits letterSpacing through the --ui-* custom properties when its unit is not px', () => {
    const el = renderNode(makeNode({ text: 'Hello', letterSpacing: 1.14, letterSpacingUnit: 'vh' }));
    expect(el.style.letterSpacing).toBe('calc(1.14 * var(--ui-vh, 1vh))');
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
    // jsdom 30 serializes the `background-position` shorthand spec-correctly as two axes
    // ('center' → 'center center'); jsdom 26 echoed the input. The assertion is about the image
    // being CENTRED, not about which spelling the environment round-trips, so accept both.
    expect(el.style.backgroundPosition).toMatch(/^center( center)?$/);
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

  // #337 close-out (opus-reviewer, 2nd pass): the SceneView editor's click arbiter
  // (`isPaintOpaque`, `editor/panels/uiPreviewPick.ts`) reads the `data-ui-paint` marker
  // `NineSliceImage` stamps to know a 9-sliced host paints something even with no CSS
  // background of its own. Every earlier test for this marker hand-built a `<div>` and set the
  // attribute directly — asserting the CONSUMER against a fixture of the test's own making, not
  // against what `UINode` actually renders. A prior mutation check found that stripping the
  // marker from all four real producers left `npm run verify` fully green, because nothing tied
  // producer to consumer. This test renders the REAL `UINode` → `NineSliceImage` path and feeds
  // its REAL output into the REAL `isPaintOpaque` — it fails if either side of that contract
  // (the attribute name, or where it gets stamped) drifts.
  it('a real 9-sliced UINode host is opaque to the SceneView click arbiter, via the REAL NineSliceImage marker', () => {
    const GUID = '11111111-1111-4111-8111-111111111111';
    h.resolveSprite.mockReturnValue({ border: { l: 8, r: 8, t: 12, b: 4 }, sheetW: 100, sheetH: 60, frame: { x: 0, y: 0, w: 100, h: 60 } });
    const el = renderNode(makeNode({ imageSrc: GUID, imageMode: 'fill' }));
    const overlay = el.firstElementChild as HTMLElement;
    expect(overlay.getAttribute(UI_PAINT_ATTR)).toBe('nine-slice');
    expect(isPaintOpaque(el)).toBe(true);
  });

  // #337 close-out: while a TextAnimation plays, `AnimatedText` wraps the text in its OWN
  // <span> — the text is no longer a direct text-node child of the host `isPaintOpaque`'s
  // generic check looks at, which is exactly why the marker exists for this path too. Same
  // real-producer-into-real-consumer shape as the 9-slice test above.
  it('a real UINode host with a playing TextAnimation is opaque, via the REAL AnimatedText marker', () => {
    const el = renderNode(makeNode({
      text: 'Score: 12',
      textAnim: { effect: 'fade', speed: 1, amplitude: 0.1, frequency: 1, loop: false, fadeIn: true },
    }));
    const span = el.querySelector(`[${UI_PAINT_ATTR}="text"]`);
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe('Score: 12');
    expect(isPaintOpaque(el)).toBe(true);
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

  it('stretch: four edge longhands (NOT the inset shorthand), width/height cleared', () => {
    const el = renderNode(makeNode({ width: 100, height: 40, anchor: anchor({ anchor: 'stretch' }) }));
    // Deliberately longhands: the offset block writes style.right/style.bottom, which
    // against a shorthand would only win by declaration ORDER. See anchorCss.ts.
    expect([el.style.top, el.style.right, el.style.bottom, el.style.left])
      .toEqual(['0px', '0px', '0px', '0px']);
    expect(el.style.cssText).not.toContain('inset');
    expect(el.style.width).toBe('');
    expect(el.style.height).toBe('');
  });

  // A STRETCHED axis pins both edges, so each offset insets ITS OWN edge and the box
  // shrinks — `left` + `right` are side margins, not two descriptions of one edge.
  // (Until 2026-07-31 both folded into the near edge, so they cancelled to full-bleed.)
  it('stretched axis: left/right land on their own edges and do not cancel', () => {
    const el = renderNode(makeNode({
      anchor: anchor({ anchor: 'bottom-stretch', left: 5, leftUnit: '%', right: 5, rightUnit: '%' }),
    }));
    expect(el.style.left).toBe('5%');
    expect(el.style.right).toBe('5%');
    expect(el.style.left).not.toContain('calc');
  });

  it('stretched axis: top/bottom inset vertically on a v-stretched mode', () => {
    const el = renderNode(makeNode({
      anchor: anchor({ anchor: 'left-stretch', top: 12, topUnit: 'px', bottom: 20, bottomUnit: 'px' }),
    }));
    expect(el.style.top).toBe('12px');
    expect(el.style.bottom).toBe('20px');
  });

  it('non-stretched axis keeps point semantics: a far-edge offset folds into the near edge', () => {
    // bottom-stretch stretches X only, so `bottom` must still SHIFT rather than inset.
    const el = renderNode(makeNode({
      anchor: anchor({ anchor: 'bottom-stretch', bottom: 30, bottomUnit: 'px' }),
    }));
    expect(el.style.top).toMatch(/calc\(100% - 30px\)/);
    expect(el.style.bottom).toBe('');
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
    expect(s).toMatch(/max\(0px,\s*var\(--ui-sa-top,\s*env\(safe-area-inset-top\)\)\)/);
  });

  // The inset is emitted as `var(--ui-sa-*, env(...))`, not a bare `env()`. Both halves
  // are load-bearing and this pins BOTH: the var is what lets an editor device preview
  // simulate a notch (desktop `env()` is always 0, which is why a notched-phone layout
  // was structurally invisible in the editor — #271), and the `env()` fallback is what
  // every shipped build actually runs, since nothing sets the var there. Dropping the
  // fallback would silently zero the safe area on real hardware.
  it('safeArea: each edge is an overridable var with the real env() as its fallback', () => {
    const s = safeAreaStyle('stretch');
    for (const e of ['top', 'bottom', 'left', 'right']) {
      expect(s).toContain(`var(--ui-sa-${e}, env(safe-area-inset-${e}))`);
    }
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
  it('safeArea: center reaches no edge → a genuine no-op, padding AND offset', () => {
    expect(safeAreaStyle('center')).not.toContain('env(safe-area-inset');
  });

  // A POINT anchor takes the inset as an OFFSET, never as padding (#272). Padding would
  // inflate the element — a 44pt gear anchored top-right renders 106pt tall on a notched
  // iPhone with its glyph shoved to the bottom — which is why the padding arm is
  // stretch-gated. This used to assert "no safe area AT ALL" on a corner, and that was
  // the defect wearing a test: a corner-anchored badge then had no way to clear the
  // camera, and the Inspector greyed the checkbox out to say so.
  const parsed = (a: string) => {
    const s = safeAreaStyle(a);
    return { style: s, hasPadding: /padding[^;]*safe-area-inset/.test(s) };
  };
  it('safeArea: top-left corner → offsets top and left, and pads NOTHING', () => {
    const { style, hasPadding } = parsed('top-left');
    expect(hasPadding).toBe(false);
    expect(style).toContain('var(--ui-sa-top, env(safe-area-inset-top))');
    expect(style).toContain('var(--ui-sa-left, env(safe-area-inset-left))');
    expect(style).not.toContain('safe-area-inset-bottom');
    expect(style).not.toContain('safe-area-inset-right');
  });
  it('safeArea: bottom-right corner → offsets bottom and right only', () => {
    const { style, hasPadding } = parsed('bottom-right');
    expect(hasPadding).toBe(false);
    expect(style).toContain('var(--ui-sa-bottom, env(safe-area-inset-bottom))');
    expect(style).toContain('var(--ui-sa-right, env(safe-area-inset-right))');
    expect(style).not.toContain('safe-area-inset-top');
    expect(style).not.toContain('safe-area-inset-left');
  });

  // The exclusivity is the anti-double-inset guarantee: every anchor takes exactly one
  // arm. A stretched anchor pads (its CHILDREN move, its own box does not), a point
  // anchor offsets (its box moves, its size does not), and none does both.
  it('no anchor takes BOTH arms — padding and offset are mutually exclusive', () => {
    const MODES = ['stretch', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right',
      'bottom-left', 'bottom-right', 'center', 'top-stretch', 'bottom-stretch',
      'left-stretch', 'right-stretch', 'h-stretch', 'v-stretch'];
    for (const m of MODES) {
      const s = safeAreaStyle(m);
      const pads = /padding[^;]*safe-area-inset/.test(s);
      // An offset is a safe-area term reached through top/left rather than a padding.
      const offsets = /(^|;)\s*(top|left):[^;]*safe-area-inset/.test(s);
      expect(pads && offsets, `${m} took both arms`).toBe(false);
    }
  });

  // The authored offset is composed with, not replaced: `top: 4vmin` on a notched phone
  // must mean "4vmin BELOW the notch", which is what whoever wrote 4vmin meant.
  it('safeArea composes with an authored offset instead of overwriting it', () => {
    const s = styleAttr(renderNode(makeNode({
      anchor: anchor({ anchor: 'top-right', safeArea: true, top: 4, topUnit: 'vmin' }),
    })));
    expect(s).toMatch(/top:\s*calc\([^;]*--ui-vmin[^;]*\+\s*var\(--ui-sa-top/);
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

// ── toggle branch ──
// The FIRST control that draws more than one DOM node from one entity — root is the
// track (carrying the standard `style`), the single child is the knob. See the UIToggle
// trait header + the branch's own comment in UINode.tsx for the design.
describe('UINode toggle branch', () => {
  it('renders a track containing exactly one child (the knob)', () => {
    const el = renderNode(makeNode({ toggle: toggle() }));
    expect(el.children).toHaveLength(1);
  });

  it('role=switch, aria-checked follows value (both states)', () => {
    const off = renderNode(makeNode({ guid: 'tg-1', toggle: toggle({ value: false }) }));
    expect(off.getAttribute('role')).toBe('switch');
    expect(off.getAttribute('aria-checked')).toBe('false');
    cleanup();
    const on = renderNode(makeNode({ guid: 'tg-2', toggle: toggle({ value: true }) }));
    expect(on.getAttribute('aria-checked')).toBe('true');
  });

  it('justifyContent flips with value: flex-end when on, flex-start when off', () => {
    const off = renderNode(makeNode({ guid: 'tg-3', toggle: toggle({ value: false }) }));
    expect(off.style.justifyContent).toBe('flex-start');
    cleanup();
    const on = renderNode(makeNode({ guid: 'tg-4', toggle: toggle({ value: true }) }));
    expect(on.style.justifyContent).toBe('flex-end');
  });

  it('track background uses trackOnColor when on, trackOffColor when off', () => {
    // jsdom's CSSOM drops alpha 1 down to rgb(...), so match channels rather than the
    // exact rgba() string hexToRgba produces (same idiom as the box-rendering test above).
    const off = renderNode(makeNode({
      guid: 'tg-5', toggle: toggle({ value: false, trackOnColor: 0x00ff00, trackOffColor: 0xff0000, trackOpacity: 1 }),
    }));
    expect(off.style.backgroundColor).toMatch(/255,\s*0,\s*0/);
    cleanup();
    const on = renderNode(makeNode({
      guid: 'tg-6', toggle: toggle({ value: true, trackOnColor: 0x00ff00, trackOffColor: 0xff0000, trackOpacity: 1 }),
    }));
    expect(on.style.backgroundColor).toMatch(/0,\s*255,\s*0/);
  });

  it('clicking with a change binding calls applyBindings with the NEGATED value — both starting states', () => {
    const offNode = makeNode({
      guid: 'tg-7', toggle: toggle({ value: false }),
      action: { bindings: [{ event: 'change', kind: 'set' } as never] },
    });
    const offEl = renderNode(offNode);
    fireEvent.click(offEl);
    expect(h.applyBindings).toHaveBeenCalledWith(offNode.action!.bindings, 'change', { selfGuid: 'tg-7', eventValue: true });
    cleanup();

    const onNode = makeNode({
      guid: 'tg-8', toggle: toggle({ value: true }),
      action: { bindings: [{ event: 'change', kind: 'set' } as never] },
    });
    const onEl = renderNode(onNode);
    fireEvent.click(onEl);
    expect(h.applyBindings).toHaveBeenCalledWith(onNode.action!.bindings, 'change', { selfGuid: 'tg-8', eventValue: false });
  });

  // ⚠️ This test asserted the OPPOSITE until 2026-08-20, under the name "a click binding (not just
  // change) also fires the toggle" — and it passed, because `applyBindings` is mocked in this file,
  // so it only ever proved that UINode CALLED the mock with 'change'. The real `applyBindings`
  // skips every row whose own `event` differs from the dispatched one (pinned independently by
  // `bindings.test.ts` § "only runs bindings whose event matches"), so a 'click'-only toggle could
  // never move — while the mocked test vouched for it. A reinstated "click works" expectation here
  // is a regression, not a fix.
  it('a click-ONLY binding cannot move the toggle: it is inert and warns as dead', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = makeNode({
      guid: 'tg-9', toggle: toggle({ value: false }),
      action: { bindings: [{ event: 'click', kind: 'set' } as never] },
    });
    // try/finally, not a trailing `mockRestore()`: this file's other warn tests restore at the END
    // OF THE BODY, so a failing assertion leaks the console.warn spy into every later test in the
    // file. Measured while mutation-testing this very block — one real failure cascaded into three
    // unrelated warning tests and made the signal unreadable twice.
    try {
      const el = renderNode(node);
      fireEvent.click(el);
      // Not interactive, so nothing is dispatched at all — the click cannot silently half-work.
      expect(h.applyBindings).not.toHaveBeenCalled();
      // And the author is TOLD, naming the event mistake the Inspector's 'click' default leads to.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("'click' binding will NOT work");
    } finally {
      warn.mockRestore();
    }
  });

  it('a toggle drops a Canvas2D and any children — and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = makeNode({
      guid: 'tg-drop', toggle: toggle({ value: false }),
      action: { bindings: [{ event: 'change', kind: 'set' } as never] },
      canvas2D: { referenceWidth: 100, referenceHeight: 100, scaleMode: 'contain' },
      children: [makeNode({ guid: 'tg-drop-kid' })],
    });
    try {
      const el = renderNode(node);
      // Only the knob renders — the child never mounts.
      expect(el.querySelectorAll('[data-entity-id]').length).toBe(0);
      const msgs = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msgs).toContain('UIToggle draws only a track and a knob');
      expect(msgs).toContain('its Canvas2D');
      expect(msgs).toContain('child');
    } finally {
      warn.mockRestore();
    }
  });

  it('disabled: no applyBindings call on click, and aria-disabled is set', () => {
    const node = makeNode({
      guid: 'tg-10', toggle: toggle({ value: false, disabled: true }),
      action: { bindings: [{ event: 'change', kind: 'set' } as never] },
    });
    const el = renderNode(node);
    expect(el.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(el);
    expect(h.applyBindings).not.toHaveBeenCalled();
  });

  it('no bindings at all: no applyBindings call on click', () => {
    const el = renderNode(makeNode({ guid: 'tg-11', toggle: toggle({ value: false }) }));
    fireEvent.click(el);
    expect(h.applyBindings).not.toHaveBeenCalled();
  });

  it('keyboard: Space and Enter fire the same applyBindings call; another key does not', () => {
    const node = makeNode({
      guid: 'tg-12', toggle: toggle({ value: false }),
      action: { bindings: [{ event: 'change', kind: 'set' } as never] },
    });
    const el = renderNode(node);
    fireEvent.keyDown(el, { key: ' ' });
    expect(h.applyBindings).toHaveBeenCalledWith(node.action!.bindings, 'change', { selfGuid: 'tg-12', eventValue: true });
    h.applyBindings.mockClear();

    fireEvent.keyDown(el, { key: 'Enter' });
    expect(h.applyBindings).toHaveBeenCalledWith(node.action!.bindings, 'change', { selfGuid: 'tg-12', eventValue: true });
    h.applyBindings.mockClear();

    fireEvent.keyDown(el, { key: 'a' });
    expect(h.applyBindings).not.toHaveBeenCalled();
  });

  it('editor mode: clicking selects the entity and does NOT call applyBindings', () => {
    const onSelect = vi.fn();
    const node = makeNode({
      entityId: 30, guid: 'tg-13', toggle: toggle({ value: false }),
      action: { bindings: [{ event: 'change', kind: 'set' } as never] },
    });
    const el = renderNode(node, { onSelectEntity: onSelect });
    fireEvent.click(el);
    expect(onSelect).toHaveBeenCalledWith(30);
    expect(h.applyBindings).not.toHaveBeenCalled();
  });

  it('dev-warns once when a toggle has no change/click binding, and dedupes per guid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = makeNode({ guid: 'tg-dead-1', toggle: toggle({ value: false }) });
    render(<UINode node={node} storeState={{}} />);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('UIToggle');
    cleanup();

    // Same guid again → dedupe suppresses the second warning.
    render(<UINode node={node} storeState={{}} />);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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

  it('runtime opts INTO rendering.web.sizeMode — the shipped-game/GameView surface (#38)', async () => {
    // Pairs with the editor case below: the `max` buffer clamp must reach the shipped game
    // (matching Scene3D, which clamps the 3D layer on this same surface) and must NOT reach
    // the editor SceneView viewport, which sizes itself / uses device presets. The prop
    // defaults to false, so this is the call site that has to opt in — if it stops passing
    // applyWebSizeMode, `max` silently goes back to doing nothing on the 2D layer.
    const node = makeNode({ entityId: 7, canvas2D: { referenceWidth: 1080, referenceHeight: 1920, scaleMode: 'fitH' } });
    const { findByTestId } = render(<UINode node={node} storeState={{}} />);
    expect((await findByTestId('canvas2dmount')).getAttribute('data-web-size-mode')).toBe('true');
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

  // ── Video in a UI node ──────────────────────────────────────────────────────────────
  // The other half of the `hasVideo` seam (uiTreeReuse.test.ts drives the projection half).
  it('mounts the video into the node box when hasVideo, carrying imageMode as the fit', async () => {
    const node = makeNode({ entityId: 21, hasVideo: true, imageMode: 'contain' });
    const { findByTestId } = render(<UINode node={node} storeState={{}} />);
    const mount = await findByTestId('uivideomount');
    expect(mount.getAttribute('data-entity-id')).toBe('21');
    expect(mount.getAttribute('data-fit')).toBe('contain');
  });

  it('mounts the video from the Canvas2D branch too (a separate early return)', async () => {
    // `videoLayer` is injected into TWO returns. Mutation-testing the plain-div one leaves the
    // canvas2D one green, so it needs its own case: a 2D-canvas node over a video backdrop is
    // exactly Court's shape.
    const node = makeNode({
      entityId: 25, hasVideo: true,
      canvas2D: { referenceWidth: 1080, referenceHeight: 1920, scaleMode: 'fitH' },
    });
    const { findByTestId } = render(<UINode node={node} storeState={{}} />);
    expect((await findByTestId('uivideomount')).getAttribute('data-entity-id')).toBe('25');
  });

  it('does not mount a video when hasVideo is false', () => {
    const { queryByTestId } = render(<UINode node={makeNode({ hasVideo: false })} storeState={{}} />);
    expect(queryByTestId('uivideomount')).toBeNull();
  });

  it('the running game outranks the editor authoring viewport for the one element', async () => {
    // There is ONE <video> per clip and a DOM node exists in one place, so with the editor's
    // Game and Scene panels both mounting the UI tree, priority is what stops the last host to
    // tick from winning ("the video plays only on Scene view, not on the game view").
    // `onSelectEntity` is the discriminator — set only on SceneView.
    const node = makeNode({ entityId: 22, hasVideo: true });
    const game = render(<UINode node={node} storeState={{}} />);
    expect((await game.findByTestId('uivideomount')).getAttribute('data-priority')).toBe('1');
    cleanup();
    const editor = render(<UINode node={node} storeState={{}} onSelectEntity={vi.fn()} />);
    expect((await editor.findByTestId('uivideomount')).getAttribute('data-priority')).toBe('0');
  });

  it('suppresses the video with the other UI visuals (uiVisualsHidden)', () => {
    const { queryByTestId } = render(
      <UINode node={makeNode({ hasVideo: true })} storeState={{}} uiVisualsHidden />,
    );
    expect(queryByTestId('uivideomount')).toBeNull();
  });

  it('dev-warns when a VideoPlayer sits on a non-div elementType (picture would not mount)', () => {
    // Same class as F8: an <input> is a void element, so `videoLayer` has nowhere to go and
    // the clip decodes with audio on the bus and no picture at all.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<UINode node={makeNode({ entityId: 23, hasVideo: true, elementType: 'input' })} storeState={{}} />);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('entity 23'));
    expect(warn.mock.calls[0][0]).toMatch(/cannot host a video/);
    warn.mockRestore();
  });

  it('does NOT warn for a video on a plain div', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<UINode node={makeNode({ entityId: 24, hasVideo: true })} storeState={{}} />);
    expect(warn).not.toHaveBeenCalled();
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
    // #38: the editor branch takes over ENTIRELY, so it cannot inherit the runtime's
    // applyWebSizeMode opt-in — SceneView mounts Canvas2DMount itself, without the prop.
    expect(renderCanvas2D).toHaveBeenCalledTimes(1);
    expect(renderCanvas2D.mock.calls[0]).toHaveLength(1);
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

/** Toggle block with the trait's own defaults; override per test. */
function toggle(over: Partial<NonNullable<UINodeData['toggle']>> = {}): NonNullable<UINodeData['toggle']> {
  return {
    value: false, trackOnColor: 0x4aa3ff, trackOffColor: 0x767676, trackOpacity: 1,
    knobColor: 0xffffff, knobOpacity: 1, knobInset: 2, trackRadius: 999, knobRadius: 999,
    disabled: false, ...over,
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

/** #234 — the tilt reaching the DOM. anchorCss.test.ts pins the CSS the emitter BUILDS; this pins
 *  that a `rotation` authored on the trait actually arrives on the rendered element, which is the
 *  half a unit test of the emitter cannot see (a field wired into nothing renders perfectly). */
describe('UIElement.rotation (#234)', () => {
  it('renders a tilted element', () => {
    const { container } = render(<UINode node={makeNode({ rotation: 5 })} storeState={{}} />);
    expect((container.firstElementChild as HTMLElement).style.transform).toBe('rotate(5deg)');
  });

  it('leaves an untilted element with no transform at all', () => {
    const { container } = render(<UINode node={makeNode({ rotation: 0 })} storeState={{}} />);
    expect((container.firstElementChild as HTMLElement).style.transform).toBe('');
  });

  it('composes with the anchor pivot translate rather than replacing it', () => {
    const node = makeNode({
      rotation: -4,
      anchor: {
        anchor: 'center', top: 0, topUnit: 'px', right: 0, rightUnit: 'px',
        bottom: 0, bottomUnit: 'px', left: 0, leftUnit: 'px',
        pivotX: 0.5, pivotY: 0.5, safeArea: false, zIndex: 0,
      },
    });
    const el = render(<UINode node={node} storeState={{}} />).container.firstElementChild as HTMLElement;
    expect(el.style.transform).toBe('translate(-50%, -50%) rotate(-4deg)');
    expect(el.style.transformOrigin).toBe('50% 50%');
  });
});
