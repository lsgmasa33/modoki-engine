/** UINode — renders a single UI entity as a DOM element. Recursive for children. */

import React, { lazy, Suspense } from 'react';
import type { UINodeData } from './useUIEntities';
import { applyBindings } from './bindings';
import { resolveTemplate, evalVisibility } from './bindingResolver';

// A Canvas2D UI element embeds a pooled PixiJS canvas — a render2d feature. Gate the
// mount behind the flag (lazy) so a 3D-only build (render2d off) DCEs Canvas2DMount,
// and PixiJS with it (UINode is on the shared UI path, so a static import here pulls
// pixi.js into every game). A scene that actually uses Canvas2D resolves render2d=true
// via the detector, so `null` here only ever coincides with "no 2D content".
const Canvas2DMount = __MODOKI_MODULE_RENDER2D__
  ? lazy(() => import('../rendering/Canvas2DMount').then((m) => ({ default: m.Canvas2DMount })))
  : null;
// Same gating for video-in-a-UI-node: a static import would pull the video stack into
// every game's UI path, and `build.modules` exists to DCE exactly that.
const UIVideoMount = __MODOKI_MODULE_VIDEO__
  ? lazy(() => import('../video/UIVideoMount').then((m) => ({ default: m.UIVideoMount })))
  : null;
import { fitFontSizePx, refineFontSizePx, resolveMinPx, MAX_FIT_PASSES, FIT_EPSILON_PX } from './autoFitText';
import { resolveDomImageUrl, resolveSprite } from '../core/textureRefs';
import { isGuid } from '../core/assetRefRules';
import { onWorldSwap } from '../core/ecs/world';
import { applyAnchorStyle, applyRotationStyle } from './anchorCss';
import { NineSliceImage } from './NineSliceImage';
import { shrinkWrapAlign, uiTextAnimation, ensureUITextAnimStyles } from './uiTextAnimation';
import { useFocusStore } from './focusManager';
import { isTouchDevice } from '../core/formFactor';
import { TOUCH_ATTR, TOUCH_OPACITY_ATTR } from '../traits/TouchControl';
import { UI_PAINT_ATTR } from './uiPaintMarker';
import { UI_PRESS_ORIGIN_ATTR, pressBelongsTo, clearPressOrigin } from './pressOrigin';
import { scrollViewStyle, writeScrollState, clearScrollRequest, pendingScrollTo, readScrollMeasurement, readPreciseBoxSize } from './scrollViewDom';
import { scrollByEntry } from './scrollApi';
import { useScrollAnchoring } from './scrollAnchor';
import { driveEntriesFromScroll } from './entriesSystem';

/** The CSS-animated text span, isolated in React.memo. The game UI re-renders every
 *  frame (fps is in its store selector); re-creating the span each frame RESTARTS its
 *  CSS animation (it never advances → looks frozen). Memoizing on the primitive props
 *  (all value-stable frame-to-frame) makes React bail out, leaving the span's DOM
 *  untouched so the browser-driven animation runs uninterrupted. */
const AnimatedText = React.memo(function AnimatedText(
  { text, animation, amp, extra, perCharStagger, perCharLoop, perCharFade }:
  { text: string; animation: string; amp: number; extra?: Record<string, string>;
    perCharStagger?: number; perCharLoop?: boolean; perCharFade?: boolean },
) {
  // Typewriter: split into one span per glyph and stagger each by `perCharStagger`, so
  // whole glyphs pop in sequence (a width clip slices mid-glyph on a proportional font).
  // Reveal is by opacity with the layout pre-allocated → no reflow. Memoized on
  // primitives (like the whole-element path) so the parent's per-frame re-renders don't
  // rebuild the spans and restart the animation. aria-label carries the full string;
  // the per-glyph spans are aria-hidden so screen readers read it once, not letter-by-letter.
  if (perCharStagger != null) {
    const chars = Array.from(text);
    const typeDur = chars.length * perCharStagger;
    // Loop cycle = type + a hold long enough that the staggered erase finishes (and a
    // brief blank gap shows) before the first glyph retypes. -in pops fast per glyph.
    const total = typeDur + Math.max(1.6, typeDur * 4);
    const popDur = Math.min(0.1, Math.max(0.03, perCharStagger));
    // fadeIn off → each glyph appears/vanishes instantly (mechanical typewriter feel):
    // a steps() timing on the one-shot, and the -cycle-hard keyframe for the loop.
    const fade = perCharFade !== false;
    // `display: 'block'`, not `'inline-block'` (#646) — see `AutoFitText`'s span below +
    // `docs/ui-system.md`'s `maxLines` callout for why.
    return (
      <span aria-label={text} {...{ [UI_PAINT_ATTR]: 'text' }} style={{ display: 'block', whiteSpace: 'pre-wrap' }}>
        {chars.map((ch, i) => {
          const delay = i * perCharStagger;
          const anim = perCharLoop
            ? `${fade ? 'mdk-ui-type-cycle' : 'mdk-ui-type-cycle-hard'} ${total.toFixed(3)}s linear ${delay.toFixed(3)}s infinite both`
            : `mdk-ui-type-in ${popDur.toFixed(3)}s ${fade ? 'ease-out' : 'steps(1,jump-start)'} ${delay.toFixed(3)}s 1 both`;
          return <span key={i} aria-hidden={true} style={{ animation: anim }}>{ch}</span>;
        })}
      </span>
    );
  }
  // `display: 'block'`, not `'inline-block'` — same fix as the typewriter span above (#646).
  const style: React.CSSProperties = { display: 'block', animation, willChange: 'transform', ...(extra as React.CSSProperties) };
  // ⚠️ **em, not px** (#245). The amplitude is a MULTIPLE of the font size — `uiTextAnimation`'s
  // own doc calls it "em" — and it used to be resolved to px by multiplying the authored
  // `fontSize` NUMBER. That silently breaks the moment `fontSizeUnit` is not px, because the
  // number is then vmin, not pixels. `em` resolves against the element's own COMPUTED font size,
  // so it is correct for every unit and needs no resolution step at all.
  if (amp) (style as Record<string, string>)['--ui-amp'] = `${amp}em`;
  return <span {...{ [UI_PAINT_ATTR]: 'text' }} style={style}>{text}</span>;
});

/** Content-box width of `elem` at sub-pixel precision: the border-box rect minus padding and
 *  border, read the SAME way `fit()` measures the span so the two sides of every fit comparison
 *  can't disagree over rounding — SCALED to the rect's own space first. Pre-fix this was
 *  `elem.getBoundingClientRect().width - pad - border` with NO scaling: a TRANSFORM-AWARE rect
 *  (screen px) minus TRANSFORM-BLIND computed lengths (layout px). A CSS `transform` between
 *  `elem` and its reference frame — the editor's SceneView/GameView preview-frame scale, or
 *  `applyRotationStyle`'s rotate()/scale() on ANY UIElement with an authored rotation/scale —
 *  scales the rect but not the computed padding/border, so the old expression computed `S·W − pad`
 *  where the correct content width is `S·(W−pad)`. Exact only at `S=1` (every earlier measurement
 *  here happened to run under one) — measured live (Chromium 151, 300px parent, 20px padding, 2px
 *  border): +9.5% at `S=0.667` (the editor's typical docked-panel scale), +67.2% at `S=0.3`, so
 *  `fit()`'s `availablePx` could be badly wrong exactly where `UIElement.rotation`/`scale` or a
 *  scaled preview frame make this common, not exotic.
 *
 *  The fix derives `scale` LOCALLY from `elem` itself — `rectWidth / elem.offsetWidth`, the ratio
 *  between `elem`'s own screen-space and layout-space border-box width — rather than switching to
 *  a transform-blind read (`clientWidth`) everywhere, which was tried first and REGRESSED a real
 *  fit: `naturalPx`/`measuredPx` would then need the same integer-rounded space too (to stay
 *  comparable), and two INDEPENDENT integer roundings (parent + span) can each round up to 0.5px
 *  in opposite directions — enough combined error to push a genuinely-fitting label past
 *  `FIT_EPSILON_PX` and wrap it (caught live by `editor-ui-autofit.spec.ts`, not by a unit test —
 *  jsdom can't see either failure mode). Multiplying `scale` back onto just the padding/border
 *  keeps `availablePx` in the SAME sub-pixel screen-px space `naturalPx` already reads (unchanged
 *  below), so precision is unaffected by this fix — verified live at every measured `S` above:
 *  the shipped:true ratio error stays pinned to the untransformed baseline's own ~0.14%, not
 *  growing with `S` the way the pre-fix ratio did. `elem.offsetWidth`'s own integer rounding only
 *  enters through this multiplicative `scale` term (not an ADDITIVE term subtracted from a
 *  differently-scaled quantity, which is what made the original bug non-cancelling), so its error
 *  stays proportionally tiny. `scale` falls back to 1 (the pre-fix, `S=1` behaviour) when
 *  `elem.offsetWidth` is 0 (detached/`display:none`), matching what an unmeasurable read already
 *  degrades to elsewhere in this component.
 *
 *  This is exact only for a uniform, non-rotating `scale()` — `rectWidth / offsetWidth` is a
 *  WIDTH-axis ratio, which is what a horizontal padding/border correction needs, uniform or not,
 *  but a ROTATED ancestor still degrades `rectWidth` itself to an axis-aligned bounding box no
 *  per-axis ratio can undo. That was already just as wrong pre-fix (see the module docblock on
 *  `AutoFitText`) — not a regression this fix introduces, just a gap it does not close. */
function contentWidthOf(elem: HTMLElement): number {
  const rectWidth = elem.getBoundingClientRect().width;
  const layoutWidth = elem.offsetWidth;
  const scale = layoutWidth > 0 ? rectWidth / layoutWidth : 1;
  const s = getComputedStyle(elem);
  const layoutPadBorder =
    parseFloat(s.paddingLeft || '0') + parseFloat(s.paddingRight || '0')
    + parseFloat(s.borderLeftWidth || '0') + parseFloat(s.borderRightWidth || '0');
  return rectWidth - scale * layoutPadBorder;
}

