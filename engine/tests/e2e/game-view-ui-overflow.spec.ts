/** UI text overflow warning (#1126), end-to-end in a real browser — the one part the vitest suite
 *  cannot reach. `uiOverflow.test.ts` covers the decisions and the scan's wiring with the DOM
 *  measurement stubbed, because jsdom has no layout: every rect is 0x0 and a Range has no
 *  `getBoundingClientRect`. What only a browser can show is that `measureTextOverflow` reads the
 *  RIGHT boxes: the text's painted extent rather than its stretched box, the padding edge of the
 *  enclosing row, and CSS px rather than the GameView preview's scaled screen px.
 *
 *  Fixture `e2e-ui-overflow.scene.json` holds one element per shape plus the negatives:
 *  - `SpillLabel`: a single word in a fixed-width centred row → `spill`, against `SpillRow`.
 *  - `OwnBoxValue`: a definite-width box its one word is wider than → `own-box`.
 *  - `ClipBox`: the same, with the element's own `overflow: hidden` → `own-box`, `clipped`.
 *  - `CoinCount`: a `{e2eCoins}` bound count, driven through `setUIValues` the way a game does. It
 *    changes the TEXT NODE only, with no tree rebuild, so it reaches the scan's mutation trigger.
 *  - `AnchorLabel`: centred by `UIAnchor` — `position: absolute` plus a translate — and wider than
 *    the whole UI → `spill` against the UI root (`boxEntityId: 0`) by excess width. The live check on
 *    wordweave's banner found this shape unreported.
 *  - `EllipsisSpill`: a 260px ellipsis box in a 200px row → `spill`. The ellipsis is the text's own
 *    clip and must not stop the walk (close-out review).
 *  - Negatives: `FitsLabel`, `ScrollLabel` (inside a horizontal scroll view), `EllipsisBox` (an
 *    authored ellipsis truncates on purpose), `Badge` (an anchored corner badge overhanging its host),
 *    `Caption` (anchored under a 40px icon and wider than it), `JitterLabel` (a `jitter` text animation
 *    shaking a content-sized label — the review measured a flickering false own-box finding),
 *    `PaddedEllipsis` (an ellipsis clip inside 20px padding, flush with its row), `ScrollAnchorLabel`
 *    (an anchored label wider than the UI, inside a scroll view), `JitterScaled` (jitter on a
 *    scale(1.5) host — the translate must be subtracted at the element's own scale). */

import { test, expect, type Page } from '@playwright/test';
import { gotoEditorWithScene, idByName } from './helpers';

const SCENE = '/tests/e2e/fixtures/e2e-ui-overflow.scene.json';
/** Longer than two scan passes (`SCAN_DELAY_MS` x2 — a finding needs a confirming second pass). */
const SETTLE_MS = 1_000;

type Finding = { entityId: number; boxEntityId: number; kind: string; clipped: boolean; current: boolean; availablePx: number; overflowPx: number; text: string };

const findings = (page: Page) =>
  page.evaluate(() => (window as unknown as { __modokiEditorTest: { uiOverflowFindings(): unknown[] } }).__modokiEditorTest.uiOverflowFindings()) as Promise<Finding[]>;
const setUIValues = (page: Page, patch: Record<string, string | number>) =>
  page.evaluate((p) => (window as unknown as { __modokiEditorTest: { setUIValues(p: unknown): void } }).__modokiEditorTest.setUIValues(p), patch);

