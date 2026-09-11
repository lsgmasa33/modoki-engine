/** uiLength — the ONE table of UI length defaults, and the one reader of a value+unit pair (#840).
 *
 *  A `UIElement` or `UIAnchor` length is TWO fields: a number and its unit (`width` + `widthUnit`).
 *  Nothing used to bind them, so every reader of authored data re-decided on its own what an ABSENT
 *  unit means — and a scene/prefab save strips a field equal to its default, so an absent unit is
 *  the ordinary on-disk shape, not an edge case. The answer is PER FIELD: `width`/`height`/`padding*`
 *  /`margin*` default to `'%'`; `gap`, `min*`/`max*`, `minTapSize`, `fontSize` and `letterSpacing`
 *  default to `'px'`; every `UIAnchor` offset defaults to `'px'`. The readers applied ONE blanket
 *  fallback each, so each was right for some fields and wrong for the rest:
 *  `sceneValidation.unitOrDefault` said `'%'`, `uiTreeStore` said `'px'`, and two Court tests said
 *  `'px'` of a padding.
 *
 *  **So the defaults live here, and the traits take them FROM here** — `UIElement.ts` and
 *  `UIAnchor.ts` build their schema defaults out of these tables, which makes the schema default and
 *  this reader's default one value by construction rather than two copies kept in step.
 *
 *  **And the pair is read through `readUILength` / `readUIAnchorLength`**, which return the value and
 *  its unit together, so a caller cannot take the number and guess the unit. An architecture guard
 *  (`engine/tests/architecture/uiLengthFallback.test.ts`) fails on a literal unit fallback in any
 *  script under engine/, games/ or demos/.
 *
 *  ⚠️ No imports, deliberately: `runtime/loaders/sceneValidation.ts` runs in the Node Vite plugin with
 *  no trait registered and must not import a module that calls koota's `trait({...})` at import time.
 *  Game code outside the engine package reads a single field through the public
 *  `traitFieldOrDefault`, which resolves an ABSENT field against the same schema defaults. ⚠️ The two
 *  differ on an EMPTY unit string: this reader treats `''` as absent (as every fallback it replaced did),
 *  `traitFieldOrDefault` only `undefined`. No tracked scene or prefab authors an empty unit. */

/** Length units for UIElement/UIAnchor fields. `px`/`%` plus the four viewport
 *  units (resolved against the LOGICAL device viewport — see resolveLengthPx /
 *  cssVal). Adding a unit here means updating: resolveLengthPx (anchorLayout.ts),
 *  cssVal (UINode.tsx), the anchor CSS emitter (anchorCss.ts), the inspector
 *  dropdown + registerTraits enums, and uiResizeMath. */
export type UILengthUnit = 'px' | '%' | 'vw' | 'vh' | 'vmin' | 'vmax';

/** The four units that resolve against the device VIEWPORT rather than a parent or a fixed px. */
export const VIEWPORT_LENGTH_UNITS: ReadonlySet<string> = new Set(['vw', 'vh', 'vmin', 'vmax']);

interface LengthSpec { readonly value: number; readonly unit: UILengthUnit }

/** Every `UIElement` length, keyed by its VALUE field; the unit field is `${key}Unit`. */
export const UI_ELEMENT_LENGTHS = {
  width: { value: 0, unit: '%' },
  height: { value: 0, unit: '%' },
  gap: { value: 0, unit: 'px' },
  paddingTop: { value: 0, unit: '%' },
  paddingLeft: { value: 0, unit: '%' },
  paddingRight: { value: 0, unit: '%' },
  paddingBottom: { value: 0, unit: '%' },
  marginTop: { value: 0, unit: '%' },
  marginRight: { value: 0, unit: '%' },
  marginBottom: { value: 0, unit: '%' },
  marginLeft: { value: 0, unit: '%' },
  minWidth: { value: 0, unit: 'px' },
  maxWidth: { value: 0, unit: 'px' },
  minHeight: { value: 0, unit: 'px' },
  maxHeight: { value: 0, unit: 'px' },
  minTapSize: { value: 0, unit: 'px' },
  fontSize: { value: 16, unit: 'px' },
  letterSpacing: { value: 0, unit: 'px' },
} as const satisfies Record<string, LengthSpec>;

/** Every `UIAnchor` length (the four offsets), keyed by its VALUE field. */
export const UI_ANCHOR_LENGTHS = {
  top: { value: 0, unit: 'px' },
  left: { value: 0, unit: 'px' },
  right: { value: 0, unit: 'px' },
  bottom: { value: 0, unit: 'px' },
} as const satisfies Record<string, LengthSpec>;

export type UIElementLengthField = keyof typeof UI_ELEMENT_LENGTHS;
export type UIAnchorLengthField = keyof typeof UI_ANCHOR_LENGTHS;

/** A length read with its unit. `unit` is a `string`, not `UILengthUnit`: an authored value that is
 *  PRESENT is returned exactly as written, so a caller that must handle an unknown unit still sees it. */
export interface UILength { value: number; unit: string }

/** Any trait-shaped object: a live koota trait snapshot, a JSON trait bag, or a typed input interface
 *  (which a `Record<string, unknown>` parameter would refuse for want of an index signature). */
type Bag = object | null | undefined;

function readLength(spec: LengthSpec, bag: Bag, field: string): UILength {
  const record = bag as Readonly<Record<string, unknown>> | null | undefined;
  const value = record?.[field];
  const unit = record?.[`${field}Unit`];
  return {
    value: typeof value === 'number' ? value : spec.value,
    // An empty string is "no unit", as every reader before this treated it.
    unit: typeof unit === 'string' && unit !== '' ? unit : spec.unit,
  };
}

/** Read a `UIElement` length and its unit from a trait bag — live trait data or authored JSON — with
 *  each ABSENT half resolved to that field's own default. */
export function readUILength(bag: Bag, field: UIElementLengthField): UILength {
  return readLength(UI_ELEMENT_LENGTHS[field], bag, field);
}

/** Read a `UIAnchor` offset and its unit, each absent half resolved to the field's own default. */
export function readUIAnchorLength(bag: Bag, field: UIAnchorLengthField): UILength {
  return readLength(UI_ANCHOR_LENGTHS[field], bag, field);
}