/** Shrink-only auto-fit (#614, `UIElement.autoFitText`) — reduces the rendered font size, never
 *  past the authored `fontSize`, until the text fits its box on one line, down to `fontSizeMin`.
 *  Same `React.memo`-on-primitives reason as `AnimatedText` above: the game UI re-renders every
 *  frame, and an un-memoized layout read here would force a reflow per frame. Memoized on
 *  `fontSize`/`fontSizeMin`/`text`/`children` (React.memo shallow-compares every prop, so
 *  `children`'s identity still matters here even though `fit()` itself never keys off it — see
 *  `text` below), so a per-frame re-render that changes none of these bails out before `fit()`
 *  is even considered.
 *
 *  `fit()` re-runs on: a `fontSize`/`fontSizeMin`/`text` prop change (its own `useCallback`
 *  deps); the parent's box actually resizing (`ResizeObserver`, guarded against the write
 *  `fit()` itself makes re-firing the same callback); a WINDOW resize with no parent px-width
 *  change (a `vh`-authored `fontSize` moves with the viewport even when the parent doesn't,
 *  coalesced through `requestAnimationFrame` so a drag-resize doesn't re-fit per event); and the
 *  first `document.fonts.ready` landing after mount (metrics before the real webfont arrives are
 *  wrong). `text` is a FIT-INVALIDATION KEY ONLY, never rendered — `children` is what renders,
 *  and its identity is UNSTABLE on the animated path (`AnimatedText`'s own per-frame-stable memo
 *  intentionally lets a new element through only when the animation itself changes, not on every
 *  frame, but never so reliably that it belongs in a measurement dependency list) — so `text` is
 *  threaded down separately as the plain string `children` was built from. Without it in `fit`'s
 *  deps, a `{storeField}` template or a localised string re-rendering with new text never
 *  re-measures: the font size (and `nowrap`) stay pinned to whatever the FIRST string fit.
 *
 *  The actual shrink DECISION is `autoFitText.ts`'s `fitFontSizePx`/`refineFontSizePx` (pure,
 *  unit-tested); this component is only the DOM measurement + re-fit scheduling around it.
 *
 *  ⚠️ INVARIANT: auto-fit may only ever change the rendering when it is ACTIVELY SHRINKING — it
 *  shrank the font AND the shrunk size measured back as fitting. Every other outcome (already
 *  fits at the authored size, an unmeasurable/inert reading, or floored short of a fit) renders
 *  IDENTICALLY to `autoFitText: false` — see the `whiteSpace` write at the end of `fit()`. That
 *  is what makes a bad/contaminated measurement SAFE: the worst a wrong answer can do is fail to
 *  shrink, never make the box worse than the feature being off would have. */
const AutoFitText = React.memo(function AutoFitText(
  { children, text, fontSize, fontSizeMin, clampLines }:
  { children: React.ReactNode; text: string; fontSize: number; fontSizeMin: number; clampLines?: number },
) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  // The `availablePx` the last COMPLETED fit() was computed at — set at the end of every fit()
  // that actually measured (never on the early `!el || !parent` return). The ResizeObserver
  // callback below compares against this to tell a real parent resize from its own write re-firing
  // the observer.
  const lastFitAvailablePxRef = React.useRef<number | null>(null);

  const fit = React.useCallback(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    // ⚠️ ORDERING IS LOAD-BEARING — measured BEFORE this function writes anything to the span's
    // style, in particular before the `width: max-content` scaffold below. `UIElement.width`
    // defaults to 0 (auto), so a content-sized parent is the DEFAULT case, not an exotic one —
    // and that scaffold, which exists to unstretch THIS span from a flex-stretch parent (see the
    // comment on it below), also inflates a content-sized PARENT to the text's own natural width
    // one level up. Read `availablePx` after the scaffold and it converges on `naturalPx` by
    // construction — "it fits" every time — which is the identical contaminated-measurement bug
    // the scaffold itself exists to close, just recreated one level up. Reading it here, against
    // the parent's box as authored before this component has touched anything, is the only
    // measurement that isn't self-referential.
    const availablePx = contentWidthOf(parent);
    // Clear a previous shrink AND a previous floor-wrap before measuring — otherwise a re-fit
    // (e.g. on resize) measures the already-shrunk/already-wrapped box, not the text's natural
    // single-line width at the authored size.
    el.style.fontSize = '';
    el.style.whiteSpace = 'nowrap';
    // ⚠️ `UIElement` authors `display: flex` (+ `alignItems`) on every node BY DEFAULT, so this
    // span (its own authored `display: block`, #646) is virtually always a FLEX ITEM of its
    // parent, never a normal block box in flow. (Since #655 a clamped node puts a wrapper between
    // this span and the host — so the parent is then that BLOCK wrapper rather than the flex
    // host. The scaffold below is still required: the stretch case is the common one, and a
    // `max-content` width is correct in both.) The default `align-items:
    // stretch` then stretches a flex item's cross size to the parent's — so WITHOUT this line,
    // the span's measured width reads the parent's AVAILABLE width, not the span's natural
    // content width. Measured live on a `games/text_demo` fixture (42px "UI TEXT ANIMATION" in a
    // 40%-wide box): the measurement read 319.59px (== the parent's content width) instead of the
    // real 446.93px, so `naturalPx === availablePx` on every call, the pure fit function always
    // concluded "it fits", and the span was left `white-space: nowrap` — one line overflowing its
    // box, strictly worse than the wrap it replaced. An explicit `width` overrides `stretch` (a
    // sized flex item is not stretched), so `max-content` here forces the rect back to the span's
    // true natural width regardless of flex context. It is a measurement scaffold ONLY — it stays
    // set across every re-measurement below (the refine loop re-applies a smaller font size and
    // re-reads the same unstretched rect) and is cleared once, after the LAST measurement, before
    // the fitted font size is written, so it never reaches paint (this whole function runs inside
    // `useLayoutEffect`, before the browser paints).
    // ⚠️ In a `flexDirection: 'row'` parent this width is the item's MAIN size, so the default
    // `flexShrink: 1` (UIElement.ts:31) is free to shrink it back below `max-content` — which
    // would collapse `naturalPx` to `availablePx`, make the fit conclude "it fits", and leave
    // autoFitText SILENTLY INERT. It does not, and the reason is not this line: a flex item's
    // default `min-width: auto` floors shrinking at min-content, and the `white-space: nowrap`
    // set just above makes min-content == max-content. Measured (Chromium 151, 320px row parent,
    // 399.16px natural): the ONLY combination that defeats the scaffold is
    // `row` + `flex-shrink:1` + `min-width:0` — every other permutation reads the true 399.16.
    // Shipped code never hits it because `UIElement.minWidth` defaults to 0 and `cssVal` drops
    // falsy values, so `min-width: 0` is never written to the DOM — i.e. the scaffold was safe
    // by COINCIDENCE, one refactor away from dying silently. The `minWidth` line below makes it
    // safe by CONSTRUCTION instead: it pins the floor the flex auto-minimum was supplying for
    // us, so the measurement no longer depends on nobody ever authoring a `min-width`. It is a
    // no-op against today's DOM (with `nowrap`, min-content == max-content) and is torn down
    // with the width scaffold below.
    el.style.width = 'max-content';
    el.style.minWidth = 'max-content';
    const authoredPx = parseFloat(getComputedStyle(el).fontSize);
    // `scrollWidth` is rounded to an integer px, which can under-report a natural width like
    // 100.6px as 100 — combined with the pure function's 0.5px FIT_EPSILON_PX that lets a
    // genuinely-overflowing label read as fitting. `el` is `display: block; white-space: nowrap;
    // width: max-content` (unstretched by the flex parent), so its border-box rect width IS the
    // natural single-line width, at sub-pixel precision.
    const naturalPx = el.getBoundingClientRect().width;
    // `availablePx` was already captured above, via `contentWidthOf` (not the rounded
    // `clientWidth`) — same sub-pixel precision as `naturalPx` here (both screen-px rects; see
    // `contentWidthOf`'s header for how it corrects for a CSS transform without losing that
    // precision), so both sides of the fit comparison agree to the same precision, and BEFORE the
    // max-content scaffold, so it can't be contaminated by it (see the comment at the top of this
    // function).
    const minPx = resolveMinPx(authoredPx, fontSize, fontSizeMin);
    const first = fitFontSizePx({ authoredPx, naturalPx, availablePx, minPx });

    // `first` is only a PROPORTIONAL ESTIMATE — exact when width(fontSize) passes through the
    // origin, an OVER-estimate whenever a size-independent term exists (px `letterSpacing`, px
    // word-spacing, a text-stroke, a px-padded inline child). Measured live on `games/text_demo`'s
    // "UI TEXT ANIMATION" (3px letterSpacing, a 319.59px box): the proportional model predicted
    // 30.03px would fit, but 30.03px still measures 336.06px wide — 17px of overflow the pure
    // function could not see, because it never re-measures its own answer. So the estimate is
    // only ever a STARTING point here: re-measure at the candidate size and refine
    // (`refineFontSizePx`), up to `MAX_FIT_PASSES` times, converging to ~28.4px for that case —
    // and take the fit/overflow decision (`fits` below) from what was actually MEASURED at the
    // final size, never from `first`'s own predicted `fits`/`fontSizePx`. A future "optimisation"
    // that deletes this loop and trusts `fitFontSizePx` alone reintroduces exactly this bug.
    //
    // Cost: `fit()` runs on mount / prop change / parent resize / `fonts.ready` — never per frame
    // — so up to `MAX_FIT_PASSES` + 1 extra layout reads here (the loop, plus the one final
    // re-measurement below) is not a hot path.
    let fits: boolean;
    if (first.shrunk) {
      let candidatePx = first.fontSizePx;
      for (let pass = 0; pass < MAX_FIT_PASSES; pass++) {
        el.style.fontSize = `${candidatePx}px`;
        const measuredPx = el.getBoundingClientRect().width;
        const refined = refineFontSizePx({ currentPx: candidatePx, measuredPx, availablePx, minPx });
        candidatePx = refined.nextPx;
        if (refined.done) break;
      }
      // Commit the loop's final decision AND take one more measurement AT it — the loop's last
      // reading was taken at the size fed INTO the last `refineFontSizePx` call, which the
      // "shrink-only, stop on no more progress" branch can return a smaller `nextPx` than (see
      // that function's header). Reusing the stale reading here reintroduces the exact bug this
      // loop exists to close: a real case measured 342.14px (overflowing 340px) on the pass that
      // decided "no more progress" and committed 31.95px — but 31.95px itself actually measures
      // ~340.4px, WITHIN tolerance. Trusting the stale 342.14 wrongly declared `fits: false` and
      // wrapped a label that, at the size actually left on screen, did not need to.
      el.style.fontSize = `${candidatePx}px`;
      const finalMeasuredPx = el.getBoundingClientRect().width;
      // MEASURED, not predicted — trusting `fitFontSizePx`'s own `fits` here is exactly what
      // produced the #614 follow-up overflow: it believed the proportional model's answer instead
      // of asking the DOM what actually rendered.
      fits = finalMeasuredPx <= availablePx + FIT_EPSILON_PX;
    } else {
      // Common case: already fits at the authored size. One measurement, no loop, no write.
      // `first.fits` is always `true` on this branch — including the "nothing was measurable"
      // guard in `fitFontSizePx` (a garbage/detached measurement) — so this is also what keeps a
      // bad reading from tripping the floor-wrap fallback below: re-deriving `fits` from
      // `naturalPx` here would re-introduce a guess exactly where `fitFontSizePx` refused one.
      el.style.fontSize = '';
      fits = first.fits;
    }
    el.style.width = '';
    el.style.minWidth = '';   // torn down with the width scaffold — both are measurement-only.
    // `nowrap` ONLY when auto-fit actively did something AND that something measured as fitting
    // — `first.shrunk && fits`. Every other outcome (already fit at the authored size, an
    // unmeasurable/inert `first.fits`, or floored short of a fit) ends at `pre-wrap`, the SAME
    // rendering `autoFitText: false` gets — hand off to the existing wrap/textOverflow behaviour
    // instead of leaving one nowrap line hanging past its box. This is the invariant from the
    // component docblock: a bad or contaminated measurement can only ever cost a missed shrink,
    // never a worse box than the feature being off. Auto-fit is the shrink-FIRST step, never a
    // replacement for the wrap/textOverflow fallback.
    el.style.whiteSpace = (first.shrunk && fits) ? 'nowrap' : 'pre-wrap';
    lastFitAvailablePxRef.current = availablePx;
  }, [fontSize, fontSizeMin, text]);

  React.useLayoutEffect(() => {
    let alive = true;
    fit();
    const parent = ref.current?.parentElement;
    // The text's available width tracks its parent box, which can change on resize/orientation
    // without `fontSize`/`fontSizeMin` themselves changing — a ResizeObserver is the only one of
    // the three triggers that is not already a React prop change. Guard its existence like
    // `safeArea.ts` does — an older WebView may not implement it.
    const ro = parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      if (!alive) return;
      // fit() writes el.style.fontSize, which can resize this observed PARENT and re-fire this
      // very callback. Skip a re-entrant fire whose parent content width hasn't actually moved
      // (0.5px tolerance — a font-size change can perturb it by a sub-pixel) — otherwise even a
      // converging loop trips the browser's "ResizeObserver loop completed with undelivered
      // notifications" error, which globalErrors.ts mirrors to Crashlytics as telemetry noise.
      // This guards only OUR OWN write re-entering — it is not about skipping a real resize, so a
      // genuine parent resize (this check finds a moved width) still fits.
      const p = ref.current?.parentElement;
      if (!p) return;
      // Same `contentWidthOf` helper `fit()` uses for `availablePx` — comparing like with like
      // means this guard can't diverge from what the next `fit()` would actually measure.
      const currentAvailablePx = contentWidthOf(p);
      if (lastFitAvailablePxRef.current != null && Math.abs(currentAvailablePx - lastFitAvailablePxRef.current) < 0.5) return;
      fit();
    }) : undefined;
    if (ro && parent) ro.observe(parent);
    // A `vh`-authored `fontSize` (`cssVal`'s `vh`/`vw`/`vmin`/`vmax` cases) moves with the
    // VIEWPORT even when the parent's own px width does not — the ResizeObserver above watches
    // only the parent's content box, so that case is invisible to it and the fit goes stale
    // (measured: the authored size changes, `fit()` never re-runs, the old shrunk/unshrunk size
    // stays on screen). `window` may be absent (a non-browser host); guard it like the others
    // here. Coalesced through `requestAnimationFrame` so a drag-resize re-fits once per frame,
    // not once per `resize` event.
    let resizeRaf: number | null = null;
    const onWindowResize = () => {
      if (resizeRaf != null) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        if (alive) fit();
      });
    };
    if (typeof window !== 'undefined') window.addEventListener('resize', onWindowResize);
    // A webfont landing after the first measure changes the metrics — measuring before it
    // arrives is the classic wrong answer here. `document.fonts` may be absent; guard it.
    // .catch: a font that never resolves must not surface as an unhandled rejection (globalErrors
    // mirrors those to Crashlytics too) — we just keep the first measurement.
    document.fonts?.ready.then(() => { if (alive) fit(); }).catch(() => { /* a font that never resolves just means we keep the first measurement */ });
    return () => {
      alive = false;
      ro?.disconnect();
      if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
      if (resizeRaf != null) cancelAnimationFrame(resizeRaf);
    };
  }, [fit]);

  // `whiteSpace` is set BOTH here in the JSX style prop ('pre-wrap' — the SAME value the
  // invariant above requires for every non-shrinking outcome, i.e. the state this span is in
  // before `fit()` has ever run) AND imperatively by `fit()` ('nowrap' only while a shrink is
  // active and measured to fit; 'pre-wrap' in every other outcome, restated here). React only
  // ever writes a style prop that CHANGED from its last render, so once `fit()` sets 'nowrap'
  // imperatively, a re-render with this same unchanged 'pre-wrap' prop does not stomp it back.
  // This looks like the two fighting and isn't — don't "fix" it by removing either one.
  //
  // `UI_PAINT_ATTR` (#337 close-out, mirrors `AnimatedText` above): this span pulls the text out
  // of the host entity div's direct children, same as `AnimatedText`'s does — without the
  // marker, `isPaintOpaque` (editor/panels/uiPreviewPick.ts) finds no direct text-node child and
  // no marker, credits the entity as purely decorative, and a SceneView click falls through to
  // whatever sits behind it. A nested `AutoFitText` wrapping a playing `AnimatedText` stamps the
  // marker twice (once per span) — harmless: `isPaintOpaque` only asks whether ANY marked
  // descendant's nearest `[data-entity-id]` ancestor is the host div, and both spans agree on
  // that answer via the same host.
  // `display: 'block'`, NOT `'inline-block'` (#646) — an `inline-block` child defeats the
  // `node.maxLines > 0` clamp (on the wrapper since #655 — it can't split an atomic inline), and
  // does not reopen #614's flex-stretch bug (`block` and `inline-block` compute identically as
  // a flex item). Full reasoning + verification: `docs/ui-system.md`'s `maxLines` callout.
  // `clampLines` (#727): the `clip` + `autoFitText` maxLines cap, put on THIS span instead of the
  // `clampStyle` wrapper above it in the tree — `fit()` above writes a SHRUNK `font-size` onto
  // this exact span, so `${clampLines}lh` resolves against the size that actually rendered,
  // instead of the wrapper's authored (larger) one. `fit()` only ever measures WIDTH (this
  // component's whole docblock), so this `maxHeight`/`overflow` addition cannot contaminate it —
  // it is inert during every `fit()` measurement pass and only ever affects paint. No explicit
  // `line-height` is set here (nor anywhere for this purpose): `line-height` inherits, and setting
  // one would change the shrunk text's line spacing, a visual change #727 explicitly rules out.
  const clampStyleProps: React.CSSProperties | undefined = clampLines != null
    ? { maxHeight: `${clampLines}lh`, overflow: 'hidden' }
    : undefined;
  return (
    <span ref={ref} {...{ [UI_PAINT_ATTR]: 'text' }} style={{ display: 'block', whiteSpace: 'pre-wrap', ...clampStyleProps }}>
      {children}
    </span>
  );
});