async function openPlayingGameView(page: Page) {
  await gotoEditorWithScene(page, SCENE, 'SpillLabel');
  // Same tab + Play dance as game-view-pointer-block.spec.ts: "Game" shares a tabset, and the scan
  // is installed only on the RUNTIME UIRenderer GameView mounts (never SceneView's preview).
  await page.locator('.flexlayout__tab_button_content', { hasText: 'Game' }).first().click();
  await page.locator('[data-game-view-area]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByTitle('Play (⌘P)').click();
  await expect(page.getByText('PLAYING', { exact: true })).toBeVisible({ timeout: 10_000 });
}

test.describe('UI text overflow warning (#1126)', () => {
  test('records exactly the overflowing labels, in both shapes, measured in CSS px', async ({ page }) => {
    await openPlayingGameView(page);
    const id = Object.fromEntries(await Promise.all(
      ['SpillRow', 'SpillLabel', 'OwnBoxValue', 'ClipBox', 'FitsLabel', 'ScrollLabel', 'EllipsisBox', 'AnchorLabel', 'Badge', 'Caption', 'CaptionIcon', 'EllipsisRow', 'EllipsisSpill', 'JitterLabel', 'PaddedEllipsis', 'ScrollAnchorLabel'].map(async (n) => [n, await idByName(page, n)] as const),
    ));

    const expected = [id.SpillLabel, id.OwnBoxValue, id.ClipBox, id.AnchorLabel, id.EllipsisSpill].sort();
    await expect.poll(async () => (await findings(page)).map((f) => f.entityId).sort()).toEqual(expected);
    // Not a race the poll happened to win: a further settle adds nothing — the negatives stay out.
    await page.waitForTimeout(SETTLE_MS);
    const all = await findings(page);
    expect(all.map((f) => f.entityId).sort()).toEqual(expected);
    for (const negative of [id.FitsLabel, id.ScrollLabel, id.EllipsisBox, id.Badge, id.Caption, id.JitterLabel, id.PaddedEllipsis, id.ScrollAnchorLabel]) {
      expect(all.some((f) => f.entityId === negative)).toBe(false);
    }

    const spill = all.find((f) => f.entityId === id.SpillLabel)!;
    expect(spill).toMatchObject({ kind: 'spill', boxEntityId: id.SpillRow, clipped: false, current: true });
    // The row's padding box, as authored (200px). The SCALED case — CSS px vs screen px — is the
    // second test's, which applies a transform: this GameView renders at scale 1 here, measured.
    expect(spill.availablePx).toBeGreaterThan(199);
    expect(spill.availablePx).toBeLessThan(201);
    expect(spill.text).toBe('Supercalifragilisticexpialidocious');

    // Cross-checked against the DOM directly, in the same CSS-px space: the label's own layout
    // width minus the row's, centred, so it overshoots by half the difference on each side.
    const [labelW, rowW] = await Promise.all([id.SpillLabel, id.SpillRow].map((eid) =>
      page.locator(`[data-game-view-area] [data-entity-id="${eid}"]`).evaluate((el) => (el as HTMLElement).offsetWidth)));
    expect(rowW).toBe(200);
    expect(Math.abs(spill.overflowPx - (labelW - rowW) / 2)).toBeLessThan(1.5);

    expect(all.find((f) => f.entityId === id.OwnBoxValue)).toMatchObject({ kind: 'own-box', boxEntityId: id.OwnBoxValue, clipped: false });
    expect(all.find((f) => f.entityId === id.ClipBox)).toMatchObject({ kind: 'own-box', clipped: true });
    expect(all.find((f) => f.entityId === id.OwnBoxValue)!.availablePx).toBeCloseTo(60, 0);

    // The anchored label: a spill against the UI ROOT by EXCESS WIDTH, independent of where the
    // anchor placed it. Cross-checked against the label's own layout width and the root's.
    const anchored = all.find((f) => f.entityId === id.AnchorLabel)!;
    expect(anchored).toMatchObject({ kind: 'spill', boxEntityId: 0, clipped: false });
    const [anchoredW, rootW] = await Promise.all([
      page.locator(`[data-game-view-area] [data-entity-id="${id.AnchorLabel}"]`).evaluate((el) => (el as HTMLElement).offsetWidth),
      page.locator('[data-game-view-area] [data-modoki-ui-root="runtime"]').evaluate((el) => (el as HTMLElement).clientWidth),
    ]);
    expect(anchored.availablePx).toBeCloseTo(rootW, 0);
    // 3px, not 1.5: on a ~2000px word the glyph range and the integer offsetWidth differ by ~2px
    // (measured). Still decisive — a POSITION-based reading would report half the excess, ~1000px off.
    expect(anchoredW - rootW).toBeGreaterThan(100);
    expect(Math.abs(anchored.overflowPx - (anchoredW - rootW))).toBeLessThan(3);

    // The ellipsis spill: measured from the painted (clamped) 260px box, centred in the 200px row.
    expect(all.find((f) => f.entityId === id.EllipsisSpill)).toMatchObject({ kind: 'spill', boxEntityId: id.EllipsisRow, clipped: false });
    expect(all.find((f) => f.entityId === id.EllipsisSpill)!.overflowPx).toBeCloseTo(30, 0);

    // The negatives are live shapes, not empty ones: the caption really is wider than its icon, and
    // the jitter label really is moving.
    const [captionW, iconW] = await Promise.all([id.Caption, id.CaptionIcon].map((eid) =>
      page.locator(`[data-game-view-area] [data-entity-id="${eid}"]`).evaluate((el) => el.getBoundingClientRect().width)));
    expect(captionW).toBeGreaterThan(iconW);
    const jitterAnim = await page.locator(`[data-game-view-area] [data-entity-id="${id.JitterLabel}"] [data-ui-paint="text"]`).first()
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(jitterAnim).not.toBe('none');
    // The badge's box really does overhang its host — so its absence above is the rule, not a miss.
    const [badgeRight, hostRight] = await Promise.all([id.Badge, await idByName(page, 'BadgeHost')].map((eid) =>
      page.locator(`[data-game-view-area] [data-entity-id="${eid}"]`).evaluate((el) => el.getBoundingClientRect().right)));
    expect(badgeRight).toBeGreaterThan(hostRight + 2);
  });

  // A CSS animation writes no DOM, so the scan samples a shaking label only when something ELSE
  // triggers a pass — which is why the jitter case is frozen here rather than left to luck. At the
  // 25% keyframe `mdk-ui-shake` holds translate(-amp): the glyphs sit past the host's left edge on
  // screen, and the scan must measure where they are LAID OUT (the close-out review measured 13 of 20
  // samples reading as a false own-box overflow before the translate was subtracted).
  for (const name of ['JitterLabel', 'JitterScaled']) test(`a jitter label frozen mid-shake is not a finding — the animation's translate is subtracted (${name})`, async ({ page }) => {
    await openPlayingGameView(page);
    const jitter = await idByName(page, name);
    const host = page.locator(`[data-game-view-area] [data-entity-id="${jitter}"]`);
    // The animated span mounts only once Play has re-projected the tree with the TextAnimation.
    await host.locator('[data-ui-paint="text"]').first().waitFor({ state: 'attached', timeout: 10_000 });
    const shift = await host.evaluate((el) => {
      const span = el.querySelector('[data-ui-paint="text"]') as HTMLElement;
      const dur = parseFloat(getComputedStyle(span).animationDuration);
      span.style.animationDelay = `${-dur * 0.25}s`;
      span.style.animationPlayState = 'paused';
      const text = span.querySelector('span') ?? span;
      const range = document.createRange();
      range.selectNodeContents(text);
      return el.getBoundingClientRect().left - range.getBoundingClientRect().left;
    });
    expect(shift).toBeGreaterThan(1.5);   // the premise: the glyphs really are past the box on screen

    await setUIValues(page, { e2eCoins: 42 });   // any DOM change schedules a pass (and its confirmation)
    await page.waitForTimeout(SETTLE_MS);
    await setUIValues(page, { e2eCoins: 43 });
    await page.waitForTimeout(SETTLE_MS);
    expect((await findings(page)).some((f) => f.entityId === jitter)).toBe(false);
  });

  test('a bound runtime count is caught when it grows, and goes non-current when it shrinks back', async ({ page }) => {
    await openPlayingGameView(page);
    const coin = await idByName(page, 'CoinCount');
    const row = await idByName(page, 'CoinRow');
    const box = page.locator(`[data-game-view-area] [data-entity-id="${coin}"]`);

    await setUIValues(page, { e2eCoins: 5 });
    await expect(box).toHaveText('5');
    await page.waitForTimeout(SETTLE_MS);
    expect((await findings(page)).some((f) => f.entityId === coin)).toBe(false);

    // Scale the whole GameView area to half size BEFORE the overflow exists, so the finding is
    // measured under a transform. The scan reads screen-px rects and must divide by the root's own
    // screen/layout ratio: without that, the authored 120px row reports as 60px. (Measured: this
    // spec's GameView otherwise renders at scale 1, so no other assertion here can see that bug.)
    await page.locator('[data-game-view-area]').evaluate((el) => {
      (el as HTMLElement).style.transform = 'scale(0.5)';
      (el as HTMLElement).style.transformOrigin = '0 0';
    });
    await setUIValues(page, { e2eCoins: '1234567890123456' });
    await expect(box).toHaveText('1234567890123456');
    await expect.poll(async () => (await findings(page)).find((f) => f.entityId === coin)).toMatchObject({
      kind: 'spill', boxEntityId: row, current: true, text: '1234567890123456',
    });
    const coinFinding = (await findings(page)).find((f) => f.entityId === coin)!;
    expect(coinFinding.availablePx).toBeGreaterThan(119);
    expect(coinFinding.availablePx).toBeLessThan(121);
    const [labelW, rowW] = await Promise.all([coin, row].map((eid) =>
      page.locator(`[data-game-view-area] [data-entity-id="${eid}"]`).evaluate((el) => (el as HTMLElement).offsetWidth)));
    expect(Math.abs(coinFinding.overflowPx - (labelW - rowW) / 2)).toBeLessThan(1.5);

    await setUIValues(page, { e2eCoins: 7 });
    await expect.poll(async () => (await findings(page)).find((f) => f.entityId === coin)?.current).toBe(false);
  });
});
