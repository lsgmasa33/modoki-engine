/** #651 B2 — the seam that let a `uiScale`-dependent resize regression ship through a full
 *  green `npm run verify` plus a review pass, caught only by a browser measurement.
 *
 *  `uiResizeMath.test.ts` feeds hand-written numbers to `containingBlockSize`/`computeResize` —
 *  those pure functions were never the broken part. The bug lived entirely in
 *  `UIResizeOverlay.tsx`'s `handlePointerDown`, which mixed `getBoundingClientRect()` (post-
 *  transform SCREEN px) with `getComputedStyle` padding (pre-transform LAYOUT px) and then
 *  multiplied the result by a screen→logical scale factor — so the computed %-denominator was
 *  correct ONLY at `uiScale === 1.0`. `UIResizeOverlay.test.tsx` never enters `handlePointerDown`
 *  at all (its fixture's entity has `parentId: 0`, so no parent element mounts), and even if it
 *  did, jsdom has no layout engine — `getBoundingClientRect`/`getComputedStyle` are all zeros
 *  there, so a scale-mixing bug is invisible BY CONSTRUCTION. Only a real browser, with a real
 *  CSS `transform: scale()` on the preview frame and a `uiScale` that actually differs from 1,
 *  can see this — which is exactly what this spec forces.
 *
 *  ⚠️ **#651 B2 follow-up**: the fix above divided out the preview FRAME's own `uiScale` but
 *  missed a SECOND, independent transform — `applyRotationStyle` (anchorCss.ts) also emits
 *  `transform: scale(s)` on any node whose `UIElement.scale !== 1`. `clientWidth`/`offsetWidth`
 *  never see that (transforms don't affect layout); `getBoundingClientRect()` does. The
 *  `ScaledParent`/`ScaledPercentChild` test below (its OWN fixture,
 *  `e2e-ui-resize-entity-scale.scene.json`) is the dedicated regression for THIS bug — the
 *  ORIGINAL test above never exercises it, because `PaddedParent` carries no `UIElement.scale`
 *  of its own.
 *
 *  `e2e-ui-resize-scale.scene.json`:
 *  - `PaddedParent` (200×150px, 60px left/right padding, 5px border) with a `%`-sized in-flow
 *    child (`PercentChild`, 50% width) — the parent's padding+border is what makes the content-box
 *    denominator (the correct %-basis) diverge sharply from the parent's border-box size (what a
 *    scale-mixing bug corrupts it towards).
 *  - `AnchoredPercentChild`, also parented to `PaddedParent` but carrying a `UIAnchor` (anchor
 *    `bottom-right`, so it can't sit over `PercentChild` and steal its click) — resolves against
 *    the parent's PADDING box (`containingBlockSize`'s OTHER branch, and the box
 *    `paddingBoxRect`'s anchor-reference diamond is drawn against), which `PercentChild` alone
 *    never exercises (it has no `UIAnchor`).
 *
 *  `e2e-ui-resize-entity-scale.scene.json` (its OWN fixture — kept separate so its scaled render
 *  can't overlap anything above): `ScaledParent` (`UIElement.scale: 2`) with three in-flow
 *  children — `%`-sized `ScaledPercentChild`, `px`-sized `ScaledPxChild`, and auto-sized (`width:0`)
 *  `ScaledAutoPxChild` — the SECOND-transform case, covering the unit whose denominator happens to
 *  cancel the ancestor scale (`%`), the one whose branch never divides it out at all (`px`, #651 B2
 *  second follow-up), and that same `px` branch's AUTO-SIZE base, which needs its own division on
 *  top of `dx`'s (#651 B2 — the auto-sized px base — `ScaledAutoPxChild` sets `alignSelf: 'flex-start'` so it does not
 *  stretch to the parent's full width, and `minWidth: 100` so its auto/min-content width is a
 *  known, non-zero layout size to drag from).
 *
 *  The first test forces a non-1 `uiScale` WITHOUT a device preset (no need for the GameView panel
 *  to be mounted — `setGameViewSize` is a plain store write and `UIEditorOverlay` reads
 *  `gameViewSize` directly): the SceneView panel's letterboxed frame width (`bounds.w` in
 *  `useLetterboxBounds`) depends only on the panel's own on-screen size and the store's default
 *  `gameRect` aspect (800×450) — NOT on `gameViewSize` — so requesting a logical device width
 *  that is some multiple of the frame's CURRENT on-screen width changes `uiScale` by exactly the
 *  inverse of that multiple, deterministically, regardless of how wide the panel happens to be in
 *  this environment. The test still asserts `uiScale !== 1` from a live DOM measurement — a hard
 *  failure, not a comment — so a setup that silently no-ops cannot pass by accident. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene, switchToUIMode, idByName, selectedName, stableBoundingBox, waitForFrames, traitField } from './helpers';

const SCENE_UI_RESIZE_SCALE = '/tests/e2e/fixtures/e2e-ui-resize-scale.scene.json';
const SCENE_UI_RESIZE_ENTITY_SCALE = '/tests/e2e/fixtures/e2e-ui-resize-entity-scale.scene.json';

// How far off 1.0 `uiScale` must land for this spec to trust it is actually exercising the
// scale-mixing seam (not a setup that landed on ~1.0 by coincidence).
const MIN_SCALE_DEVIATION = 0.15;

// The screen-space (CSS px) distance to drag the resize handle. Chosen well clear of both the
// handle's own on-screen size (a few px at the `uiScale` this spec forces) and of measurement
// noise, so a round-trip failure reads as a large, unambiguous gap rather than a coin flip.
const DRAG_PX = 40;

// A round-trip is "close enough" once it is CSS-rounding-close (a few px) — the bug this spec
// guards inflates the rendered delta by roughly 4x (see the header comment's worked numbers), so
// this tolerance is nowhere near the failure signature.
const TOLERANCE_PX = 8;

test('UI mode: dragging a %-child resize handle at non-1 uiScale renders the size actually dragged to (#651 B2)', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE_UI_RESIZE_SCALE, 'PercentChild');
  await switchToUIMode(page);

  const frame = page.locator('[data-ui-preview-frame]');
  const frameBoxBefore = await stableBoundingBox(frame);

  // Force a non-1 uiScale: request a logical device width 1.5x the frame's CURRENT on-screen
  // width. `bounds.w` (the frame's actual on-screen size) does not depend on gameViewSize — only
  // on the panel's own size and the store's default gameRect aspect — so this changes ONLY
  // uiScale (= bounds.w / gameViewSize.width), predictably to ~1/1.5 ≈ 0.667, whatever this
  // environment's panel width happens to be. No device preset / GameView panel needed:
  // setGameViewSize is a plain store write that UIEditorOverlay reads directly.
  const deviceW = Math.round(frameBoxBefore.width * 1.5);
  const deviceH = Math.round(deviceW * 450 / 800); // matches the store's default gameRect aspect
  await page.evaluate(({ w, h }) => {
    (window as any).__modokiEditorTest.store.getState().setGameViewSize(w, h);
  }, { w: deviceW, h: deviceH });
  await waitForFrames(page, 3); // let the rAF-deferred overlay/letterbox updates settle

  const frameBoxAfter = await stableBoundingBox(frame);
  const uiScale = frameBoxAfter.width / deviceW;
  expect(
    Math.abs(uiScale - 1),
    `setGameViewSize(${deviceW}, ${deviceH}) did not move uiScale away from 1.0 (measured ` +
    `${uiScale.toFixed(3)} from frame width ${frameBoxAfter.width}px / device width ${deviceW}px) ` +
    `— this spec tests nothing until uiScale actually differs from 1.`,
  ).toBeGreaterThan(MIN_SCALE_DEVIATION);

  // Select the %-sized child so its UIResizeOverlay (and resize handles) mount.
  const childId = await idByName(page, 'PercentChild');
  const child = page.locator(`[data-ui-preview-frame] [data-entity-id="${childId}"]`);
  await child.click();
  await expect.poll(() => selectedName(page)).toBe('PercentChild');
  await waitForFrames(page, 3); // let the resize overlay mount + measure before grabbing a handle

  // The 'resize-r' handle sits at the entity's on-screen (fx=1, fy=0.5) point — mid-right edge —
  // per UIResizeOverlay's `registerHandleProvider` (er.left+er.width*fx, er.top+er.height*fy),
  // which reads the SAME getBoundingClientRect() this locator does. Only width is affected by
  // this handle (edges='r'), so the parent's (untouched) height plays no part in the math below.
  const childBoxBefore = await stableBoundingBox(child);
  const handleX = childBoxBefore.x + childBoxBefore.width;
  const handleY = childBoxBefore.y + childBoxBefore.height / 2;

  // Driven via real window-level pointer events, exactly as a user would (handlePointerDown
  // attaches window listeners, not handle-div-local ones — see its own comment on why).
  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX + DRAG_PX, handleY, { steps: 8 });
  await page.mouse.up();

  const childBoxAfter = await stableBoundingBox(child);
  const actualDeltaPx = childBoxAfter.width - childBoxBefore.width;

  expect(actualDeltaPx).toBeGreaterThan(0); // sanity: the drag grew it at all
  expect(
    Math.abs(actualDeltaPx - DRAG_PX),
    `dragged the resize-r handle by ${DRAG_PX}px (screen) at uiScale=${uiScale.toFixed(3)}, but ` +
    `the child's rendered width changed by ${actualDeltaPx.toFixed(1)}px — expected ~${DRAG_PX}px. ` +
    `A denominator computed from the wrong box (or the wrong px/screen space) reproduces at ` +
    `uiScale===1 and only shows up once uiScale genuinely differs from 1, which this spec forces.`,
  ).toBeLessThan(TOLERANCE_PX);

  // The screen-delta check above would ALSO pass for a `px`-unit child — computeResize's `px`
  // branch never reads the denominator at all, so it can't tell "the %-math is right" from "the
  // field silently stopped being a %". Assert directly on the stored trait: still `%`, and the
  // %-VALUE itself grew by roughly the delta the fixed denominator predicts (PaddedParent's
  // content-box: 200 - 2*60(padding) - 2*5(border) = 70px; PaddedParent carries no `UIElement.scale`
  // of its own, so the ancestor-scale factor is 1 here and this is pure #651 B2 math).
  const widthUnitAfter = await traitField(page, childId!, 'UIElement', 'widthUnit');
  const widthAfter = await traitField(page, childId!, 'UIElement', 'width') as number;
  expect(widthUnitAfter).toBe('%');
  const PARENT_CONTENT_WIDTH = 70;
  const expectedWidthAfter = 50 + (DRAG_PX / uiScale / PARENT_CONTENT_WIDTH) * 100;
  expect(
    Math.abs(widthAfter - expectedWidthAfter),
    `widthUnit stayed '%' (good) but width=${widthAfter}% — expected roughly ${expectedWidthAfter.toFixed(1)}% ` +
    `(50 + a ${DRAG_PX}px drag / uiScale ${uiScale.toFixed(3)} against the ${PARENT_CONTENT_WIDTH}px content-box ` +
    `denominator). A regression that turned the %-path into a no-op could still pass the on-screen ` +
    `check above by accident (e.g. a px-unit fallback); this pins the stored value too.`,
  ).toBeLessThan(15); // generous: CSS/measurement rounding, nowhere near "the field didn't move"
});

test('UI mode: an ANCHORED %-child resolves against the parent\'s PADDING box, and its diamond renders there (#651 B2 follow-up — paddingBoxRect had no consumer test)', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE_UI_RESIZE_SCALE, 'AnchoredPercentChild');
  await switchToUIMode(page);

  const parentId = await idByName(page, 'PaddedParent');
  const parent = page.locator(`[data-ui-preview-frame] [data-entity-id="${parentId}"]`);
  const parentBox = await stableBoundingBox(parent);

  const childId = await idByName(page, 'AnchoredPercentChild');
  const child = page.locator(`[data-ui-preview-frame] [data-entity-id="${childId}"]`);
  await child.click();
  await expect.poll(() => selectedName(page)).toBe('AnchoredPercentChild');
  await waitForFrames(page, 3);

  // The diamond (anchorRef for 'bottom-right' → fx=fy=1) must sit at the parent's PADDING-box
  // bottom-right corner — inset FROM the border-box corner by the parent's border (5 logical
  // px, scaled to screen the same way every other length here is) — never at the raw
  // border-box corner itself. (Anchored 'top-left', tried first, sat directly over
  // `PercentChild` and stole its click — this corner keeps the two apart.) `PercentChild` (used
  // by the test above) carries no `UIAnchor`, so it never mounts this diamond at all; this is
  // the first test in this file to select an entity that IS anchored against `PaddedParent`.
  const diamond = page.locator('[data-testid="ui-resize-anchor-diamond"]');
  const diamondBox = await stableBoundingBox(diamond);
  const diamondCenterX = diamondBox.x + diamondBox.width / 2;
  const diamondCenterY = diamondBox.y + diamondBox.height / 2;
  const borderPx = 5 * (parentBox.width / 200); // PaddedParent's authored border is 5, width 200
  const expectedX = parentBox.x + parentBox.width - borderPx;
  const expectedY = parentBox.y + parentBox.height - borderPx;

  expect(Math.abs(diamondCenterX - expectedX)).toBeLessThan(2);
  expect(Math.abs(diamondCenterY - expectedY)).toBeLessThan(2);
  // Sanity: must NOT coincide with the border-box corner itself — a dead border inset would
  // still pass the checks above if it silently fell back to 0, so rule that out directly.
  expect(Math.abs(diamondCenterX - (parentBox.x + parentBox.width))).toBeGreaterThan(2);

  // Drag its 'resize-r' handle — exercises `computeResize` fed the 'padding'-mode denominator
  // (`containingBlockSize`'s branch `PercentChild`'s in-flow test never reaches), with the same
  // round-trip correctness check as the test above.
  //
  // ⚠️ `AnchoredPercentChild`'s fixture height (120) is deliberately tall: any freely-movable
  // anchored entity (`anchorDragAxes` — any non-stretch corner, `bottom-right` included) also
  // renders a move-arrow pair (UIResizeOverlay's `showDragArrows`) at a FIXED size (40px reach,
  // 18px wide) centered on the SAME pivot corner as the resize handles. On a short entity the
  // corner arrow's hit-box swallows the mid-edge resize handles entirely — mousedown here landed
  // on the vertical arrow (`move-y`) instead of `resize-r` at height 30, a real, pre-existing
  // overlay characteristic unrelated to this fix. 120px puts `resize-r` (at height/2 from the
  // corner) outside the arrow's 40px reach with margin.
  const childBoxBefore = await stableBoundingBox(child);
  const handleX = childBoxBefore.x + childBoxBefore.width;
  const handleY = childBoxBefore.y + childBoxBefore.height / 2;
  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX + DRAG_PX, handleY, { steps: 8 });
  await page.mouse.up();

  const childBoxAfter = await stableBoundingBox(child);
  const actualDeltaPx = childBoxAfter.width - childBoxBefore.width;
  expect(actualDeltaPx).toBeGreaterThan(0);
  expect(Math.abs(actualDeltaPx - DRAG_PX)).toBeLessThan(TOLERANCE_PX);
  expect(await traitField(page, childId!, 'UIElement', 'widthUnit')).toBe('%');
});

test('UI mode: a %-child of a SCALED parent (UIElement.scale) renders at the dragged size, not overshot by the parent\'s scale (#651 B2 follow-up — the SECOND transform)', async ({ page }) => {
  // Its OWN fixture (just ScaledParent + ScaledPercentChild) — kept isolated from the other
  // entities above so ScaledParent's own `scale: 2` render can't visually overlap (and steal
  // clicks from) anything else on the page, the way an earlier draft of this fixture did.
  await gotoEditorWithScene(page, SCENE_UI_RESIZE_ENTITY_SCALE, 'ScaledPercentChild');
  await switchToUIMode(page);

  // `ScaledParent` carries `UIElement.scale: 2` — the transform `applyRotationStyle` emits
  // independently of the preview frame's own `uiScale`, which the original #651 B2 fix never
  // accounted for. No `setGameViewSize` forcing needed here: this bug reproduces regardless of
  // the frame's own scale (the ancestor-scale factor this fix recovers is independent of it —
  // see `accumulateAncestorScale`'s unit tests), so the DEFAULT frame scale already exercises it.
  const childId = await idByName(page, 'ScaledPercentChild');
  const child = page.locator(`[data-ui-preview-frame] [data-entity-id="${childId}"]`);
  await child.click();
  await expect.poll(() => selectedName(page)).toBe('ScaledPercentChild');
  await waitForFrames(page, 3);

  const childBoxBefore = await stableBoundingBox(child);
  const handleX = childBoxBefore.x + childBoxBefore.width;
  const handleY = childBoxBefore.y + childBoxBefore.height / 2;

  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX + DRAG_PX, handleY, { steps: 8 });
  await page.mouse.up();

  const childBoxAfter = await stableBoundingBox(child);
  const actualDeltaPx = childBoxAfter.width - childBoxBefore.width;

  expect(actualDeltaPx).toBeGreaterThan(0);
  expect(
    Math.abs(actualDeltaPx - DRAG_PX),
    `ScaledParent carries UIElement.scale=2 — the SECOND transform this bug is about (the ` +
    `original #651 B2 fix only divided out the preview FRAME's own uiScale). Dragging ${DRAG_PX}px ` +
    `rendered a ${actualDeltaPx.toFixed(1)}px change; the unfixed formula overshoots by roughly ` +
    `the parent's OWN scale factor on top of DRAG_PX (measured during this fix: an 80px render ` +
    `for a 40px drag under scale:2).`,
  ).toBeLessThan(TOLERANCE_PX);
  expect(await traitField(page, childId!, 'UIElement', 'widthUnit')).toBe('%');
});

test('UI mode: a PX-child of a SCALED parent (UIElement.scale) renders at the dragged size, not overshot by the parent\'s scale (#651 B2 second follow-up — the non-% units)', async ({ page }) => {
  // Same fixture/parent as the `%`-child test above (`ScaledParent`, `UIElement.scale: 2`), but
  // `ScaledPxChild` is `px`-unit. The `%` test above already proved the denominator math right —
  // it survives this bug BY ACCIDENT, because its denominator (`parentComputedSize`) is scaled by
  // the SAME ancestor factor as the numerator, so the ratio cancels. `computeResize`'s `px`
  // branch has no such denominator: `dx` alone reaches `baseW + dx` unmodified, so under
  // `ScaledParent`'s `scale: 2` a `DRAG_PX` screen-px drag rendered roughly `2 * DRAG_PX` before
  // this fix (see uiResizeMath.ts's `computeResize` doc comment).
  await gotoEditorWithScene(page, SCENE_UI_RESIZE_ENTITY_SCALE, 'ScaledPxChild');
  await switchToUIMode(page);

  const childId = await idByName(page, 'ScaledPxChild');
  const child = page.locator(`[data-ui-preview-frame] [data-entity-id="${childId}"]`);
  await child.click();
  await expect.poll(() => selectedName(page)).toBe('ScaledPxChild');
  await waitForFrames(page, 3);

  const childBoxBefore = await stableBoundingBox(child);
  const handleX = childBoxBefore.x + childBoxBefore.width;
  const handleY = childBoxBefore.y + childBoxBefore.height / 2;

  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX + DRAG_PX, handleY, { steps: 8 });
  await page.mouse.up();

  const childBoxAfter = await stableBoundingBox(child);
  const actualDeltaPx = childBoxAfter.width - childBoxBefore.width;

  expect(actualDeltaPx).toBeGreaterThan(0);
  expect(
    Math.abs(actualDeltaPx - DRAG_PX),
    `ScaledParent carries UIElement.scale=2 — computeResize's PX branch (uiResizeMath.ts) never ` +
    `divides dx by the ancestor's own scale before this fix. Dragging ${DRAG_PX}px rendered a ` +
    `${actualDeltaPx.toFixed(1)}px change; the unfixed formula overshoots by roughly the parent's ` +
    `OWN scale factor on top of DRAG_PX, mirroring the %-child test above but through the branch ` +
    `that test can't reach.`,
  ).toBeLessThan(TOLERANCE_PX);
  expect(await traitField(page, childId!, 'UIElement', 'widthUnit')).toBe('px');
});

test('UI mode: an AUTO-SIZED (0-width) px child of a SCALED parent resizes correctly — the measured-base double-count (#651 B2 — the auto-sized px base)', async ({ page }) => {
  // Same fixture/parent as the two tests above (`ScaledParent`, `UIElement.scale: 2`), but
  // `ScaledAutoPxChild` is `px`-unit AND auto-sized (`width: 0`, floored to a 100-layout-px
  // min-content box by `minWidth: 100` + `alignSelf: 'flex-start'` so it does not stretch to
  // fill the parent). The `ScaledPxChild` test above proves computeResize's `px` branch divides
  // `dx` by the ancestor scale; it does NOT prove the auto-size BASE (`computed.width`, which
  // `UIResizeOverlay` measures into the SAME ancestor-inflated space as `dx`) gets the same
  // treatment — `baseW` fell back to that inflated `computed.width` UNDIVIDED before this fix,
  // so the written width double-counted the ancestor scale (measured: a 40px drag wrote 220
  // instead of 120 for a 100-layout-px base under scale:2 — see uiResizeMath.ts's `computeResize`
  // doc comment). The render round-trip below catches it the same way the tests above do: the
  // bug's extra `100 * ancestorScale` term shows up as a large screen-space overshoot, not just
  // a wrong stored number.
  await gotoEditorWithScene(page, SCENE_UI_RESIZE_ENTITY_SCALE, 'ScaledAutoPxChild');
  await switchToUIMode(page);

  const childId = await idByName(page, 'ScaledAutoPxChild');
  const child = page.locator(`[data-ui-preview-frame] [data-entity-id="${childId}"]`);
  await child.click();
  await expect.poll(() => selectedName(page)).toBe('ScaledAutoPxChild');
  await waitForFrames(page, 3);

  const childBoxBefore = await stableBoundingBox(child);
  const handleX = childBoxBefore.x + childBoxBefore.width;
  const handleY = childBoxBefore.y + childBoxBefore.height / 2;

  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX + DRAG_PX, handleY, { steps: 8 });
  await page.mouse.up();

  const childBoxAfter = await stableBoundingBox(child);
  const actualDeltaPx = childBoxAfter.width - childBoxBefore.width;

  expect(actualDeltaPx).toBeGreaterThan(0);
  expect(
    Math.abs(actualDeltaPx - DRAG_PX),
    `ScaledAutoPxChild starts auto-sized (width:0, floored by minWidth:100) under ` +
    `ScaledParent's scale:2. Dragging ${DRAG_PX}px rendered a ${actualDeltaPx.toFixed(1)}px ` +
    `change; the unfixed formula double-counts the ancestor scale into the auto-size BASE (not ` +
    `just dx), overshooting by roughly the parent's OWN scale factor times the base size.`,
  ).toBeLessThan(TOLERANCE_PX);
  expect(await traitField(page, childId!, 'UIElement', 'widthUnit')).toBe('px');
  // Sanity: the field actually left 'auto' (0) — a formula that silently no-oped could still
  // pass the screen-delta check by accident if the box never actually re-measured.
  expect(await traitField(page, childId!, 'UIElement', 'width') as number).toBeGreaterThan(0);
});

test('UI mode: a %-child of a ROTATED (not scaled) parent resolves the SAME %-denominator as an unrotated one — decomposeScale against a REAL browser transform matrix (#651 B2 third follow-up — the rotation regression)', async ({ page }) => {
  // `RotatedParent` (80×60, `UIElement.rotation: 15`, no `scale`) is the browser-level guard the
  // rotation regression itself never got: `dcd4506d3` fixed `decomposeScale`/`accumulateAncestorScale`
  // to read the ancestor's CSS transform MATRIX, replacing the `getBoundingClientRect()`-ratio
  // approach that broke under rotation — but every consumer of that fix (`uiResizeMath.test.ts`)
  // feeds it HAND-WRITTEN matrix strings, and `measureAncestorScale` (UIResizeOverlay.tsx), the one
  // thing that reads `getComputedStyle(node).transform` off a REAL rotated DOM node, had zero
  // callers in `engine/tests/e2e/**`. A hand-written matrix string cannot reproduce the original
  // bug (it was never wrong about DECOMPOSING a matrix — it was wrong about how the matrix was
  // RECOVERED from the DOM in the first place), so only a real browser rotating a real element can
  // catch a regression here.
  //
  // 80×60 keeps the SAME 4:3 aspect ratio as the doc's measured 200×150 case (`docs/editor.md`'s
  // seam section, `dcd4506d3`'s commit message) — the pre-fix `ancestorScaleRatio(screenSize,
  // layoutSize, frameScaleAxis)` ratio is `getBoundingClientRect().width / offsetWidth`, which
  // depends only on aspect ratio + rotation angle, not absolute size, so this reproduces the exact
  // same wrong 1.160/1.311 (X/Y) the doc measured at rotation 15° — hence "15 is the measured case".
  // Positioned at `left: 270` (not `center`, `RotatedParent`'s own default) purely so its ~93×79
  // on-screen AABB (80×60 rotated 15°) can't overlap `ScaledParent`'s footprint in the SAME fixture
  // file (`ScaledParent` at `scale: 2` occupies roughly the frame's x:[200,600] — see that fixture).
  //
  // What this asserts, and why NOT the on-screen pixel round-trip the other tests in this file use:
  // `RotatedPercentChild` itself carries no rotation — only its ANCESTOR does — so growing its
  // WIDTH is still a straight horizontal drag in the element's own (unrotated) local space. But
  // `toLogicalDelta` (UIResizeOverlay.tsx) never projects the screen-space drag onto that local
  // axis, and the CHILD's own on-screen `getBoundingClientRect()` is itself an AABB once its
  // rotated ancestor is in the paint chain — so the RENDERED pixel delta for this drag is not a
  // clean 1:1 readout of the stored value even with a fully correct `ancestorScale` (a real, still
  // outstanding limitation — see docs/editor.md's seam section). Asserting the STORED `%` value
  // instead sidesteps that confound entirely and isolates exactly the thing this fixture exists to
  // guard: whether the recovered ancestor scale (the %-denominator, `parentComputedSize.width` in
  // `handlePointerDown`) is 1 (correct — a pure rotation carries no scale) or ~1.160 (the old,
  // wrong AABB ratio).
  await gotoEditorWithScene(page, SCENE_UI_RESIZE_ENTITY_SCALE, 'RotatedPercentChild');
  await switchToUIMode(page);

  const childId = await idByName(page, 'RotatedPercentChild');
  const child = page.locator(`[data-ui-preview-frame] [data-entity-id="${childId}"]`);
  await child.click();
  await expect.poll(() => selectedName(page)).toBe('RotatedPercentChild');
  await waitForFrames(page, 3);

  // uiScale (the FRAME's own, unrelated transform) is measured rather than assumed ~1 — the %
  // math divides it out via `toLogicalDelta`, so the predicted width below must account for
  // whatever it actually is in this environment.
  const frame = page.locator('[data-ui-preview-frame]');
  const frameBox = await stableBoundingBox(frame);
  const gameViewSize = await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().gameViewSize);
  const uiScale = frameBox.width / gameViewSize.width;

  const childBoxBefore = await stableBoundingBox(child);
  const handleX = childBoxBefore.x + childBoxBefore.width;
  const handleY = childBoxBefore.y + childBoxBefore.height / 2;
  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX + DRAG_PX, handleY, { steps: 8 });
  await page.mouse.up();

  const widthUnitAfter = await traitField(page, childId!, 'UIElement', 'widthUnit');
  const widthAfter = await traitField(page, childId!, 'UIElement', 'width') as number;
  expect(widthUnitAfter).toBe('%');

  // RotatedParent's authored width (80) IS its %-denominator here (no padding/border, in-flow
  // child → 'content' mode) whether or not the ancestor is rotated — a pure `rotate()` carries NO
  // scale, so a correct `ancestorScaleX` is exactly 1 and the denominator is untouched by rotation.
  // The old `getBoundingClientRect()`-ratio bug recovered ~1.160 instead (see header comment),
  // inflating the denominator and undershooting this increment by ~13.8% — a gap tied to the
  // ratio's OWN error, not to `uiScale` or `DRAG_PX`, so a RELATIVE tolerance is what actually
  // discriminates regardless of this environment's frame size.
  const RotatedParentWidth = 80;
  const expectedIncrement = (DRAG_PX / uiScale / RotatedParentWidth) * 100;
  const expectedWidthAfter = 50 + expectedIncrement;
  const relDiff = Math.abs(widthAfter - expectedWidthAfter) / expectedIncrement;
  expect(
    relDiff,
    `RotatedParent carries UIElement.rotation=15 and NO scale — a correct ancestor-scale recovery ` +
    `(decomposeScale of a pure rotate() matrix) is exactly 1, so this %-drag should land at ` +
    `~${expectedWidthAfter.toFixed(2)}%. Measured ${widthAfter}% (${(relDiff * 100).toFixed(1)}% off ` +
    `the predicted increment) — the old getBoundingClientRect()-ratio approach recovers ~1.160 for a ` +
    `15°-rotated 4:3 box instead of 1, undershooting this same increment by ~13.8%.`,
  ).toBeLessThan(0.05);
});
