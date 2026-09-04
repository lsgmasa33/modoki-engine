# UI System

modoki's UI layer is **ECS-driven**: each UI element is a normal entity carrying
`Renderable.layer = 'ui'` (the `RenderableUI` tag trait) plus a set of UI traits.
A React component, `UIRenderer`, queries those entities every time they change and
renders them as a tree of DOM nodes laid out with CSS flexbox. There is no separate
UI scene graph — the ECS world *is* the UI document.

This page documents the runtime UI traits, the renderer, the projection/dirty-flag
model that keeps it off the per-frame path, anchor positioning, directional
controller/keyboard focus, text animation, nine-slice backgrounds, fonts, an image-ref
gotcha, and the per-game custom-React-UI escape hatch.

Related: [Architecture](./architecture.md) · [Scene Loading](./scene-loading.md) ·
[Prefabs](./prefabs.md) · [Materials & Textures](./textures.md) · [Visual Editor](./editor.md)

---

## UI traits

All UI traits live in `packages/modoki/src/runtime/traits/`. An entity becomes a UI
node when it has the `RenderableUI` tag plus `UIElement`; the rest — `UIBinding`,
`UIAction`, `UIAnchor`, plus `UIFocusable` (marks an element reachable by directional
controller/keyboard focus nav — opt-in, resolved per active scope by `uiFocusSystem`),
`UIToggle` (renders the element as an on/off switch) and `Canvas2D` (marks a `UIElement`
as hosting a 2D PixiJS canvas; child `Renderable2D` entities render into it) — are
optional add-ons.

### `UIElement` — the consolidated element trait

`UIElement` is a single ~73-field trait holding layout, box style, text, image, and
element-type properties. There is no separate "label" vs "panel" vs "button" trait —
**rendering is content-driven**: a node renders its `text` if non-empty, and paints
`imageSrc` as a CSS `backgroundImage` if non-empty (so text can sit *over* an image).

Field groups (representative fields, verified against `UIElement.ts`):

- **Layout** — `width`/`height` (+ `widthUnit`/`heightUnit`, `0` = auto). ⚠️ **Every `*Unit` field
  is the SIX-member `UILengthUnit`** — `'px' | '%' | 'vw' | 'vh' | 'vmin' | 'vmax'` — exported from
  `@modoki/engine/runtime`, and every one of them is selectable from the Inspector dropdown. This
  line read `'px' | '%'` until 2026-08-07, contradicting the viewport-units paragraph below and the
  type itself; a game had already written a three-way unit resolver that silently treated `vw` and
  `vmax` as `vmin`, which is wrong on any non-square host. **Resolve units through a map that is
  total over the union, not a ternary chain with a fall-through.** Also:
  `flexDirection`, `flexWrap`, `justifyContent`, `alignItems`, `gap` + `gapUnit`, `flexGrow`,
  `flexShrink`, per-edge `padding*`/`margin*` (each with its own `*Unit`),
  `minWidth`/`maxWidth`/`minHeight`/`maxHeight`, `alignSelf`, `zIndex`, `rotation` (see below),
  `overflow`
  (`visible | hidden | scroll`), `scrollbarStyle` (`auto | tinted | hidden`) with
  `scrollbarThumbColor`/`scrollbarTrackColor`, `isVisible`, `pointerThrough` (see below).

  **The scrollbar skin is `scrollbar-color` + `scrollbar-width` and nothing else**, because these
  are INLINE styles and `::-webkit-scrollbar` is a pseudo-element that cannot be written inline at
  all (`scrollViewDom.ts` records the same limit where it hides a scroll view's bar). So you get a
  thumb colour, a track colour and a coarse width — no shape, corner or arrow control. The skin is
  gated on `overflow: 'scroll'`, so a tint authored on an element that never scrolls does nothing
  rather than sitting in the Inspector pretending to.
  ⚠️ **`UIScrollView.scrollbar` says the same thing and WINS** — both emit `scrollbar-width: none`
  for their hidden case and the scroll view's style is merged after, so on an element carrying a
  `UIScrollView` that trait decides whether a bar exists and `scrollbarStyle` only tints it.
  ⚠️ `'hidden'` removes an **affordance**, not just a decoration: with no bar, nothing on screen
  says the content continues below the fold. Use it only where something else already does.

  **Scroll anchoring** (`runtime/ui/scrollAnchor.ts`, wired into `UINode`) keeps a
  `overflow: 'scroll'` box's content still when its content SIZE changes — a child appearing,
  vanishing, or changing height — the same job Chromium's own `overflow-anchor` does, done by us
  so it happens on every engine. That split is why this class of bug was invisible in the editor:
  Chromium and Firefox self-correct a scroll-position clamp when content shrinks, WebKit never
  has, so a shipped iOS WKWebView could drift permanently while the same scene in the Electron
  editor read as fine (#531 — Court's store shelf lost its purchase-target alignment after a
  cancelled purchase, because the "Done" button unmounting while buying shrank the shelf and
  nothing restored the clamped offset: `scrollTop` 303 -> 251, every row 52px lower, permanently).
  See `scrollAnchor.ts`'s header comment for the mechanism and the two failure modes
  (`isIntentfulScroll`) it has to tell apart.
  ⚠️ **The hook owns `overflow-anchor` itself, at runtime, and only where it can act.**
  `scrollAnchor.ts` sets `style.overflowAnchor = 'none'` only on a box with two or more flow
  children — the condition under which it can actually anchor to something — rather than `UINode`
  stamping it unconditionally. A box with exactly one flow child — notably any `UIEntries`
  virtualized view, whose pooled rows all live under a single `__uiEntriesContent` wrapper — keeps
  the BROWSER's anchoring instead: our mechanism would degrade to restoring the raw offset there,
  and taking away Chromium's working behaviour to replace it with an inert one would be a
  regression on Court's `LevelScroll` and `DailyScroll`.
  ⚠️ **Known residual, measured separately from #531:** when the anchored child is itself the one
  removed, the restore falls back to the first surviving child below it and lands within about one
  flex `gap` of exact — measured 8px on Court's shelf, against ~111px of drift before the fix in
  that same scenario. The primary case — content removed above or below the viewport while the
  anchored child survives — is pixel-exact.

  ⚠️ **A third failure mode, orthogonal to `isIntentfulScroll`'s two impostors (#579):** `restore()`
  writes `scrollTop` directly, and nothing stopped it firing while the PLAYER'S OWN FINGER was mid-
  drag on the same box — a content-size change (a row mounting/unmounting under `syncStoreChrome`,
  say) racing a live touch gesture reads as "I scrolled down and it snapped back on release", a
  genuine competition over the same `scrollTop` rather than a resize bug. The hook now tracks a
  live `pointerdown`→`pointerup`/`pointercancel` gesture (`window`-level release listeners, a
  same-shape-as-`scheduleResync` safety timeout in case neither fires) and DEFERS any pending
  restore until the gesture ends, rather than fighting it. See `scrollAnchor.ts`'s header comment.

  ⚠️ **A fourth, UNRELATED mechanism that read identically on old hardware — now RESOLVED, not
  merely mitigated (#579 → #612):** none of the above actually explained a freeze measured live
  on an iPhone 8 (iOS 16.7.16) — `touchmove` kept firing the whole gesture; only the resulting
  scroll position stopped updating. Root cause was `runtime/ui/safeArea.ts`'s
  `getSafeAreaInsets()`: past its own 250ms cache throttle it re-measured by appending a hidden
  probe and reading `getComputedStyle()` on it — a forced synchronous layout by construction,
  REGARDLESS of when in the frame it ran (confirmed: deferring the call to
  `requestAnimationFrame`, the fix that class of problem usually takes, only reduced the damage
  here — inserting a fresh element and immediately querying it forces a layout for that element
  no matter the timing). Court called it from six per-frame chrome-sync functions that this
  codebase deliberately never gates on a dirty flag, so the forced reflow fired continuously —
  including with a modal or the menu covering the board entirely, where none of it was visible.
  Cheap enough to be invisible on modern hardware; enough to desync WebKit's native touch-scroll
  compositor on the iPhone 8.

  **The #612 rewrite fixed the mechanism itself, so there is no call-site gate left to
  describe.** `safeArea.ts` no longer forces a layout at all — `getSafeAreaInsets()` is a plain
  field read (see "Game code reads the insets through `getSafeAreaInsets()`" below) — so Court's
  gesture-gated wrapper (`boardSafeAreaInsets()`, which used to skip the call while a touch
  gesture was live anywhere on the page) has been deleted, and all six chrome-sync call sites now
  call the engine function directly. The `#579` history above is kept because it is why this
  file's scroll-anchoring code looks the way it does; the bug itself is resolved at its source,
  not routed around.

  ⚠️ **Match `gapUnit` to the unit the CHILDREN are sized in.** `gap` was px-only until
  2026-08-07, and a `flexWrap: 'wrap'` container whose items scale (`vh`/`vmin`/`%`) while its
  gaps do not has a viewport size below which an item silently reflows onto the next row — the
  items shrink, the gaps do not, and eventually one stops fitting. It is silent because nothing
  is wrong with the data: Court's 5x5 attack reference (five 5vh cells, four 4px gaps, a 29.6vh
  row) needed 98.95px of a 98.26px row on a short window and drew 4-wide by 7 rows deep. Mixed
  units are only safe where the row COUNT carries no meaning.

  ⚠️ **`min*`/`max*` default to `px` while `width`/`height` default to `%` — and until #549 you
  could not SEE which.** `minWidth`/`maxWidth`/`minHeight`/`maxHeight` default their unit to
  `'px'`; `width`/`height` (and every `padding*`/`margin*`) default theirs to `'%'`. So authoring
  `width: 5.4` beside `maxWidth: 3.5` — the obvious reading being "5.4% wide, never more than
  3.5% wide" — clamps to 3.5 **pixels**. Nothing errors and the element silently collapses;
  Court's `RulesClose` shipped that way and drew its label entirely outside itself (#529).

  The defaults are deliberately NOT aligned: of the 50 authored `min*`/`max*` values in the repo
  that rely on the px default, ~47 are genuinely pixels (`maxWidth: 460`, the `minWidth: 44` tap
  targets), so flipping them would break the many to rescue the few — and would break scenes
  authored outside this repo. What was actually broken is that the four `*Unit` companions were
  read by the renderer (`UINode.tsx`, `canvas2DLayout.ts`) but registered in **no trait metadata**,
  so the Inspector never showed them and no author could change one; the value fields' tooltips
  meanwhile asserted "(px)", false at the 114 sites using `vh`/`%`/`vmin`. #549 registered them and
  added them to `UNIT_FIELD_MAPS`, so they now render inline with their value like every other
  length. **Every non-px value in the repo predating that was set by an agent or by hand-editing
  JSON** — a good illustration of the CLAUDE.md rule that a field the renderer reads and the author
  cannot reach is worse than no field at all.

  A dev-only warning (`runtime/ui/lengthUnitWarning.ts`) now flags an axis sized in a relative unit
  whose own `min*`/`max*` is left in px at a value `<= 20`. ⚠️ It lives in **`uiTreeStore`'s
  tree-build pass, not in `UINode`'s render**, and must stay there: `UINodeInner` early-returns on
  `!node.isVisible` before recursing into children, so a render-time check cannot see inside a
  closed dialog — which is exactly where the two entities that motivated this warning (Court's
  `RulesClose`/`RulesLine4`, both inside the How-to-Play dialog) sat unnoticed until #529 reached a
  device. `tests/runtime/uiTreeLengthUnitWarning.test.ts` pins that by spawning a suspect under a
  hidden parent. **Both of those entities were fixed on `main` by #529** (which removed their
  size fields entirely), so a fresh sweep of the corpus now finds **zero live positives** — this
  warning ships as a **preventative guard for the next one**, not as an active catch.


  ⚠️ **`fontSize` carries a unit too, since #245 — and it did NOT until then.** It was unitless px
  while every other length had a unit, so an element whose HEIGHT comes from its text could not
  scale while its container could: there was always a viewport size below which such content
  overflowed a `%`/`vh`-sized parent. Court hit it twice — a pen glyph that "agreed at exactly one
  screen size and drifted at every other", and its main menu overflowing the paper page below a
  ~975px window. `fontSizeUnit` defaults to `'px'`, so nothing authored before it changes.
  **Pick the unit from the CONSTRAINT's axis**: if the thing that must fit is a height, use `vh` —
  `vmin` is `min(vw,vh)`, so it equals `vh` only while the host is WIDER than tall and follows
  WIDTH the moment it is TALLER than wide, which is every phone in portrait. There a window that
  only gets shorter shrinks the parent and leaves `vmin` text alone — the bug intact, on the
  orientation a mobile game ships in. `vh` tracks height in both orientations, which is the whole
  reason to prefer it. And remember margin/padding percentages resolve
  against WIDTH even for `marginTop`, so a `%` top margin is a width-derived vertical term.
  ⚠️ **`letterSpacing` carries a unit too, and it must MATCH `fontSizeUnit`.** Tracking is only
  meaningful as a ratio of the glyph size, so px tracking under a scaling font says something
  different at every viewport — measured on Court's menu title, 0.130em of tracking at its
  reference size and 0.261em at a 480px window, from the same authored 7px, because only the font
  shrank. Both now scale: 0.1296em and 0.0627em hold across viewports (observed live).
  ⚠️ `lineHeight` is still px-only — leave it `0` (auto) alongside a scaling `fontSize`. So are
  `textStrokeWidth`, `textShadowOffset{X,Y}`/`textShadowBlur`, `borderWidth` and `borderRadius`;
  each has the same shape and will drift under a scaling font, and none is wired yet.
- **Style (box visuals)** — `backgroundColor` (packed hex int, `0` = transparent),
  `backgroundOpacity`, `borderRadius`, `borderWidth`, `borderColor`, `borderOpacity`
  (border color alpha, folded into the `borderColor` picker), `opacity`.
