import { trait } from 'koota';

/** Length units for UIElement/UIAnchor fields. `px`/`%` plus the four viewport
 *  units (resolved against the LOGICAL device viewport — see resolveLengthPx /
 *  cssVal). Adding a unit here means updating: resolveLengthPx (anchorLayout.ts),
 *  cssVal (UINode.tsx), the anchor CSS emitter (anchorCss.ts), the inspector
 *  dropdown + registerTraits enums, and uiResizeMath. */
export type UILengthUnit = 'px' | '%' | 'vw' | 'vh' | 'vmin' | 'vmax';

/** UIElement — consolidated UI trait: layout, style, text, and image. */
export const UIElement = trait({
  // ── Layout ──
  width: 0,   // 0 = auto
  height: 0,  // 0 = auto
  widthUnit: '%' as UILengthUnit,
  heightUnit: '%' as UILengthUnit,
  flexDirection: 'column' as 'row' | 'column',
  flexWrap: 'nowrap' as 'nowrap' | 'wrap',
  justifyContent: 'flex-start' as 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around',
  alignItems: 'stretch' as 'flex-start' | 'center' | 'flex-end' | 'stretch',
  gap: 0,
  /** Unit for `gap`. Defaults to 'px', which is what gap silently WAS before this existed.
   *
   *  ⚠️ Every other length on this trait carries a unit; gap did not, and a wrap-based grid whose
   *  items scale (vh/%) while its gaps do not has a viewport size below which an item silently
   *  reflows onto the next row. Court's 5x5 attack reference did exactly that: 5 cells of 5vh plus
   *  4 gaps of 4px needed 98.95px of a 98.26px row once the window got short enough, so it drew as
   *  4-wide and 7 rows deep. Nothing was wrong with the data — only with mixing the two units. */
  gapUnit: 'px' as UILengthUnit,
  flexGrow: 0,
  flexShrink: 1,
  paddingTop: 0,
  paddingTopUnit: '%' as UILengthUnit,
  paddingLeft: 0,
  paddingLeftUnit: '%' as UILengthUnit,
  paddingRight: 0,
  paddingRightUnit: '%' as UILengthUnit,
  paddingBottom: 0,
  paddingBottomUnit: '%' as UILengthUnit,
  marginTop: 0,
  marginTopUnit: '%' as UILengthUnit,
  marginRight: 0,
  marginRightUnit: '%' as UILengthUnit,
  marginBottom: 0,
  marginBottomUnit: '%' as UILengthUnit,
  marginLeft: 0,
  marginLeftUnit: '%' as UILengthUnit,
  minWidth: 0,   // 0 = none
  minWidthUnit: 'px' as UILengthUnit,
  maxWidth: 0,   // 0 = none
  maxWidthUnit: 'px' as UILengthUnit,
  minHeight: 0,  // 0 = none
  minHeightUnit: 'px' as UILengthUnit,
  maxHeight: 0,  // 0 = none
  maxHeightUnit: 'px' as UILengthUnit,
  alignSelf: 'auto' as 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch',
  zIndex: 0,
  /**
   * Tilt, in DEGREES clockwise. 0 = square, the pre-existing behaviour of every authored element.
   *
   * ⚠️ **It rotates about the ANCHOR PIVOT, not about the element's own centre** — matching what
   * `UIAnchor.pivotX/pivotY` already means everywhere else: the pivot is the point of the element
   * that sits ON the anchor point, so it is the one point a tilt must leave alone. Rotating about
   * the box centre instead would slide a top-left-anchored element off its own anchor as soon as
   * the angle changed, which is the shape of bug that reads as "the anchor is broken". An element
   * with no anchor, or on a STRETCHED axis (where the pivot is ignored because both edges are
   * pinned), rotates about its centre — there is no pivot to honour.
   *
   * Why it exists (#234): a nine-slice CANNOT bake its own tilt. Slices are axis-aligned rects, so
   * a rotated master is cut along the wrong axes and the corners shear — and a dialog card has to
   * be a nine-slice, because one master serves both a wide panel and a tall one. So it was
   * tilt-in-the-engine or square, with nothing in between. Court's approved art direction wants its
   * cards a few degrees off square, which is most of what makes them read as paper on a desk.
   *
   * ⚠️ **A non-zero rotation creates a STACKING CONTEXT** (any transform does), which traps the
   * `zIndex` of everything inside it — the trap `games/court/CLAUDE.md` already records for
   * `ChromeRoot`'s centre anchor. Tilting a full-screen container is therefore not free: children
   * that were escaping its z-order stop escaping. Tilt the CARD, not the layer that holds it.
   *
   * ⚠️ The editor's selection overlay stays AXIS-ALIGNED — `resolveAnchorRect` measures an
   * unrotated rect, so a tilted element's outline and gizmo box will not follow the tilt. Cosmetic
   * (the render is correct), and deliberately out of scope; it is the honest cost of the feature.
   */
  rotation: 0,
  overflow: 'visible' as 'visible' | 'hidden' | 'scroll',
  isVisible: true,
  /**
   * Never take the pointer: taps fall through to whatever is BEHIND this element, while its
   * children keep whatever they had (CSS `pointer-events: none` on a parent does not disarm a
   * child that sets `auto`).
   *
   * Default false = the renderer decides, which is the pre-existing behaviour and the right one
   * almost always: an element with a click binding is interactive, a LEAF with none is
   * transparent, and a container stays `auto` because it must pass events down to its children.
   *
   * This exists for the case those rules cannot express — **a container that is pure decoration**,
   * sitting over something that must still be tappable. Court's narration band is the worked
   * example: it is a panel with a Skip button inside it, drawn above a full-screen tap-catcher.
   * The band has no binding of its own, but being a container (and a `scroll` one, which is
   * separately forced to `auto` so it can be scrolled) it swallowed every tap aimed at the catcher
   * underneath. The only alternative was to put the catcher ON TOP, which buried the Skip button
   * in the band's stacking context and made it silently unclickable.
   */
  pointerThrough: false,

  // ── Style (box visuals) ──
  backgroundColor: 0 as number,   // 0 = transparent
  backgroundOpacity: 0,
  borderRadius: 0,
  borderWidth: 0,
  borderColor: 0x333333 as number,
  borderOpacity: 1,      // border color alpha (folded into the borderColor picker)
  opacity: 1,

  // ── Text ──
  text: '' as string,
  fontFamily: '' as string,
  fontSize: 16,
  /**
   * Unit for `fontSize`. Defaults to `'px'`, which is what fontSize silently WAS before this
   * existed — so every authored value keeps its meaning and nothing re-lays-out.
   *
   * ⚠️ **Why it exists (#245): text-sized content could not scale, and its container could.** Every
   * other length on this trait carries a unit; `fontSize` did not, so a control whose height comes
   * from its TEXT is fixed px inside a parent that may be sized in `%`/`vh` — which means there is
   * always a viewport size below which it overflows. Court hit this twice: the pen glyph that
   * "agreed at exactly one screen size and drifted at every other" (see `noteBrushSprite`), and
   * the main menu, where three difficulty buttons pushed the column off the paper page below a
   * ~975px window (measured, #245).
   *
   * Set it to `vh` to make text scale with the viewport the way `width`/`padding` already can.
   *
   * ⚠️ **`vh`, not `vmin`.** `vmin` is `min(vw, vh)`, so it follows WIDTH on any viewport
   * TALLER than it is wide — every phone in portrait. There, shrinking only the height leaves a
   * `vmin` font unchanged while a `%`/`vh` parent shrinks under it, which is this bug intact. A
   * vertical constraint needs a vertical unit, and `vh` is the one that tracks height in both
   * orientations. Court authors all 11 of its scaling text fields in `vh` (#245).
   *
   * ⚠️ `lineHeight` has the SAME shape and is still px-only — deliberately out of scope here, so
   * a scaling `fontSize` with an authored `lineHeight` will drift. Author `lineHeight` 0 (auto)
   * alongside a non-px `fontSize` until that follows.
   */
  fontSizeUnit: 'px' as UILengthUnit,
  fontWeight: 'normal' as 'normal' | 'bold',
  fontStyle: 'normal' as 'normal' | 'italic',
  textColor: 0xffffff as number,
  textOpacity: 1,        // text color alpha (folded into the textColor picker)
  textAlign: 'left' as 'left' | 'center' | 'right',
  lineHeight: 0,         // 0 = auto/normal
  letterSpacing: 0,
  /**
   * Unit for `letterSpacing`. Defaults to `'px'` — what it silently was before this existed.
   *
   * ⚠️ **Tracking must follow the font, or it drifts** (#245). Letter spacing is only meaningful
   * as a RATIO of the glyph size, so a px tracking under a scaling `fontSize` says something
   * different at every viewport. Court's menu title measured 0.130em of tracking at its reference
   * size and 0.261em at a 480px window — the same authored 7px, twice the optical gap, because
   * only the font shrank. Author both in the same unit.
   */
  letterSpacingUnit: 'px' as UILengthUnit,
  textShadowColor: 0x000000 as number,
  textShadowOpacity: 1,  // shadow color alpha (folded into the textShadowColor picker)
  textShadowOffsetX: 0,
  textShadowOffsetY: 0,
  textShadowBlur: 0,
  textStrokeColor: 0x000000 as number,
  textStrokeOpacity: 1,  // stroke color alpha (folded into the textStrokeColor picker)
  textStrokeWidth: 0,
  textOverflow: 'clip' as 'clip' | 'ellipsis',
  maxLines: 0,           // 0 = unlimited

  // ── Image ──
  imageSrc: '' as string,
  imageMode: 'cover' as 'cover' | 'contain' | 'fill' | 'none',

  // ── Element type ──
  elementType: 'div' as 'div' | 'input' | 'range',
  placeholder: '' as string,

  // ── Range (slider) ──
  rangeMin: 0,
  rangeMax: 100,
  rangeStep: 1,
});
