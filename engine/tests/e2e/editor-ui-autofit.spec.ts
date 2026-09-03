/** #614 regression — `AutoFitText`'s DOM MEASUREMENT, not the pure `fitFontSizePx` decision
 *  (that has its own unit tests: `autoFitText.test.ts`).
 *
 *  `UIElement` authors `display: flex` (+ `alignItems: stretch`) on EVERY node, so the auto-fit
 *  span's own `display: inline-block` is virtually always a FLEX ITEM of its parent (the
 *  element's own div). That blockifies it to `block` and stretches it to the parent's cross
 *  size, so an unfixed `getBoundingClientRect().width` reads the parent's AVAILABLE width, not
 *  the span's natural single-line width — the fit always concludes "it fits" and leaves a
 *  `white-space: nowrap` label overflowing its box. jsdom reports every rect as 0×0, so this
 *  class of bug is invisible to vitest by construction (see `autoFitText.ts`'s own header) and
 *  can only be caught in a real browser — hence this spec, not another unit test.
 *
 *  Both cases use the `e2e-smoke` fixture's `AutoFitOff`/`AutoFitOn` entities: same 42px
 *  `fontSize` and text as the live measurement that found this bug (#614: "UI TEXT ANIMATION"),
 *  differing only in `UIElement.autoFitText` and the box width (each chosen for what that case
 *  needs to demonstrate — see the fixture). Their parent (each entity's own div) is `display:
 *  flex` by the SAME default every other UIElement node carries — nothing special is authored to
 *  reproduce the bug.
 *
 *  ⚠️ `AutoFitOn`'s `letterSpacing: 3` (px) is LOAD-BEARING, not decoration (#614 follow-up). A
 *  px `letterSpacing` makes the label's width function AFFINE (width = k*fontSize + c) instead of
 *  proportional — the shrink-to-fit model in `fitFontSizePx` assumes proportional (passes through
 *  the origin) and OVER-estimates the fitting size whenever that intercept is non-zero. Without
 *  `letterSpacing` here, the fixture's width function has intercept 0, the proportional model is
 *  exact, and this spec would pass even with the one-shot (unrefined) estimate — which is exactly
 *  why the original bug reached a live editor instead of failing here first. Do not remove it, and
 *  do not "clean up" this fixture back toward a bare label.
 *
 *  A THIRD, separate bug (also #614 follow-up): `availablePx` used to be read AFTER the
 *  `max-content` scaffold above wrote to the span, which is fine for `AutoFitOn` (a FIXED-width
 *  parent) but contaminates a CONTENT-SIZED one — `UIElement.width` defaults to 0/auto, so that
 *  is the common case, not an edge case. `AutoFitContentParent`/`AutoFitContentSizedOff`/
 *  `AutoFitContentSizedOn` reproduce it: the parent is fixed-width, but each LABEL is the
 *  content-sized one (`alignSelf:'center'` opts a flex child out of the parent's default
 *  `alignItems:'stretch'`), so the span's own immediate parent — the label's own div — is what
 *  goes content-sized, one level down from `AutoFitOn`'s case. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene, switchToUIMode, idByName, SCENE } from './helpers';

const AUTHORED_FONT_SIZE_PX = 42;

test.describe('AutoFitText (#614)', () => {
  test('autoFitText: false wraps a too-long label onto multiple lines (baseline)', async ({ page }) => {
    await gotoEditorWithScene(page, SCENE, 'AutoFitOff');
    await switchToUIMode(page);
    const id = await idByName(page, 'AutoFitOff');
    const box = page.locator(`[data-ui-preview-frame] [data-entity-id="${id}"]`);
    await box.waitFor({ state: 'visible', timeout: 10_000 });

    const rect = await box.boundingBox();
    if (!rect) throw new Error('AutoFitOff box has no bounding box');

    // No shrink happens here (autoFitText is off), so the label wraps at the full authored
    // 42px size — the box grows well past a generous single-line ceiling (1.8x the font size,
    // comfortably above the ~1.2x a normal line-height renders at).
    expect(rect.height).toBeGreaterThan(AUTHORED_FONT_SIZE_PX * 1.8);
  });

  test('autoFitText: true shrinks the font to fit on one line, with no overflow', async ({ page }) => {
    await gotoEditorWithScene(page, SCENE, 'AutoFitOn');
    await switchToUIMode(page);
    const id = await idByName(page, 'AutoFitOn');
    const box = page.locator(`[data-ui-preview-frame] [data-entity-id="${id}"]`);
    await box.waitFor({ state: 'visible', timeout: 10_000 });
    // The AutoFitText span is the entity div's only child (no nested UI children in the fixture).
    const span = box.locator('span');
    await span.waitFor({ state: 'visible', timeout: 10_000 });

    const [fontSizePx, boxHeight, fits] = await Promise.all([
      span.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      box.evaluate((el) => el.getBoundingClientRect().height),
      // The distinguishing assertion: "shrank correctly" vs. "left a nowrap line hanging out of
      // its box" both can leave SOME shrink on the font-size below — only the overflow check
      // tells them apart. +1 for sub-pixel rounding (scrollWidth/clientWidth are integer-rounded
      // DOM properties over a sub-pixel-precise render, so a converged fit can round either side
      // by up to ~1px with nothing actually overflowing on screen).
      span.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ]);

    // Pre-fix, `naturalPx` was measured as the parent's stretched (available) width, so
    // `fitFontSizePx` always concluded "it fits" and never shrank — font-size stayed at the
    // authored 42px and the span overflowed its box (this is the exact assertion the bug fails).
    expect(fontSizePx).toBeLessThan(AUTHORED_FONT_SIZE_PX);
    // Back to one line, not the multi-line wrap the baseline test above measures.
    expect(boxHeight).toBeLessThan(fontSizePx * 1.8);
    expect(fits).toBe(true);
  });

  // FIX 3 (follow-up review) — `availablePx` used to be read AFTER the `max-content` scaffold
  // that unstretches the span from a flex-stretch parent. `UIElement.width` defaults to 0
  // (auto), so a CONTENT-SIZED parent is the DEFAULT case, not an exotic one — and that same
  // scaffold, applied to a content-sized parent, inflates ITS width to the text's own natural
  // width one level up. `naturalPx` then equals the contaminated `availablePx` by construction,
  // the fit always concludes "it fits", and the label never shrinks — worse than `autoFitText:
  // false`, which at least wraps within the box. `AutoFitContentParent` (fixed 340px, the
  // fixture's default `flexDirection:'column'`/`alignItems:'stretch'`) holds two children at
  // `alignSelf:'center'` — the one override that makes a child SIZE TO ITS CONTENT instead of
  // stretching to the parent's width, i.e. a content-sized parent for the AutoFitText span one
  // level down. Measured pre-fix: the shrunk-looking span still rendered 429px wide against a
  // 340px parent (44px past its right edge) at the full 42px authored size — the shrink never
  // engaged at all.
  test('autoFitText: true does not overflow a CONTENT-SIZED parent it would have wrapped inside', async ({ page }) => {
    await gotoEditorWithScene(page, SCENE, 'AutoFitContentSizedOn');
    await switchToUIMode(page);
    const parentId = await idByName(page, 'AutoFitContentParent');
    const offId = await idByName(page, 'AutoFitContentSizedOff');
    const onId = await idByName(page, 'AutoFitContentSizedOn');
    const parentBox = page.locator(`[data-ui-preview-frame] [data-entity-id="${parentId}"]`);
    const offBox = page.locator(`[data-ui-preview-frame] [data-entity-id="${offId}"]`);
    const onBox = page.locator(`[data-ui-preview-frame] [data-entity-id="${onId}"]`);
    await onBox.waitFor({ state: 'visible', timeout: 10_000 });

    const [parentRect, offRect, onRect, onFontSizePx] = await Promise.all([
      parentBox.boundingBox(),
      offBox.boundingBox(),
      onBox.boundingBox(),
      onBox.locator('span').evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ]);
    if (!parentRect || !offRect || !onRect) throw new Error('a box has no bounding box');

    // Baseline: autoFitText:false wraps the too-long label onto multiple lines WITHIN the
    // content-sized parent — it never extends past the 340px grandparent horizontally, because
    // normal (non-nowrap) text wraps to the available width instead of overflowing it.
    expect(offRect.x + offRect.width).toBeLessThanOrEqual(parentRect.x + parentRect.width + 2);
    expect(offRect.height).toBeGreaterThan(AUTHORED_FONT_SIZE_PX * 1.8); // multi-line

    // The regression: with the fix, the shrink actually engages (font size drops from the
    // authored 42px)...
    expect(onFontSizePx).toBeLessThan(AUTHORED_FONT_SIZE_PX);
    // ...and the shrunk label stays within the 340px grandparent — pre-fix this measured 429px
    // wide (44px past the right edge) at the FULL 42px size, because the contaminated
    // `availablePx` made the fit conclude "it fits" without ever shrinking.
    expect(onRect.x + onRect.width).toBeLessThanOrEqual(parentRect.x + parentRect.width + 2);
    // Back to one line, not the multi-line wrap the OFF case renders above.
    expect(onRect.height).toBeLessThan(onFontSizePx * 1.8);
  });
});