- **Text** — `text`, **`fontFamily`** (a font-asset GUID) + **`systemFont`** (a CSS family name; the asset wins — see § Fonts), `fontSize` + **`fontSizeUnit`**, `fontWeight`, `fontStyle`, `textColor`,
  `textOpacity` (folded into the `textColor` picker), `textAlign`, `lineHeight`,
  `letterSpacing` + **`letterSpacingUnit`**, `textShadow*` (color/opacity/offsetX/offsetY/blur — `textShadowOpacity`
  folded into `textShadowColor`), `textStrokeColor`/`textStrokeOpacity`
  (folded into `textStrokeColor`)/`textStrokeWidth`, `textOverflow` (`clip | ellipsis`),
  `maxLines`, **`autoFitText`** + **`fontSizeMin`**.

  ⚠️ **`autoFitText` is SHRINK-ONLY (#614)** — off by default; when on, the effective font size is
  reduced, never grown past the authored `fontSize`, until the text fits its box on one line, down
  to `fontSizeMin`. Below that floor, `maxLines`/`textOverflow` take over exactly as they would
  with the field off — auto-fit is the shrink-FIRST step, not a replacement for them. `fontSizeMin`
  is authored in `fontSizeUnit` — the SAME unit as `fontSize`, deliberately with no separate unit
  field of its own (same reasoning as `letterSpacingUnit` above: a floor in a different unit than
  the size it bounds can't be compared without a second layout read). `0` means "no explicit
  floor" — the effective floor is half the authored `fontSize`. It does nothing on
  `elementType: 'input'` (player-entered text, not an authored label — see `UIElement.ts`). Fit
  math: `runtime/ui/autoFitText.ts`; DOM measurement: `UINode.tsx`'s `AutoFitText`.

  ⚠️ **`maxLines` clamps LINE BOXES only — a `display: inline-block` text child defeats it
  (#646).** `maxLines > 0` sets the entity div's own `display: '-webkit-box'` +
  `-webkit-line-clamp` (`UINode.tsx`) — Chromium's legacy clamp mechanism, which only splits
  BLOCK-level descendant content into lines. A plain text child works; a wrapper `<span>` around
  the text (`AutoFitText`, `AnimatedText`) does not if it is `inline-block` — the clamp treats it
  as one atomic inline-level box (like an image) and does nothing, leaving `overflow: hidden` on
  a box whose height has collapsed (a ~12px sliver, or the full unclamped height without an
  accompanying flex-shrink squeeze). Both wrapper spans are `display: 'block'` for exactly this
  reason — verified this does not reopen #614's flex-stretch measurement bug: under this
  entity's normal `display: flex` (no `maxLines`), a flex item's `inline-block` is *blockified*
  to `block` regardless of what is authored, so `block` and `inline-block` compute identically
  there. Two non-flex contexts escape that blockification, not one, and both need the authored
  value to already be `block`: the `-webkit-box` parent (exactly the `maxLines` case), and
  `AutoFitText`'s own span — itself `display: 'block'`, never flex — whenever it wraps
  `AnimatedText` (both `autoFitText` and a `TextAnimation` authored on the same node). That
  nesting makes the animation span a child of a plain block box instead of a flex item,
  independently of whether `maxLines` is even set.

  ⚠️ **The fit converges by RE-MEASUREMENT, never by the model (#614 follow-up).** The first
  estimate (`authoredPx * availablePx / naturalPx`) is exact only when width passes through the
  origin — real text is affine: `games/text_demo`'s "UI TEXT ANIMATION" (42px, `letterSpacing:
  3px`) measured `width = 9.344 * fs + 54.46`, an intercept from the px `letterSpacing` (17 x 3px)
  that does not scale with the font. The estimate predicted 30.03px would fit a 319.59px box;
  30.03px actually measures 336.06px. `refineFontSizePx` re-measures and refines from there
  (bounded by `MAX_FIT_PASSES`), and the fit/no-fit verdict comes from the final MEASURED width,
  never the model's prediction. Any size-independent term — px letter/word-spacing, a text stroke,
  a px-padded inline child — creates that intercept; with none, the proportional model is exact,
  which is why it's right on every simple fixture and wrong on a real screen.

  ⚠️ **The invariant that makes a bad measurement safe.** Auto-fit may only change the rendering
  while ACTIVELY shrinking — it reduced the font AND the reduced size measured back as fitting.
  Every other outcome (already fits, an unmeasurable reading, or floored short of a fit) renders
  identically to `autoFitText: false`, so a wrong measurement can only fail to shrink — never leave
  a box worse than the feature being off. Concretely: an earlier version held `white-space: nowrap`
  unconditionally, and on a content-sized parent that turned a correct 2-line wrap (229px) into one
  non-wrapping line 199px outside its 200px parent.

  ⚠️ **Why the DOM measurement is shaped the way it is.** `UIElement` authors
  `flexDirection`/`alignItems` on every node, so the measuring span is a flex ITEM: `inline-block`
  is blockified to `block` and `align-items: stretch` sizes it to the container, so a plain
  `getBoundingClientRect()` reads the AVAILABLE width, not the natural one (measured 319.59px vs a
  real 446.93px) — fixed with a temporary `width: max-content` scaffold that overrides the stretch,
  cleared before paint. And `availablePx` must be captured BEFORE that scaffold: `UIElement.width`
  defaults to `0` (auto), so a content-sized parent is the default case, and the scaffold inflates
  the PARENT too — read after it, `availablePx` converges on `naturalPx` and the fit concludes "it
  fits" every time. Same contaminated-measurement bug, one level up.

  ⚠️ **Cost: a re-fit is a synchronous layout read, and a BOUND label re-fits every time its text
  changes.** `text` is resolved through `resolveTemplate` (`UINode.tsx`), so a label with a
  `textBinding` onto a per-frame store field (a score, a timer, an fps readout) produces a new
  string every frame and re-fits every frame — 2 reads when it already fits, up to
  `MAX_FIT_PASSES + 1` when it shrinks. That is CORRECT (its width really did change) but it is
  not free, and it is the one case where `autoFitText` costs something a static label never pays.
  Prefer it for the case it was built for: a fixed string that overflows at some viewport or
  locale. For a fast-changing bound readout, author a `fontSize` that fits the widest value
  instead.

  Testing: jsdom reports every rect as 0x0, so the decision function is unit-tested
  (`engine/packages/modoki/tests/ui/autoFitText.test.ts`) while the DOM behaviour is pinned by an
  e2e (`engine/tests/e2e/editor-ui-autofit.spec.ts`) whose fixture deliberately carries a px
  `letterSpacing` — without that intercept the proportional model is exact and the spec cannot
  fail. Mounting `UINode` in jsdom to assert this would assert the mock.
  ⚠️ **The DOM collapses runs of whitespace, and every instrument that would normally catch a
  content bug agrees with the collapsed version.** Two, three or twenty consecutive spaces in
  `text` render as ONE — this is default CSS (`white-space: normal`), not a `UINode` bug — so it is
  invisible to `element.textContent` (already collapsed by the time you read it back), invisible to
  the AUTHORED trait value (`text` still holds the extra spaces; nothing strips them there), and
  invisible to a string-EQUALITY test comparing two authored strings that both got mangled the same
  way. **If spacing between two pieces of text is meant to be visible, it must be LAYOUT — a flex
  `gap` between two separate elements or a fixed-width spacer — never extra space characters inside
  one `text` string.** This bites hardest when porting a string from a canvas-rendered origin (a
  PixiJS/2D `Text2D`, which does NOT collapse whitespace — every space character it is given draws):
  the ported copy can carry a multi-space run that read correctly on the 2D layer and silently loses
  its spacing the moment the same string becomes a DOM `text` field. Sweep a ported string for
  multi-space runs before trusting it, or replace the gap with layout at the same time.

- **Image** — `imageSrc`, `imageMode` (`cover | contain | fill | none`).
- **Element type** — `elementType` (`div | input | range`) and `placeholder`. Most
  elements are `div`; `input` renders an `<input>` text field and `range` renders an
  `<input type="range">` slider (`rangeMin`/`rangeMax`/`rangeStep`).

Colors are stored as packed hex integers (e.g. `0xffffff`) and converted to CSS at
render time. Numeric+unit pairs are converted by `UINode`'s `cssVal()` helper, which
also supports viewport units (`vw`/`vh`/`vmin`/`vmax`) via CSS custom properties that
`UIRenderer` sets on its container — so viewport-relative sizes resolve against the
**game viewport**, not the browser window (critical for the editor's simulated device).

⚠️ **`--ui-*` and `getBoundingClientRect` are in DIFFERENT SPACES in the editor, and code that
mixes them is wrong by the preview's zoom factor.** The Game panel's device preset sizes
`UIRenderer`'s container at the device's *logical* size (375x667 for an iPhone SE) and then
displays it under a CSS `scale()` — so `--ui-vh` is `6.67px` while a rect measured off the same
subtree reports the scaled number. Consequences, both measured on 2026-08-20:

- A **ratio** of two measured values is safe: the scale cancels. That is why the game-side
  helpers that must survive this emit **percentages** (see `games/court/runtime/sceneChrome.ts`,
  whose position/size patchers refuse px for exactly this reason — those stayed game-side when the
  generic core moved to the engine; see § "Pushing live values onto scene-authored chrome" below).
- A **length** derived from a measured rect and then handed back as a style value is scaled
  twice. Court computed HUD font sizes that way and got `41.6px` where `22.8px` was intended —
  1.83x, the preview's own factor — which pushed the HUD through the board on nine of twelve
  device presets before it was caught.

So: convert positions to `%`, and express a length that must track the canvas design box as a
viewport unit rather than a computed px. Note that **no single viewport unit equals a
`contain`-fitted design box** — it is `min(100vw, refW/refH * 100vh)` wide, so `vh` is exact only
while the box is height-bound and `vw` only while it is width-bound. Court picks between them per
frame from the host aspect (`designUnit()`); the `vmin` + `vh`-cap pairing used on its buttons is
a hand-rolled approximation of the same thing.

### `UIBinding` — store-driven content & visibility

Connects an element to a Zustand store (`UIBinding.ts`):

- `textBinding` — store field whose value feeds the `text` template.
- `visibleBinding` + `visibleOp` + `visibleValue` — gate visibility on a store field
  (in ADDITION to the authored `UIElement.isVisible` — both must be true). `visibleOp`
  is `''` (truthy) | `'=='` | `'!='` | `'>'` | `'>='` | `'<'` | `'<='`; the store value
  is compared against `visibleValue` (number-coerced when both look numeric).
- `inputBinding` — two-way value field for `input`/`range` elements.
- **Active highlight** — `highlightTarget` (a GUID) / `highlightComponent` /
  `highlightProperty` / `highlightValue` / `highlightColor` / `highlightTextColor`:
  paint this element with `highlightColor`/`highlightTextColor` whenever the live value
  of `highlightComponent.highlightProperty` on the `highlightTarget` entity string-equals
  `highlightValue` (canonical use: a clip-selector button that lights up while its clip is
  the one playing). Disabled when `highlightColor` < 0 (the default). It reads the source
  of truth directly (no mirrored store flag) and re-resolves only on a UI dirty signal — a
  system that drives the watched value via a raw `entity.set` must call `markUIDirty()`.

Text templates use `{field}` placeholders resolved by `resolveTemplate()` in
`runtime/ui/bindingResolver.ts`; visibility by `evalVisibility()` in the same file.

### `UIAction` — button & input events

A single AoS array field, `bindings: UIActionBinding[]` (`UIAction.ts`) — the six old
fields (`onClick`/`onClickPayload`/`onClickTarget`/`onClickSet`/`onChange`/`onSubmit`)
were unified away. Each binding (`runtime/ui/bindings.ts`) fires on one `event`
(`'click'` | `'change'` | `'submit'`) and does one of two `kind`s of work:

- `kind:'set'` — a declarative property write: set `property` of `component` on the
  `target` entity (empty → the element's own entity) to `value`. Subsumes the old
  show/hide pair — opening a panel is `UIElement.isVisible = true`, no game code.
- `kind:'call'` — dispatch a named `action` (system logic or an engine built-in like
  `engine.loadScene`) with typed `params`.

The `$value` token (in a set's `value` or any `params` entry) is replaced at dispatch
with the triggering event's value — e.g. a range slider's `change` writes its live
number straight into a field with zero game code.

`UINode` runs the matching rows with `applyBindings(node.action.bindings, event, {selfGuid, …})`
(imported from `runtime/ui/bindings.ts`) on `'click'`/`'change'`/`'submit'`. For a
`kind:'call'` row, `applyBindings` dispatches internally through `dispatchUIAction` into
`runtime/core/actionRegistry.ts`, where games register handlers via
`registerUIAction(name, handler)` / `unregisterUIAction(name)`. An unknown action
**throws in dev** and warns in production, so typo'd action names surface immediately.
(Bindings are inert unless the game is running — `applyBindings` early-returns when the
sim is stopped, so editor Stopped/Paused states never mutate the scene.)

#### Engine built-in `UIAction`s

Four stateless lifecycle/animator handlers are registered once at startup by
`registerEngineActions()` (`runtime/actions/engineActions.ts`), callable from any
`kind:'call'` binding by name:

- **`engine.reload`** — `window.location.reload()` (hard web-view reload).
- **`engine.quit`** — a no-op that logs on web; the app shell wires Capacitor's
  `App.exitApp()` if a real device quit is needed.
- **`engine.toggleAnimator`** — flips `playing` on the binding's `target` entity's
  animator, toggling whichever of `SkeletalAnimator` (GLB skeletal clips) / `Animator`
  (keyframe `.anim.json`) the target carries — a plain field write the render sync picks
  up next frame. Warns if the target is missing or carries neither trait.
- **`engine.playClip`** — switches the target's active clip BY NAME across all three
  animator flavours (`Animator` keyframe, `SpriteAnimator` flipbook, `SkeletalAnimator`
  GLB) — the unified twin of `engine.toggleAnimator`. The clip name comes from the
  binding's typed `clip` param (or the event `$value`); keyframe/sprite validate the name
  synchronously against their clip bank and no-op+warn on an unknown one, while skeletal
  clips are validated at the render layer (unknown names are ignored there).

Scene navigation (`engine.loadScene` / `engine.navigateBack`) is **not** here — it lives
in `NavigationManager`, which owns the history stack (see
[Managers & Systems](./managers-and-systems.md)).

#### Global input lock (#466)

`applyBindings` guards every **discrete activation** (`click`, `submit`, a `UIToggle`'s
`change`) with a single **global** lock: while one is being handled, EVERY other discrete
activation anywhere in the UI is swallowed whole — before the click cue, so a blocked
second tap makes no sound. Not per-button: a fast tap on a different button is also
swallowed, by design.

The click cue is gated on the **same** discrete/continuous predicate as the lock, not on
the event name (#528) — it used to test `event === 'click'`, which silenced every
`UIToggle` (a toggle activates through `'change'`, not `'click'`) while the lock correctly
treated it as a press: two mechanisms meant to agree, disagreeing. **`submit` (Enter in a
text field) is discrete and still takes the input lock like any other discrete
activation, but is deliberately exempt from the cue** (owner, 2026-09-01) — Enter follows
typing, where a tap sound reads as a keyboard click rather than a button press. Don't
"unify" this away as an inconsistency; it's a deliberate exception, not a bug.

The real gate is the action **completing** — every promise a `kind:'call'` binding's
handler returns is awaited before the lock releases — not a timer; `UISettings`'s
`inputLockMinMs` (default 300ms) is only a floor under that, for a synchronous handler
that settles instantly. `0` disables the floor entirely (action-completion only), the
escape hatch for a rapid-fire button. A safety valve, `inputLockMaxMs` (default 10000ms),
force-releases a lock that outlives it and `console.warn`s the still-pending action(s), so
a hung async handler can't brick the UI permanently.

**The completion gate is a silent opt-in, and that is arguably why #530 went unnoticed.**
It works by duck-typing a `call` handler's return value (`trackLockPromise`) — only a
thenable holds the lock open. A game whose handlers are synchronous wrappers (Court's
`registerUIAction(name, () => fireTap(target))`, returning `void`) gets nothing from it:
no error, no warning, no failing test — the lock just falls back to the `inputLockMinMs`
floor as if the handler had always been instant.

**A third gate (#530): a registered busy predicate.** `registerUIBusySource(name, isBusy)`
(`runtime/core/uiBusySources.ts`, re-exported from the runtime barrel) lets a game tell the
lock that some asynchronous state it owns should keep input blocked, without rewriting its
handlers to return promises. It is a predicate the engine ASKS — polled every FRAME since #551
(`pollUIBusyContinuity`, not just at a discrete activation) — not a `begin`/`end` pair the game
TELLS — a push/pop scope leaks if the operation throws between
the two calls, and Court's `beginSignIn` is a bare fire-and-forget async IIFE with no
`finally`, so a throw between `begin` and `end` would have bricked every button in the game
until its own 60s watchdog finally fired. `isInputLockActive` consults this gate first, even
when no lock is currently held — the busy period can start outside any UI activation at all
(a sign-in flow kicked off from a menu button, not a chrome tap).

**It carries its own safety valve, mirroring `inputLockMaxMs`**, because a predicate stuck
true would otherwise brick input forever — the exact failure the lock's own valve exists to
prevent. A throwing predicate degrades to "not busy" and logs once per THROW STREAK (deduped via
`erroredSinceRecovery`, cleared the moment the predicate stops throwing) rather than once per
call — since #551 the predicate is polled every frame, so an un-deduped log would flood at ~60Hz
instead of firing once; a bad game-side read still can't starve input either.

**Both knobs are read fresh from `UISettings` on every discrete activation, never cached
(#543).** They used to be snapshotted into module-level `lockMinMs`/`lockMaxMs` by
`acquireLock()` — but the busy gate above is consulted BEFORE the acquire, and when it
blocks, `applyBindings` returns early so `acquireLock()` is never reached. A busy episode
beginning before the session's first unblocked activation therefore ran the valve on the
module DEFAULT for its whole duration, with no path to learn the authored value while it
kept blocking; the first episode after a world swap ran on the OUTGOING scene's value.
`readLockWindow(world)` is now the single place either knob is read and clamped, so there
is no cached copy for a swap or a first activation to leave stale.

**The valve measures OBSERVED busy time, and continuity is now observed on a frame cadence, not
inferred between discrete activations (#551).** `pollUIBusyContinuity()`
(`runtime/core/uiBusySources.ts`) runs every frame as a system registered at `SYSTEM_PRIORITY.GAME`
(`app/ecs/pipeline.ts`), and accumulates the delta between adjacent polls whenever the busy set is
non-empty. `isInputLockActive()` in `bindings.ts` no longer tracks any of this itself — it just
reads the accumulated total (`getBusyAccumulatedMs()`) and compares it to `lockWindow.maxMs`. This
replaced an earlier version that could only sample the busy predicates at a discrete UI
activation, so it had to INFER continuity between samples via a tuned gap threshold
(`BUSY_OBSERVATION_GAP_MS`) — ambiguous by construction, because one tap N seconds after the last
was indistinguishable between "still stalled" and "an unrelated new episode". Polling every frame
removes that ambiguity: two polls are (almost always) genuinely adjacent frames, so the delta
between them is a decidable fact, not a guess.

⚠️ **The pipeline does not always tick, though, so the poll-to-poll delta still needs a clamp.** A
gap between two polls can exceed a normal frame (editor Pause, a backgrounded tab where rAF halts,
a long synchronous stall like a scene load or shader compile) with nothing observed across it.
`MAX_POLL_GAP_MS` (250ms, `uiBusySources.ts`, mirroring `timeSystem.ts`'s `MAX_DELTA` clamp for
the same class of problem) treats a gap larger than that as unwatched: the accumulator resets to a
fresh episode instead of crediting the full gap, so a real in-flight operation surviving a pause
doesn't get force-released on the very next poll after resume — the #530 regression this clamp
exists to prevent.

A **continuous** event stream passes `continuous: true` to `applyBindings` and is exempt both
ways: it neither takes nor respects the lock. Two streams qualify, not one: a range slider's
`change` (fires on every pixel of drag — locking it would freeze the slider mid-drag) and a
controlled text input's `change` (fires once per KEYSTROKE — locking it would DROP characters,
since the binding write is what produces the field's value, so a swallowed keystroke is lost,
not merely delayed). The Enter/`submit` handler and a `UIToggle`'s `change` stay discrete.

⚠️ A `call` handler must not synchronously trigger a second **discrete** activation (e.g. call
`applyBindings` itself, or another path that re-enters it, for a different `click`/`submit`/toggle
event) — the lock the outer activation just acquired is still held, so the re-entrant call is
silently swallowed. No such caller exists in-tree today; this is a trap for game code to avoid,
not a live defect.

### `UIToggle` — an on/off switch

Add it beside `UIElement` and the entity renders as a switch: a track with a knob at one
end or the other. Fields: `value`, `trackOnColor`/`trackOffColor`/`trackOpacity`,
`knobColor`/`knobOpacity`/`knobInset`, `trackRadius`/`knobRadius`, `disabled`.

**It does not write its own `value`.** A click fires the `change`-event bindings with
`eventValue` set to the NEGATION of the current value, and the canonical authoring is a
`set` binding onto its own `UIToggle.value` with `'$value'` (leave `target` empty to mean
"my own entity"). Pair it with a `call` binding when the game must also *do* something —
persist the preference, retune a service — and both fire from the one click.

⚠️ **The reason it does not self-write is not tidiness.** `applyBindings` early-returns
when the sim is not running, so a control that wrote its own trait field would mutate the
scene from a **Stopped editor**, which that early return exists to prevent. It also keeps
one writer for one value instead of two that can disagree.

The cost is that a toggle authored with no binding renders perfectly and is inert — the
silent-authoring-failure class this repo keeps paying for. So `UINode` **warns once per
entity in dev** when a `UIToggle` carries no `change`/`click` binding. It warns rather
than throws: an authoring mistake must not blank the screen mid-render.

⚠️ **A `UIToggle` OWNS its inner layout**, so `UIElement`'s flex and padding fields are
overridden on that entity and do nothing. Everything else on `UIElement` — size, border,
opacity, visibility, anchoring — still applies normally, because the rendered ROOT element
is the track and it carries the standard style object. That is also what gives a toggle
the focus ring and the pointer-events rules for free.

The knob is positioned by flex (`justifyContent` flips between the two ends) and sized off
the track's own height via `aspectRatio`, so a switch works at any authored size with no
measurement and no second render pass.

⚠️ **Keyboard support is the DOM's, not `UIFocusable`'s.** The track is focusable
(`tabIndex`) and Space/Enter flip it. Routing a toggle through the controller-nav focus
manager is a **follow-up**: that path activates by firing `click` bindings with no event
value, and a switch has to carry the new value with it. Deliberately not half-wired.

It is the first control in the engine to render more than one DOM node from one entity —
`input` and `range` both delegate to a native element — so it is the template for the next
one.

### `UIAnchor` — screen positioning + safe area

For root UI containers that should pin to a screen edge rather than flow in their
parent (`UIAnchor.ts`):

- `anchor` — one of `stretch`, `center`, the four edges (`top`/`bottom`/`left`/`right`),
  the four corners (`top-left` … `bottom-right`), and the stretch variants
  (`top-stretch`, `h-stretch`, `v-stretch`, etc.).
- `top`/`left`/`right`/`bottom` (+ units), `pivotX`/`pivotY` (0..1 pivot relative to the
  element's own box), `zIndex`.
- `safeArea` — clear the notch / home indicator. **Defaults to TRUE** — an absent field
  in a scene JSON is ON, not off. It takes ONE OF TWO ARMS, decided by the anchor, and
  they are mutually exclusive by construction so nothing can be inset twice:
  - **A STRETCHED anchor PADS**: `max(<padding>, var(--ui-sa-*, env(safe-area-inset-*)))`
    on the edges the anchor reaches. Its *children* move away from the edge; its own box
    does not move.
  - **A POINT anchor OFFSETS**: the anchor point moves inward, the box keeps its size,
    composed onto (not replacing) any authored offset — so `top: 4vmin` on a notched
    phone means "4vmin below the notch". Padding would be wrong here because it INFLATES
    the element: a 44pt gear anchored top-right would render 106pt tall with its glyph
    shoved to the bottom.
  - **`center` is a genuine no-op** — it reaches no edge. It is the only anchor for which
    the Inspector greys the checkbox out.

  ⚠️ **The padding arm moves FLOW children — it does nothing for the element's own box, and
  nothing for an absolutely-positioned (anchored) child either.** A stretched element's safe-area
  padding pushes normal-flow children in off the edge, the same way any CSS padding does; it does
  not move the element's own box, and a child that carries its own `UIAnchor` (root-only by
  convention, but nothing stops one being authored deeper) resolves against the padding **box**,
  not inside it, so the padding never reaches it either. Reading `safeArea: true` off the trait
  therefore tells you nothing by itself — the question is what KIND of children the element has.
  `games/wordweave`'s `AdBannerSlot` (`bottom-stretch`) is the worked negative: its only child
  `AdBannerLabel` is POINT-anchored, so nothing about the slot was inset by anything, and it
  shipped rendering UNDER the iOS home indicator — measured on an iPhone Air, the slot spanned
  device y 829–912 against the indicator's own 878–912, while reading "safe-area aware" from the
  trait alone. The fix was to author `safeArea: false` on the slot and LIFT its box at runtime
  (`patchAnchorPct`), not to trust the padding. Contrast `games/wordweave`'s `BottomButtonRow`,
  also `bottom-stretch`: its two buttons are FLOW children (no `UIAnchor` of their own), so the
  same padding arm lifts them correctly with no runtime code at all.

  ⚠️ **The anchor MODE is a proxy for "which edges this element reaches", and an authored
  or runtime-driven offset can falsify it.** An element anchored `top-stretch` but pushed
  to the bottom of the screen still takes a top inset — the inset is static CSS and cannot
  see where the element ended up. That is an authoring call, not an engine bug: opt such
  an element out.

An anchored element is rendered with `position: absolute`; pivot is applied as a CSS
`translate(-pivotX%, -pivotY%)`. Stretched axes ignore pivot (both edges are pinned).

⚠️ **It is the trait's PRESENCE, not its values, that makes a child absolutely positioned** — a
child with no `UIAnchor` at all flows in its parent; a child carrying a `UIAnchor` authored at every
field's own default (`anchor: 'stretch'`, `top: 0`, `pivotX: 0`, …) is a DIFFERENT, absolutely
positioned element that just happens to resolve to the same box. And a scene save **strips a trait
field equal to its default** (the editor's own save path — a scene diff reads as data loss until you
know this), so a `UIAnchor` authored at all-defaults serialises to `"UIAnchor": {}` — **byte-identical
to what a
`UIAnchor` authored with one non-default field but otherwise defaulted also produces for those other
fields**, and structurally indistinguishable from "some other trait happens to be `{}`". The one
fact that never disappears is the KEY: an absent `UIAnchor` has no `"UIAnchor"` entry in `traits` at
all, while a present-at-defaults one does. **Any check for "is this element anchored" must ask
`'UIAnchor' in traits`, never "does its `UIAnchor` differ from the defaults"** — the latter is `false`
for a deliberately-anchored element as often as for an unanchored one, and cannot tell them apart.
This is not a hypothetical: `games/wordweave`'s `ZoomControl` subtree (#628 Phase 5 of its DOM UI
port) is six flex children that all carry an authored `UIAnchor` — some at genuinely default values,
because what matters for a `center`-pivoted inner glyph like `ZoomMagnifierRing` is that it IS
positioned relative to its parent, not that any one field differs from its default.

⚠️ **The app root is FULL-BLEED and must stay that way** (`engine/app/App.css`). It
carried a blanket `padding: env(safe-area-inset-top/bottom)` from the initial commit,
which inset everything the app drew — black bands on a notched iPhone, no art able to
bleed to the edge, and an element that opted in inset twice. Per-element is the whole
mechanism; a second blunt one is strictly worse than either alone (#272).

#### The editor simulates the safe area (#271)

`env(safe-area-inset-*)` resolves to **0** on every desktop browser, so an editor preview
structurally could not show what a notched phone does — a class of layout bug that was
invisible until a build reached hardware, and the reason a previous safe-area fix shipped
unverified and had to be reverted (`c6e570f6` → `6f495a0d9`).

So the inset is emitted as `var(--ui-sa-<edge>, env(safe-area-inset-<edge>))`
(`runtime/ui/anchorCss.ts`), and the editor's device preview publishes `--ui-sa-*` from
the selected device preset. Three things about that shape are load-bearing:

- **A shipped build never sets the var** and falls through to the real `env()`. There is
  no `isEditor` branch in the runtime and only one expression, so the two cannot drift.
- **Both viewports publish the same insets.** GameView owns the device picker and writes
  them to `gameViewSafeArea` in the editor store; SceneView's UI preview frame reads them
  back. The same UI tree is mounted in both, so insetting one and not the other would put
  an element in two places and make the authoring view the liar.
- **The insets are per-orientation DATA, not a rotation.** `DevicePreset.safeArea` carries
  a portrait and a landscape quartet because they are genuinely different: an iPhone in
  portrait is inset at the top by the notch (62) and the bottom by the home indicator
  (34); rotated, it has **no top inset at all** (0 top, 21 bottom, 62 on both sides).
  Deriving one from the other by swapping w/h — which `resolveLogicalSize` legitimately
  does for the screen box — invents a top inset the device does not have.

The bands are drawn over the preview (`editor/rendering/SafeAreaOverlay.tsx`), always on
with a device preset: simulating an inset without showing it trades one invisible failure
for another.

#### Game code reads the insets through `getSafeAreaInsets()`

Chrome that only needs to CLEAR the notch should use `UIAnchor.safeArea` and never touch this.
It exists for a game whose own layout ARITHMETIC has to account for the inset — Court reserves a
band for a banner ad and derives the button row's position and the narration band's height from
it. It reports px **and percentages of the UI root**; use the percentages, because dividing the
px by your own `getBoundingClientRect` mixes a pre-transform inset with a post-transform box and
is wrong in editor previews only.

**`getSafeAreaInsets()` is now a plain field read — no throttle, no measurement, no DOM access,
and therefore nothing a per-frame caller has to be careful about (#612).** Freshness comes from a
PUSH signal instead of a poll: two **persistent** probe elements live inside the UI root, and a
`ResizeObserver` on them fires whenever an inset actually moves. The callback writes the new value
straight off `contentRect` — no forced layout, nothing to bound, nothing to arm.

⚠️ **The probes are SIZED BY the inset, and that is the whole mechanism — the obvious
implementation silently never fires.** `ResizeObserver` reports the CONTENT box by default. The
previous probe was `width:0; height:0` with the inset in its PADDING (a shape chosen to stay out
of flow and clamp negatives to 0 for free), so its content box was 0×0 before and after every
transition, forever — bolting an observer onto it would pass review, ship, and fail on device with
no error. Each new probe's `width`/`height` IS one edge's inset instead (one probe carries
top+left, the other bottom+right — `contentRect` delivers both edges in one observation). Measured
on the device this whole mechanism exists for (Galaxy A23 / Android 13, Court, real WebView, bars
driven by `SystemBars`): `SystemBars.show()` (top 28→32px, bottom 0→48px) fired the sized probes'
observer ~108ms later with the correct values; `SystemBars.hide()` (32→28, 48→0) fired them
~105ms later; a background→resume cycle (Court re-applying immersive mode) fired them again.
Across the whole session the sized probes fired 10 times; the old padding-shaped probe fired
exactly **once** — its initial observation — and never on a change.

⚠️ **That measurement corrects a claim this doc used to make here, and it is the sentence that
kept this design unexplored across four issues (#273 → #579 → #592 → #600): "under
`setDecorFitsSystemWindows(false)` an Android window keeps its size when the system bars hide, so
only the insets move and no `ResizeObserver` fires."** The first half is true and now measured:
`innerWidth`/`innerHeight` stayed a constant 384×832 through every transition above and **zero**
`resize` events fired, so an observer on the UI ROOT genuinely never fires. The second half does
not follow from the first and was false as stated — it is true only of an observer on the root,
whose size genuinely does not change. A probe whose own size *is* the inset resizes exactly when
the inset does, independent of whatever its ancestor does; the fix was never "make something else
emit an event", it was "observe a different element."

⚠️ **A sized probe is MORE dangerous than a padding one in one specific way.** `padding` clamps a
negative to 0 and cannot be `auto`; `height` can be both. Measured in Chromium and WebKit: an
`env()` name the engine does not know makes the whole size declaration invalid, so height falls
back to `auto` and the probe reports its OWN content height as the inset — a confident, wrong,
non-zero number, measured at 18px in both engines. `max()` does not save that; the guard is the
explicit `0px` fallback *inside* `env(...)`, measured to give 0 in both engines. This deliberately
differs from `anchorCss.ts`'s `var(--ui-sa-<edge>, env(safe-area-inset-<edge>))`, which has no
inner fallback and needs none: there the expression sits inside `max(<padding>, …)` on a `padding`
property, where an invalid value just drops the declaration and yields no padding — safe. Don't
"align" the two.

⚠️ **A probe whose ancestor is `display:none` reports a confident 0×0, and the callback has to
reject it rather than write it through** — the same failure `getSafeAreaInsets` guards against on
the read side (a detached root), arriving through the other door. Measured in both engines:
`isConnected` stays **true** and `getComputedStyle().height` still reports the correct value, so
neither can tell a hidden probe from a genuine zero-inset device. `getClientRects().length` is the
discriminator: a real zero-inset device still has one rect, and so does a root with no box yet —
only a non-rendered subtree reports none. Detaching the root outright fires nothing at all, in
either engine, so only the hidden case reaches this guard.

**One synchronous measurement still happens, but only at REGISTRATION** — a mount, a resize, or a
scene swap handing the module a fresh root (`measureSafeAreaInsets`, called by `UIRenderer`) — to
get a correct value in place before the first observation arrives. That forced layout is the only
one left in this module, paid once per registration instead of on a 250ms poll for the life of the
session.

A **detached** root is refused on both sides. On the read side it is released rather than measured
(a cheap `isConnected` flag check, not a forced layout): `UIRenderer`'s unmount path never hands
this module a null, so the stale reference would otherwise keep pointing at a removed node —
releasing it is also what stops the whole removed subtree being retained. On the **write** side
`measureSafeAreaInsets` refuses a detached element outright, because `UIRenderer` rAF-defers the
call that registers a root: a container unmounting in the frame it mounted (a scene swap's
empty-tree beat, an editor panel closing mid-resize) otherwise lands a registration with a removed
node, and `getComputedStyle` on a detached probe answers empty strings — every inset rewritten to
0, which is #273's symptom exactly. `UIRenderer` also cancels that queued frame, so the two guards
meet in the middle. The last known insets are kept either way: a device's insets do not change
because some UI unmounted.

⚠️ **A root with no LAYOUT BOX must never become the denominator, and the two guards above do not
stop it — REGISTRATION screens on neither.** `getSafeAreaInsets` discriminates on `isConnected` and
`onProbeResize` on `getClientRects()`; the registration path needs neither in order to read the raw
insets, which is precisely what makes it the open door. `flexlayout-react` maximises a panel by
setting `display: none` on every other tabset container, and on the tabs of every non-maximised
tabset (read in 0.8.19's bundled `dist/index.js`; both writes are guarded on
`getMaximizedTabset(...) !== undefined && !isMaximized()`), and the editor mounts one `UIRenderer`
per viewport — so maximising the Game panel
leaves SceneView's root **connected but not rendered**. `isConnected` passes it through;
`getComputedStyle(probe).height` still answers the correct length under `display: none` (the same
measurement that forces `onProbeResize` to use `getClientRects` instead), so the raw px insets are
measured perfectly; only `clientWidth`/`clientHeight` are 0. `recompose`'s `total > 0 ? … : 0` then
rewrites all four `*Pct` to a confident **zero** — the one value a consumer cannot tell from a real
measurement, and the only fields `patchAnchorPct` and Court's six per-frame call sites read. The CSS
arm is immune because it is a `var()` with no arithmetic; only the JS arm divides.

Measured 2026-09-04: `games/wordweave`'s ad banner silently lost its 34px home-indicator lift the
moment the Game panel was maximised, `AdBannerSlot.UIAnchor.bottom` written as 0 while
`--ui-sa-bottom` still read `34px` and the padding arm on `HUD Root` stayed correct. Guarding it
restored the lift — bottom moved 966.75 → 931.39. ⚠️ Those are **device** px off the scaled preview,
so the 35.36 delta is post-transform and must not be equated with the 34px **logical** inset (the
exact trap the `*Pct` fields exist to prevent). It establishes that the lift returned, not its
magnitude.

So **both** writers of the denominator — registration (`applyMeasurement`) and the observer's
re-read (`onProbeResize`) — adopt the new box **per axis, only when it is greater than zero**,
keeping the last good one otherwise. That is this module's existing rule for a root it cannot
measure, applied to the case where the root is still there and only its box is missing. Per-axis
because a root can legitimately lose one dimension and keep the other; a real box always replaces
the retained one, so rotation and resize still work. Only the registration door has been observed
live — the observer's read sits behind the `rendered` bail, which does cover `display: none`, and is
guarded for consistency and against a root that is *rendered* with a zero box. That case is narrow:
only under the **`Free`** preset is GameView's UI root `position: absolute; inset: 0` over a `flex: 1`
area and able to be squeezed flat while still rendering (a flexlayout tabset's minimum is 1px, not 0
— but a 1px tabset holding a 32px toolbar still leaves the area at 0). Under a fixed device preset
the root is a `deviceW × deviceH` box and cannot collapse. A scene swap's empty→refill beat is the
same shape.

⚠️ **The retained box is not necessarily the current root's, and that is deliberate.** `rootW`/`rootH`
are module state and survive `releaseRoot()`, so a second root registering with no box divides *its*
insets by the *previous* root's dimensions. Clearing them on a root change would put the confident
zero straight back for the case above whenever the alternation lands that way — the editor's two
viewports alternate, so the poisoned registration **can be** a root change; which it is depends on
which viewport registered last, and that is not deterministic. Half the time is enough to disqualify
clearing. A foreign-but-plausible denominator also degrades far better than
a zero, which does not merely read wrong but *moves* things (Court's `syncMenuIconBar` is
change-gated, so a transient zero moves the icon bar and moves it back). Both viewports publish the
same `safeAreaCssVars(gameViewSafeArea)` and are normally sized alike, so the divergence window is
about a frame under the `Free` preset. If this ever has to be exact, the answer is a per-root box,
not clearing.

⚠️ **The percentages are recomputed against the CURRENT root box on every observation, not against
the one cached at registration** — a rotation moves the root and the insets together, and the probe
observation is delivered a frame BEFORE `UIRenderer`'s rAF-deferred re-registration. Measured:
384×832 → 832×384 with a bottom inset of 48 gives `bottomPct` 5.77 against the stale height where
12.5 is correct. It self-corrects a frame later, but Court reads these percentages every frame at
six sites, so the banner, board and narration band would all pop for that frame.

⚠️ **The preset numbers are mostly PUBLISHED, not measured**, and they model the
**physical** insets — the notch/Dynamic Island and the home indicator, i.e. what a
full-screen game sees with the status bar hidden. A device with no notch reports 0 there
(measured on the iPhone 8; that fact is what disproved the first attempt at the fix). See
the header of `editor/scene/devicePresets.ts` for what is verified, what is not, and the
Android caveat (real Android insets move with the OEM and with gesture vs 3-button nav).

### Rotation (`UIElement.rotation`)

`rotation` tilts an element by N **degrees clockwise**; 0 is square. It composes onto the anchor's
pivot translate (`translate(…) rotate(Ndeg)`), never replaces it — replacing it would MOVE the
element rather than turn it.

**It turns about the anchor PIVOT**, via a matching `transform-origin`. The pivot is by definition
the point of the element that sits on the anchor point, so it is the one point a tilt must leave
alone; rotating about the box centre would swing a `top-left`-anchored element off its own anchor as
the angle changed, which reads as a broken anchor rather than as a tilt. An element with **no**
anchor, or on a **stretched** axis (where the pivot is already ignored because both edges are
pinned), turns about its centre — there is no pivot to honour.

Why it exists (#234): **a nine-slice cannot bake its own tilt.** Slices are axis-aligned rects, so a
rotated master is cut along the wrong axes and the corners shear — and a dialog card has to be a
nine-slice, because one master serves both a wide panel and a tall one. So the choice was
tilt-in-the-engine or square, with nothing in between.

Two costs, both real:

- ⚠️ **A non-zero rotation creates a stacking context** (any CSS transform does), which traps the
  `zIndex` of everything inside it — the same trap `games/court/CLAUDE.md` records for
  `ChromeRoot`'s centre anchor. Tilt the CARD, not the layer that holds it. A zero angle emits
  nothing at all (no `rotate(0deg)`, no origin), so an element that predates the field is
  byte-identical and gains no stacking context.
- ⚠️ **The editor's selection overlay stays axis-aligned.** `resolveAnchorRect` measures an
  unrotated rect, so a tilted element's outline and gizmo box do not follow the tilt. Cosmetic —
  the render is correct — and deliberately out of scope.

### Scale (`UIElement.scale`)

`scale` is a **uniform** scale about the anchor pivot; 1 is natural size. It rides the same composer
as `rotation` (`applyRotationStyle` in `ui/anchorCss.ts`) and inherits every rule above: it composes
onto the anchor's pivot translate rather than replacing it, it takes the same pivot-derived
`transform-origin` so the anchored point does not move as the element grows, and it creates the same
stacking context. Uniform scale and rotation commute about a shared origin, so the order the two are
appended in does not matter.

**It scales the RENDER, not the layout.** The element's box keeps its laid-out size, so siblings do
not reflow and nothing shifts underneath a growing card. That is the reason the field exists at all
rather than keying `width`/`height`: those *do* reflow, and they leave text at its original size, so
a "pop" authored that way reads as a box stretching around stationary words.

Why it exists (#340): Court's level-win dialog snapped on screen with no transition, and the fix had
to be an **authored keyframe clip** rather than a tween in code (owner's standing rule — timing and
easing are data the owner retunes in the editor, not numbers an agent picks in a `.ts`).
`UIElement.opacity` was already keyable, but a fade alone reads as soft; a dialog wants to arrive.
No keyable property in the UI layer could express that. The worked example is
`games/court/runtime/assets/anim/dialog-pop.anim.json` — a scale track 0.8 → 1.06 → 1.0 against an
opacity track, played by an `Animator` authored on the card.

⚠️ **Identity is 1, and it is checked against 1, not against falsy.** `scale: 0` is a legitimate
authored value (a pop-in's first keyframe) and must emit `scale(0)`; a `|| 1` anywhere on this path
would silently promote it and the animation would start already open. The projection in
`uiTreeStore.ts` uses `?? 1` for exactly this reason. An element left at 1 emits no transform at
all, so everything that predates the field is byte-identical and gains no stacking context.

⚠️ Like `rotation`, the editor's selection overlay stays at the **unscaled** rect — `resolveAnchorRect`
measures layout, and this deliberately does not change layout.

**An offset means a different thing per axis, and the axis decides — not the field.**
On a **non-stretched** axis the anchor is a single *point*, so an offset **moves** the
box and leaves its size alone: `left`/`top` push away from that point, `right`/`bottom`
push *inward from the far edge* (i.e. they subtract from the same near edge). On a
**stretched** axis both edges are pinned, so each offset **insets its own edge** and the
box **shrinks** — `left: 5%` + `right: 5%` on a `bottom-stretch` bar is a pair of side
margins, giving a 90%-wide band. (Folding `right` back into the near edge there would
make the two cancel to a full-bleed box — the bug fixed 2026-07-31.) A stretched axis
also **clears any authored `width`/`height`**, so the two offsets fully govern that axis.

That last clause is a trap worth stating twice, because the authored value is still
*stored and displayed*: on a stretched axis `UIElement.width`/`height` can never take
effect, and the two offsets are the ONLY way to size it. The axes are independent — a
`top-stretch` element has an inert width but a perfectly live height. Three places agree
on this via the one predicate `isSizeInert` (`runtime/ui/anchorLayout.ts`), so none of
them can drift from the layout that does the clearing:
- **the layout** — `applyAnchorStyle` clears the CSS size, `resolveAnchorRect` overwrites
  the pixel extent;
- **the Inspector** — greys the field out per-axis (read-only input + disabled unit
  dropdown; across a multi-selection only when it is unanimous — see below) and, on
  hover, names the responsible anchor and the offsets to edit instead.
  The `AnchorLayoutNote` banner atop the Layout section says the same thing generically
  for the whole section; the per-field tooltip is the specific half — *which* axis, and
  what to reach for. It deliberately **supersedes** the field's own hint, because
  "0 = auto (sized by content/flexbox)" is false once the axis is stretched;
- **the scene validator** — warns on an authored size the anchor makes inert, so a scene
  read as JSON gets the same signal the Inspector gives, including for a prefab
  instance's overridden fields when a prefab resolver is available. Its noise budget
  (why `0` and `100%` are excluded) and the prefab-instance resolver contract are in
  [scene-loading.md](./scene-loading.md#scene-validation-warn-but-load).

**Across a multi-selection the gate is unanimous-or-nothing.** Because it *disables* the
control rather than merely dimming it, resolving it from the primary entity alone is wrong in
both directions: a stretched primary makes the field read-only on siblings where the value
genuinely takes effect, and an un-stretched primary lets a write land on siblings that
silently discard it — the very trap the gate exists for, re-entered through the selection.
So both gates read EVERY selected entity (`selectionSizeGate` / `selectionAnchorGate`,
`runtime/ui/uiAuthoring.ts`) and yield one of three verdicts: **inert** (dead on all → read-only
+ dimmed), **live** (dead on none → untouched), or **mixed** — which stays **editable**,
half-dimmed, its tooltip stating how much of the write will be discarded. Blocking the mixed
case would strand the entities where the value works, which is why "some are inert" may not
disable anything. The same rule governs the self-placement props and the `AnchorLayoutNote`,
which carries a "partly anchored" wording rather than claiming fields are disabled when they
are not. One distinction the two gates deliberately disagree on: an anchor with an unreadable
mode kills self-placement (any anchor does) but stretches nothing, so it leaves the size live.

The failure mode this guards: `games/court`'s `NarrationBand` carries `width: 90%` on a
`bottom-stretch` anchor whose `left: 5%` + `right: 5%` offsets independently produce 90%.
It looks deliberate and correct, and editing that field to `50%` would change nothing.

---

## `UIRenderer` — ECS → DOM

`runtime/ui/UIRenderer.tsx` is the entry point, mounted in both the **GameView**
(editor) and the running app (`app/App.tsx`, via `DefaultGameUILayer`). It:

1. Pulls the current UI node tree from `useUIEntities()`.
2. Measures its own container with a `ResizeObserver` and sets `--ui-vw/--ui-vh/
   --ui-vmin/--ui-vmax` CSS variables so viewport units resolve to the container.
3. Renders each root through `UINode` (recursive), passing a `storeState` object used
   to resolve bindings and an optional `onSelectEntity` callback (editor click-select).

The container is `position: absolute; inset: 0; pointerEvents: none` — only interactive
leaves (buttons, inputs, scroll containers) re-enable `pointerEvents`, so the UI never
blocks the 3D/2D canvases underneath.

#### `pointerThrough` — the escape hatch those rules cannot express

The rules above are inferred from STRUCTURE: an element with a click binding is interactive, a
LEAF with none is transparent, and a **container stays `auto` because it must pass events to its
children**. `overflow: 'scroll'` separately forces `auto` so the box can be scrolled.

That leaves one shape unrepresentable: **a decorative container drawn over something that must
stay tappable.** `UIElement.pointerThrough` is the author's explicit "let taps through to what is
behind me". It is applied last, so it outranks both inferences — inference must not beat a
statement of intent.

- It does **not** disarm children. CSS `pointer-events: none` on a parent leaves a child that sets
  `auto` fully clickable, which is the entire point: a decorative panel that still holds a working
  button.
- It is **ignored in the editor's click-to-select mode** (`onSelectEntity`). Selecting an element
  in the viewport is authoring, not gameplay — an element the game must not receive taps on is
  still one the author has to be able to pick.
- On an `overflow: 'scroll'` box it gives up **scrolling** (that is what the force was for), so it
  is correct only when the box is sized never to overflow.
- A child `Canvas2D` re-enables `auto` on its own mount, so a `pointerThrough` container wrapping
  one still delivers taps to the canvas. That is the "children keep their own" rule, not an
  exception to it.

Worked example — Court's narration band: a panel holding a Skip button, drawn above a full-screen
tap-catcher. Being a container (and a `scroll` one) it swallowed every tap meant for the catcher;
putting the catcher on top instead buried Skip inside the band's stacking context and made it
silently unclickable. Neither ordering works, because the two controls need opposite answers —
`pointerThrough` is what breaks the tie.

`UINode` (`runtime/ui/UINode.tsx`) translates one `UINodeData` into a styled DOM
element, applying the trait fields in order (layout → box style → image → text →
anchor → click handler), then recurses into children. It is wrapped in `React.memo`.

### Parent/child tree from `EntityAttributes.parentId`

There is no nested data structure in ECS — every UI entity is flat. The tree is built
in `runtime/ui/uiTreeStore.ts` (`buildTree()`): it queries all
`RenderableUI + UIElement` entities, reads `EntityAttributes.parentId` /
`sortOrder` for each, then links children to parents. The builder is **cycle-safe**:
any node whose parent chain doesn't terminate within `nodes.size` hops is treated as a
root and logged in dev (so the editor can flag a bad `parentId`).

⚠️ **`sortOrder` is NOT the stacking authority for anything that authors `UIAnchor.zIndex`.**
`sortOrder` decides DOM order among siblings (`buildTree`'s `sortChildren`, ascending — later
siblings paint over earlier ones). But `UIAnchor.zIndex` is copied onto the node and written by
`anchorCss.ts` as a real CSS `z-index` alongside `position: absolute`, and **CSS z-index beats DOM
order** — `sortOrder` is only the tiebreak between elements at the SAME z-index. Two root-level
anchored elements therefore stack purely by `zIndex`, whatever their `sortOrder` says.

This bites because a scene can carry two ordering tables that disagree, and only one of them is
real. Court's modal group is the worked example (2026-08-31): by `sortOrder` it reads
`AccountModal` 39 → `ConflictModal` 41 → `BusyOverlay` 42 → `StoreModal` 43, with the store on top;
by `zIndex` — what actually paints — `StoreModal` (50) is the BOTTOM of that group and
`ConflictModal` (55) and `BusyOverlay` (56) are above everything. A session diagnosing a stacking
bug there read the `sortOrder` column, "fixed" it by authoring a higher `sortOrder`, watched the
correct behaviour on device, and concluded the edit had worked — when the pre-existing `zIndex`
had always guaranteed it and the edit changed nothing. **Read the `zIndex` column, and when you
assert a stacking fix, verify it by perturbing the value you actually changed.**

---

## Projection & the dirty flag (no per-frame work)

The UI tree is **not** rebuilt every frame. `useUIEntities()` is a thin Zustand
selector over `uiTreeStore`:

```ts
export function useUIEntities() {
  return useUITreeStore(s => s.tree);
}
```

The store is updated by `uiTreeProjection(world)`, an ECS system registered at
`SYSTEM_PRIORITY.PROJECTION`. It checks a module-level `_dirty` flag:

- Any ECS write that could affect UI (`writeTraitField`, `deleteEntity`, …) calls
  `markUIDirty()`, an O(1) boolean set wired in via `addDirtyListener`.
- Each frame, `uiTreeProjection()` runs once; if clean it **returns immediately**
  (zero cost when the UI is idle); if dirty it clears the flag, rebuilds the tree, and
  pushes it into the Zustand store, which re-renders the subscribed React components.
- A world swap (scene change) forces a rebuild and clears the tree.

This replaced an older architecture that re-queried ECS and diffed ~50 fields per node
every frame. See [Architecture](./architecture.md) for where PROJECTION sits in the
frame pipeline.

---

## Pushing live values onto scene-authored chrome (`runtime/ui/sceneChrome.ts`)

A game's HUD, overlays and menus are **authored in the scene**, not built in code — the position,
size, colour and font of every panel live in scene JSON where the owner can reach them (see
CLAUDE.md § "Author values in the SCENE and the PREFAB"). What code still has to do is push the
*live* values through: the score, whether the pause overlay is showing, which entrance animation
just fired. `runtime/ui/sceneChrome.ts` is the seam for exactly that, and nothing else.

| Export | What it does |
|---|---|
| `patchUI(world, name, patch)` | Write `ChromeUIPatch` fields onto the `UIElement` of the scene entity called `name`. Returns whether anything actually changed. |
| `patchToggle(world, name, patch)` | The same for `UIToggle`. |
| `restartClip(world, name)` | Play the entity's authored `Animator` clip from the top. |
| `readChromeUI(world, name)` | Read the element back — for a test or a check, not a render path. |
| `findChromeEntity(world, name)` | The name lookup on its own. |
| `resetSceneChromeCache()` | Drop the name cache; tests call it in `afterEach`. |

Four properties of this module are load-bearing, and each exists because of a defect:

- **Writes are DIFFED.** An unchanged `UIElement` write costs a whole UI-projection rebuild (see
  § "Projection & the dirty flag" above), so `patchUI`/`patchToggle` compare first and call
  `markUIDirty()` only on a real change. `restartClip` is the deliberate exception — it must
  rewind a playhead that may already sit at the target, so callers edge-detect instead.
- **A present-but-`undefined` key means "leave it alone".** koota's SoA setter tests `'key' in
  value`, not whether the value is defined, so `{ isVisible: flags.show }` with an undefined
  `flags.show` would otherwise write a real `undefined` — blanking the element *and its whole
  subtree*, permanently, since the next identical call diffs as unchanged and never recovers.
- **The name lookup is cached but self-validating.** A hit is O(1); a miss costs one pass over
  every `EntityAttributes` entity (a few hundred in a real game). That cost is why chrome pushes
  are gated on a CHANGE rather than run per frame.
- **The cache clears on world swap**, registered lazily on first lookup — never at module scope,
  which would fire on import in every test that mocks `core/ecs/world`.

⚠️ **Several `UIElement` style fields are inert without a companion field that defaults to 0** —
`backgroundColor` needs `backgroundOpacity`, `borderColor` needs `borderWidth`. `ChromeUIPatch`
exposes both halves of each pair for that reason. The canonical statement of the trap, and the
full list, is on the trait itself (`runtime/traits/UIElement.ts`) — cite it rather than restating
it here.

**Position and size are NOT in this module's remit.** A game that needs to move authored chrome
does it in percentages, from its own code — see the `%`-vs-px warning under `UIElement` above, and
`games/court/runtime/sceneChrome.ts`, which keeps exactly those game-specific patchers as a thin
layer over these engine functions.

⚠️ **A DOM element (this `ui` layer) and a 2D canvas element (the `2d` layer, PixiJS) cannot be
spaced against each other by LAYOUT — only by a runtime patcher that composes both coordinate
spaces explicitly, the way `patchUI`/`patchAnchorPct` do here.** A DOM node's position is a `%` of
the HOST viewport; anything drawn on the 2D canvas is a `%` of the DESIGN box the canvas is
`contain`-fitted into. **The two boxes coincide exactly only at the design aspect ratio and in the
editor's default preset** — so a DOM control positioned by eye to sit flush against a canvas-drawn
element looks pixel-perfect on the machine it was authored on and drifts on any real device whose
aspect ratio differs, with nothing in the editor able to show the mismatch (Court's own `CLAUDE.md`
records the identical rule for a `%`-of-host value sized against a design-space one — cross-reference
rather than re-deriving it if you land here from that direction). The fix is always a function like
`games/wordweave`'s `designToHostPct` (`runtime/systems.ts`) that explicitly composes the canvas's
own letterbox scale/offset AND the safe-area inset into one host-percentage answer, called every
frame from the game's own system — never a static authored offset guessed from one screenshot.
`games/wordweave`'s `ZoomControl` (#628) is the worked example: it re-anchors to the crossword
panel's own corner, computed in DESIGN space and converted through `designToHostPct` every frame,
specifically because no authored `UIAnchor` offset could track a 2D-canvas-drawn panel that itself
moves with `boardShare`/device aspect.

---

## Anchor layout (`resolveAnchorRect`)

`runtime/ui/anchorLayout.ts` exposes `resolveAnchorRect(w, h, vpW, vpH, anchor)`, which
resolves a `UIAnchor` to a pixel rect within a viewport. It is the **shared** source of
truth for anchor math: the runtime DOM path in `UINode` mirrors it with CSS
`top/left/right/bottom` + `translate`, and the editor's `SceneView` uses it directly to
draw the device-space gizmo over the simulated viewport. Keeping both paths on one
function avoids the runtime and editor drifting on edge cases (pivot on stretched axes,
far-edge offsets subtracting inward on a point axis but insetting on a stretched one,
etc. — see the offset rules under `UIAnchor` above).

The parity test (`uiAnchorParity.test.ts`) feeds identical anchor data to both paths and
asserts they agree. **Agreement is not correctness** — it pins consistency, and the two
implementations can be wrong in the *same* way, which is exactly how the stretched-axis
offset bug survived. So that suite also asserts the resolved rect outright (a 5%/5%
`bottom-stretch` band must measure x=5%, w=90%), not just that the two paths match.

---

## Directional focus navigation (controller / keyboard)

`UIFocusable` opts an element into pointer-free navigation — a controller or keyboard
traverses and activates UI without a cursor. It is purely additive: pointer/touch is
unchanged, and focus stays inert until nav input arrives. **v1 is opt-in** — only
entities carrying the trait are focusable (auto-focusability for every interactive
element is a deliberate follow-up, to avoid changing existing pointer-only games).

### `UIFocusable` trait (`runtime/traits/UIFocusable.ts`)

All-scalar (GUID strings / number / booleans), so it serializes cleanly and is
editor-authorable:

- `focusable` — participates in nav (default `true`).
- `focusOrder` — tie-break within a scope (lower = earlier); seeds autofocus and is the
  stable fallback when no on-screen rect is available (headless).
- `navUp` / `navDown` / `navLeft` / `navRight` — explicit directional link target GUIDs;
  empty → fall back to spatial resolution. Authoring these pins a menu's traversal
  regardless of layout.
- `focusScope` — groups a screen/menu/modal; focus only moves among same-scope elements
  (`''` = default scope).
- `autoFocus` — when this scope becomes active and nothing is focused, focus lands here
  (lowest `focusOrder` wins among several marked).

### `uiFocusSystem` + `focusManager`

`uiFocusSystem` (`runtime/ui/uiFocusSystem.ts`) is an app-pipeline GAME-tier system
— it runs only while the sim plays, after `inputSystem` writes the frame's input edges.
Each tick it: gathers focusable candidates in the **active scope** (top of the scope
stack), ensures something is focused (autofocus if not), moves focus on a nav edge
(`navUp`/`navDown`/`navLeft`/`navRight`), queues activation on `confirm`, and pops the
scope on `cancel`. It reads only plain data (the `Input` resource, ECS traits, on-screen
rects, the focus store) — no wall-clock, no RNG — so it is determinism-guard-safe and
harness-testable.

`focusManager` (`runtime/ui/focusManager.ts`) owns the state in a Zustand store
(`focusedGuid`, a `scopeStack`, and `pendingActivateGuid`) so `UINode` re-renders its
focus ring reactively — no per-frame polling, matching the `uiTreeProjection` dirty-flag
pattern. `UINode` subscribes with `useFocusStore(s => s.focusedGuid === node.guid)`, so
only the entering/leaving node re-renders; the ring is a non-layout
`outline: 2px solid #4aa3ff` (offset 2px) that never shifts the flexbox box, and it is
**runtime-only** (suppressed in the editor's click-select mode).

Directional resolution, per move:

1. **Explicit link** — the `nav<Dir>` GUID, if it points at a live scoped candidate.
2. **Spatial** — `pickInDirection()` picks the nearest scoped candidate strictly in the
   pressed direction, scored by distance *along* the axis plus 2× the perpendicular
   offset (a slightly-off but closer target still wins; a wildly-sideways one loses).
   Rects come from the **DOM** — the same `[data-entity-id]` nodes the `layout-bounds` op
   reads — measured within ONE host, the one holding the focused node (the editor mounts a
   `UIRenderer` in both GameView and SceneView's preview frame, and the two are different
   projections of the same layout). A registered bounds provider is the fallback for a
   non-DOM host; headless (no rects either way) → spatial no-ops, but explicit links +
   autofocus still work.

   ⚠️ It read `collectScreenBounds()` alone until QA-UI-0002, and that never returned a
   rect for a UI entity: **every bounds provider is a 2D/3D renderer** (`Scene2D`,
   `Scene3D`, `SceneView`), and UI rects have always been merged separately from the DOM.
   So the spatial tier — the fallback that fires when an explicit link points at something
   no longer focusable — could not fire in a real game, and focus BLOCKED on a disabled
   button instead of skipping it. It looked healthy because the unit test registered a
   provider of its own.

Candidate gathering enforces **ancestor-inclusive visibility**: the canonical hide
pattern sets `UIElement.isVisible=false` on a panel container while its children stay
visible, and `UINode` prunes the whole subtree — so `gatherCandidates` walks each
candidate's parent chain and excludes any child of a hidden ancestor, matching the
renderer's prune.

**Deferred activation, on purpose.** `applyBindings`'s `call` path must run from an event
context, not a pipeline tick (it throws in dev otherwise — see `bindings.ts`). So
`confirm` does NOT fire bindings inside the system tick: `uiFocusSystem` sets
`pendingActivateGuid`, and `consumePendingActivation(world)` — drained from the
`UIRenderer` effect (or a headless test) — runs the SAME
`applyBindings(bindings, 'click', …)` a DOM tap runs. It clears the pending GUID first
(reading the live store value), so two `UIRenderer`s draining in one tick activate
exactly once. Focus fully resets on world/scene swap (`onWorldSwap` → `resetFocus`), so
stale GUIDs never linger.

---

## Scroll views and recycled entries (`UIScrollView` + `UIEntries`)

A scroll box with a **pooled** content set: a handful of prefab instances re-driven as you
scroll, so a view over N entries costs `visible + overscan` entities instead of N. Landed as
#250 + #316 (Court's level selector); the design tracker is deleted per `doc-conventions.md` and
its durable rationale folded in below.

**An entry is not a row.** The content is a `countX × countY` index space of **entries**, and one
entry is whatever the prefab says — a list row, a card, or a whole authored grid (a *page*). The
three shapes differ only in authored numbers, not in code paths: a vertical strip is `countX: 1`,
a horizontal one `countY: 1`, a pager is a strip whose entry fills the viewport (`100%`), and a
2-D grid has both above 1.

**The first draft modelled this as a vertical list of rows instead** — `rowPrefab`, `rowHeight`,
`firstIndex` — which is one of the three shapes dressed as the general one, and the mistake is
worth keeping rather than erasing. It would have made Court the EXPENSIVE case instead of the
cheap one: virtualizing 589 tiles needs per-tile recycling and a per-tile identity story, where
Court-as-One-case pools ~3 whole *page* entries it already authors. And the naming would have
leaked into the scene format, where it is costly to correct — `rowPrefab` on a horizontally-
scrolling shop strip is a lie an author reads past forever.

| Trait | Owns |
|---|---|
| `UIScrollView` | the box: `axis`, `snap`, `snapStop`, `overscroll`, plus engine-written `scrollX/Y` and viewport size — and content size, which the engine writes and only a reader consumes (see "Rules that bite") |
| `UIEntries` | what it shows: `prefabs` (a JSON bank of `{name, prefab}`), entry size, `gap`, `overscan`, `countX/countY`, `epoch`, `source` |
| `UIEntry` | stamped by the engine on each pooled instance: the **data** index, the slot, and `live` |

`UIElement.overflow: 'scroll'` is still what makes the box scroll — `UIScrollView` supplies the
position and the motion fields, and does not override what the author wrote.

### The contract: the engine asks, the game answers

The engine decides WHICH pooled instance shows entry (x, y); the game answers WHAT it says, via
`registerEntrySource(name, resolver)`. Keys are **member paths** inside the entry prefab
(`'Tile3/Solved/Num'`, `''` for the root); values are **trait-keyed** (`{ UIElement: { text } }`).

- A path must be FULL and match exactly one member — **ambiguity is an error, not a fan-out**.
  `level-tile.prefab.json` USED to carry three entities named `Num`, so a leaf-name match would
  have written all three and looked like it worked (⚠️ #344 collapsed that prefab to a single
  face — four entities, one `Num` — so the rule outlived its worked example). This differs
  deliberately from Court's former
  `patchUIInInstance`, which wrote every match by design — deleted in #316 with its last caller,
  so this is the only mechanism of its kind now.
- Trait-keyed with no shorthand, because a flat field map would have to *guess* a trait — a
  resolver returning a `UIToggle.value` would then silently write nothing.
- Bump **`epoch`** when content changes but the window does not (a level gets solved; an async
  manifest arrives). Without it the resolver is only called when the window moves.
- The member-path walker is **new engine code over the `parentId`/`localId` chain**, not a
  promotion of Court's former `findAllInInstance` (deleted in #316). `rootInstanceId` is stamped
  on a prefab's OWN members only — never inner members — so that helper's flat `rootInstanceId
  === rootEcsId` scan would have reached zero of a page prefab's 25 nested tile instances, which
  is why it was not the thing to promote.
- The scene's generated `resources` manifest only seeds what it is told is a ref:
  `UIEntries.prefabs[].prefab` must be registered in `REF_FIELDS_BY_TRAIT`
  (`loaders/sceneValidation.ts`) and in `SCALAR_RESOURCE_TYPE_BY_FIELD` as a `prefab`-typed ref,
  or the entry prefab is invisible to the manifest — the #53 "assets the build cannot see"
  class, silent in dev (which serves everything off disk) and broken only once shipped. Once
  registered, the entry prefab's own assets need nothing further: `SceneManager`'s transitive
  worklist walks its entities with the same collector used for scene entities, so a textured
  entry prefab, a font, or a prefab nested inside it are all acquired and scene-refcounted.

### Sizing, and why the two terms are separate

`poolSize = visible + 1 + 2 × overscan`:

- **`visible + 1`** is GEOMETRY — one entry always straddles the viewport edge at a partial
  offset. Required even at `overscan: 0`.
- **`overscan`** is LATENCY — how far the scroll travels between two pool updates. It is a
  FLOOR, raised at runtime to cover measured travel, because a fixed value blanks: on a Galaxy
  A23 a hard fling traverses up to **4.56 entries per pool update**, and `overscan: 1` blanked
  12/1787 frames.

The raise is **capped at three viewports' worth**. A jump (a `scrollToEntry`, a scrollbar drag)
reports thousands of entries of travel, and an uncapped raise pools every one of them — measured
live, a 5,000-entry list went from a 9-entity pool to 5,000.

⚠️ **The third viewport is not slack — it absorbs a dropped frame.** The window reaches the DOM
through event → ECS → projection → React commit, and that chain misses a frame about one time in
six: measured in the editor 2026-08-21, **7 of 40 frames** of a steady 8-entries-per-frame scroll
left the padding exactly where it was, and those frames were 13 ms like every other — not a
budget problem, a scroll event landing after the pipeline had already run. A one-viewport cap
cannot absorb that miss and the viewport goes **black**, which is how this was reported (a
trackpad flick on the strip). Three viewports was measured, not picked: five costs 45 rows where
three costs 29, buys five more entries per frame, and still blanks on a 30-per-frame flick.

**A `scroll` event also drives the pool immediately** (`driveEntriesFromScroll`), before the frame
paints, instead of waiting for the next pipeline tick. It opens a system tick deliberately — the
pool spawns, and `spawnEntity` tags `Transient` only inside one, without which a pooled entity
reaches the saved scene file. That is the specific reason pool growth is NOT driven from the DOM
`scroll` handler or a React effect directly: `spawnEntity` tags `Transient` only when
`inSystemTick()`, and `spawnPrefabInstance` tags it only when the run mode is not `stopped` — a
handler or effect spawning outside a tick would evade both checks silently, and CLAUDE.md's #18
incident (a stray runtime entity persisted into `tropical-island.json` via a plain save) is
exactly what an untagged pooled entity would repeat.

⚠️ **Travel is measured against the last PIPELINE tick, on both paths.** Two drives now land per
frame, and an accumulator reset by whichever ran first leaves the other reading zero travel and
shrinking the band that was just grown — the pipeline always runs second, so its smaller window
is the one that paints. Measured: the band pinned at 17 rows for every speed from 8 to 30 entries
per frame, and the view went black anyway.

Where that leaves the strip (5,000 entries, 120px rows, 440px viewport):

| scroll speed | before | after |
|---|---|---|
| 5 / frame | clean | clean |
| 8 / frame | 4 black frames in 20 | **clean, zero gap** |
| 12 / frame | black | **clean, zero gap** |
| 15 / frame | black | clean (200px partial) |
| 20 / frame | black | still blacks — the honest ceiling |

The band grows to 29 rows while scrolling that fast and returns to 9 at rest.

⚠️ **Travel is measured from the SCROLL, never from `first`, and that is the whole reason the
pool settles.** `first` is `floor(scroll / stride) − overscan`, so a travel taken from `first`
folds in the change in overscan — and overscan is computed *from* travel. That loop closes: on a
Galaxy A23 (2026-08-21) a 20 × 250 grid **left completely alone** flipped between a 9 × 8 and a
13 × 10 pool forever, re-driving on 102 of 154 frames and holding the device at ~30 fps with no
input at all. Scroll is exogenous; `first` is the response. The accumulator resets only when the
pool actually re-drives, so it stays "the distance the pool has to cover", dropped frames folded
in.

### The engine OWNS a pooled row's box — eight authored fields are inert there (#651)

`entriesSystem` pins the resolved entry box onto every pooled entry root every tick, and that
list is longer than it looks. Beyond `width`/`height`/`widthUnit`/`heightUnit` and
`flexShrink: 0`, it also forces **`marginTop/Right/Bottom/Left`** and
**`minWidth/maxWidth/minHeight/maxHeight`** to `0`.

Both groups exist for the same reason and attack the stride from opposite sides:

- **Margin sits OUTSIDE the border box.** An authored margin on the entry prefab root makes the
  real on-screen stride `entrySize + gap + marginStart + marginEnd`, while the whole scroll
  geometry is solved from `stride = entrySize + gap`. Unlike a one-off offset this is **per item
  and accumulates linearly with the index**: 200 entries at `entryHeight: 120`, `gapY: 8`,
  `marginBottom: 4` puts entry 199 at `199 × 132 = 26268` while `scrollToEntry(199)` writes
  `199 × 128 = 25472` — 796px, six entries short, and `padLeading` drifts by the same amount so
  pooled slots walk off their snap points the deeper you scroll.
- **A min/max constraint overrides the definite size from INSIDE it.** The pin writes a definite
  `width`/`height`; a `maxWidth` smaller than it silently wins, and the stride desyncs the same
  way. These four were missed by the original margin fix and are the same defect.

⚠️ **This is an "authored field that does nothing" — CLAUDE.md's partially-wired-authoring-surface
class — and the mitigations are deliberately incomplete.** `entriesSystem` warns once per slot per
field when it discards a non-default authored value (keyed `viewGuid:slot:field`, **not**
`entity.id()`, because koota recycles ids and a retired id would swallow a real mistake), and the
Inspector shows a "pooled row" note on the `UIElement` section, gated on the sibling `UIEntry`
trait via `selectionPooledRowGate`.

**The Inspector note cannot reach the case that matters.** `UIEntry` is stamped by the engine on
the LIVE pooled instance at spawn, so the note appears when you select a running row. The entry
**prefab** — the thing you actually open and author — carries no marker saying it is used as an
entry kind, and no such marker exists today. So the authoring path has no editor cover at all, and
the runtime warning is the only thing that catches it, after the fact.

### Measured on the low-end target

Galaxy A23 (Mali-G57 MC2), the shipped web build of `games/scroll-demo`, driven by real touch
(`adb input swipe`) with frame times and viewport coverage sampled per rAF:

| Scene | Fling p50 / p95 | Blank frames | Max travel | Entities at rest → peak | At rest |
|---|---|---|---|---|---|
| strip (1 × 5,000, 120px) | 16.7 / 33.4 ms | **0** of 688 | 40 entries | 34 → 52 | 57 fps, 0 pool updates |
| pager (40 × 1, viewport-sized) | 16.7 / 16.7 ms | **0** of 1,010 | 1 entry | 53 → 53 | 53 fps, 0 pool updates |
| grid (20 × 250, stride 128) | 16.7 / 66.6 ms | **0** of 409 | 14 entries | 229 → 407 |

⚠️ The **peak** column predates the three-viewport cap and will now read higher on a fast fling;
the at-rest figures and the frame times are unaffected (touch travel never exceeded ~2 entries
per frame on that device, so the raise rarely fires there at all). 61 fps, 0 pool updates |

Read it as three separate facts. **Recycling keeps up**: no fling on any shape ever exposed a
gap, at travel up to 40 entries between two pool updates. **Snapping bounds the pager to exactly
one page per fling** when the entry *is* the viewport — which is not a contradiction of the
`snapStop` note above (a 120px entry crossed 3), just the same rule at a different entry size.
And **the 2-D grid is genuinely heavy**: 229 DOM entities is ~7× the strip's, and a fling holds
p95 at 66 ms. That is the cost of a grid on a Mali-G57, not a defect — but it is the number to
weigh before making Court's page a scrolling grid rather than a pager.

### Focus follows the ENTRY across recycling — measured

`games/scroll-demo`'s `row.prefab.json` authors `UIFocusable` for one reason: nothing else in the
repo does. Court's selector is pointer-driven and uses no focus nav, so the engine's
focus-on-recycle re-target (`runtime/ui/entriesFocus.ts`) had zero live callers before this — the
same "an API nothing calls" shape as `scrollTo`'s buttons, one layer up.

`uiFocusSystem` autofocuses the first row on Play, and as you scroll the focus ring stays on the
same **Entry N** while hopping between pooled entities. Measured in the editor 2026-08-22 — a
wheel up from `scrollTop` 363 to 123 moved the ring from entity **22 to 24** with its label still
reading `Entry 1`, while entity 22 went on to show `Entry 0`. That second half is the bug being
prevented: without the re-target the ring would have sat on entity 22 and the player would have
been on `Entry 0` believing they were on `Entry 1`.

### Status (#250, #316, #321)

Built as the live verification harness for #250 and kept as `games/scroll-demo`. All three of the
plan's cases are authored and were measured in a running editor (2026-08-21) — and authoring the
two new ones is what found three engine defects the vertical strip could not expose: the
collapsing content box, a resize that never re-laid-out, and `scroll-snap-align` that no code ever
applied. All three were then flung on a Galaxy A23 with real touch input — no blank frames on any
shape, and a defect that only a device could show: the overscan raise fed itself, so a grid nobody
was touching re-drove its pool on 102 of 154 frames (see "Measured on the low-end target" above).
`wheel` and `scrollbar` were authored on the pager on 2026-08-22 (#321) and measured in the editor
the same day: a trusted 480px wheel advances the pager **exactly one page** (410px) and three
gestures in a row land +1, +1, +1 with a reverse flick at -1, while the identical wheel on the
strip travels 363px freely — the half that proves the `'native'` default survived. And the two
boxes read `clientWidth == offsetWidth` (pager, `scrollbar: 'hidden'`) against **447 vs 462**
(strip, the `'auto'` default): the 15px a classic desktop scrollbar steals, measured on the same
machine in the same session rather than quoted.

The Court migration landed on 2026-08-21 (#316) — Court's level selector is a pager over this same
mechanism, with a 5x5 page as the entry, and wiring its arrows to `scrollToEntry` immediately
found two engine defects this harness had not.

`entryWidth`/`entryHeight` of **`0` means "read it from the prefab root"**, so a fixed-size entry
is not a second copy of a number the prefab already states; `%` resolves against the viewport,
which is how a pager is expressed.

### Motion is CSS, and the vocabulary matches

`snap` / `snapStop` / `overscroll` map to `scroll-snap-align`+`scroll-snap-type`,
`scroll-snap-stop` and `overscroll-behavior`. There is deliberately **no** `deceleration`,
`elasticity`, `duration` or `easing`: CSS cannot honour them, and an authored field that moves
nothing is a lie with a tooltip.

⚠️ **The owned-physics backend is DECLINED, not pending** (owner, 2026-08-21). Shipping CSS
first was what made the question answerable by feel instead of by argument: the owner scrolled
the real Android build on a Galaxy S22 and judged it good. Reopen only for a concrete motion CSS
cannot express — and name it. Recorded in [todo.md](./todo.md) § Declined so it is not
re-litigated.

⚠️ **`snapStop: 'always'` CONSTRAINS a fling; it does not cap it at one entry.** Measured on an
A23: one hard fling advanced **11** entries at `'normal'` and **3** at `'always'`, while a slow
drag advanced exactly 1. The cap is the POOL's extent — a browser can only stop at snap points
that EXIST in the DOM, and recycling is what removes the further ones. So do not size a pool to
buy a feel promise.

`scrollToEntry(viewGuid, {x, y}, {behavior})` and `snapToNearest` request in **entry**
coordinates (the system converts, since it is what resolves entry size); the declarative
`ui.scrollTo` action does the same from a button with no game code. Both are exercised by
`games/scroll-demo`'s strip scene — two authored buttons, one `instant` and one `smooth` — and,
since #316, by Court's level-selector arrows, which is the first caller in a SHIPPING game.

⚠️ **The per-request `behavior` and the authored default are TWO fields, and must stay two**
(#409). `UIScrollView.scrollBehavior` is authored; the request rides the `runtimeOnly`
`scrollToBehavior` and is consumed with the rest of the request by `clearScrollRequest`.
`scrollToEntry` used to store the request ON the authored field, so a call that named no
`behavior` — which defaulted to `'instant'` — permanently destroyed an author's `'smooth'`, and
the next save wrote the overwrite into the scene as authored data. Marking the field `runtimeOnly`
could not fix that; it would have deleted the author's choice instead. Consequence at the call
site: **omitting `behavior` is not the same as passing `'instant'`** — the request then moves the
way the view was authored to move.

⚠️ **OMIT the axis the view does not scroll — `0` is a REAL request, not "no request".** The
sentinel is `-1`. Court asked for `{x: page, y: 0}` on an `axis: 'x'` view; that converted to
`scrollToY: 0`, and because `clearScrollRequest` used to clear only the VIEW's axis it could never
be cleared. `pendingScrollTo` then returned a request on every rebuild, each firing
`scrollTo({top: 0})` with no `left` — which per spec keeps the CURRENT left, so it cancelled the
in-flight smooth scroll about 20 ms in and re-targeted it to roughly where it started. **The
arrows moved nothing, the trait read a clean `scrollToX: -1`, and every unit test was green.** The
clear now clears BOTH axes so the mistake is recoverable, but the call site should still be right.

⚠️ **A converted request must DIRTY the tree.** The px request lands on `UIScrollView` through
the same raw no-dirty `entity.set` the scroll read-back uses, so when the window has not also
moved, nothing rebuilds the UI tree and `UINode`'s one-shot `scrollTo` effect never re-runs —
the request then sits on the trait forever. The API shipped that way and it took wiring the
first real caller to see it: the trait read `scrollToY: 480000` while `scrollY` stayed 0.
Verified live afterwards (2026-08-21): `instant` lands 480,000px in one frame, and `smooth`
eases over 86 frames with 85 distinct intermediate positions.

⚠️ **Clearing the request dirties too, and that asymmetry is deliberate.** The effect is keyed on
the request VALUES, so a second request for the SAME offset only re-fires if the tree observed
the `-1` in between — otherwise the stale value compares equal and the request is swallowed.
The declarative `ui.scrollTo` path HIDES this, because `bindings.ts` dirties after applying any
binding, so the tree happens to see the cleared value first. A game calling `scrollToEntry()`
directly has no binding and no such rescue, so the same call would work from a button and not
from code. Everything else in `scrollViewDom.ts` stays dirty-free; a consumed request costs one
rebuild and is never per-frame.

### Rules that bite

- **The system runs at `SYSTEM_PRIORITY.UI_ENTRIES` (270), ≥ `TRANSFORM`.** `runPipeline` skips
  everything below `TRANSFORM` while the sim is stopped, and a settings list or a level select is
  exactly what you scroll while paused — a sim-gated pool would stop RECYCLING while the native
  scroll kept moving.
- **The scroll read-back does NOT dirty the UI tree.** `UINode` writes `scrollX/Y` through a raw
  `entity.set`, bypassing the `markUIDirty` hook, so a scroll frame that does not move the window
  costs one field write. Routing it through a dirtying helper rebuilds the whole tree at fling
  frequency.
- **The editor mounts `UIRenderer` TWICE, and the measurement is keyed by GUID (#413).** One in
  the Game panel, one in SceneView's UI preview — two real React trees over one ECS world, so a
  scroll view has two DOM elements, two `ResizeObserver`s, and ONE `UIScrollView` slot to write.
  The element inside a hidden dock tab measures 0x0, and with `entryWidth` authored in `%` a zero
  viewport makes every entry zero-wide, the window empty and the pool zero-slot — a blank view
  with **every diagnostic silent**, because the prefab is cached and the source is registered.
  Court's calendar and level selector both sat blank on this. `push()` therefore refuses to record
  a measurement from an element that generates no box (`readScrollMeasurement`): a zero-extent view
  can display no entries either way, so declining costs nothing, while accepting it destroys the
  only good measurement. ⚠️ The device-size gap this used to warn about can't actually happen —
  SceneView sizes its preview from GameView's own size, so both mounts share one logical device
  size by construction; the residual hazard is a MIXED measurement instead — a real viewport from
  one mount paired with `scrollX: 0` from the other while the two trees disagree on scroll offset,
  which can still land the pool's window outside the visible band and blank the view.
- **`contentWidth`/`contentHeight` are DIAGNOSTICS the engine writes and does not read (#414).** They
  carry the box's `scrollWidth`/`scrollHeight` — its full content extent — and every consumer in the
  repo is a human or an agent reading the trait through Percept: `contentWidth === viewportWidth`
  while `countX: 5` is the observation that first said "this view is sized for one page" in #413. No
  engine code derives anything from them. `entriesSystem` and `scrollApi` use only the **viewport**
  pair, and a pooled view's own extent is the PADDING `writeLayout` computes from the entry stride,
  which is a separately-computed quantity. This is deliberate, not an oversight: they are also the
  intended source for the extent-derived features a pooled view cannot supply — a scrollbar thumb
  (`viewport / content`), edge fades, a "can this scroll?" affordance, scroll-to-end, near-the-end
  prefetch, and the upper clamp `scrollByEntry` still lacks — it clamps at `0` only, so a wheel past
  the last entry arms a request off the end, `consumeEntryRequest` hands that target back, and
  **this frame's pooled window is planned for a place the view never reaches** before the DOM clamps
  the offset. The view lands right; the pool spent a frame elsewhere, and nothing in the engine can
  answer "already at the end" for a caller wanting to grey the arrow out (Court's `level-page`
  handler clamps for itself with `clampPage`). All of those are `content − viewport`, and on a
  `UIScrollView` carrying **no** `UIEntries` there is no other source for it.
  ⚠️ **Scope the measurement to one owning tree before building behaviour on them** — they come from
  whichever of the two editor mounts fired, which is exactly the mixed-measurement hazard above.
- **A parked entry reads as DESTROYED to Percept and Enact** — not listed, not aimable, subtree
  included. This is NOT the same as `isVisible: false`, which stays addressable.
- **Every pooled instance shares the prefab's authored `sortOrder`**, so ties fall to koota
  archetype order fixed at pool-creation time — nothing to do with an entry's data position after
  the first recycle. Entries can render in the wrong visual order while every trait value reads
  correctly, the worst shape of "data-correct ≠ pixels-correct" — fixed by writing `sortOrder` to
  the data index on every recycle.
- **`UIElement`'s padding units default to `'%'`, and CSS percentage padding resolves against the
  containing block's WIDTH on both axes** — so a `%` vertical padding is silently wrong. The
  offset write therefore pins the UNIT alongside every padding value it writes; the value on its
  own would be read as a percentage of the WIDTH, on the vertical axis too.
- **Two engine-owned layers sit under the box**, both spawned inside a system tick so they are
  `Transient` and never reach a saved scene: a `__uiEntriesContent` column, and one
  `__uiEntriesRow` per pooled row. See "the DOM shape" below for why the row layer exists.
- **The entry prefab root needs `RenderableUI`**, or the entry renders nothing while looking
  perfect in `get_scene_state`.
- ⚠️ **A prefab the loader never caches leaves the view BLANK, and since #363 it says so.** "Not
  cached yet" is normal for the first frames of a scene load, so `spawnInstance` returns `0` and
  the system retries — but a *permanent* miss is indistinguishable from a transient one at that
  return value, and used to be retried silently forever with no throw, warn or log. The provider
  is now asked `isCached` directly (a zero `rootSize` cannot answer it — an unsized prefab root is
  a legitimate `0`), and `UNCACHED_WARN_TICKS` consecutive pipeline ticks of "no" warns once per
  view, naming the prefab and the causes that were verified against the loader: a GUID that is not
  the one the file declares as its `id`, a prefab unreachable from the scene's `resources`, or a
  fetch that failed. It is exactly the diagnostic #344 lacked — Court's level selector rendered an
  empty grid with `npm run verify` green at 8,462 tests, because every one of those tests reads the
  prefab FILE and the file was well-formed.
  ⚠️ **#344's recorded cause — "a `version: 2` makes the loader decline to cache" — is not real,
  and the belief had spread to four places.** `fetchPrefab` (`meshTemplateCache.ts`) fetches,
  parses and caches without ever inspecting `version`; `editor/scene/prefab.ts` *wrote* `2` for
  any prefab holding nested-instance rows; and `games/court/.../level-page.prefab.json` carried 25
  nested rows at version `1` and worked. (Both of those are stated in the past tense on purpose:
  #379 made every writer stamp `PREFAB_FORMAT_VERSION` unconditionally and migrated the fleet, so
  `level-page.prefab.json` now reads `2` like everything else. The argument is unaffected — it was
  never about which value, only that no value gates loading.) **Confirmed live** (#365): with `level-tile.prefab.json`
  set to `2` and the editor restarted cold, the selector rendered its full 100 tiles at rects
  byte-identical to the version-1 control, with nothing logged. `prefabFormatVersion.test.ts`,
  which required every committed prefab to be `1` citing that mechanism, is **deleted** — it
  guarded a non-entrance and contradicted the serializer, so any editor re-save of a nested prefab
  would have turned `npm run verify` red telling the author to undo what the editor had just done.
  What actually emptied #344's grid is **still unestablished, and probably not a defect at all**:
  the reported commit was checked out and booted COLD, and it rendered the grid in full. The
  symptom belongs to one editor session, not to a tree — most likely the prefab cache serving the
  pre-restructure doc under a live editor. See [prefabs.md](./prefabs.md) and #365 before acting on
  the version theory again.
- ⚠️ **`axis` PINS the cross axis, and it has to.** `UIElement.overflow: 'scroll'` is a both-axes
  CSS property, so an `axis: 'x'` view scrolled vertically too — and on any platform with CLASSIC
  scrollbars (desktop web, the Electron editor) the second scrollbar STEALS cross-axis space from
  the content box. Measured in Court's selector (2026-08-21): a 31.6vh page inside a 31.6vh box
  came back **203px against the grid's 218px**, so the 5-across grid hung 15px outside its own
  page. `axis: 'x'` now emits `overflow-y: hidden`, and `'y'` the mirror.
- ⚠️ **A converted `scrollToEntry` builds that frame's window from the TARGET, not from the
  scroll still observable** (`entriesSystem`), and moves the travel baseline with it. This is the
  fix for a snap/recycling failure that had two faces and one cause: the offset is carried as
  PADDING, so a window built from the observable scroll described where the view WAS while the
  DOM moved to where it had been ASKED to go — and `scroll-snap-type: mandatory` answered that
  mismatch by re-snapping to the previously-snapped ELEMENT, which recycling had just repointed at
  different data. That moved the scroll, re-drove the pool, rewrote the padding, and re-snapped.
  Measured before the fix: asking for page 12 landed on 4 and page 23 on 6 (converging a few pages
  per attempt), and frame time at REST — no input, no pool churn — was **p50 39ms / p95 52ms**
  against 13/18. `scroll-snap-type: proximity` fixed neither.
✅ **Judged good on real touch hardware** (owner, 2026-08-22): Court's level selector, the shipped
iOS build on an iPhone Air — *"Scroll feels good on Air."* That is the verdict the CSS-motion
decision below rests on for touch, taken on a second device and a second platform after the S22
Android run, and it is what closes out the snap question: snapping stays ON throughout, with no
suspension. A perf number for the LOW-end target (Galaxy A23) is still owed — see #320; feel and
frame budget are different questions and the Air answers only the first.

- ⚠️ **Do NOT fix a snap/recycle symptom by suspending snap while the view moves.** It was tried,
  it worked, and the owner felt what it cost within minutes: with snap off during momentum the
  browser cannot decelerate INTO a snap point, so the view coasts to a full stop mid-entry and
  then jerks into line — *"the scroll stops completely once, then it snaps"* — and past the
  halfway mark that jerk reads as an extra entry. Fix the window instead; snap then has nothing to
  correct and stays on throughout. Verified with snap mandatory the whole time: swipe +1, +1,
  fling +3, swipe -2 all land exactly, a programmatic jump to entry 19 lands on 19, and frame time
  is p50 13ms at entry 3 AND at entry 21.
- ⚠️ **A HIDDEN view releases its pool, and "the pool never shrinks" never meant otherwise.** That
  rule is about not churning entities mid-scroll, when the device is busiest; holding them once
  nothing can see the view is a different thing and it cost real memory during play. Measured on a
  Galaxy A23 (2026-08-22): opening Court's level selector took the world from **668 to 1,477**
  entities, and closing it released **none** — 809 entities, 55% of the total, carried for the rest
  of the session behind a screen the player had left. The release checks BOTH ways the engine takes
  something off screen — `EntityAttributes.isActive` (cascading) and `UIElement.isVisible` (a
  per-element hide) — and walks the ANCESTOR chain, because the shipping case hides a ROOT above
  the scroll view, not the view itself. Re-showing rebuilds by re-instantiating.
- ⚠️ **`overscan` is NOT "how many extra you can see" — a pager needs 1 even though only 2 entries
  are ever visible.** Tried at `0` on Court's pager: the pool halved to 2 and never blanked at any
  speed (0 blank frames at ⅓, 1 and even 3 pages per frame) — and *landings broke*, a jump to page
  4 arriving at 0 and a fling to 4 arriving at 21. With no spare, a re-drive can remove the entry
  the scroll offset is standing on, and snap then grabs whatever does exist. **A blank-frame test
  does not cover this**; that is how `0` looked safe. The margin is what keeps the current entry in
  the pool across a re-drive, not what fills the viewport.
- ⚠️ **`wheel: 'entry'` on a PAGER, or a trackpad flies through pages.** A wheel delta MULTIPLIER
  cannot help: under `snap: mandatory` the browser quantises any offset to a whole entry, so
  scaling the delta changes nothing on screen. What needs bounding is how many entries one gesture
  may cross. A single mouse NOTCH (~100-120px against a 218px page) is under half an entry and
  snaps back to where it started; a trackpad swipe emits a rapid stream whose deltas accumulate
  into hundreds of px before the browser resolves them, so one flick crossed several pages (owner,
  2026-08-22: *"with the mouse wheel, scroll is too sensitive"*). `'entry'` moves exactly one entry
  per gesture, where a gesture ends after 140 ms of wheel silence — a fixed cooldown instead would
  let a trackpad's continuous stream re-fire and reintroduce the runaway. Default is `'native'`
  because a long LIST wants the raw delta; capping a 5,000-row strip to one row per gesture would
  be unusable. **Touch is unaffected either way** — a swipe is not a wheel event.
- `scrollByEntry(viewGuid, {x|y}, {behavior})` is what backs it: "move one entry from wherever I
  am", the same window arithmetic `snapToNearest` does plus a delta. A caller cannot compute it
  itself — the engine publishes no resolved entry stride, and `firstX` is the first POOLED entry.
- ⚠️ **`scrollbar: 'hidden'` when the box is sized to fit its content exactly.** A classic
  scrollbar takes ~15px off the CROSS axis, and mobile's overlay scrollbars take none — so
  authoring the box bigger to compensate leaves a gap on the platform that ships. Court's page
  grid was clipped 7px top and bottom until this was authored. Default is `'auto'`.

### Addressing a live entry — data coordinate, not identity

A parked entry (above) is the easy case. The one that produces a wrong answer SILENTLY is a
*visible* entry whose data coordinate changed underneath it: same entity, same guid, different
row of data. An agent that reads a guid while the view shows entry 5 and aims at it two calls
later — after a fling — drives entry 12 and gets a clean `ok:true`. That is a **false success**
([enact.md](./enact.md)) wearing a new hat: the standing advice is "address by `{guid}`, never
`{id}`", and here even the guid is not a stable address.

⚠️ **There is no address that survives this yet.** `entityResolve` accepts `{guid} | {name} |
{id}` and nothing else, so today the only safe protocol is to **re-read the guid immediately
before acting on it** — the same "re-read bounds immediately before acting" rule, one level up.
The plan proposed a data-coordinate address resolved server-side inside the call, refused when
the coordinate is not currently realized (scrolled out, or past `countX`/`countY`), the way
`selector`/`tap_handle` already work:

```
entity: { entry: { view: '<scroll-view guid>', x: 3, y: 0 }, surface: 'game-ui' }   // NOT BUILT
```

That is a **proposal, not a surface**. Nothing parses it; do not write it into a call.

⚠️ **A pooled instance's guid is random unless made otherwise.** `spawnPrefabInstance` mints a
fresh `newGuid()` root unless given a `guidSeed`, and members derive off that root. The pool
passes a deterministic `guidSeed` built from the view guid + slot (which the determinism guard
wants anyway) — but that makes the guid stable at the **slot**, not the entry.
`{entity:{name:'Tile3'}}` means "whatever is in slot 3 right now", and its meaning changes as you
scroll; addressing by `{name}` is worse still, since every pooled instance of one prefab collides
and CLAUDE.md says that is refused rather than first-matched.

### Focus follows the ENTRY, not the slot

The same hazard, one layer up, and it bites the PLAYER rather than an agent. Focus is addressed
by guid (`focusManager`), a pooled instance's guid is stable at the **slot**, and the window
moves data under the slots — so a recycle leaves the focused guid resolving to a live, visible
element that is now showing different data. A gamepad cursor on level 5 is silently on level 12,
and the next Confirm launches the wrong one. Nothing errors, which is why this stayed latent as
long as it did: neither Court's selector nor `games/scroll-demo` uses focus nav, so nothing on
the surface could show it (#319).

So `entriesSystem` captures where focus sits — the entry coordinate plus the member path inside
that entry — before it re-drives the slots, and re-points focus at whichever slot holds that
entry afterwards (`entriesFocus.ts`).

- **It runs at `UI_ENTRIES` (270), inside the drive that caused the recycle**, not in
  `uiFocusSystem`. That system is GAME-tier and therefore dead while paused — the same reason the
  pool itself runs at 270.
- ⚠️ **When the entry has left the pool entirely, focus CLAMPS to the nearest resident entry**
  (owner, 2026-08-22). Clearing focus is the simpler rule and was rejected on feel: with a
  gamepad, focus vanishing mid-fling reads as a dropped input, and autofocus would then drop the
  cursor at the list's lowest `focusOrder` rather than where the player was looking. Clamping
  makes focus ride the leading edge in the direction of travel.
- **The member path is a `stepId` chain, and both obvious alternatives are wrong.** It cannot be
  `resolveMemberPathIn`'s name path: that walker calls an ambiguous segment an ERROR by design,
  which is right for an authored resolver key and wrong here — this path is DERIVED from an
  entity that provably exists, so refusing it would mean declining to re-target focus that is
  demonstrably sitting somewhere (the worked example was `level-tile.prefab.json` carrying three
  `Num`s — ⚠️ #344 collapsed it to one, so the reasoning stands but that prefab no longer shows
  it). And it
  must not be **name + ordinal among siblings**, which is the tempting fix and is unsound: that
  order comes from `buildChildIndex` iterating `world.entities`, which is koota's `dense` array,
  which `releaseEntity` maintains by **swap-pop** — destroying any entity moves the world's LAST
  alive one into the freed slot. `releaseViewPool` destroys hundreds at once when an unrelated
  view is hidden (809 on Court's selector close), so a destroy elsewhere can reorder two siblings
  of a live instance relative to the same two in every other instance, and the ordinal would then
  name a different member per slot with no error anywhere. A segment is therefore
  `PrefabInstance.parentLocalId || localId` — authored, identical across instances, unique among
  siblings by construction. That is not a new claim: `deriveInstanceMemberGuids` already builds
  every member guid from exactly this chain, for exactly this reason.
- ⚠️ **A QUEUED ACTIVATION moves with the focus, and forgetting that half fires the wrong
  element.** A "confirm" is deferred on purpose: `uiFocusSystem` sets `pendingActivateGuid`
  inside the pipeline tick and `UIRenderer` drains it from a React effect after commit, because
  `applyBindings`' `call` path throws from a tick. `driveEntriesFromScroll` runs straight off the
  DOM `scroll` event, so a re-drive lands *inside* that gap — and a queued guid left on the old
  slot would activate whatever entry the slot recycled to. Confirm on level 5 launching level 12,
  from one fling. `retargetFocusedGuid` moves both or neither; never call `setFocus` here.
- **Zero cost when nothing is focused** — one `focusedGuid()` read, which returns the empty
  string in every game today.
- `focusOrder` is authored once in the prefab and is therefore identical across the whole pool,
  so nav ORDER between entries still falls entirely to the DOM-rect spatial path. That is a
  separate gap and this does not close it.

### The DOM shape — a column of auto-width rows, and why a flat box cannot work

The scroll offset is carried as **padding**, and CSS padding eats the box it sits on. A single
content child at `width: 100%` with `padding-right: 23040px` has a content box of **zero**: every
entry in it shrinks to nothing and `flex-wrap` has no line to wrap into. Measured on
`games/scroll-demo` (2026-08-21): pager pages came back **0px wide**, and grid tiles authored at
120px rendered at **36px stacked in one column**. The vertical strip survived only because
vertical padding does not touch the *horizontal* content box — which is precisely why one axis
shipped looking correct while both others were broken.

So the content child is a **column of auto-width rows**: an auto-width box sizes to
`padding + children` instead of being squeezed by its own padding.

| Element | Carries |
|---|---|
| the scroll box | `overflow`, `scroll-snap-type`, `overscroll-behavior` |
| `__uiEntriesContent` (column) | the **Y** offset as `padding-top`/`bottom`, and the **Y** gap as `gap` |
| `__uiEntriesRow` (row, auto width) | the **X** offset as `padding-left`/`right`, and the **X** gap as `gap` |
| the pooled entry | the resolved entry size in px, `flex-shrink: 0`, `margin: 0`, and `scroll-snap-align` |

Three things fall out of the split rather than needing their own rule: `UIElement`'s single `gap`
field serves both axes (a column's gap is the Y gap, a row's is the X gap); wrap disappears, so
the 2-D case never has to reconcile "break every `pooled` entries" with the width the scrollbar
needs; and `padLeading + rendered + padTrailing` lands exactly on `count × stride − gap`
(verified live: a 20 × 250 grid of 120px tiles at `gap: 8` measured `scrollWidth` 2552 and
`scrollHeight` 31992).

**The engine writes the resolved entry size onto the pooled root**, in px. That is not a shadow
of the authored value — it *is* the authored value resolved (`%` against the live viewport, `0`
read back from the prefab root), and a definite box is what a `%`-sized prefab root needs once
its parent is an auto-width row.

⚠️ **The pooled root's margin is zeroed too, for the same reason `flex-shrink: 0` is (#651).**
`stride = entrySize + gap` is the whole model — every offset above (`padLeading`/`padTrailing`,
`scrollToEntry`'s px conversion) is `index × stride`. Margin sits OUTSIDE the border box, so an
authored margin on the entry prefab root would make the REAL on-screen stride
`entrySize + gap + marginStart + marginEnd`, a term the model never carries — and unlike a single
intercept, this one is per-entry and compounds linearly with index, drifting every pooled slot
further off its scroll-snap point the deeper the list goes.

⚠️ **Two things change the window without moving its origin, and both are in the invalidation
test.** A viewport RESIZE leaves `first` put while every padding value changes — without that the
pager kept a 640px page inside a 395px panel, for good. And at `scroll = 0` the origin is
CLAMPED to 0, so a travel spike that raises the overscan and then decays changes `pooled` while
`first` cannot move: with only the X pooled count tracked, the top of the 5,000-entry strip went
from 8 rows to 29 on a fast scroll and stayed at 29 through 60 idle frames. Entry size AND the
pooled count on BOTH axes therefore invalidate, not just the origin.

**Snapping is declared on the box and honoured on the TARGET**, and those are different
elements. The tree build stamps `scroll-snap-align`/`scroll-snap-stop` onto the pooled entries
(or, for a scroll view with no entries, onto its direct children). Stamping the *entry* rather
than the row serves both axes at once. `scrollSnapChildStyle` shipped with a unit test and no
caller, so `snap` styled the container and nothing ever snapped — found by measuring the pager's
DOM, and the reason this paragraph exists.

### Degenerate shapes

`countX`/`countY: 0` is undefined — nothing renders, and whether the view still scrolls to
nowhere is unspecified. More sharply: a scroll container needs a **definite** cross-axis size,
and `UIElement.height` defaults to `0` = auto — so an un-anchored scroll view in flex flow grows
forever and never scrolls, with **no error at all**. Author an explicit height (or anchor the
view); there is no diagnostic for this yet.

⚠️ **Nested scroll views WORK — read the sentence below as a scoped gap, not a prohibition.** A
horizontal snap pager whose pages are each their own vertical scroller was proved to work, both in
the editor (driven programmatically: the inner card reached `scrollTop 101` fully scrolled while the
outer pager landed exactly on page 3, `scrollLeft 704` = 2 x 352, snapping intact) and **on device**
(iPhone 8 / iOS 16.7, owner-confirmed by finger in Mobile Safari, "it works well") — `games/wordweave`'s
dictionary panel ships exactly this shape. The outer pager needs `overscroll: 'contain'` (the field
that stops the inner scroller chaining out to the page swipe) and the definite cross-axis size the
paragraph above already requires. The one real gap is narrower than it reads: nested scroll views get
`overscroll` (which only governs chaining) and have no inner-viewport measurement story — meaning
the ENGINE's `UIScrollView.viewportHeight`/`contentHeight` read-back is not wired for the INNER view,
which matters only if you want scroll-hint chevrons or want to drive `UIEntries` pooling off the
inner scroller's own scroll position. A plain inner scroller holding a block of content needs
neither and has no open question. (One real trade worth knowing going in: a pager forces UNIFORM
page size — equal stride is what makes snapping and pooling work — so a paged panel cannot hug each
page's own content height; that is a feel trade, not a bug.)

### Open questions

- Does the padding-offset approach interact cleanly with `UIAnchor` when the scroll view is
  itself anchored? Believed yes — the padding lives on an inner child, not the anchored root —
  but unverified.
- Should scroll position be journalled? Leaning no: it is DOM-driven presentation state, and
  journalling at fling frequency would drown the journal. Revisit if a test ever needs it.

## Text animation (`TextAnimation` → CSS)

`TextAnimation` (`runtime/traits/TextAnimation.ts`) is a modifier trait: attach it
alongside a text-bearing entity and its glyphs animate procedurally from
`(glyphIndex, engine time, params)` — no per-glyph authoring, and it works on
dynamic/CJK strings of any length. Fields: `effect` (`none | typewriter | wave | bounce |
jitter | fade | rainbow`), `speed`, `amplitude` (em — emitted as `em`, see below), `frequency` (per-glyph
phase), `loop`, and `fadeIn` (typewriter soft-fade vs hard-pop). Like skeletal animation
it plays only while the sim runs and freezes when stopped.

The trait is **shared across all three text layers** but realized differently:

- **2D / 3D world text** (`Text2D`/`Text3D`) animate per-glyph GEOMETRY via the pure
  `applyTextAnimation()` (`runtime/rendering/text/textAnimate.ts`): it rewrites the
  laid-out glyph quads each frame — translating (wave/bounce/jitter), collapsing hidden
  glyphs to zero-area rects for a typewriter reveal (length-invariant, so geometry
  rebuilds in place with no shader recompile or vertex-count churn), or tinting per-glyph
  (`fade`/`rainbow`). Offsets are authored in em and scaled to px here; jitter uses an
  integer hash, never `Math.random`/wall-clock — headless-testable and
  determinism-guard-clean.
- **DOM UI text** (`UIElement.text`) can't animate per-glyph geometry (it's one styled
  string), so `uiTextAnimation()` (`runtime/ui/uiTextAnimation.ts`) maps the same effect
  vocabulary to a **CSS `@keyframes` animation** run by the browser compositor (no
  per-frame ECS/React work). Amplitude drives the translate distance via a `--ui-amp`
  custom property so the keyframes stay static (injected once by `ensureUITextAnimStyles()`).
  Most effects animate the whole element (wave→float, bounce, jitter→shake, fade→pulse,
  rainbow→a scrolling `background-clip:text` gradient); **typewriter is genuinely
  per-character** — `UINode`'s `AnimatedText` splits the text into one `<span>` per glyph
  and staggers each by `staggerSec` (a width clip would slice mid-glyph on a proportional
  font), so whole glyphs pop/fade in sequence.

The play gate lives in the **projection**, not the renderer: `uiTreeProjection`
(`uiTreeStore.ts`) copies `TextAnimation` onto `node.textAnim` only when `isSimRunning()`,
so a stopped editor shows static text and starting/stopping the sim re-renders the node.

---

## Nine-slice backgrounds

A UI sprite with authored **border insets** renders as a scalable 9-slice background
behind a `UIElement`'s text/children — corners stay fixed, edges + centre stretch. When
`UINode` resolves a `UIElement.imageSrc` to a sprite whose `border` (`{l,r,t,b}` in source
px, optional `scale`) is non-zero, it renders `NineSliceImage`
(`runtime/ui/NineSliceImage.tsx`) instead of a plain CSS background.

`NineSliceImage` paints the 9 regions as SEPARATE, slightly-overlapping `<div>`s — NOT
CSS `border-image`. Per spec, border-image's regions tile exactly and cannot overlap, so
Chrome leaves hairline subpixel seams under the non-integer scaling of the editor preview;
separate divs each bleed `OV = 1px` past their grid cell to swallow the gap — seamless at
any zoom, no backstop plane. The layer sits `pointer-events:none`, `z-index:-1` behind
content (the host element sets `isolation:isolate`); a CSS grid (`{l} 1fr {r}` ×
`{t} 1fr {b}`) adapts cell sizes to the element's real, unknown size. Each cell shows its
source sub-rect via the dimensionless `background-position`/`background-size` % trick, so
it's independent of the (downscaled) texture variant actually loaded.

### ⚠️ `scale` does not adapt — and for a capsule that is load-bearing

`border.scale` is **CSS px per source px, fixed**. The grid adapts *cell sizes* to the element's
real size, but the corner/edge columns are drawn at `inset × scale` regardless of how big the
element turned out. So a master is only correct at the size its `scale` was chosen for.

The sharp case is a **capsule** — a pill sliced with `t/b = 0`, where the left/right columns *are*
the round caps. A true capsule needs its cap exactly **half the rendered height**; the columns
still stretch vertically to fill, so any other value renders them as an ellipse. Court shipped
`btn-pill-small` (228×68, `l/r = 36`) at `scale: 1` inside a 26 px-tall button: caps drawn 36 px
wide and crushed to 26 tall, sitting inside the element's own `borderRadius: 999` — which draws a
*real* capsule. Two mismatched curves, one inside the other, reading on screen as a stray shape
floating in the button. `scale: 0.36` (= 13/36) fixes it.

- **The check**: `l × scale ≈ height / 2`. Measure the emitted columns to confirm — expect
  `l × scale + 2`, since each cell bleeds `OV = 1px` per side (above).
- **Slicing a pill horizontally cannot work.** `t/b > 0` cuts through the caps and straightens
  their sides; no guide value recovers the curve. A small pill needs its own master at `t/b = 0`
  rather than a share of a bigger button's.
- **A viewport-relative height desyncs it.** An element sized in `vmin`/`vh` under a fixed `scale`
  is only correct at one viewport; below that the caps flatten again. Pin the height in px, or
  accept the distortion off the design size. Court's pill measured 26 px on an iPad Pro 11", 19 px
  on an iPhone Air and 16 px on a folded Fold7 from one `4.5vmin` authoring — caps 1.00× / 1.37× /
  1.60× off. Only the height matters; the width may stay relative, since the middle column stretches.
- ⚠️ **Verify on the SMALLEST target, never the largest.** Where a `vmin` height clamps to its own
  px cap, the broken and pinned authorings render identically — so the big screen passes under both
  hypotheses and proves nothing. The iPad did exactly that for Court.

### The 9-slice editor

`NineSliceEditor` (`editor/panels/NineSliceEditor.tsx`) is a dev-only modal opened from
the Texture Inspector (UI-type textures — also reachable via the `modoki_open_nine_slice_editor`
MCP tool). It shows the source image on a zoomable/pannable canvas with **four draggable
guide lines** (the l/r/t/b insets) plus an "edge scale" (CSS px per source px — Unity's
"pixels per unit"). Save persists `border` into the texture's `.meta.json` sidecar and
**live-registers the texture's auto whole-image sprite** with the new border (via
`registerSprite` + `markUIDirty`), so `UINode` reflects the edit without a rescan. The
four guide knobs are also exposed as Enact interaction handles (`kind:'nineslice-guide'`)
for headless dragging.

Two things about the modal are load-bearing, both from the same report ("editing the 9-slice
doesn't change the Inspector values", owner 2026-08-18):

- **Save AWAITS the meta write before calling `onClose`.** The Inspector's close handler re-reads
  the same sidecar (`loadMeta()`), so an un-awaited POST raced that GET over one file with no
  ordering between them. When the GET won, the edit was on disk and the Inspector kept showing
  the pre-edit numbers indefinitely. It reproduced 2 times in 6 on a live editor — intermittent
  enough that a first attempt to reproduce it came back clean, which is exactly what made it
  expensive. `writeMetaOrWarn` returns its promise for this reason; a caller that then READS the
  file back must await it. (`SpriteEditor` had the identical shape and the identical fix.
  `EnvironmentAssetView` was already writing `await writeMetaOrWarn(...)` against the old `void`
  signature — an await that sequenced nothing.)
- **Closing without saving REVERTS the live preview.** The preview re-registers the whole-image
  sprite on every drag; nothing used to undo it, so Cancel left the RUNNING manifest holding the
  discarded border while the file and the Inspector held the old one. Measured on `games/3d-test`'s
  "Hello Buton" (a UI element whose `imageSrc` IS that sprite guid): drag `l` 34→59, Cancel, then
  touch any `UIElement` field and the button re-renders at `background-size: 472.881%` (279/59)
  instead of `820.588%` (279/34) — file 34, Inspector 34, screen 59, for the rest of the session.
  That three-way divergence is most of why the whole thing read as "the editor applied my change
  but the Inspector didn't update". `nineSliceRevert.ts` restores the SNAPSHOT taken when the modal
  opened rather than re-deriving from the meta: a sliced sheet has no whole-image sprite at all
  (see [textures.md](./textures.md)), so it must end up with none again rather than one the modal
  invented. A FAILED write does not count as saved: `savedRef` is assigned from the write's RESULT,
  so the revert still fires and the live sprite cannot keep a border that never reached disk.
- **A failed write keeps the dialog OPEN** (owner, 2026-08-18), with the reason logged — closing
  would throw the edit away for something that has nothing to do with the edit (a dev-server blip)
  and leave no way to retry. Verified against a real 500: the dialog stays open with the edit
  intact, pressing Save again lands it, and cancelling after a failed save still reverts the
  preview to the last value that actually reached disk. `SpriteEditor` does the same, and matters
  more there — a slice set is far more work to re-author than four insets.
- **The backdrop does NOT dismiss it.** This dialog holds unsaved work, and a stray click outside
  used to close it and discard every edit with no confirmation — indistinguishable from a Save,
  while the scene kept the live preview. Cancel and Save are the only exits. The one-shot pickers
  (SpritePicker, AddPropertyPicker, BindAnimatorPicker, the layout prompts) keep their backdrop
  dismiss, because there dismissing IS the cancel. Guarded both ways by
  `engine/tests/architecture/modalDismissScope.test.ts`.

---

## Fonts

Two independent font pipelines feed the two text worlds:

### DOM / PixiJS fonts (`FontFace`)

`runtime/loaders/fontLoader.ts` loads `.ttf`/`.otf` files via the browser `FontFace` API
and registers each family (`document.fonts.add`), serving both the DOM UI layer
(`UIElement.fontFamily`) and the PixiJS 2D layer, since both use the browser's font system. `loadAllFonts()` bulk-loads every `type:'font'`
asset from the scan; concurrent loads of the same path share one in-flight
`FontFace.load()`, and a failed load is evicted so it can retry. Family/weight/style come
from the filename (`parseFontFilename`); a (weight, style) collision within a family warns
(last-added wins).
`getLoadedFontFamilies()` / `getLoadedFonts()` expose the registry to game code; nothing in the
engine or editor consumes them today (verified 2026-08-20).

#### Two fields, one answer: `fontFamily` + `systemFont` (#231)

**`UIElement.fontFamily` is a font-ASSET GUID**, resolved through the manifest like every
other asset reference; **`UIElement.systemFont`** is a plain CSS family name, for the case a
GUID cannot express (`system-ui`, `Helvetica`, a stack). **Precedence is one-way: the asset
wins when set, else `systemFont`, else the browser default** — pinned in `resolveUIFontFamily`
(`runtime/ui/fontFamilyRef.ts`), which is the only place that decides, so "both are set" is
never a question answered by experiment.

Resolution happens in the **UI tree projection**, not in `UINode`: `uiTreeStore` writes the
RESOLVED CSS value into the node's `fontFamily`, and the DOM layer stays a pure style writer.
`ui/` is an L2 subsystem and cannot import the L3 manifest, so it reaches it through the
`core/domFontProvider` seam (installed by `loaders/registerProviders.ts`), the same shape
`textureProvider` uses.

**Why it changed.** `fontFamily` held the CSS family name, which made it the one
`accept:`-typed field in the engine that did not store a ref — so the build's tree-shaker had
to resolve it by matching family names against FILENAMES, the validator and `diagnose` could
not check it at all, and a font named from anywhere the static scan cannot read was simply
dropped from the shipped bundle. It also forced a second, field-aware path predicate
(`isInternalFontPath`, QA-INSP-0004), since a literal font path was legitimate in that one
field and invalid everywhere else; that predicate is retired and font extensions are now
part of `isInternalAssetPath` like every other asset kind.

**Migration.** A legacy family name still RENDERS — `resolveUIFontFamily` passes it through
with a one-time warning — so a pre-#231 scene is not broken, merely invisible to the build.
`engine/scripts/migrate-font-family-refs.mjs` rewrites authored values to GUIDs (dry-run by
default, `--write` to apply); a family matching no font asset is reported rather than guessed
at, since it is probably a system typeface that belongs in `systemFont`. In-repo, the only
authored value was Court's `Intro` root, migrated with the script.

**Authoring.** Drag a font from the Assets panel onto the field (the drop writes the GUID and
registers the FontFace so the Game panel updates immediately), or use the field's **`Aa`**
picker, which lists every font asset previewed in its own typeface. Typing is no longer an
option for this field — `isAcceptableTypedRef` rejects a bare family name in every font field,
because a GUID cannot be typed and a name would resolve to nothing.

#### Who registers a scene's fonts — and the bug that answer used to have (#253)

**A scene's own fonts are registered by the SCENE-LOAD path**, not by whoever happens to
have called `loadAllFonts`. `collectResourceRefsFromEntities` emits each authored
`UIElement.fontFamily` as a **`{type:'font-family', path:'<font GUID>'}`** scene resource, and
`SceneManager`'s `acquireResource` hands it to **`loadFontFamilyForRef`** → `loadFontFamily(family)`
— which finds
every manifest `font` asset whose `parseFontFilename(path).family` matches and FontFace-loads
them all (all variants: a UI authoring `fontWeight: 700` needs the real Bold file, or the
browser synthesizes a fake bold). It is awaited with the scene's other resources, so the
first frame has the face. The walk covers referenced PREFABS too — the same collector runs
over each prefab's entities.

⚠️ **`font-family` and `font` are two resource types over the same kind of asset, and that is
deliberate.** A `font` resource is an SDF atlas acquire (`Text2D.font`/`Text3D.font`, scene-scoped
+ refcounted); a `font-family` resource is a FontFace registration for the DOM. **One asset can be
both** — Court names one typeface from a canvas label and from DOM text — so collapsing them into
one type would drop whichever consumer the surviving branch does not serve.

⚠️ **Matching is `parseFontFilename(path).family`, deliberately the same rule the build's
`resolveFontsByFamily` (`asset-tree-shaker.ts`) uses** to decide whether a font's source
`.ttf` is worth shipping. The two must agree: a family the runtime resolves but the build
does not is a font that works in the editor and is absent from the shipped game.

That acquire used to be a **no-op**, on the reasoning that `loadAllFonts` had already
registered everything globally. It has exactly two callers — the game runtime's
`initWorldSync` (`engine/app/ecs/init.ts`) and **the editor's Assets PANEL**. The editor
route mounts `EditorApp`, not `GameShell`, so `initWorldSync` never runs there and the only
registrar left was a panel: with the Assets tab unmounted, `document.fonts.size` was **0**
and every DOM string in the Game panel rendered in the browser's default **serif**.

**Why that was worth more than a cosmetic bug: it silently corrupts MEASUREMENT.** Nothing
errors, and a serif page still looks like a page — so a capture judged against reference art
can be wrong about weight, tracking, wrap, line count and therefore panel fit, with nothing
to indicate it. It was found while re-capturing Court's menu for an art evaluation. Measured
A/B on the live editor with the panel's registration disabled (2026-08-20, `games/court`):

| | `document.fonts.size` | `measureText('COURT')` @ `700 73px` |
|---|---|---|
| before | 0 | `Varela Round` 261.096 = `NoSuchFontXyz123` 261.096 = `serif` 261.096 |
| after | 1 (`Varela Round`) | `Varela Round` **260.318** ≠ `serif` 261.096 |

**The cheap guard that came with it**: a family matching no manifest font asset warns once
(naming the filename→family rule, since that is usually the mistake), and a family whose
source the build dropped (`sourceShipped:false`) gets a *different* message — those need
different fixes, and the second reads as the first otherwise. Generic CSS keywords
(`sans-serif`, `system-ui`, …) name no asset by design and are silent. Before this, the
failure produced no console output at all.

#### Re-importing a font: how the DOM face is replaced (#276)

`fontLoader` subscribes to the **same `onFontInvalidated` signal the SDF loader uses** (fired by
`registerAsset` when a `'font'` entry re-registers with a changed `hash` or `font.mode`), resolves
the guid to a path, and re-registers the face. Until this landed the DOM half had **no
invalidation at all**: `loadFont` short-circuited on `loadedPaths`, so a re-imported font re-baked
the SDF atlas and visibly changed `Text2D`/`Text3D` **while DOM text kept the old typeface until
the editor was restarted** — no error, and the two text systems silently disagreeing on screen
about what one font looks like. Measured on the live editor before/after, one re-import swapping a
font's bytes at the same path (Varela Round → Arimo, `games/anim-bug`, 2026-08-20):

| | SDF `Text3D` world width | DOM span width @100px |
|---|---|---|
| before the fix | 8.412 → **7.848** ✅ re-baked | 837.91 → **837.91** ❌ stale |
| after | 8.412 → **7.848** ✅ | 837.91 → **778.38** ✅ |

The four parts are a **package** — any one alone still leaves the old face rendering:

1. **The registry is evicted.** `invalidateFontFace(path)` drops the path from `loadedPaths`, and
   `forgetVariant` drops its `FontInfo` from `loadedFonts` so the reload registers exactly one
   variant instead of appending a duplicate (which would also trip the same-(weight,style)
   collision log against the font's own previous self).
2. **The URL is cache-busted** — `withCacheBust(assetUrl(path), getAssetEntry(path)?.hash)`,
   matching `fontUrls()` in the SDF sibling. Without it the refetch is served the cached bytes and
   the reload is a no-op. Like its sibling this is a **no-op in dev** (the Vite dev server does not
   cache), so it is the production half of the fix; the editor half is (1) and (3).
3. **The old `FontFace` is deleted from `document.fonts`** — the browser owns a face until
   something removes it, so re-adding alone leaves the stale one registered. A `faces` map keys the
   live face per path, and the delete happens in `doLoadFont` **immediately after the replacement is
   added** — the only place a face is ever added, so the ordering cannot drift. That ordering is the
   answer to "when is it safe to delete a face live text is rendering with": after its replacement
   is registered, never before, so nothing falls back to a system font for a frame.
4. **In-flight loads are fenced.** A `generation` counter (mirroring the SDF loader's) is bumped by
   every invalidation; a load captures it before `await face.load()` and refuses to register if it
   changed. Otherwise a load of the OLD bytes still in flight when the re-import lands resolves
   afterwards and re-registers the stale face on top of the fresh one — last-added wins.

A **failed** reload deliberately leaves the previous face registered (and warns) rather than
dropping the family to a system fallback, which follows from the ordering in (3): the delete never
runs if the replacement never arrives. ⚠️ **That branch is where the naive version of this fix
re-created the very bug it was closing**, and it is worth knowing before touching the guard: a
failed reload clears both `loadedPaths` and `loading`, which reads *identically to "never loaded"*
— so an early-out keyed on those silently drops **every later re-import**, and the stale face
(never deleted, because the delete only follows a successful add) renders until an editor restart.
The early-out is therefore keyed on **`faces`**, which survives a failed reload precisely because
the old face is still registered. For the same reason `forgetVariant` runs in `doLoadFont` at
registration time rather than in the invalidation: the registry then keeps describing what is
actually in `document.fonts`, instead of reporting a family as gone while its old face is visibly
still rendering. A path this module never loaded IS a genuine no-op — eagerly loading on
invalidation would FontFace-load fonts no scene asked for. `disposeAllFontFaces()`
mirrors `disposeAllFonts()` for full teardown and removes the faces from `document.fonts` too: a
face the browser still holds after its registry is cleared can never be removed afterwards.

⚠️ This is the dev-editor half of a class the production build has too: **the tree-shaker
cannot see a family NAME reached from anywhere but a scene/prefab field** (a stylesheet, a
code constant), so the font is dropped and every string falls back — see
[Build](./build.md) § "Converted assets: the manifest points at the SOURCE, the build ships the
VARIANT". **The scene/prefab half of that is closed** — `fontFamily` is a GUID as of #231, so a
UI font ref is followed by the same walk as every other ref (and its family's other variants come
with it). What remains is a family named from a place no static scan can read — a stylesheet or a
runtime code string — which is what `shipSource: 'always'` exists for.

### MSDF world-text atlases (`Text2D`/`Text3D`)

World-space text renders from a signed-distance-field atlas, not a `FontFace`.
`engine/plugins/font-convert.ts` (Node — dev server + build) runs **msdf-atlas-gen** over
a source `.ttf`/`.otf` and the resolved charset to emit an mtsdf atlas PNG + a Chlumsky
JSON metrics layout into a content cache (cache hits skip the work; a missing
`msdf-atlas-gen` binary surfaces an install hint). Per-font settings live in the font's
`.meta.json` (`font` block, `runtime/core/fontSettings.ts`): `fieldType` (`mtsdf`),
`size` (default 128), `pxRange` (default 8 — headroom for outline/glow), `charset`
(`ascii`/`latin1`/`custom`), `atlasMax`, and `mode` (`baked` fixed atlas vs `dynamic`,
which seeds a runtime MSDF generator for unseen/CJK glyphs). Settings are baked into the
asset manifest (`FontManifestBlock`) so the runtime picks its provider without a per-font
fetch; the derived files are served/copied at the `~atlas.png` / `~metrics.json` variant
URLs, mirroring the texture-variant convention (see [Materials & Textures](./textures.md)).

#### Invalidating an SDF font: a late cleanup must run, not queue

`invalidateFont(guid)` (the SDF sibling of the DOM eviction above) disposes the live provider and
re-acquires a fresh one **under the same guid**, so the Three/Pixi atlas-texture caches — keyed
`${provider.id}:image` — are what carry the old atlas across the swap. Those entries are freed
through `provider.addDisposable`, and the Pixi image path registers its cleanup **inside the
`.then()` of an async `loadPixiTexture`**. Disposing the provider mid-flight therefore left the
registration landing on an already-disposed provider, where it was pushed onto a `disposables`
array nothing would ever drain again: the entry survived, the re-acquired provider hit it as a
cache hit, and the **re-baked font kept drawing the old atlas until a page reload** — permanently,
since a provider taking the cache-hit early-return registers no disposable of its own to clean it
up later either.

The fix is on the contract, not the call site: **`addDisposable` after `dispose()` runs `fn`
immediately** (both `BakedFontProvider` and `DynamicFontProvider`). A late registration is the
normal case for an async load, not a misuse, so dropping it silently was the defect. The Three
twin never showed the symptom — `TextureLoader.load` returns synchronously and registers before
any dispose can interleave — which is exactly why the shared contract, rather than a patch to the
Pixi `.then()`, is where this belongs. Pinned by `fontTexturePixi.test.ts` § "a provider disposed
mid-load must not leave its texture in the cache", which asserts the cache entry, the
`Assets.unload`, and the contract on both provider classes.

##### The other edge of that contract: a texture destroyed before it is returned (#481)

Immediate-invoke has a second-order consequence, and it cuts the opposite way. The **dynamic**
(canvas) path in `getDynamicFontTexturePixi` mints a `Texture`, caches it, then registers a
disposer that evicts it and `destroy(true)`s it. On an already-disposed provider that disposer
runs **synchronously, before the `return`** — so the function could hand its caller a corpse in
the same call, and `Scene2D`'s `if (!ptex) continue` did not catch it: **a destroyed `Texture` is
still truthy.** It went into `makeMtsdfPixiShader` and a `Mesh` that the same pass renders,
against a `TextureSource` whose GPU teardown had already run.

Guarded on both sides, because they are different contracts: the producer returns `null` when the
texture it just minted is already destroyed (and evicts a destroyed cache hit, so the function is
total rather than trusting the disposer's evict-before-destroy ordering forever), and the consumer
reads `destroyed` as not-ready — `if (!ptex || ptex.destroyed) continue`, the same posture #455's
fix took in `videoTextureSync2D.detach`.

**Both paths, and the second one is not merely latent.** The dynamic (canvas) path above is the
one #481 filed, and it *is* latent — every disposer also removes the provider from the `providers`
map and Scene2D only obtains one via `getLoadedFont`, so no disposed provider has a route to it.
The **baked/image** path had the same two holes and a describable route:

- Its cache hit (`const existing = cache.get(key)`) returned without a `destroyed` check.
- Its disposer is registered *inside* the async `.then()`, so on an already-disposed provider it
  evicts the entry cached one line earlier, and the code then wakes every waiter into an empty
  cache. **That one is NOT a defect, and the close-out initially "fixed" it and was wrong** — the
  episode is recorded here because the wrong fix is the intuitive one:

  > Settling those waiters with `wake: false` looks right (there is no texture to draw, same as
  > the `.catch` path) and is a regression. `waiters` is keyed by the font **GUID**, so it
  > outlives the provider *instance* while the cache entry does not: the set can hold a waiter
  > belonging to the live **successor**, because `invalidateFont` disposes P1 and re-acquires P2
  > under the same guid, and a repaint in that window queues P2's `markDirty` behind P1's
  > still-in-flight load. Not waking strands that renderer — reproducing the very
  > "texts are not rendered until I click the entity" bug the waiters set was added to fix. The
  > `.catch` may settle without waking only because no successor is stranded there; the analogy
  > between the two paths is false.
  >
  > The feared load/unload storm cannot happen either: a woken repaint resolves its provider via
  > `getLoadedFont(guid)`, and every disposal path deletes from `providers` in the same
  > synchronous block, so the retry gets the live P2 or no provider at all — never the disposed
  > P1. Bounded at one iteration.

  The code carries this as a **do-not-change** comment rather than a guard, because the correct
  behaviour here is the absence of one.

The route into the cache-hit hole runs through `Assets`, not through a disposed provider:
**`Assets.unload` destroys a texture's source EAGERLY but removes the cache entry asynchronously**
— measured on a live renderer 2026-08-10 and documented on `evictSourcelessEntry` in
`pixiTextureLoad.ts`. A re-acquire of the same guid landing in that window (a baked↔dynamic mode
flip with an unchanged asset hash yields the same `?v=` url) can therefore repopulate this
module's own cache with a texture the in-flight teardown then destroys. That shim protects
`Assets.cache`; `fontTexturePixi`'s map is its own, and was not covered by it.

Two entity-level consumers, not one: `Scene2D.tsx`'s per-page loop **and** its readiness gate
(`if (!getFontTexturePixi(provider, 0, …)) return`), which decides whether the entity renders at
all. Only the loop was guarded at first. A corpse passing the gate admits the entity to
`activeIds` and stamps `meshFrameKey` while every page is then skipped — the string renders as
nothing, and for a **baked** provider that is permanent rather than transient, because
`BakedFontProvider.atlasVersion` is `readonly = 0` and the loop's "rebuilds on atlasVersion bump"
consolation can never fire for it.

⚠️ `fontTextureThree.ts` is deliberately untouched and carries a comment saying so. It has the
same *shape* and none of the hazard: THREE exposes no `.destroyed`/`.disposed` flag, and
`dispose()` only drops the renderer's cached `WebGLTexture` while `.image` survives, so the next
bind re-uploads. Porting the Pixi guard there would blank text that renders correctly today.

The test's fake mirrors `BakedFontProvider.addDisposable`'s real disposed-branch exactly. A fake
that queued the callback instead would have modelled behaviour the real provider does not have,
and vouched for the bug.

---

## Image-ref gotcha (production builds drop source PNGs)

2D/DOM image refs (`UIElement.imageSrc`) **must** resolve through the texture variant
resolver, not the raw asset URL. `UINode` does this via `resolveDomImageUrl(node.imageSrc)`
(from `runtime/rendering/renderUtils`), which maps the ref to its **WebP/PNG** variant for
the DOM path — a `<img>`/CSS `background-image` cannot decode the KTX2 GPU variant.

This matters because `vite build` drops source PNGs from `dist/` and ships only the
converted variants. Resolving an `imageSrc` with raw `resolveRef` + `assetUrl` would
point at a PNG that no longer exists in production, yielding a broken image. Do NOT use
`resolveImageUrl` here — it returns `resolveTextureVariantUrl(ref, '2d')`, the KTX2 GPU
variant meant for the PixiJS/Scene2D path, which the DOM can't decode. Always go through
`resolveDomImageUrl` → `resolveBrowserImageUrl` for DOM/Canvas2D. See
[Materials & Textures](./textures.md) for the full conversion pipeline.

---

## Custom React UI per game

Sometimes a game's UI is easier to write as a hand-authored React component than as ECS
entities (chat transcripts, a chessboard, etc.). A game's `GameDefinition` (exported as
`game` from its `game.ts`) may set an optional `UIComponent`:

```ts
UIComponent?: React.LazyExoticComponent<React.ComponentType> | React.ComponentType;
```

When set, the app renders this component **instead of** the default ECS `UIRenderer`.
The component takes **no props** — it reads Zustand stores and ECS queries directly.
Lazy-load it to keep it out of the main bundle:

```ts
UIComponent: React.lazy(() =>
  import('./chess/runtime/ui/ChessGameUI').then(m => ({ default: m.ChessGameUI })),
)
```

`app/App.tsx` wires it up: the custom UI is wrapped in a `GameUIErrorBoundary` whose
fallback is `DefaultGameUILayer`, inside a `<Suspense>` — so if the custom UI crashes or
is still loading, the default ECS UI takes over. Games currently using it: **llm-test**
(`LLMGameUI`) and **chess** (`ChessGameUI`).

### Store-hook injection (`addStoreHook` / `removeStoreHook`)

`DefaultGameUILayer` (`app/ui/DefaultGameUILayer.tsx`) feeds store state into
`UIRenderer`'s `storeState` for binding resolution. Because the Rules of Hooks forbid a
dynamic number of `useStore()` calls, games register their stores up-front via
`addStoreHook(hook)` / `removeStoreHook(hook)`; the layer remounts (via a `version` key)
when the hook set changes and calls each hook. This lets multiple games contribute store
fields to the shared UI bindings without prop-drilling. (Source: `games/CUSTOM_UI.md`,
verified against the game's `game.ts`/`runtime/setup.ts` and `app/App.tsx`.)

---

## Quick reference

| Concern | Where |
| --- | --- |
| Element trait (~73 fields) | `runtime/traits/UIElement.ts` |
| Bindings / actions / anchor | `runtime/traits/UIBinding.ts`, `UIAction.ts`, `UIAnchor.ts` |
| Renderer + DOM node | `runtime/ui/UIRenderer.tsx`, `UINode.tsx` |
| Tree build + dirty flag | `runtime/ui/uiTreeStore.ts` (`buildTree`, `markUIDirty`, `uiTreeProjection`) |
| Selector hook | `runtime/ui/useUIEntities.ts` |
| Action registry + engine built-ins | `runtime/core/actionRegistry.ts`, `runtime/actions/engineActions.ts` |
| Global input lock + its authored settings | `runtime/ui/bindings.ts` (`applyBindings`), `runtime/traits/UISettings.ts` |
| UI-busy-source registry (the lock's third gate) | `runtime/core/uiBusySources.ts` (`registerUIBusySource`) |
| Binding resolver | `runtime/ui/bindingResolver.ts` |
| Anchor math | `runtime/ui/anchorLayout.ts` |
| Focus nav (trait / system / manager) | `runtime/traits/UIFocusable.ts`, `runtime/ui/uiFocusSystem.ts`, `runtime/ui/focusManager.ts` |
| Text animation | `runtime/traits/TextAnimation.ts`, `runtime/ui/uiTextAnimation.ts`, `runtime/rendering/text/textAnimate.ts` |
| Nine-slice image + editor | `runtime/ui/NineSliceImage.tsx`, `editor/panels/NineSliceEditor.tsx` |
| Fonts (FontFace loader / MSDF convert / settings) | `runtime/loaders/fontLoader.ts`, `plugins/font-convert.ts`, `runtime/core/fontSettings.ts` |
| Custom game UI | game's `game.ts` (`UIComponent`), `app/App.tsx`, `app/ui/DefaultGameUILayer.tsx` |
