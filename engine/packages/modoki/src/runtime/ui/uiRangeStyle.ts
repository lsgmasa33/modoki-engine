/**
 * The DRAWN slider (`elementType: 'range'` with `rangeThumbSize > 0`).
 *
 * A bare `<input type="range">` is the browser's own control: its knob is whatever size the WebView
 * picks (about 16 CSS px on Chromium, and it does not grow with the element's box), and the only
 * thing an author can change is `accent-color`. On a phone that knob is hard to grab — reported on
 * Weaveling's Music / Sound sliders (#2106).
 *
 * The knob and the track are pseudo-elements, which an inline style cannot reach, so the look is ONE
 * stylesheet injected once, parameterised per element through CSS custom properties. `rangeThumbSize`
 * 0 keeps the native control, so every slider authored before this field existed is unchanged.
 *
 * Pure except {@link ensureUIRangeStyles} (DOM injection).
 */

/** The class a drawn slider carries; the stylesheet below keys on it. */
export const UI_RANGE_CLASS = 'mdk-ui-range';

/** The track's height when `rangeTrackHeight` is 0: a quarter of the knob, at least 2 px. */
export function defaultRangeTrackHeight(thumbSize: number): number {
  return Math.max(2, Math.round(thumbSize / 4));
}

const TRACK = 'linear-gradient(to right, var(--mdk-range-color) 0, var(--mdk-range-color) var(--mdk-range-fill),'
  + ' color-mix(in srgb, var(--mdk-range-color) 30%, transparent) var(--mdk-range-fill),'
  + ' color-mix(in srgb, var(--mdk-range-color) 30%, transparent) 100%)';
const THUMB = 'width: var(--mdk-range-thumb); height: var(--mdk-range-thumb); border-radius: 50%;'
  + ' background: var(--mdk-range-thumb-color); border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.35);';

// ⚠️ The `-webkit-` and `-moz-` rules are SEPARATE rule sets on purpose: a selector list containing a
// pseudo-element the browser does not know is dropped WHOLE, so one combined rule would style nothing.
const RULES = `
input[type=range].${UI_RANGE_CLASS} { -webkit-appearance: none; appearance: none; background: transparent; margin: 0; cursor: pointer; }
input[type=range].${UI_RANGE_CLASS}::-webkit-slider-runnable-track { height: var(--mdk-range-track); border-radius: 999px; background: ${TRACK}; }
input[type=range].${UI_RANGE_CLASS}::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; ${THUMB} margin-top: calc((var(--mdk-range-track) - var(--mdk-range-thumb)) / 2); }
input[type=range].${UI_RANGE_CLASS}::-moz-range-track { height: var(--mdk-range-track); border-radius: 999px; background: ${TRACK}; }
input[type=range].${UI_RANGE_CLASS}::-moz-range-thumb { ${THUMB} }
`;

let _injected = false;
/** Inject the slider rules once into the document head (idempotent, SSR-safe). */
export function ensureUIRangeStyles(): void {
  if (_injected || typeof document === 'undefined') return;
  _injected = true;
  const el = document.createElement('style');
  el.setAttribute('data-mdk-ui-range', '');
  el.textContent = RULES;
  document.head.appendChild(el);
}

export interface UIRangeLook {
  rangeThumbSize: number;
  rangeTrackHeight: number;
  rangeMin: number;
  rangeMax: number;
}

/**
 * The custom properties for one drawn slider, or `null` when it is the native control
 * (`rangeThumbSize` not above 0).
 *
 * `color` paints the track (solid up to the knob, faded past it); `thumbColor` paints the knob.
 *
 * `--mdk-range-fill` is where the filled part of the track ends, measured to the knob's CENTRE: the
 * knob travels `width - thumb`, not `width`, so a plain percentage of the value would let the fill run
 * ahead of the knob at the low end and fall behind it at the high end.
 */
export function uiRangeVars(
  look: UIRangeLook, value: number, color: string, thumbColor: string,
): Record<string, string> | null {
  const thumb = look.rangeThumbSize;
  if (!(thumb > 0)) return null;
  const track = look.rangeTrackHeight > 0 ? look.rangeTrackHeight : defaultRangeTrackHeight(thumb);
  const span = look.rangeMax - look.rangeMin;
  const t = span > 0 && Number.isFinite(value) ? Math.min(1, Math.max(0, (value - look.rangeMin) / span)) : 0;
  return {
    '--mdk-range-thumb': `${thumb}px`,
    '--mdk-range-track': `${track}px`,
    '--mdk-range-color': color,
    '--mdk-range-thumb-color': thumbColor,
    '--mdk-range-fill': `calc(${thumb / 2}px + (100% - ${thumb}px) * ${Number(t.toFixed(4))})`,
  };
}