/** Convert a numeric value + unit string to a CSS value. Returns undefined if value is 0/falsy.
 *  Viewport units (vw/vh/vmin/vmax) use CSS custom properties set by UIRenderer so they
 *  resolve relative to the UI container, not the browser window. This is critical for the
 *  editor's simulated device viewport. */
export function cssVal(value: number, unit: string): string | number | undefined {
  if (!value) return undefined;
  switch (unit) {
    case '%':    return `${value}%`;
    case 'vw':   return `calc(${value} * var(--ui-vw, 1vw))`;
    case 'vh':   return `calc(${value} * var(--ui-vh, 1vh))`;
    case 'vmin': return `calc(${value} * var(--ui-vmin, 1vmin))`;
    case 'vmax': return `calc(${value} * var(--ui-vmax, 1vmax))`;
    default:     return value; // px
  }
}

/** Warn ONCE per entity that a UIToggle can never move: it carries no binding on an
 *  event the switch fires. A toggle does not write its own `value`, so an unbound one
 *  renders perfectly and is inert — the silent-authoring-failure class that has cost
 *  this repo real time. Warn, never throw: an authoring mistake must not blank the
 *  screen mid-render. */
const _deadToggles = new Set<string>();
// ⚠️ Cleared on world swap, because the fallback key is an ENTITY ID and runtime ids are reassigned
// on every scene reload — so a stale entry could swallow a DIFFERENT dead toggle's warning after a
// reload, which is the one moment an author is most likely to be looking for it. (A guid-bearing
// entity is unaffected; guid-less ones are the runtime-spawned case.)
onWorldSwap(() => _deadToggles.clear());

function warnDeadToggle(key: string): void {
  if (_deadToggles.has(key)) return;
  _deadToggles.add(key);
  console.warn(`[UIToggle] ${key} has no 'change' binding, so tapping it does nothing. A toggle does not write its own value — add a UIAction binding on event 'change' that sets UIToggle.value to '$value'. NOTE a 'click' binding will NOT work here (the Inspector defaults to 'click'): the switch dispatches 'change', and applyBindings skips rows whose event differs.`);
}

