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
  /**
   * Uniform scale about the ANCHOR PIVOT. 1 = natural size.
   *
   * Scales the RENDER, not the layout: the element's box keeps its laid-out size, so siblings do
   * not reflow as it grows and nothing shifts underneath a scaling card. That is the whole reason
   * this exists rather than keying `width`/`height` — those DO reflow, and they leave the text
   * behind at its original size, so a "pop" authored that way reads as a box stretching around
   * stationary words.
   *
   * Why it exists (#340): the level-win dialog snapped on screen with no transition, and the fix
   * had to be an authored keyframe clip rather than a tween in code. `UIElement.opacity` was
   * already keyable, but a fade alone reads as soft — a dialog wants to arrive. There was no
   * keyable property in the whole UI layer that could express that.
   *
   * ⚠️ **Scales about the anchor pivot, not the box centre** — the same rule {@link rotation}
   * follows, for the same reason: the pivot is the point that sits ON the anchor point, so it is
   * the one point that must not move. Growing about the box centre would slide a top-left-anchored
   * element off its own anchor as it scaled. Unanchored or STRETCHED-axis elements scale about
   * their centre, there being no pivot to honour.
   *
   * ⚠️ **A scale ≠ 1 creates a STACKING CONTEXT**, exactly as a non-zero rotation does, and traps
   * the `zIndex` of everything inside it. Scale the CARD, not the layer that holds it. An element
   * left at 1 emits no transform at all and is unaffected.
   *
   * ⚠️ Like `rotation`, the editor's selection overlay stays at the UNSCALED rect —
   * `resolveAnchorRect` measures layout, and this deliberately does not change layout. The render
   * is correct; the gizmo box just does not follow.
   */
  scale: 1,
  overflow: 'visible' as 'visible' | 'hidden' | 'scroll',
  /**
   * How this element's scrollbar is drawn when `overflow: 'scroll'` actually overflows.
   *
   * - `'auto'`   — the platform's own scrollbar. The default, so nothing existing changes.
   * - `'tinted'` — `scrollbarThumbColor` / `scrollbarTrackColor` are applied.
   * - `'hidden'` — no scrollbar at all; the element still scrolls by drag/wheel.
   *
   * ⚠️ **This is the ONLY way to theme a scrollbar here, because these are INLINE styles.**
   * `::-webkit-scrollbar` is a pseudo-element and cannot be expressed inline (`scrollViewDom.ts`
   * says the same thing where it hides a scroll view's bar), so the standards properties
   * `scrollbar-color` / `scrollbar-width` are the whole available surface. That buys the thumb and
   * track colour and a coarse width — not a custom shape, and not a corner or arrow style.
   *
   * ⚠️ **`UIScrollView.scrollbar` overlaps this and takes precedence** — both emit
   * `scrollbar-width: none` for their hidden case, and the scroll view's style is merged after
   * this one. On an element with a `UIScrollView`, let that trait decide whether a bar exists and
   * use these fields only to tint it.
   *
   * ⚠️ **`'hidden'` removes an AFFORDANCE, not just a decoration.** With no bar there is nothing on
   * screen saying content continues below the fold. Use it only where something else already says
   * so.
   */
  scrollbarStyle: 'auto' as 'auto' | 'tinted' | 'hidden',
  /** Thumb colour for `scrollbarStyle: 'tinted'` (0xRRGGBB). Ignored otherwise. */
  scrollbarThumbColor: 0x888888 as number,
  /** Track colour for `scrollbarStyle: 'tinted'` (0xRRGGBB). Ignored otherwise. */
  scrollbarTrackColor: 0xdddddd as number,
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
  /** Background fill colour. ⚠️ **Inert on its own** — see `backgroundOpacity` below, which
   *  defaults to 0 and gates whether this paints at all. */
  backgroundColor: 0 as number,
  /** Background fill alpha. ⚠️ **Defaults to 0, so setting `backgroundColor` ALONE paints
   *  NOTHING.** The renderer gates the fill on this field — `ui/UINode.tsx`'s
   *  `if (node.backgroundOpacity > 0)` — so a colour with no opacity is invisible, not
   *  transparent-by-choice. Author or patch BOTH.
   *
   *  This is the canonical statement of a trap with three prior sightings, all of which worked
   *  around it instead of documenting it here: four Court overlays shipped with invisible scrims;
   *  `UIToggle` declares `trackOpacity`/`knobOpacity` explicitly (defaulting to 1) rather than
   *  borrow this field, and says why; and `ui/sceneChrome.ts`'s `ChromeUIPatch` exposed
   *  `backgroundColor` with no companion, making a patched colour a silent no-op on any element
   *  whose scene left this at 0. Cite this comment rather than restating the rule.
   *
   *  ⚠️ **This is a FOUR-instance trap, and this comment has understated it twice.** The fix that
   *  added this paragraph closed the background half and left the border half open; the paragraph
   *  then called itself the canonical statement of a *two*-instance trap, and a close-out sweep
   *  found two more. The full set, each an authored colour gated by a companion defaulting to 0:
   *
   *  | Colour | Gate (default 0) | Renderer |
   *  |---|---|---|
   *  | `backgroundColor` | `backgroundOpacity` | `ui/UINode.tsx` `if (node.backgroundOpacity > 0)` |
   *  | `borderColor` | `borderWidth` | `if (node.borderWidth)` |
   *  | `textShadowColor` | `textShadowBlur` OR `textShadowOffsetX` OR `textShadowOffsetY` — all three default 0, so all three must stay 0 for the gate to be closed | `if (node.textShadowBlur \|\| node.textShadowOffsetX \|\| node.textShadowOffsetY)` |
   *  | `textStrokeColor` | `textStrokeWidth` | `if (node.textStrokeWidth > 0)` |
   *
   *  `ui/sceneChrome.ts`'s `ChromeUIPatch` exposes both halves of the first two pairs, because it
   *  exposed those colours already; it exposes NEITHER half of the last two, which is consistent
   *  and therefore not the same defect — a caller cannot half-open a gate it cannot reach at all.
   *  Expose both halves or neither, never the colour alone.
   *
   *  ⚠️ **The boundary, because it is about to be tested again:** this is a trap only when the
   *  gating field's NAME does not announce the gate. `fontSizeMin` does nothing without
   *  `autoFitText` (landed on main 2026-09-03), and every PostFX strength field does nothing
   *  without that effect's `enabled` — neither is an instance, because an author who set the
   *  value and saw nothing happen knows immediately what to look for. `borderColor` gives them
   *  nothing to look for. Add a row here only when the gate is SILENT in that sense.
   *
   *  Counter-example worth keeping in view: `textOpacity`, `borderOpacity`, `textShadowOpacity`
   *  and `textStrokeOpacity` all default to **1**, so they gate nothing; and `UIToggle` declares
   *  `trackOpacity`/`knobOpacity` at 1 specifically to avoid inheriting this shape. */
  backgroundOpacity: 0,
  borderRadius: 0,
  /** Border thickness in CSS px. ⚠️ **Defaults to 0, and it GATES THE WHOLE BORDER** — the
   *  renderer draws nothing border-related unless this is nonzero (`ui/UINode.tsx`:
   *  `if (node.borderWidth) { … style.borderColor = … }`). So `borderColor` alone paints NOTHING,
   *  exactly as `backgroundColor` without `backgroundOpacity` does. Same trap, second instance.
   *
   *  This is PAINT, not layout: the renderer sets `box-sizing: border-box`, so a border draws
   *  INSIDE the element's box and never changes its outer size or moves a sibling. */
  borderWidth: 0,
  /** Border colour. ⚠️ **Inert on its own** — gated by `borderWidth` above, which defaults to 0. */
  borderColor: 0x333333 as number,
  borderOpacity: 1,      // border color alpha (folded into the borderColor picker)
  opacity: 1,

  // ── Text ──
  text: '' as string,
  /**
   * The typeface for this element's text — a font-ASSET GUID, resolved through the manifest
   * and inherited by descendants exactly as CSS `font-family` is (#231).
   *
   * ⚠️ **A GUID, not a family name.** It used to hold the CSS family name; that made it the
   * one `accept:`-typed field in the engine that did NOT store a ref, so the build's
   * tree-shaker could not see it (a UI font ref the build cannot follow — the #53 class). A
   * legacy family name still renders, with a one-time warning; re-pick the font in the
   * Inspector to migrate it.
   *
   * Empty ⇒ fall through to {@link systemFont}, then to the browser default. When BOTH are
   * set the ASSET wins — see `ui/fontFamilyRef.ts`, the one place that decides.
   */
  fontFamily: '' as string,
  /**
   * A plain CSS family name (`system-ui`, `Helvetica`) — the case a GUID cannot express,
   * since no asset backs a system typeface (#231). Used only when `fontFamily` is empty or
   * unresolvable; a font stack (`"Iowan Old Style", serif`) is legal here, as in CSS.
   */
  systemFont: '' as string,
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
  /**
   * Shrink-to-fit (#614): when true, the effective font size is reduced — never grown past the
   * authored `fontSize` — until the text fits its box on ONE line, down to `fontSizeMin`. Below
   * that floor the existing `maxLines`/`textOverflow` behaviour takes over unchanged, exactly as
   * it would without this field. Off by default: an author opts a label in only where a fixed
   * string can overflow at some viewport/locale (Court's `ConflictLocalButton`, #614 — "Keep this
   * device" wrapped to two lines while its twin "Use the cloud" sat on one, both authored
   * identically). See `ui/autoFitText.ts` for the fit math.
   *
   * ⚠️ Does nothing on `elementType: 'input'` — an input's text is player-entered, not an
   * authored label, and shrinking it as the user types is a different feature (out of scope here).
   */
  autoFitText: false,
  /**
   * The shrink floor for `autoFitText`, in the SAME UNIT as `fontSize` (`fontSizeUnit`) —
   * deliberately no separate `fontSizeMinUnit`. A floor authored in a different unit than the
   * size it bounds could not be compared without a second layout read, and two units on one pair
   * of fields is a drift trap (cf. the `letterSpacingUnit` note above, which must match
   * `fontSizeUnit` for the same reason). `0` means "no explicit floor": the effective floor is
   * `fontSize * DEFAULT_AUTOFIT_MIN_RATIO` (see `ui/autoFitText.ts`), i.e. half the authored size.
   */
  fontSizeMin: 0,
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
  /** ⚠️ **Inert on its own** — gated by `textShadowBlur`/`textShadowOffsetX`/
   *  `textShadowOffsetY`, all of which default to 0. The THIRD instance of the trap
   *  documented on `backgroundOpacity` above; read that comment, don't restate it. */
  textShadowColor: 0x000000 as number,
  textShadowOpacity: 1,  // shadow color alpha (folded into the textShadowColor picker)
  textShadowOffsetX: 0,
  textShadowOffsetY: 0,
  textShadowBlur: 0,
  /** ⚠️ **Inert on its own** — gated by `textStrokeWidth`, which defaults to 0. The FOURTH
   *  instance of the trap documented on `backgroundOpacity` above; read that comment, don't
   *  restate it. */
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
