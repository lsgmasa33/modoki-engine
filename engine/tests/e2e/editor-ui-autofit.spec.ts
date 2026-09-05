/** #614 regression — `AutoFitText`'s DOM MEASUREMENT, not the pure `fitFontSizePx` decision
 *  (that has its own unit tests: `autoFitText.test.ts`).
 *
 *  `UIElement` authors `display: flex` (+ `alignItems: stretch`) on EVERY node, so the auto-fit
 *  span (its own authored `display: block`, #646) is virtually always a FLEX ITEM of its parent
 *  (the element's own div). The default `align-items: stretch` then stretches it to the
 *  parent's cross size, so an unfixed `getBoundingClientRect().width` reads the parent's
 *  AVAILABLE width, not the span's natural single-line width — the fit always concludes "it
 *  fits" and leaves a `white-space: nowrap` label overflowing its box. jsdom reports every rect
 *  as 0×0, so this class of bug is invisible to vitest by construction (see `autoFitText.ts`'s
 *  own header) and can only be caught in a real browser — hence this spec, not another unit
 *  test. (The `#646` describe block below tests a SEPARATE bug found alongside this one: the
 *  span's display also decides whether `maxLines` can clamp it at all — see its own comment.)
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
import { gotoEditorWithScene, switchToUIMode, idByName, SCENE, stableBoundingBox, waitForFrames } from './helpers';

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

test.describe('AutoFitText + UIElement.maxLines (#646)', () => {
  // `MaxLinesAutoFit`: `fontSizeMin` == the authored `fontSize`, so `resolveMinPx` returns the
  // authored size and NO shrink is possible — `fitFontSizePx` floors at the authored size and
  // reports `fits: false`, landing the span in the `pre-wrap` fallback exactly as the module
  // header describes: "at the fontSizeMin floor, the existing maxLines/textOverflow behaviour
  // takes over". A 160px box can't fit "UI TEXT ANIMATION" at 42px on one line, so this is
  // precisely the state #646 measured live: the host div's `maxLines: 1` branch sets
  // `display: '-webkit-box'` + `-webkit-line-clamp: 1`, and (pre-fix) the AutoFitText span's own
  // `display: inline-block` made it an ATOMIC inline-level box the clamp mechanism cannot split
  // into lines, so nothing constrained the height — only `overflow: hidden` on a box whose
  // height had collapsed, rendering a ~12px sliver with 87px of text clipped away instead of one
  // clamped ~48px line.
  test('maxLines: 1 clamps to ONE LINE, not a sliver, when the label is an AutoFitText span', async ({ page }) => {
    await gotoEditorWithScene(page, SCENE, 'MaxLinesAutoFit');
    await switchToUIMode(page);
    const id = await idByName(page, 'MaxLinesAutoFit');
    const box = page.locator(`[data-ui-preview-frame] [data-entity-id="${id}"]`);
    await box.waitFor({ state: 'visible', timeout: 10_000 });
    const span = box.locator('span');
    await span.waitFor({ state: 'visible', timeout: 10_000 });

    const [boxHeight, spanDisplay, spanScrollHeight] = await Promise.all([
      box.evaluate((el) => el.getBoundingClientRect().height),
      span.evaluate((el) => getComputedStyle(el).display),
      span.evaluate((el) => el.scrollHeight),
    ]);

    // The sliver bug: pre-fix this measured ~12px, with `scrollHeight` (the full unclamped
    // text) at ~99px — over 8x taller than what rendered. A real clamped line at 42px is
    // comfortably above half the font size; the sliver is comfortably below it.
    expect(boxHeight).toBeGreaterThan(AUTHORED_FONT_SIZE_PX * 0.8);
    // One line, not the ~96-99px two-line wrap an INERT clamp would let through.
    expect(boxHeight).toBeLessThan(AUTHORED_FONT_SIZE_PX * 1.8);
    // The mechanism this fix relies on: the `-webkit-box` clamp only clamps LINE BOXES, so the
    // span itself must compute as a real block, not an atomic inline-level box. (That clamp moved
    // off the host onto an inner wrapper in #655 — the host is a flex container again — but the
    // requirement on THIS span is unchanged, which is why the assertion below still reads the
    // same.)
    expect(spanDisplay).toBe('block');
    // Sanity: the text genuinely doesn't fit on one line at this width/size — scrollHeight
    // reports its full (unclamped) extent, which must be taller than what actually rendered.
    expect(spanScrollHeight).toBeGreaterThan(boxHeight);
  });

  // A sibling of the bug above, found sweeping for its PATTERN during close-out: `AnimatedText`
  // (the CSS text-animation span, distinct from `AutoFitText`) had the exact same
  // `display: 'inline-block'`, and it renders as the entity div's direct child too — so
  // `maxLines` is defeated identically when an entity carries BOTH a `TextAnimation` trait and
  // `maxLines`. `node.textAnim` (and therefore this span) only exists while the sim is running
  // (like skeletal animation — frozen/absent when Stopped), so this test presses the real
  // Play transport (`ControlOrMeta+p`, the same chord `EditorApp`'s `app.playPause` binds) to
  // reach it, rather than a shortcut that leaves `isSimRunning()` false.
  test('maxLines: 1 clamps to ONE LINE when the label carries a TextAnimation (AnimatedText sibling)', async ({ page }) => {
    await gotoEditorWithScene(page, SCENE, 'MaxLinesTextAnim');
    await switchToUIMode(page);
    const id = await idByName(page, 'MaxLinesTextAnim');
    const box = page.locator(`[data-ui-preview-frame] [data-entity-id="${id}"]`);
    await box.waitFor({ state: 'visible', timeout: 10_000 });

    // Enter Play so the TextAnimation trait populates `node.textAnim` and `AnimatedText` mounts.
    await page.keyboard.press('ControlOrMeta+p');
    const span = box.locator('span[style*="animation"]');
    await span.waitFor({ state: 'visible', timeout: 10_000 });

    const [boxHeight, spanDisplay] = await Promise.all([
      box.evaluate((el) => el.getBoundingClientRect().height),
      span.evaluate((el) => getComputedStyle(el).display),
    ]);

    expect(boxHeight).toBeGreaterThan(AUTHORED_FONT_SIZE_PX * 0.8);
    expect(boxHeight).toBeLessThan(AUTHORED_FONT_SIZE_PX * 1.8);
    expect(spanDisplay).toBe('block');
  });
});

test.describe('maxLines + textOverflow: clip (#656)', () => {
  // The gap #656 named: BOTH fixtures #646 added author `textOverflow: 'ellipsis'`, so they
  // agreed with the rendering by accident and nothing exercised the field's DEFAULT. `clip` was
  // unhonourable — `-webkit-line-clamp` paints its own ellipsis unconditionally and never
  // consults `text-overflow` — so an author who chose `clip`, or who never touched the field,
  // got an ellipsis they could not turn off. `demos/postfx-demo`'s Caption is a live instance.
  //
  // This is the measurement #656 itself used, inverted: pre-fix the two boxes rendered
  // BYTE-IDENTICAL (compared with Buffer.compare), which is the defect stated as a pixel fact.
  // Post-fix they must differ, and differ ONLY by the ellipsis — hence the height check, which
  // is what stops this passing for the boring reason that one box is a different size.
  // ⚠️ AN EARLIER VERSION OF THIS TEST WAS VACUOUS, and it is worth recording why. It compared
  // the clip entity's screenshot against a separate ellipsis-authored TWIN and asserted the two
  // differed. That passes whether or not the fix is present: the two elements sit at different
  // sub-pixel offsets, so their rasterised glyphs differ anyway. Red-greened by restoring the
  // `-webkit-box` clip path — the test still passed, i.e. it measured nothing.
  //
  // The fix is to compare ONE element against ITSELF, which is what #656 actually did. Shot A is
  // the element as the engine renders it. Shot B is the same element after forcing the wrapper
  // into the old `-webkit-box` clamp in-page. Same node, same position, same text — so any
  // difference IS the ellipsis. With the fix, A (height cap, no ellipsis) and B (line-clamp,
  // forced ellipsis) differ. WITHOUT the fix, A is already `-webkit-box`, B changes nothing,
  // and the buffers match — a real red.
  test('the DEFAULT clip paints no ellipsis — forcing line-clamp on the same node changes the pixels', async ({ page }) => {
    await gotoEditorWithScene(page, SCENE, 'MaxLinesClipDefault');
    await switchToUIMode(page);

    const clipId = await idByName(page, 'MaxLinesClipDefault');
    const host = page.locator(`[data-ui-preview-frame] [data-entity-id="${clipId}"]`);
    await host.waitFor({ state: 'visible', timeout: 10_000 });

    // The host must still be a flex container — #655's half of the same change.
    const hostDisplay = await host.evaluate((el) => getComputedStyle(el).display);
    expect(hostDisplay).toBe('flex');

    const hostH = await host.evaluate((el) => el.getBoundingClientRect().height);
    expect(hostH).toBeGreaterThan(AUTHORED_FONT_SIZE_PX * 0.8);
    expect(hostH).toBeLessThan(AUTHORED_FONT_SIZE_PX * 1.8);

    const before = await host.screenshot();

    // Force the pre-fix mechanism onto the very same wrapper.
    const forced = await host.evaluate((el) => {
      const w = el.querySelector('div') as HTMLElement | null;
      if (!w) return false;
      w.style.maxHeight = 'none';
      w.style.display = '-webkit-box';
      (w.style as unknown as Record<string, string>).webkitLineClamp = '1';
      (w.style as unknown as Record<string, string>).webkitBoxOrient = 'vertical';
      return true;
    });
    expect(forced).toBe(true);

    const after = await host.screenshot();
    // Pre-fix these are byte-identical, because the engine had already applied exactly what the
    // evaluate above applies. Post-fix the ellipsis appears and the pixels move.
    expect(Buffer.compare(before, after)).not.toBe(0);
  });
});

test.describe('AutoFitText scale invariance (contentWidthOf, transform-aware fix)', () => {
  // `contentWidthOf` (UINode.tsx) used to subtract transform-BLIND `getComputedStyle`
  // padding/border from a transform-AWARE `getBoundingClientRect().width` — exact only at
  // `uiScale === 1`, and wrong by up to 67% at `uiScale === 0.3` (see its own header comment for
  // the measured numbers). `AutoFitOn` above never catches a regression here: its parent carries
  // NO padding/border, so the buggy and fixed expressions are IDENTICAL for it regardless of
  // scale, and `editor-ui-autofit.spec.ts`'s other cases all run at the default (near-1) preview
  // scale, where the bug's own error is ~0.14% — invisible. `AutoFitPaddedBordered` (this
  // fixture's own entity — its `UIElement.paddingLeft`/`paddingRight`/`borderWidth` are the exact
  // term the bug mishandles) is sized so its content-box width (384 - 40 padding - 4 border =
  // 340px) matches `AutoFitOn`'s own box width, i.e. it reproduces the SAME proven shrink as
  // `AutoFitOn`'s regression test above, just wrapped in padding/border.
  //
  // The assertion that actually pins the defect is SCALE INVARIANCE, not a hardcoded px number
  // (self-calibrating — doesn't rot when a font metric shifts): the committed `fontSize` for this
  // label must be the SAME whether the preview frame renders it at `uiScale ~= 1` or at a forced
  // `uiScale ~= 0.3`. At `uiScale === 1` the buggy and fixed expressions are numerically identical
  // (the `scale` factor multiplies to 1), so that measurement is unaffected by which version is
  // running — only the forced-scale measurement can differ, which is exactly what isolates the
  // regression.
  test('autoFitText commits the SAME fitted font size at a forced non-1 uiScale as at uiScale~1, on a padded+bordered box', async ({ page }) => {
    await gotoEditorWithScene(page, SCENE, 'AutoFitPaddedBordered');
    const id = await idByName(page, 'AutoFitPaddedBordered');
    if (id == null) throw new Error('AutoFitPaddedBordered not found in fixture');

    const frame = page.locator('[data-ui-preview-frame]');
    // Same `select:has(option[value="ui"])` element `switchToUIMode` drives — grabbed directly
    // here so this test can flip it back to '3d' between measurements too.
    const modeSelect = page.locator('select:has(option[value="ui"])');
    const box = page.locator(`[data-ui-preview-frame] [data-entity-id="${id}"]`);

    // Establish the SceneView panel's own on-screen frame width ONCE. Per
    // `editor-ui-resize-scale.spec.ts`'s header comment, `bounds.w` (the letterboxed frame's
    // on-screen size, `useLetterboxBounds` in SceneView.tsx) depends only on the panel's own
    // on-screen size and the store's default `gameRect` aspect (800x450) — NOT on
    // `gameViewSize` — so this single measurement is valid for computing BOTH forced scales
    // below, whatever this environment's panel width happens to be.
    await switchToUIMode(page);
    const baseFrameBox = await stableBoundingBox(frame);
    await modeSelect.selectOption('3d'); // unmount — the forced gameViewSize below must apply to a FRESH mount

    // Measures the committed font-size at a forced preview uiScale. Toggling the SceneView mode
    // away from 'ui' and back fully unmounts/remounts `UIEditorOverlay` (SceneView.tsx's
    // `mode === 'ui'` render gate) — and with it every `AutoFitText` span — so each call gets a
    // FRESH `fit()` measurement made under whatever uiScale is in effect AT MOUNT, rather than
    // reusing a stale committed font-size from the previous scale: `fit()` only re-runs on a real
    // ResizeObserver box-size change, a fontSize/text prop change, or `fonts.ready` — a
    // CSS-transform-only uiScale change (the preview frame's own `transform: scale(uiScale)`)
    // fires none of those.
    async function measureAtScale(targetScale: number) {
      const deviceW = Math.round(baseFrameBox.width / targetScale);
      const deviceH = Math.round(deviceW * 450 / 800); // matches the store's default gameRect aspect
      await page.evaluate(({ w, h }) => {
        (window as any).__modokiEditorTest.store.getState().setGameViewSize(w, h);
      }, { w: deviceW, h: deviceH });
      await modeSelect.selectOption('ui');
      await waitForFrames(page, 3); // let the rAF-deferred letterbox/overlay updates settle

      const frameBox = await stableBoundingBox(frame);
      const uiScale = frameBox.width / deviceW;

      await box.waitFor({ state: 'visible', timeout: 10_000 });
      const span = box.locator('span');
      await span.waitFor({ state: 'visible', timeout: 10_000 });
      const fontSizePx = await span.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

      await modeSelect.selectOption('3d'); // unmount before the next forced scale
      return { uiScale, fontSizePx };
    }

    const near1 = await measureAtScale(1);
    expect(
      Math.abs(near1.uiScale - 1),
      `forcing targetScale=1 did not land uiScale near 1.0 (measured ${near1.uiScale.toFixed(3)}) — this ` +
      `spec's "unscaled reference" measurement is not actually unscaled.`,
    ).toBeLessThan(0.05);

    const forced = await measureAtScale(0.3);
    expect(
      Math.abs(forced.uiScale - 1),
      `forcing targetScale=0.3 did not move uiScale away from 1.0 (measured ${forced.uiScale.toFixed(3)}) — ` +
      `this spec tests nothing until uiScale actually differs from 1.`,
    ).toBeGreaterThan(0.4);

    const relDiff = Math.abs(forced.fontSizePx - near1.fontSizePx) / near1.fontSizePx;
    expect(
      relDiff,
      `committed fontSize was ${near1.fontSizePx.toFixed(2)}px at uiScale=${near1.uiScale.toFixed(3)} but ` +
      `${forced.fontSizePx.toFixed(2)}px at uiScale=${forced.uiScale.toFixed(3)} (${(relDiff * 100).toFixed(1)}% ` +
      `relative difference) on a padded+bordered box — contentWidthOf's availablePx must be scale-invariant; ` +
      `mixing a transform-aware rect with transform-blind padding/border makes it drift with uiScale (see ` +
      `UINode.tsx's contentWidthOf header comment for the mechanism and the measured error at other scales).`,
    ).toBeLessThan(0.05);
  });
});