export function hexToRgba(hex: number, opacity: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgba(${r},${g},${b},${opacity})`;
}

export function hexToColor(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

interface UINodeProps {
  node: UINodeData;
  storeState: Record<string, unknown>;
  onSelectEntity?: (entityId: number) => void;
  /** Editor injection: render the 2D canvas for a Canvas2D node inline in the UI
   *  tree, so it stacks by hierarchy exactly like the runtime. Returns null to
   *  hide 2D (the editor's 2D layer toggle). When omitted, the runtime mounts
   *  its pooled PixiJS canvas via Canvas2DMount. */
  renderCanvas2D?: (entityId: number) => React.ReactNode;
  /** Editor: render UI nodes as invisible layout-only structure — keeps the tree
   *  (so nested Canvas2D canvases still mount/position) while the UI layer is
   *  toggled off. Canvas content is unaffected (gated separately by renderCanvas2D). */
  uiVisualsHidden?: boolean;
}

function UINodeInner({ node, storeState, onSelectEntity, renderCanvas2D, uiVisualsHidden }: UINodeProps) {
  // Focus ring (controller/keyboard navigation, Part B). Runtime only — the editor's
  // click-to-select mode (onSelectEntity set) is authoring, not gameplay nav. The
  // selector subscribes THIS node to the focus store, so only the entering/leaving
  // node re-renders when focus moves. Hook runs before any early return (React rule).
  const isFocused = useFocusStore((s) => !onSelectEntity && s.focusedGuid !== '' && s.focusedGuid === node.guid);

  // Scroll view (UIScrollView). Like the focus hook above, this must run before ANY early
  // return — the hook itself no-ops when `node.scroll` is absent, which is the vast majority
  // of nodes. It writes scroll position back into ECS WITHOUT dirtying the UI tree.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  useScrollView(node, scrollRef);

  // Scroll anchoring (#531). Same before-any-early-return rule, and gated on the SAME one field
  // that makes the box scroll at all rather than on `node.scroll` — the bug was found on a panel
  // that carries no `UIScrollView` at all, just `overflow: 'scroll'`, so hanging this off the
  // trait would have left the reported case unfixed. See scrollAnchor.ts for what it holds still.
  //
  // ⚠️ It takes the ELEMENT, not `scrollRef`: this call sits ABOVE the `isVisible` early return
  // and a hidden-but-mounted node renders null, so an effect keyed on the (stable) ref object
  // would run once against null and never re-attach when the box appeared.
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null);
  // ⚠️ A virtualized view is EXCLUDED, by trait and not by child count. Its rows all live under
  // one `__uiEntriesContent` wrapper whose `offsetTop` never moves, so anchoring degrades to
  // restoring the raw number — and doing that with the browser's anchoring switched off is worse
  // than leaving the box alone. See scrollAnchor.ts § "Where it does NOT apply".
  const isScrollBox = node.overflow === 'scroll' && !node.isEntriesView;
  const attachScroll = React.useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    // Only a scroll box pays for the extra render; every other UI node keeps the plain ref.
    if (isScrollBox) setScrollEl(el);
  }, [isScrollBox]);
  useScrollAnchoring(isScrollBox, scrollEl);

  // isVisible is authored (or flipped by a button's UIAction `kind:'set'` binding). A
  // state-driven visibility binding (UIBinding.visibleBinding) can additionally hide the element
  // from a store field — BOTH must be true to render. Play-time only (gated on `!onSelectEntity`,
  // like the focus hook above): in the editor (authoring, empty storeState) the element must stay
  // visible + selectable — only the authored isVisible hides it there.
  if (!node.isVisible) return null;
  if (!onSelectEntity && node.binding?.visibleBinding &&
      !evalVisibility(storeState, node.binding.visibleBinding, node.binding.visibleOp || '', node.binding.visibleValue || '')) {
    return null;
  }

  // Resolve text
  let text = node.text || '';
  if (node.binding?.textBinding && text) {
    text = resolveTemplate(text, storeState);
  }

  // Build CSS style
  const style: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    flexDirection: node.flexDirection as any,
    flexWrap: node.flexWrap as any,
    justifyContent: node.justifyContent,
    alignItems: node.alignItems,
    gap: node.gap ? cssVal(node.gap, node.gapUnit) : undefined,
    flexGrow: node.flexGrow,
    flexShrink: node.flexShrink,
    width: cssVal(node.width, node.widthUnit),
    height: cssVal(node.height, node.heightUnit),
    paddingTop: cssVal(node.paddingTop, node.paddingTopUnit),
    paddingLeft: cssVal(node.paddingLeft, node.paddingLeftUnit),
    paddingRight: cssVal(node.paddingRight, node.paddingRightUnit),
    paddingBottom: cssVal(node.paddingBottom, node.paddingBottomUnit),
    marginTop: cssVal(node.marginTop, node.marginTopUnit),
    marginLeft: cssVal(node.marginLeft, node.marginLeftUnit),
    marginRight: cssVal(node.marginRight, node.marginRightUnit),
    marginBottom: cssVal(node.marginBottom, node.marginBottomUnit),
    minWidth: cssVal(node.minWidth, node.minWidthUnit),
    maxWidth: cssVal(node.maxWidth, node.maxWidthUnit),
    minHeight: cssVal(node.minHeight, node.minHeightUnit),
    maxHeight: cssVal(node.maxHeight, node.maxHeightUnit),
    alignSelf: node.alignSelf !== 'auto' ? node.alignSelf as any : undefined,
    zIndex: node.zIndex || undefined,
    overflow: node.overflow === 'scroll' ? 'auto' : node.overflow as any,
    boxSizing: 'border-box',
  };

  // ── Scrollbar skin ──
  // Only the STANDARDS properties, because these are inline styles: `::-webkit-scrollbar` is a
  // pseudo-element and cannot be written here at all (`scrollViewDom.ts` records the same limit
  // where it hides a scroll view's bar). `scrollbar-color` + `scrollbar-width` is therefore the
  // entire available surface — thumb, track, coarse width; no shape, corner or arrow control.
  //
  // Gated on `overflow: 'scroll'` so the fields cannot have an effect on an element that never
  // scrolls: an authored value that quietly does nothing somewhere else is the "field nothing
  // reads" trap, and this keeps the one visible consequence tied to the one field that causes it.
  //
  // ⚠️ **`UIScrollView.scrollbar` says the same thing and WINS.** Both it and
  // `scrollbarStyle: 'hidden'` emit `scrollbar-width: none`, and `scrollViewStyle` is merged
  // BELOW this block — so on an element carrying a `UIScrollView`, that trait decides whether a
  // bar exists and this one only tints it. `scrollbarStyle: 'tinted'` on a `scrollbar: 'hidden'`
  // view therefore sets `scrollbar-color` on a bar that never renders. Authoring both is the
  // author's mistake to make, but nothing errors, so it is stated here and in the trait docs
  // rather than left to be discovered.
  if (node.overflow === 'scroll') {
    // ⚠️ `overflow-anchor` is deliberately NOT set here. `useScrollAnchoring` owns it at runtime,
    // because whether we may take the browser's anchoring away depends on something only the DOM
    // knows: a box with one flow child (a `UIEntries` content wrapper) is one this file cannot
    // anchor, and disabling the browser's mechanism there would be a regression. See
    // scrollAnchor.ts § "Where it does NOT apply".
    if (node.scrollbarStyle === 'hidden') {
      style.scrollbarWidth = 'none';
    } else if (node.scrollbarStyle === 'tinted') {
      style.scrollbarWidth = 'thin';
      style.scrollbarColor = `${hexToColor(node.scrollbarThumbColor)} ${hexToColor(node.scrollbarTrackColor)}`;
    }
  }

  // ── Focus ring ──
  // Data-driven outline drawn when this element is the focused nav target. Kept as a
  // non-layout `outline` (+offset) so it never shifts the flexbox box. Pointer/touch
  // is unaffected — focus is only set when nav input arrives.
  if (isFocused) {
    style.outline = '2px solid #4aa3ff';
    style.outlineOffset = '2px';
  }

  // ── Style (box visuals) ──
  if (node.backgroundOpacity > 0) style.backgroundColor = hexToRgba(node.backgroundColor, node.backgroundOpacity);
  if (node.borderRadius) style.borderRadius = node.borderRadius;
  if (node.borderWidth) {
    style.borderWidth = node.borderWidth;
    style.borderStyle = 'solid';
    style.borderColor = hexToRgba(node.borderColor, node.borderOpacity ?? 1);
  }
  if (node.opacity < 1) style.opacity = node.opacity;

  // ── Image ──
  // 9-slice sprites render as a decorative overlay layer (see below); a plain image
  // renders as a CSS background. Built here, injected as the first child of the return.
  let nineSliceLayer: React.ReactNode = null;
  if (node.imageSrc) {
    // DOM images (CSS background / NineSliceImage <img>) MUST resolve to a browser-
    // decodable URL — the browser can't decode the KTX2 GPU variant. resolveDomImageUrl
    // returns the WebP variant (a 2d/ui texture always has one). warnKtx=true: this is the
    // production DOM, so a mis-typed 3d texture (no WebP sibling) warns rather than 404 silently.
    const imgUrl = resolveDomImageUrl(node.imageSrc, true);
    if (imgUrl) {
      // 9-slice: a UI sprite with authored border insets renders as 9 overlapping
      // divs (NineSliceImage) — seamless at any zoom, unlike CSS `border-image` whose
      // regions tile and leave subpixel seams under the editor's scaled preview.
      const sprite = isGuid(node.imageSrc) ? resolveSprite(node.imageSrc) : undefined;
      const border = sprite?.border;
      if (border && (border.l || border.r || border.t || border.b) && sprite?.sheetW && sprite?.sheetH && sprite.frame) {
        // Edge scale (Unity PPU-style): insets stay in SOURCE px, corners render at
        // insets × scale so they keep their intended on-screen size.
        const s = border.scale && border.scale > 0 ? border.scale : 1;
        // The overlay is z-index:-1; isolate so it stays behind the element's own
        // text/children but above the element background, contained to this element.
        style.isolation = 'isolate';
        nineSliceLayer = (
          <NineSliceImage
            url={imgUrl} imgW={sprite.sheetW} imgH={sprite.sheetH} frame={sprite.frame}
            l={border.l} r={border.r} t={border.t} b={border.b} scale={s}
          />
        );
      } else {
        // Plain image (raw texture, or an atlas-packed sprite with no source dims).
        style.backgroundImage = `url(${imgUrl})`;
        style.backgroundSize = node.imageMode === 'fill' ? '100% 100%' : node.imageMode === 'none' ? 'auto' : node.imageMode;
        style.backgroundPosition = 'center';
        style.backgroundRepeat = 'no-repeat';
      }
    }
  }

  // ── Font family — emitted whether or not THIS node has text ──
  // `font-family` inherits, so authoring it on a container is how a whole UI tree gets one
  // typeface from one field. It used to live inside the `if (text)` block below, which made
  // that impossible: a container's authored family was silently dropped, and the only way to
  // restyle a scene was to repeat the family on every text node — 41 of them in Court, i.e. 41
  // copies of one decision, which is the drift this repo's palette work exists to end. The
  // field is on every UIElement and the Inspector shows it everywhere, so honouring it only on
  // leaves was an authoring surface that lied.
  if (node.fontFamily) style.fontFamily = node.fontFamily;

  // ── Text styling (only when text content exists) ──
  // Built here, applied to a wrapper around the text near the end of render — see the maxLines
  // block below for why it cannot live on the host.
  let clampStyle: React.CSSProperties | undefined;
  // Set only in the `clip` + `autoFitText` + `maxLines > 0` + no-authored-`lineHeight` combination
  // (#727) — the one case where the cap can't live on `clampStyle`'s wrapper (see the block below)
  // and instead has to live on the span `AutoFitText` itself resizes. `undefined` everywhere else,
  // so `AutoFitText`'s `clampLines` prop stays absent and every other text node is unaffected.
  let autoFitClampLines: number | undefined;
  if (text) {
    // `cssVal` so a non-px `fontSizeUnit` resolves through the same `--ui-*` custom properties
    // every other length uses (#245). Default 'px' returns the bare number, i.e. unchanged.
    style.fontSize = cssVal(node.fontSize, node.fontSizeUnit);
    style.fontWeight = node.fontWeight as any;
    if (node.fontStyle !== 'normal') style.fontStyle = node.fontStyle;
    style.color = hexToRgba(node.textColor, node.textOpacity ?? 1);
    style.textAlign = node.textAlign as any;
    // lineHeight is authored in PIXELS (like fontSize). React leaves `lineHeight`
    // unitless, which CSS reads as a font-size MULTIPLIER (e.g. 20 → 20×14px =
    // 280px/line). Emit explicit px so the authored value means pixels.
    if (node.lineHeight) style.lineHeight = `${node.lineHeight}px`;
    if (node.letterSpacing) style.letterSpacing = cssVal(node.letterSpacing, node.letterSpacingUnit);
    if (node.textShadowBlur || node.textShadowOffsetX || node.textShadowOffsetY) {
      style.textShadow = `${node.textShadowOffsetX}px ${node.textShadowOffsetY}px ${node.textShadowBlur}px ${hexToRgba(node.textShadowColor, node.textShadowOpacity ?? 1)}`;
    }
    if (node.textStrokeWidth > 0) {
      (style as any).WebkitTextStroke = `${node.textStrokeWidth}px ${hexToRgba(node.textStrokeColor, node.textStrokeOpacity ?? 1)}`;
      // paint-order: stroke fill — paint the stroke first, then the fill on
      // top. Without this, -webkit-text-stroke is centered on the glyph and
      // half the width cuts INTO the letter, making thick strokes shrink the
      // visible glyph. With it, the fill covers the inner half and only the
      // outer half shows — i.e. a true outline.
      (style as any).paintOrder = 'stroke fill';
    }
    // ── maxLines: the clamp lives on an INNER wrapper, never on the host (#655) ──
    // `-webkit-box` is not a flex container, so setting it here silently killed
    // `justifyContent`/`alignItems`/`flexDirection`/`gap` authored on this same entity — while
    // `getComputedStyle` went on REPORTING them (`center`), so the fields read alive in devtools
    // and in the Inspector while doing nothing. That is this repo's "an unwired field is a lie
    // with a tooltip" class, and it went from theoretical to reachable when #646 made the clamp
    // actually engage. `clampStyle` is applied to a wrapper around the text further down.
    if (node.maxLines > 0) {
      // `shrinkWrapAlign` for the same reason #657 needed it, one element over: this wrapper is a
      // FLEX ITEM. In the default `column` host with `alignItems: 'stretch'` it fills the width
      // and `text-align` still works — but in a `row` host (or `alignItems: flex-start/flex-end`)
      // it shrink-wraps, and `text-align` then has nothing to centre. Measured pre-fix on a 400px
      // row host with `textAlign: 'center'`: wrapper x=0 w=149 (flush left) against x~125 when the
      // clamp lived on the host. Latent — no scene authors `row` + `maxLines` today — but #655 is
      // precisely what makes `flexDirection` authorable on these entities, so it is newly
      // reachable BECAUSE of this change.
      clampStyle = { overflow: 'hidden', ...shrinkWrapAlign(node.textAlign) };
      if (node.textOverflow === 'ellipsis') {
        clampStyle.display = '-webkit-box';
        (clampStyle as any).WebkitLineClamp = node.maxLines;
        (clampStyle as any).WebkitBoxOrient = 'vertical';
        clampStyle.textOverflow = 'ellipsis';
      } else {
        // `clip` is the field's DEFAULT and used to be UNHONOURABLE (#656): `-webkit-line-clamp`
        // paints its own ellipsis unconditionally and never consults `text-overflow`, so an
        // author who chose `clip` — or who never touched the field — got an ellipsis they could
        // not turn off. A height cap truncates with no ellipsis instead.
        //
        // `lh` is the element's OWN line box, so `${maxLines}lh` is exact whether or not
        // `lineHeight` was authored, and it cuts at a line boundary rather than through the
        // middle of a glyph row. An authored `lineHeight` is emitted in px above, so use px
        // there — same number, and it does not depend on the unit at all.
        // ⚠️ `lh` needs Safari 16.4, which is EXACTLY this repo's iOS floor (CLAUDE.md § Device
        // Info). Below it the declaration is dropped, the cap does not apply, and the text
        // renders unclamped — more text than asked for, never a sliver.
        // ⚠️ A HEIGHT CAP IS NOT EQUIVALENT TO COUNTING LINES, and the difference bites exactly
        // once: when a DESCENDANT renders at a different font size than this wrapper. `lh` and
        // `em` both resolve against the wrapper's own (authored) size, while `AutoFitText` writes
        // a SHRUNK `font-size` onto its inner span. Measured: host 42px, span floored at 16px,
        // `max-height: 1lh` = 48px against an 18px line box — 2.67 lines rendered where 1 was
        // authored. `-webkit-line-clamp` counts LINE BOXES and is immune by construction.
        //
        // So the cap is used only where it is provably equivalent:
        //   authored lineHeight  -> px, and a px line-height INHERITS as a fixed value, so the
        //                           span's line boxes stay that tall whatever the font does.
        //   no autoFitText       -> nothing changes the font below here; `lh` is exact.
        //   otherwise (#727)     -> the cap can't live here at all: `lh`/`em` on THIS wrapper
        //                           resolve against ITS font size, but `AutoFitText` writes the
        //                           shrunk size onto its own inner span one level down, so a cap
        //                           here is too tall (measured: host 42px, span floored at 16px,
        //                           `1lh` here = 48px against an 18px line box — 2.67 lines
        //                           rendered where 1 was authored). Leave this wrapper uncapped
        //                           and hand `maxLines` down as `autoFitClampLines` instead, so
        //                           `AutoFitText` can put `${maxLines}lh` on the SPAN it resizes,
        //                           where `lh` resolves against the size it actually wrote.
        clampStyle.display = 'block';
        if (node.lineHeight) {
          clampStyle.maxHeight = `${node.lineHeight * node.maxLines}px`;
        } else if (!node.autoFitText) {
          clampStyle.maxHeight = `${node.maxLines}lh`;
        } else {
          autoFitClampLines = node.maxLines;
        }
      }
    } else if (node.textOverflow === 'ellipsis') {
      // Moved off the host onto `clampStyle`'s wrapper (#725) — `text-overflow` never did
      // anything here because the host entity div is ALWAYS `display: flex` (`style.display`
      // above), and `text-overflow` does not apply to a flex container. It silently painted
      // nothing while every other ellipsis field (`overflow`, `whiteSpace`) kept reading back
      // from `getComputedStyle` as set — the same "lie with a tooltip" class as #656.
      //
      // `minWidth: 0` is load-bearing, not a stray reset. The wrapper mounted below is a FLEX
      // ITEM of the host. A flex item's default `min-width: auto` resolves to its MIN-CONTENT
      // size, which for `white-space: nowrap` text is the text's entire natural width — so in a
      // `row` host (or any non-stretch cross axis) the item could never shrink below that, and
      // would overflow its box instead of ellipsizing. The default `column` host with
      // `alignItems: 'stretch'` already fills the box width regardless, which is why this bug
      // shipped invisibly: nothing authors `row` + single-line `ellipsis` today, so the failing
      // axis was never exercised. `shrinkWrapAlign` only ever returns margins, never `alignSelf`
      // (see its own header), so it composes safely with this.
      //
      // Zero blast radius today: no `games/**`/`demos/**` entity authors `textOverflow: 'ellipsis'`
      // with `maxLines: 0` — the only authored instances (`e2e-smoke.scene.json`) all set
      // `maxLines: 1` and already go through the `maxLines > 0` branch above.
      clampStyle = {
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
        ...shrinkWrapAlign(node.textAlign),
      };
    }
  }

  // ── UIAnchor (absolute positioning) ──
  // CSS comes from the shared anchorCss builder — the live-DOM counterpart of
  // anchorLayout.resolveAnchorRect (pixel rects for the editor overlay). The two
  // encode identical 16-mode semantics and are kept in lockstep by a parity test (F4).
  if (node.anchor) {
    applyAnchorStyle(style, node.anchor);
  }

  // ── Rotation (#234) + scale (#340) ──
  // AFTER the anchor, because it composes onto the anchor's pivot translate rather than replacing
  // it. Applies to anchored and flow-laid-out elements alike; the pivot rules live in anchorCss.
  applyRotationStyle(style, node.rotation, node.anchor, node.scale);

  // Scroll-view CSS (snap + overscroll). Deliberately does NOT set `overflow` — that stays
  // `UIElement.overflow`, which the author already knows, so one visible consequence keeps one
  // owner. A UIScrollView on an element left at `overflow:'visible'` therefore does not scroll,
  // which is the honest outcome rather than two fields silently fighting.
  if (node.scroll) Object.assign(style, scrollViewStyle(node.scroll));
  // The snap TARGET half, stamped by the enclosing scroll view during the tree build — snapping
  // is declared on the box and honoured on the target, and those are different elements.
  if (node.snapChild) Object.assign(style, node.snapChild);

  // ── TouchControl (on-screen d-pad / button, #297) ──
  //
  // Mounting is decided by the HOST, not by what was last pressed: the control has to be there
  // BEFORE the player's first touch, or it is the thing preventing them from producing one.
  //
  // ⚠️ In the editor's authoring preview (`onSelectEntity`) a control is ALWAYS mounted, whatever
  // `showOn` says. The editor is a desktop host, so honouring `showOn:'touch'` there would leave
  // a d-pad invisible in the very viewport you position it in — un-clickable in the Hierarchy's
  // click-to-select, un-draggable, un-authorable. `showOn:'never'` still hides it, because that
  // is an author saying "off", not a host saying "not applicable".
  const touch = node.touch;
  if (touch && (touch.showOn === 'never'
    || (!onSelectEntity && touch.showOn === 'touch' && !isTouchDevice()))) return null;

  // A touch control must RECEIVE the press (its parent HUD panel is usually
  // `pointer-events:none`), and must not let the browser turn a thumb-hold into a scroll, a
  // pinch, a text selection or a tap highlight. Done in CSS rather than with `preventDefault`
  // in the source: passive listeners stay passive, and the suppression is scoped to the
  // element instead of to the window.
  //
  // ⚠️ Only a plain `div` can BE a control. `touchAttrs` is spread into the two `<div>` returns
  // at the bottom of this function; the `input`/`range`/`UIToggle` branches return earlier and
  // do not carry it. So the attribute — the only thing `input/touchControlSource.ts` resolves
  // controls by — would be missing while the touch STYLES below were still applied, leaving an
  // element that suppresses scrolling and tap highlights and drives nothing. That is the
  // partially-wired authoring surface CLAUDE.md warns about, and it is the fourth instance of
  // the same class in this file (see the canvas2D / UIToggle / VideoPlayer warns above). Both
  // halves are gated on `touchWired` so the element is coherently NOT a control, and DEV says so.
  const touchWired = !!touch && node.elementType === 'div' && !node.toggle;
  if (import.meta.env?.DEV && touch && !touchWired) {
    const why = node.toggle ? 'a UIToggle draws its own switch' : `elementType '${node.elementType}' is not a div`;
    console.warn(
      `[UINode] entity ${node.entityId}: TouchControl ('${touch.action}') will NOT drive input here — ${why}, so the control attribute is never stamped. Put the TouchControl on a plain div entity.`,
    );
  }
  const touchAttrs: Record<string, string> = {};
  // Never stamped in the editor preview: the source refuses a control outside a runtime UI root
  // anyway, so this is the second of two independent guards, not the only one.
  if (touchWired && !onSelectEntity) {
    touchAttrs[TOUCH_ATTR] = touch!.action;
    touchAttrs[TOUCH_OPACITY_ATTR] = String(touch!.pressedOpacity);
  }


  // ── Click handler ──
  // A button is interactive if it dispatches an action OR applies declarative
  // bindings — any click-event binding (set write or call action).
  const isInteractive = !!node.action?.bindings?.some(b => (b.event || 'click') === 'click');

  // In editor mode, skip click handler on canvas2D containers — they're just mount points,
  // not something worth selecting. Let clicks pass through to children.
  const handleClick = onSelectEntity
    ? node.canvas2D
      ? undefined
      : (e: React.MouseEvent) => { e.stopPropagation(); onSelectEntity(node.entityId); }
    : isInteractive
      ? (e: React.MouseEvent) => {
          e.stopPropagation();
          // #664 — a press that started on a descendant control and released past this node
          // (a horizontal swipe outrunning a panel's edge, say) must not fire this node's
          // bindings just because the browser resolved the click to this common ancestor. See
          // pressOrigin.ts's module doc for why per-control stopPropagation can't cover this.
          if (!pressBelongsTo(e.currentTarget as Element)) return;
          // Run every click binding (set writes + call actions). Inert in edit mode.
          applyBindings(node.action!.bindings, 'click', { selfGuid: node.guid });
        }
      : undefined;

  if (onSelectEntity && !node.canvas2D) {
    style.pointerEvents = 'auto';
    style.cursor = 'pointer';
  } else if (isInteractive) {
    style.pointerEvents = 'auto';
    style.cursor = 'pointer';
  } else if (node.children.length === 0) {
    // Only disable pointer events on leaf nodes (containers must pass events to children)
    style.pointerEvents = 'none';
  }

  // Scroll containers must receive wheel/touch events themselves to scroll —
  // the UIRenderer root is pointer-events:none, so without this the container
  // inherits none and the user can't scroll (the scrollbar even ignores drags).
  if (node.overflow === 'scroll') style.pointerEvents = 'auto';

  // The author's explicit "this element is decoration — let taps through to what is behind it".
  // LAST on purpose, so it wins over both rules above: the container default (`auto`, so events
  // reach children) and the scroll force (`auto`, so the box can be scrolled). Those are defaults
  // inferred from structure; this is a statement of intent, and inference must not outrank it.
  //
  // ⚠️ It does NOT disarm the children — CSS `pointer-events: none` on a parent leaves a child
  // that sets `auto` fully clickable, which is the entire point: a decorative panel that still
  // holds a working button. The cursor is cleared with it, so nothing paints a finger over an
  // element that will not receive the click.
  //
  // ⚠️ Opting a `scroll` container into this gives up SCROLLING it (that is what the line above
  // was for) — correct only when the box is sized never to overflow.
  //
  // ⚠️ NOT in the editor's click-to-select mode. `onSelectEntity` deliberately makes every element
  // clickable so it can be SELECTED (see the branch above), and that is authoring, not gameplay —
  // an element the game must not receive taps on is still one the author has to be able to pick in
  // the viewport. Ungated, this made a decorative container selectable only from the hierarchy
  // panel, which is exactly the element type the field exists for (Court's narration band).
  if (node.pointerThrough && !onSelectEntity) {
    style.pointerEvents = 'none';
    style.cursor = undefined;
  }

  // ⚠️ AFTER every rule above, including `pointerThrough`, and that ordering is the point. A
  // d-pad arrow is a LEAF, so the leaf default two blocks up would have set `pointer-events:
  // none` and the pad would have been inert while looking perfect — the exact failure class the
  // pointer-blocker passthrough bug was. `TouchControl` is the strongest statement of intent
  // available ("this element IS a control"), so it outranks the inferred defaults and an
  // author's `pointerThrough` alike.
  if (touchWired) {
    style.pointerEvents = 'auto';
    // Stop the browser turning a thumb-hold into a scroll, a pinch, a text selection or a tap
    // highlight. In CSS rather than `preventDefault` in the source: the listeners stay passive,
    // and the suppression is scoped to the element instead of to the window.
    style.touchAction = 'none';
    style.userSelect = 'none';
    (style as unknown as Record<string, string>).WebkitUserSelect = 'none';
    (style as unknown as Record<string, string>).WebkitTapHighlightColor = 'transparent';
  }

  // Editor 2D-only layer: strip UI visuals but keep layout, so nested Canvas2D
  // canvases still mount and position while the UI layer is hidden. The canvas
  // itself renders regardless (its own pointerEvents stay 'auto').
  if (uiVisualsHidden) {
    style.backgroundColor = undefined;
    style.backgroundImage = undefined;
    style.borderWidth = undefined;
    style.borderStyle = undefined;
    style.borderColor = undefined;
    style.boxShadow = undefined;
    style.pointerEvents = 'none';
    style.cursor = undefined;
    text = '';
    nineSliceLayer = null;   // 9-slice background is a UI visual — strip it too
  }

  // Video: mount the clip into this node's own box. Built here — ahead of the input and
  // Canvas2D branches, which return early — and injected beside `nineSliceLayer` in every
  // return that can carry one. It sits OVER any image background, so an authored
  // `imageSrc` doubles as the poster this element shows before Play and after a teardown
  // (video only runs while the game is playing). Suppressed with the other UI visuals.
  // `priority`: there is ONE element per clip, and in the editor this same tree is mounted
  // into BOTH the Game and Scene panels. `onSelectEntity` is set only on the editor's
  // authoring surface, so it is what distinguishes them — the running game wins, because
  // that is the picture the human is judging. Without this the last host to tick won, which
  // was the Scene panel ("the video plays only on Scene view, not on the game view").
  const videoLayer = node.hasVideo && UIVideoMount && !uiVisualsHidden
    ? (
      <Suspense fallback={null}>
        <UIVideoMount entityId={node.entityId} fit={node.imageMode} priority={onSelectEntity ? 0 : 1} />
      </Suspense>
    )
    : null;

  // F8: an input/range elementType returns before the canvas2D branch below, so an
  // entity carrying BOTH a Canvas2D and a non-'div' elementType renders as the input
  // and its 2D canvas silently never mounts. Warn in dev so the misconfig is visible
  // (author the canvas on a separate child entity instead).
  if (import.meta.env?.DEV && node.canvas2D && node.elementType !== 'div') {
    console.warn(
      `[UINode] entity ${node.entityId}: elementType '${node.elementType}' takes precedence over its Canvas2D — the 2D canvas will NOT mount. Put the Canvas2D on its own child entity.`,
    );
  }
  // ⚠️ Same class, second door. `UIToggle` returns its own subtree BEFORE the Canvas2D block and
  // before the children walk, and it does it WITHOUT touching `elementType` — so the check above
  // (which keys off `elementType !== 'div'`) is blind to it and both cases were silent. A toggle
  // draws exactly a track and a knob; anything else authored on that entity is dropped.
  if (import.meta.env?.DEV && node.toggle && (node.canvas2D || node.children.length > 0)) {
    const dropped = [node.canvas2D && 'its Canvas2D', node.children.length > 0 && `${node.children.length} child entity/entities`]
      .filter(Boolean).join(' and ');
    console.warn(
      `[UINode] entity ${node.entityId}: UIToggle draws only a track and a knob, so ${dropped} will NOT render. Move that content to a sibling entity.`,
    );
  }

  // Same class, same silence: `videoLayer` is injected into the returns that render a
  // <div>, and an <input>/<range> is a VOID element that cannot carry it. So a
  // `VideoPlayer` on a node whose elementType is not 'div' plays with no picture — the
  // clip is decoding, the audio is on the bus, and nothing appears. Warn for the same
  // reason F8 does above: the misconfig is invisible from the authored data.
  if (import.meta.env?.DEV && node.hasVideo && node.elementType !== 'div') {
    console.warn(
      `[UINode] entity ${node.entityId}: elementType '${node.elementType}' cannot host a video — the VideoPlayer's picture will NOT mount (audio still plays). Put the VideoPlayer on its own child entity.`,
    );
  }

  // Input element: render <input> instead of <div> when elementType is 'input'.
  // In editor mode, render read-only so it looks the same but doesn't steal focus.
  //
  // `node.autoFitText` is DELIBERATELY not read on this path (#614): an <input>'s value is
  // player-entered text, not an authored label, and shrinking it as the user types is a
  // different feature. autoFitText does nothing on an input today — the field's Inspector
  // tooltip says so, so the surface doesn't lie about it.
  if (node.elementType === 'input') {
    const inputValue = node.binding?.inputBinding
      ? String(storeState[node.binding.inputBinding] ?? '')
      : '';
    // Apply text styles to the input element
    if (node.fontFamily) style.fontFamily = node.fontFamily;
    style.fontSize = cssVal(node.fontSize, node.fontSizeUnit);
    style.fontWeight = node.fontWeight as any;
    style.color = hexToRgba(node.textColor, node.textOpacity ?? 1);
    if (onSelectEntity) {
      // Editor mode: read-only input, click selects entity instead of focusing
      style.pointerEvents = 'auto';
      style.cursor = 'pointer';
      return (
        <input
          style={style}
          value={inputValue}
          placeholder={node.placeholder}
          readOnly
          tabIndex={-1}
          onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onSelectEntity(node.entityId); }}
          onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
          data-entity-id={node.entityId}
          {...{ [UI_PRESS_ORIGIN_ATTR]: '' }}
        />
      );
    }
    // `!node.pointerThrough` because this line runs AFTER the pointerThrough block and would
    // otherwise silently undo it — the field would read as supported on an input and do nothing.
    if (!node.pointerThrough) style.pointerEvents = 'auto';
    return (
      <input
        style={style}
        value={inputValue}
        placeholder={node.placeholder}
        onChange={node.action?.bindings?.length
          // continuous: true — this fires once per KEYSTROKE on a controlled input, not a
          // discrete activation. Locking it would swallow every character typed within the
          // input-lock window after the first, and since this binding write IS what produces
          // the field's value, those keystrokes are LOST, not merely delayed (#466 follow-up:
          // typing "hello" would land only "h"). See uiInputLock.test.ts's typing regression.
          ? (e: React.ChangeEvent<HTMLInputElement>) => applyBindings(node.action!.bindings, 'change', { selfGuid: node.guid, eventValue: e.target.value, continuous: true })
          : undefined}
        onKeyDown={node.action?.bindings?.length
          ? (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              applyBindings(node.action!.bindings, 'submit', { selfGuid: node.guid, eventValue: (e.target as HTMLInputElement).value });
            }
          }
          : undefined}
        // Same contract as the range below and the toggle further down: focusing a text field is
        // not a click on whatever sits behind it. Latent rather than reported — no shipped game
        // has yet put a text input inside a dismiss-on-backdrop panel — but it is the same bug.
        // `clearPressOrigin()` because this stops propagation WITHOUT consulting `pressBelongsTo`
        // — see pressOrigin.ts's "The rule for a handler that swallows a click": left uncleared,
        // React's synthetic stopPropagation also stops the native event at the React root, so the
        // document-level sweep never runs and the pair survives to be misread by a later click.
        onClick={(e: React.MouseEvent) => { e.stopPropagation(); clearPressOrigin(); }}
        data-entity-id={node.entityId}
        {...{ [UI_PRESS_ORIGIN_ATTR]: '' }}
      />
    );
  }

  // Range slider: render <input type="range"> when elementType === 'range'.
  // Value reads through inputBinding (same store-field convention as text inputs);
  // onChange fires the UIAction 'change'-event bindings with the new numeric value.
  // Editor mode (onSelectEntity) makes the slider non-interactive so dragging
  // selects the entity instead of editing the value.
  if (node.elementType === 'range') {
    const rawValue = node.binding?.inputBinding
      ? Number(storeState[node.binding.inputBinding] ?? node.rangeMin)
      : node.rangeMin;
    const sliderValue = Number.isFinite(rawValue) ? rawValue : node.rangeMin;
    // Same reason as the input above: this would silently undo `pointerThrough`.
    if (!node.pointerThrough) style.pointerEvents = 'auto';
    style.accentColor = hexToColor(node.textColor);
    if (onSelectEntity) {
      return (
        <input
          type="range"
          style={{ ...style, cursor: 'pointer' }}
          min={node.rangeMin}
          max={node.rangeMax}
          step={node.rangeStep || 1}
          value={sliderValue}
          readOnly
          tabIndex={-1}
          onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onSelectEntity(node.entityId); }}
          onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
          data-entity-id={node.entityId}
          {...{ [UI_PRESS_ORIGIN_ATTR]: '' }}
        />
      );
    }
    return (
      <input
        type="range"
        style={style}
        min={node.rangeMin}
        max={node.rangeMax}
        step={node.rangeStep || 1}
        value={sliderValue}
        onChange={node.action?.bindings?.length
          // continuous: true — this 'change' fires repeatedly during a drag, not a discrete
          // activation, so it must not take (or be blocked by) the global input lock (#466).
          ? (e: React.ChangeEvent<HTMLInputElement>) => applyBindings(node.action!.bindings, 'change', { selfGuid: node.guid, eventValue: Number(e.target.value), continuous: true })
          : undefined}
        // A click that lands on an interactive control has been CONSUMED by it, and must not also
        // read as a click on an ancestor. Without this a slider inside the canonical
        // click-the-backdrop-to-dismiss panel closes that panel on every adjustment — reported on
        // games/court's settings sliders, which dismissed the dialog mid-drag. The toggle branch
        // below has always done this; `range` and the text input above simply never did.
        // `clearPressOrigin()` for the same reason as the text input above: this stops
        // propagation without consulting the gate, so it must clear the pair itself.
        onClick={(e: React.MouseEvent) => { e.stopPropagation(); clearPressOrigin(); }}
        data-entity-id={node.entityId}
        {...{ [UI_PRESS_ORIGIN_ATTR]: '' }}
      />
    );
  }

  // Toggle: an on/off switch — a track with a knob that sits at one end or the other.
  // The FIRST control in the engine that draws more than one DOM node from one entity
  // (the `input`/`range` branches above delegate to a native element), so a couple of
  // things are deliberate rather than incidental:
  //
  //  • The ROOT element is the TRACK, carrying the standard `style` object built above.
  //    That is what makes the focus ring, anchoring, visibility and the pointer-events
  //    rules apply to a toggle for free. Wrapping it in a bespoke element instead would
  //    have re-implemented all four, badly.
  //  • The knob is laid out by FLEX, not by measuring anything. `justifyContent` flips
  //    between the two ends and the knob is a square sized off the track's own height
  //    (`aspectRatio`), so the switch works at any authored size with no JS measurement
  //    and no second render pass.
  //  • ⚠️ The toggle OWNS its inner layout, so `UIElement`'s flex + padding fields are
  //    overridden here and have no effect on a UIToggle entity. Everything else on
  //    UIElement (size, border, opacity, anchoring) still applies normally.
  //
  // It does NOT write `value` itself — see the UIToggle trait header for why (a self-write
  // would mutate the scene from a Stopped editor, which `applyBindings` exists to prevent).
  if (node.toggle) {
    const t = node.toggle;
    const inset = Math.max(0, t.knobInset);
    // ⚠️ `'change'` ONLY, and the narrowness is the whole point. `fire()` dispatches `'change'`,
    // and `applyBindings` skips every row whose own `event` differs — so a toggle carrying only a
    // `'click'` binding can never move. This test used to accept `'click'` too, which made the
    // control interactive AND silent: worse than having no binding at all, because the dead-toggle
    // warning below was suppressed by the very binding that could not work.
    //
    // It is also the LIKELIEST authoring mistake, not a hypothetical: the Inspector's "add binding"
    // button defaults to `event: 'click'` (`UIActionBindingsField.tsx`), so an author who adds a
    // binding and does not change the dropdown lands exactly here — and now gets told.
    const canFire = !!node.action?.bindings?.some(b => (b.event || 'click') === 'change');
    if (import.meta.env?.DEV && !onSelectEntity && !canFire) warnDeadToggle(node.guid || String(node.entityId));

    const fire = () => applyBindings(node.action!.bindings, 'change', { selfGuid: node.guid, eventValue: !t.value });
    const interactive = canFire && !t.disabled && !onSelectEntity;

    const trackStyle: React.CSSProperties = {
      ...style,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: t.value ? 'flex-end' : 'flex-start',
      padding: inset,
      boxSizing: 'border-box',
      backgroundColor: hexToRgba(t.value ? t.trackOnColor : t.trackOffColor, t.trackOpacity),
      borderRadius: t.trackRadius,
      // Multiplied, not assigned: a toggle inside a fading panel must keep fading with it.
      opacity: (style.opacity as number ?? 1) * (t.disabled ? 0.5 : 1),
    };
    // Editor mode wins over `pointerThrough`/interactivity alike, exactly as the branches
    // above do: an authored element must stay pickable in the viewport.
    if (onSelectEntity) { trackStyle.pointerEvents = 'auto'; trackStyle.cursor = 'pointer'; }
    else if (interactive && !node.pointerThrough) { trackStyle.pointerEvents = 'auto'; trackStyle.cursor = 'pointer'; }
    else if (!node.pointerThrough) { trackStyle.pointerEvents = 'auto'; trackStyle.cursor = 'default'; }

    const knobStyle: React.CSSProperties = {
      height: '100%',
      aspectRatio: '1 / 1',
      flexShrink: 0,
      backgroundColor: hexToRgba(t.knobColor, t.knobOpacity),
      borderRadius: t.knobRadius,
    };

    return (
      <div
        style={trackStyle}
        role="switch"
        aria-checked={t.value}
        aria-disabled={t.disabled || undefined}
        // Native focus + Space/Enter, so a toggle is keyboard-operable wherever it is
        // rendered. NOTE this is the DOM's own focus, not `UIFocusable`'s controller
        // navigation — routing a toggle through that is a follow-up, because the focus
        // manager activates by firing 'click' bindings with no event value, and a switch
        // has to carry the NEW value with it. Deliberately not half-wired.
        tabIndex={interactive ? 0 : -1}
        onClick={onSelectEntity
          ? (e: React.MouseEvent) => { e.stopPropagation(); onSelectEntity(node.entityId); }
          : interactive
            // `clearPressOrigin()` for the same reason as the range/text-input branches above:
            // this stops propagation without consulting `pressBelongsTo`, so it must clear the
            // pair itself or a later click could misread it as its own.
            ? (e: React.MouseEvent) => { e.stopPropagation(); clearPressOrigin(); fire(); }
            : undefined}
        onKeyDown={interactive
          ? (e: React.KeyboardEvent) => {
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fire(); }
          }
          : undefined}
        data-entity-id={node.entityId}
        {...{ [UI_PRESS_ORIGIN_ATTR]: '' }}
      >
        <div style={knobStyle} />
      </div>
    );
  }

  // Canvas2D: mount the 2D canvas inline among the UI children so it stacks by
  // hierarchy (DOM order). Runtime → pooled PixiJS canvas (Canvas2DMount). Editor
  // → injected editor canvas via renderCanvas2D (null when 2D layer is toggled off).
  // UIElement children (without Renderable2D) still render as DOM overlays on top.
  if (node.canvas2D) {
    const canvas2DContent = renderCanvas2D
      ? renderCanvas2D(node.entityId)
      // applyWebSizeMode: this is the shipped-game / GameView surface, so it honours
      // `rendering.web.sizeMode` — matching Scene3D, which clamps the 3D buffer on the
      // same surface. The editor branch above (renderCanvas2D, SceneView.tsx) deliberately
      // does NOT pass it — the editor viewport sizes itself / uses device presets.
      //
      // pointerThrough must be threaded explicitly: Canvas2DMount's own wrapper div hardcodes
      // `pointerEvents: 'auto'` unless told otherwise, and a DOM ancestor set to `none` does not
      // stop a descendant set to `auto` from receiving pointer events — so the outer `style`
      // above (which already reflects `node.pointerThrough`) can't reach through to it on its own.
      : (!onSelectEntity && Canvas2DMount ? <Suspense fallback={null}><Canvas2DMount entityId={node.entityId} applyWebSizeMode pointerThrough={node.pointerThrough} /></Suspense> : null);
    return (
      <div ref={attachScroll} style={style} onClick={handleClick} data-entity-id={node.entityId} {...touchAttrs} {...(isInteractive ? { [UI_PRESS_ORIGIN_ATTR]: '' } : undefined)}>
        {nineSliceLayer}
        {videoLayer}
        {canvas2DContent}
        {node.children.map(child => (
          <UINode key={child.entityId} node={child} storeState={storeState} onSelectEntity={onSelectEntity} renderCanvas2D={renderCanvas2D} uiVisualsHidden={uiVisualsHidden} />
        ))}
      </div>
    );
  }

  // Whole-element CSS text animation (TextAnimation trait on a UIElement). Applied to
  // an inner span so its transform doesn't clobber the element's anchor/layout. The
  // play gate lives in the projection (uiTreeStore): node.textAnim is populated only
  // while the sim is running (freezes to base text when Stopped, like the 2D/3D
  // geometry paths), and its presence/absence drives the re-render on Play/Stop.
  let textContent: React.ReactNode = text;
  if (text && node.textAnim) {
    // textAlign is passed so a shrink-wrapped rainbow span keeps the authored alignment —
    // `fit-content` alone made a centred label jump to the left edge (#657, measured on screen).
    const a = uiTextAnimation(node.textAnim, node.textAlign);
    if (a) {
      ensureUITextAnimStyles();
      textContent = <AnimatedText text={text} animation={a.animation} amp={a.amp} extra={a.style}
        perCharStagger={a.perChar?.staggerSec} perCharLoop={a.perChar?.loop} perCharFade={a.perChar?.fadeIn} />;
    }
  }
  // Shrink-only auto-fit (#614) — wraps whatever textContent already is (a bare string, or the
  // AnimatedText span above), so it composes with text animation rather than competing with it.
  if (text && node.autoFitText) {
    // `clampLines` (#727) is only ever set for the `clip` + `autoFitText` + `maxLines > 0` +
    // no-authored-`lineHeight` combination — see where `autoFitClampLines` is assigned above.
    textContent = <AutoFitText text={text} fontSize={node.fontSize} fontSizeMin={node.fontSizeMin} clampLines={autoFitClampLines}>{textContent}</AutoFitText>;
  }
  // The maxLines clamp (#655/#656), OUTERMOST so it clamps whatever the two wrappers above
  // produced. Mounted when `maxLines > 0`, and ALSO for a single-line `textOverflow: 'ellipsis'`
  // since #725 (the host is a flex container, where `text-overflow` does nothing) — every other
  // text node still keeps byte-identical DOM. This changes the shape every game's UI text renders
  // into, so confining it to the elements that actually clamp or ellipsize is what keeps that
  // blast radius small: one authored entity for the clamp, and ZERO for the single-line case —
  // no `games/**`/`demos/**` entity authors `ellipsis` with `maxLines: 0` today.
  //
  // A `div`, not a `span`: `editor-ui-autofit.spec.ts` resolves the text span with
  // `box.locator('span')`, and a second span there is a Playwright strict-mode violation, not a
  // behavioural failure — a confusing way to learn about a wrapper.
  //
  // `UI_PAINT_ATTR` is load-bearing, not decoration. `isPaintOpaque` (editor/panels/
  // uiPreviewPick.ts) credits an entity with paint via a DIRECT text-node child; a bare string
  // moved inside this wrapper is no longer direct, so without the marker a clamped label reads
  // as purely decorative and a SceneView click falls through to whatever sits behind it. The
  // marker's `closest('[data-entity-id]')` is still the host, which is what that check asks.
  // `text &&` as well as `clampStyle`: `uiVisualsHidden` blanks `text` AFTER clampStyle is built,
  // so without it the editor's 2D-only layer mounts an EMPTY `<div data-ui-paint="text">`, which
  // `isPaintOpaque` would credit as paint. It does not misfire today only because that same block
  // sets `pointerEvents: 'none'` — i.e. one edit away from a blank label stealing 2D picks.
  if (text && clampStyle) {
    textContent = <div {...{ [UI_PAINT_ATTR]: 'text' }} style={clampStyle}>{textContent}</div>;
  }

  return (
    <div ref={attachScroll} style={style} onClick={handleClick} data-entity-id={node.entityId} {...touchAttrs} {...(isInteractive ? { [UI_PRESS_ORIGIN_ATTR]: '' } : undefined)}>
      {nineSliceLayer}
      {videoLayer}
      {textContent}
      {node.children.map(child => (
        <UINode key={child.entityId} node={child} storeState={storeState} onSelectEntity={onSelectEntity} renderCanvas2D={renderCanvas2D} uiVisualsHidden={uiVisualsHidden} />
      ))}
    </div>
  );
}


/** How long the wheel must be QUIET before a new `wheel: 'entry'` gesture may move again. Long
 *  enough to swallow a trackpad's continuous stream, short enough that a deliberate second flick
 *  is not refused. */
const WHEEL_GESTURE_GAP_MS = 140;

/** Wire a `UIScrollView` element to the DOM: read scroll position back into ECS on every scroll
 *  event, measure the viewport/content, and consume any pending `scrollTo*` request.
 *
 *  ⚠️ **None of these writes marks the UI tree dirty.** See `scrollViewDom.writeScrollState` —
 *  a scroll frame that does not move the entry window must cost a field write and nothing more.
 *  The consumer that DOES need to react (`UIEntries`) is a system reading the trait, not this. */
function useScrollView(node: UINodeData, ref: React.RefObject<HTMLDivElement | null>) {
  const scroll = node.scroll;
  const guid = node.guid;
  // ⚠️ **Snapping and recycling used to fight each other here, and the fix is NOT in this file.**
  //
  // The offset is carried as PADDING on the pooled content, so a pool re-drive rewrites it while
  // the view is mid-scroll. When the window was built from the scroll the system could still
  // OBSERVE, that padding described where the view WAS while the DOM was moving to where it had
  // been ASKED to go — and `scroll-snap-type: mandatory` answered the mismatch by re-snapping to
  // the previously-snapped element, which recycling had just repointed at different data. That
  // moved the scroll, which re-drove the pool, which rewrote the padding: a closed loop that both
  // landed on the wrong page and cost ~3x the frame time at rest.
  //
  // Suspending snap from here while the view moved was tried, shipped briefly, and REMOVED. It
  // worked, and the owner immediately felt what it cost: with snap off during momentum the browser
  // cannot decelerate INTO a snap point, so the view coasted to a full stop mid-page and then
  // jerked into line — *"the scroll stops completely once, then it snaps"*, and past the halfway
  // mark that jerk read as an extra page. Fixing the window at its source
  // (`entriesSystem`: a converted request builds the frame's window from the TARGET) removes the
  // mismatch entirely, so snap never has anything to correct and can stay on throughout. Verified
  // with snap mandatory the whole time: swipe +1, +1, fling +3, swipe -2 all land exactly, a
  // programmatic jump to entry 19 lands on 19, and frame time is p50 13ms at page 3 AND at page 21.
  //
  // So: do not reintroduce a snap suspension here. If a snap/recycle symptom reappears, the window
  // is being built from the wrong offset — fix that.

  // ── wheel: 'entry' — one wheel GESTURE moves exactly one entry ──────────────────────────────
  //
  // ⚠️ **A delta multiplier cannot do this job.** Under `snap: mandatory` the browser quantises
  // any offset to a whole entry, so scaling the delta changes nothing that reaches the screen.
  // What needs bounding is how many entries ONE gesture may cross — and it does need bounding: a
  // single wheel notch (~100-120px against a 218px page) is under half an entry and snaps back to
  // where it started, while a trackpad swipe emits a rapid stream of events whose deltas
  // accumulate into hundreds of pixels before the browser resolves them, so one flick crossed
  // several pages. Owner on Court's level selector, 2026-08-22: *"with the mouse wheel, scroll is
  // too sensitive."*
  //
  // A gesture ends when the wheel has been QUIET for `WHEEL_GESTURE_GAP_MS`, not after a fixed
  // cooldown from the first event: a trackpad's stream is continuous, so a cooldown would let a
  // long swipe fire repeatedly and reintroduce exactly the runaway being fixed. Discrete mouse
  // notches spaced further apart than the gap each move one entry, which is what a mouse user
  // expects.
  //
  // Touch is untouched — a swipe is not a wheel event.
  const wheelBusy = React.useRef(false);
  const wheelTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (wheelTimer.current) clearTimeout(wheelTimer.current); }, []);

  const wheelMode = scroll?.wheel;
  const axis = scroll?.axis;
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !guid || wheelMode !== 'entry') return;
    const onWheel = (e: WheelEvent) => {
      // ⚠️ **Only swallow the wheel when this box can actually scroll on its axis.** Non-passive
      // so it CAN preventDefault — without that the browser also applies the raw delta and fights
      // the request below — but doing it unconditionally is the classic wheel trap: a view with
      // nothing to scroll (content fits, or it is nested inside another scroller) would capture
      // every wheel event over it and drop it, so the ancestor scrollable never moves while the
      // pointer is there. Input captured and discarded is worse than input not handled.
      const canScroll = axis === 'y'
        ? el.scrollHeight > el.clientHeight
        : el.scrollWidth > el.clientWidth;
      if (!canScroll) return;
      e.preventDefault();
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => { wheelBusy.current = false; }, WHEEL_GESTURE_GAP_MS);
      if (wheelBusy.current) return;          // still inside one gesture — already moved for it
      // A horizontal pager is usually driven by a VERTICAL wheel (a plain mouse has no X axis),
      // so take whichever delta is larger and let the view's own axis decide where it applies.
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      const step = delta > 0 ? 1 : -1;
      const moved = axis === 'y'
        ? scrollByEntry(guid, { y: step }, { behavior: 'smooth' })
        : scrollByEntry(guid, { x: step }, { behavior: 'smooth' });
      if (moved) wheelBusy.current = true;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref, guid, wheelMode, axis]);

  // A ref, not state: the handler must not re-render the component it is attached to.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !scroll || !guid) return;
    // #665: the true fractional box size, refreshed only on RESIZE (see `pushResize` below) —
    // `push()` reads this cached value rather than re-measuring, so the cheap scroll path stays
    // cheap.
    let precise: { width: number; height: number } | null = null;
    const refreshPrecise = () => { precise = readPreciseBoxSize(el); };
    const push = () => {
      // #413: an element with no box (a hidden editor dock tab) must not overwrite the other
      // mount's real measurement — see `readScrollMeasurement`.
      const measured = readScrollMeasurement(el, precise);
      if (!measured) return;
      const changed = writeScrollState(guid, measured);
      // Re-drive the pool NOW, in the same frame the browser is painting this offset in — a
      // `scroll` event lands before rAF, so the projection still picks it up this frame. Waiting
      // for the next pipeline tick costs a frame, and that frame is what makes a fast scroll go
      // black: the band has to cover twice the per-frame travel instead of once. Guarded on
      // `changed` so a scroll event landing on the same rounded pixel still costs nothing, and
      // routed through `driveEntriesFromScroll` (never `entriesSystem` directly) because the
      // pool spawns and needs the system-tick flag for `Transient`.
      if (changed) driveEntriesFromScroll();
    };
    // `refreshPrecise` calls `getComputedStyle`, which forces a style recalc — cheap once per
    // resize, but #677 reports the `scroll` listener's path as frame-rate critical, so `push`
    // alone (using the cached `precise`) is what runs on every scroll event, and this combined
    // form is reserved for the resize/mutation paths below.
    const pushResize = () => { refreshPrecise(); push(); };
    pushResize();                              // seed, so a system sees real numbers on frame 1
    el.addEventListener('scroll', push, { passive: true });
    // The geometry stands on the viewport size, so measure it rather than assuming the authored
    // width/height resolved to what we think (percentages, flex, safe-area insets).
    //
    // ⚠️ **Observing `el` alone is not enough — `contentHeight`/`contentWidth` (`scrollHeight`/
    // `scrollWidth`) can change with NO resize of `el` itself.** A row mounting/unmounting inside a
    // `flexShrink:0` scroll box (Court's store shelf: `syncStoreChrome` toggles row `isVisible` every
    // frame the modal is open) changes the CONTENT height while the box's own border box, capped by
    // an authored `maxHeight`, never moves — exactly the case `scrollAnchor.ts`'s own header warns
    // about for the identical reason ("Court's panel stayed 585px tall while its content went 888 ->
    // 836"). Left unfixed, a consumer reading `contentHeight` for a "is there more to scroll"
    // affordance (`docs/ui-system.md`'s own stated use case) can go stale exactly while it matters —
    // scrolled to the bottom, a row mounts, there IS more below now, and the number does not move
    // until some OTHER event happens to fire a `scroll`. Mirrors `scrollAnchor.ts`'s own fix for
    // this: watch every direct child too, and re-observe on any child-list mutation.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(pushResize) : null;
    const observeAll = () => {
      if (!ro) return;
      ro.disconnect();
      ro.observe(el);
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    observeAll();
    const mo = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => { observeAll(); pushResize(); })
      : null;
    mo?.observe(el, { childList: true });
    return () => { el.removeEventListener('scroll', push); ro?.disconnect(); mo?.disconnect(); };
  }, [ref, guid, scroll ? 1 : 0]);           // eslint-disable-line react-hooks/exhaustive-deps

  // One-shot scrollTo request. Keyed on the request VALUES, so re-requesting the same offset
  // after the game cleared it fires again rather than being swallowed.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !scroll || !guid) return;
    const req = pendingScrollTo(scroll);
    if (!req) return;
    el.scrollTo(req as ScrollToOptions);
    // Hand back the override this effect actually consumed, so a request armed AFTER the snapshot
    // this effect is holding does not get its behaviour cleared out from under it (#409).
    clearScrollRequest(guid, scroll.scrollToBehavior);
  }, [ref, guid, scroll?.scrollToX, scroll?.scrollToY, scroll?.scrollToBehavior]); // eslint-disable-line react-hooks/exhaustive-deps
}

export const UINode = React.memo(UINodeInner);
