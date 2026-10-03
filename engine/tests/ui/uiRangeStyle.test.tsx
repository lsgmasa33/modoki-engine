// @vitest-environment jsdom
/**
 * The DRAWN slider (#2106): `rangeThumbSize > 0` swaps the browser's own slider — whose knob cannot be
 * resized — for one the engine draws through a class and per-element custom properties.
 *
 * Asserted on the real `UINode` as well as on the pure helper, because the defect this prevents is an
 * authored field nothing reads: the helper being right proves nothing if the element never wears it.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { UINode, hexToColor } from '../../packages/modoki/src/runtime/ui/UINode';
import { UI_RANGE_CLASS, defaultRangeTrackHeight, uiRangeVars } from '../../packages/modoki/src/runtime/ui/uiRangeStyle';

const LOOK = { rangeThumbSize: 32, rangeTrackHeight: 0, rangeMin: 0, rangeMax: 100 };

describe('uiRangeVars', () => {
  it('is null for the native slider — no thumb size, no drawn look', () => {
    expect(uiRangeVars({ ...LOOK, rangeThumbSize: 0 }, 50, '#fff', '#000')).toBeNull();
    expect(uiRangeVars({ ...LOOK, rangeThumbSize: -4 }, 50, '#fff', '#000')).toBeNull();
    expect(uiRangeVars({ ...LOOK, rangeThumbSize: Number.NaN }, 50, '#fff', '#000')).toBeNull();
  });

  it('carries the authored knob size and colour', () => {
    const v = uiRangeVars(LOOK, 50, 'rgb(1, 2, 3)', 'rgb(4, 5, 6)')!;
    expect(v['--mdk-range-thumb']).toBe('32px');
    expect(v['--mdk-range-color']).toBe('rgb(1, 2, 3)');
    expect(v['--mdk-range-thumb-color']).toBe('rgb(4, 5, 6)');
  });

  it('defaults the track to a quarter of the knob, and reads an authored height over it', () => {
    expect(uiRangeVars(LOOK, 50, '#fff', '#000')!['--mdk-range-track']).toBe(`${defaultRangeTrackHeight(32)}px`);
    expect(defaultRangeTrackHeight(32)).toBe(8);
    expect(defaultRangeTrackHeight(4), 'never thinner than 2 px').toBe(2);
    expect(uiRangeVars({ ...LOOK, rangeTrackHeight: 13 }, 50, '#fff', '#000')!['--mdk-range-track']).toBe('13px');
  });

  it('ends the fill at the knob\'s CENTRE, which travels width minus the knob', () => {
    const fill = (value: number, look = LOOK) => uiRangeVars(look, value, '#fff', '#000')!['--mdk-range-fill'];
    expect(fill(0)).toBe('calc(16px + (100% - 32px) * 0)');
    expect(fill(25)).toBe('calc(16px + (100% - 32px) * 0.25)');
    expect(fill(100)).toBe('calc(16px + (100% - 32px) * 1)');
    // A range that does not start at 0: the fraction is of the SPAN.
    expect(fill(15, { ...LOOK, rangeMin: 10, rangeMax: 20 })).toBe('calc(16px + (100% - 32px) * 0.5)');
  });

  it('clamps a value outside the range, and reads an empty or broken range as unfilled', () => {
    const fill = (value: number, look = LOOK) => uiRangeVars(look, value, '#fff', '#000')!['--mdk-range-fill'];
    expect(fill(-5)).toBe(fill(0));
    expect(fill(500)).toBe(fill(100));
    expect(fill(Number.NaN)).toBe(fill(0));
    expect(fill(5, { ...LOOK, rangeMin: 5, rangeMax: 5 })).toBe(fill(0));
  });
});

const NODE_DEFAULTS = {
  entityId: 1, guid: 'g1', children: [],
  width: 150, height: 48, widthUnit: 'px', heightUnit: 'px',
  flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'flex-start', alignItems: 'stretch',
  gap: 0, flexGrow: 0, flexShrink: 1,
  paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
  marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
  minWidth: 0, maxWidth: 0, minHeight: 0, maxHeight: 0,
  alignSelf: 'auto', zIndex: 0, overflow: 'visible', isVisible: true, pointerThrough: false,
  swallowClicks: false,
  backgroundColor: 0, backgroundOpacity: 0, borderRadius: 0, borderWidth: 0,
  borderColor: 0x333333, borderOpacity: 1, opacity: 1,
  text: '', fontFamily: '', fontSize: 16, fontWeight: 'normal', fontStyle: 'normal',
  textColor: 0x112233, textOpacity: 1, textAlign: 'left', lineHeight: 0, letterSpacing: 0,
  textShadowColor: 0, textShadowOpacity: 1, textShadowOffsetX: 0, textShadowOffsetY: 0,
  textShadowBlur: 0, textStrokeColor: 0, textStrokeOpacity: 1, textStrokeWidth: 0,
  textOverflow: 'clip', maxLines: 0, imageSrc: '', imageMode: 'cover', imageAlign: 'center',
  elementType: 'range', placeholder: '', rangeMin: 0, rangeMax: 100, rangeStep: 1,
  rangeThumbSize: 0, rangeTrackHeight: 0, rangeThumbColor: 0xffffff,
  rotation: 0, scale: 1,
  binding: { inputBinding: 'vol' },
};

function slider(node: Record<string, unknown>, opts: { editor?: boolean; vol?: number } = {}): HTMLInputElement {
  const { container } = render(React.createElement(UINode, {
    node: { ...NODE_DEFAULTS, ...node } as never,
    storeState: { vol: opts.vol ?? 50 },
    ...(opts.editor ? { onSelectEntity: () => {} } : {}),
  } as never));
  return container.querySelector('input[type=range]') as HTMLInputElement;
}

describe('UINode — a range element wears the drawn look only when a thumb size is authored', () => {
  it('thumb size 0 is the native slider: no class, no custom properties', () => {
    const el = slider({});
    expect(el.classList.contains(UI_RANGE_CLASS)).toBe(false);
    expect(el.style.getPropertyValue('--mdk-range-thumb')).toBe('');
  });

  /** Mutation: drop `className={rangeClass}` from the runtime `<input>` -> red. */
  it('an authored thumb size puts the class and the size on the element', () => {
    const el = slider({ rangeThumbSize: 36 });
    expect(el.classList.contains(UI_RANGE_CLASS)).toBe(true);
    expect(el.style.getPropertyValue('--mdk-range-thumb')).toBe('36px');
    expect(el.style.getPropertyValue('--mdk-range-track')).toBe('9px');
  });

  /** The perturbation: a size the code has never seen must reach the element. */
  it('follows a PERTURBED thumb size and track height', () => {
    const el = slider({ rangeThumbSize: 41, rangeTrackHeight: 7 });
    expect(el.style.getPropertyValue('--mdk-range-thumb')).toBe('41px');
    expect(el.style.getPropertyValue('--mdk-range-track')).toBe('7px');
  });

  /** Mutation: pass `node.textColor` as the knob colour in UINode -> red. Mutation: paint the knob rule
   *  with `--mdk-range-color` again -> red (the rule assertion). */
  it('the knob takes rangeThumbColor and the track textColor, as two separate colours', () => {
    const el = slider({ rangeThumbSize: 36, rangeThumbColor: 0xa1b2c3, textColor: 0x112233 });
    expect(el.style.getPropertyValue('--mdk-range-thumb-color')).toBe(hexToColor(0xa1b2c3));
    expect(el.style.getPropertyValue('--mdk-range-color')).toBe(hexToColor(0x112233));
    const css = document.head.querySelector('style[data-mdk-ui-range]')!.textContent!;
    const thumbRule = css.split('\n').find((l) => l.includes('::-webkit-slider-thumb'))!;
    expect(thumbRule).toContain('background: var(--mdk-range-thumb-color)');
    const mozRule = css.split('\n').find((l) => l.includes('::-moz-range-thumb'))!;
    expect(mozRule).toContain('background: var(--mdk-range-thumb-color)');
  });

  it('the fill follows the BOUND value', () => {
    expect(slider({ rangeThumbSize: 20 }, { vol: 25 }).style.getPropertyValue('--mdk-range-fill'))
      .toBe('calc(10px + (100% - 20px) * 0.25)');
  });

  /** Mutation: drop `className={rangeClass}` from the EDITOR `<input>` -> red here only. */
  it('the editor preview draws it too, so the Scene view shows what the game shows', () => {
    const el = slider({ rangeThumbSize: 36 }, { editor: true });
    expect(el.classList.contains(UI_RANGE_CLASS)).toBe(true);
    expect(el.style.getPropertyValue('--mdk-range-thumb')).toBe('36px');
  });

  it('injects the stylesheet once, with the knob rule in a rule set of its own per engine', () => {
    slider({ rangeThumbSize: 36 });
    slider({ rangeThumbSize: 20 });
    const sheets = document.head.querySelectorAll('style[data-mdk-ui-range]');
    expect(sheets.length).toBe(1);
    const css = sheets[0].textContent ?? '';
    expect(css).toContain(`.${UI_RANGE_CLASS}::-webkit-slider-thumb {`);
    expect(css).toContain(`.${UI_RANGE_CLASS}::-moz-range-thumb {`);
    // A selector LIST naming an unknown pseudo-element is dropped whole, so the two must never share a rule.
    expect(css).not.toMatch(/::-webkit-slider-thumb\s*,/);
  });
});
