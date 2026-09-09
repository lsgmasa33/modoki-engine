/** #664 press-origin gate, end-to-end in a real browser (`pressOrigin.ts`'s module doc).
 *
 *  `pressOrigin.ts`'s own unit tests exercise the module directly, so reverting the
 *  `pressBelongsTo(...)` call in `UINode.tsx` leaves every one of them green — the WIRING is
 *  uncovered, not the mechanism. Only a real browser can produce the thing under test: a DOM
 *  `click` whose target the browser resolves to the nearest common ancestor of the pointerdown
 *  and pointerup targets. Playwright's `page.mouse` generates that natively via real mouse
 *  events, which is exactly what a synthetic `dispatchEvent` cannot faithfully reproduce. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene, idByName, waitForFrames, stableBoundingBox } from './helpers';

// Dedicated fixture: a Scrim with a click binding, a Panel child (itself interactive, so
// UINode marks it a valid press origin), and a PanelChild with NO binding of its own. The press
// starts on PanelChild precisely because it has nothing to swallow the click itself — the only
// thing standing between the press and the Scrim's binding is the pressBelongsTo gate.
const SCENE = '/tests/e2e/fixtures/e2e-press-origin.scene.json';

// The same structure, but the Panel earns the press-origin marker via `UIElement.swallowClicks`
// (#728) instead of a no-op click binding. Both ways in must behave identically here, which is
// the whole point of the second group of tests below.
//
// What each layer actually covers — MEASURED, by reverting both stamp sites in `UINode.tsx` to
// `isInteractive` and running everything:
//   • `uiNode.test.tsx`'s "is stamped with the press-origin marker" → RED. The jsdom suite does
//     catch a missing stamp, structurally (the attribute is absent).
//   • the DRAG test below → RED. This is the same distinction the module doc at the top of this
//     file draws for `pressBelongsTo`: the unit test proves the attribute is emitted, only a real
//     browser proves it FUNCTIONS as a press origin under the browser's own resolution of a
//     click to the nearest common ancestor of press and release.
//   • the TAP test below → GREEN, under the very same mutation.
//
// That last line is the one to keep. A `swallowClicks` node that never gets stamped still stops a
// plain tap, so a tap-only suite reports success while the drag case has silently regressed to
// #664. Tap coverage is not evidence here, and this fixture exists because that is not obvious.
const SWALLOW_SCENE = '/tests/e2e/fixtures/e2e-press-origin-swallow.scene.json';

/** Boots the editor on `scene`, switches to the Game tab and presses Play — bindings are inert
 *  until PLAYING, so a test that skips this asserts nothing. */
async function playScene(page: import('@playwright/test').Page, scene: string, waitFor = 'Scrim') {
  // `waitFor` is a parameter because it used to be the literal 'Scrim' — fine while every scene
  // here had one, and a 30s timeout with a misleading stack the moment a fixture didn't.
  await gotoEditorWithScene(page, scene, waitFor);
  await page.locator('.flexlayout__tab_button_content', { hasText: 'Game' }).first().click();
  await page.locator('[data-game-view-area]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByTitle('Play (⌘P)').click();
  await expect(page.getByText('PLAYING', { exact: true })).toBeVisible({ timeout: 10_000 });
}

test('a drag that starts on a panel and releases on the scrim must not fire the scrim\'s binding', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE, 'Scrim');

  await page.locator('.flexlayout__tab_button_content', { hasText: 'Game' }).first().click();
  await page.locator('[data-game-view-area]').waitFor({ state: 'visible', timeout: 10_000 });

  // The game starts Stopped — bindings are inert until PLAYING.
  await page.getByTitle('Play (⌘P)').click();
  await expect(page.getByText('PLAYING', { exact: true })).toBeVisible({ timeout: 10_000 });

  const scrimId = await idByName(page, 'Scrim');
  const panelId = await idByName(page, 'Panel');
  const panelChildId = await idByName(page, 'PanelChild');
  const scrim = page.locator(`[data-game-view-area] [data-entity-id="${scrimId}"]`);
  const panel = page.locator(`[data-game-view-area] [data-entity-id="${panelId}"]`);
  const panelChild = page.locator(`[data-game-view-area] [data-entity-id="${panelChildId}"]`);
  await scrim.waitFor({ state: 'visible', timeout: 10_000 });
  await waitForFrames(page);

  const scrimBox = await scrim.boundingBox();
  const panelBox = await panel.boundingBox();
  const panelChildBox = await panelChild.boundingBox();
  if (!scrimBox || !panelBox || !panelChildBox) throw new Error('fixture entity has no bounding box');

  const startX = panelChildBox.x + panelChildBox.width / 2;
  const startY = panelChildBox.y + panelChildBox.height / 2;
  // A corner of the Scrim well outside the Panel's bounds — releasing here is what makes the
  // browser resolve the click to Scrim (the nearest common ancestor of press and release),
  // rather than to Panel.
  const endX = scrimBox.x + 12;
  const endY = scrimBox.y + scrimBox.height - 12;
  expect(endX).toBeLessThan(panelBox.x);
  expect(endY).toBeGreaterThan(panelBox.y + panelBox.height);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY);
  await page.mouse.up();
  await waitForFrames(page);

  // The regression: without the pressBelongsTo gate, the browser's synthesized click on the
  // common ancestor (Scrim) would fire Scrim's binding even though the press never touched it.
  await expect(scrim).toHaveText('');

  // Sanity check: the same drag must not have fired Panel's OWN binding either — Panel is the
  // element the press originated inside of by DOM containment, but the press itself started on
  // PanelChild, a plain leaf with no binding of its own.
  await expect(panel).toHaveText('');
});

// The control, and it is load-bearing: without it, the assertion above passes just as happily
// if the Scrim's binding never fires for some unrelated reason (the game not playing, the
// fixture mis-wired, the locator wrong) — this is what proves the negative above means anything.
test('a plain click on the scrim still fires its binding', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE, 'Scrim');

  await page.locator('.flexlayout__tab_button_content', { hasText: 'Game' }).first().click();
  await page.locator('[data-game-view-area]').waitFor({ state: 'visible', timeout: 10_000 });

  await page.getByTitle('Play (⌘P)').click();
  await expect(page.getByText('PLAYING', { exact: true })).toBeVisible({ timeout: 10_000 });

  const scrimId = await idByName(page, 'Scrim');
  const panelId = await idByName(page, 'Panel');
  const scrim = page.locator(`[data-game-view-area] [data-entity-id="${scrimId}"]`);
  const panel = page.locator(`[data-game-view-area] [data-entity-id="${panelId}"]`);
  await scrim.waitFor({ state: 'visible', timeout: 10_000 });
  await waitForFrames(page);

  const scrimBox = await scrim.boundingBox();
  const panelBox = await panel.boundingBox();
  if (!scrimBox || !panelBox) throw new Error('fixture entity has no bounding box');

  const x = scrimBox.x + 12;
  const y = scrimBox.y + scrimBox.height - 12;
  expect(x).toBeLessThan(panelBox.x);
  expect(y).toBeGreaterThan(panelBox.y + panelBox.height);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await waitForFrames(page);

  await expect(scrim).toHaveText('DISMISSED');
});

// ── UIElement.swallowClicks (#728) ──
//
// The same three cases against a Panel that earns the press-origin marker from the FIELD rather
// than from a no-op click binding. Court and wordweave are migrating onto this, so if the field
// does not stamp the marker, every one of those dialogs loses its #664 protection at once — and
// silently, because the tap case still works.

test('a drag from a swallowClicks panel to the scrim must not fire the scrim\'s binding (#728)', async ({ page }) => {
  await playScene(page, SWALLOW_SCENE);

  const scrimId = await idByName(page, 'Scrim');
  const panelId = await idByName(page, 'Panel');
  const panelChildId = await idByName(page, 'PanelChild');
  const scrim = page.locator(`[data-game-view-area] [data-entity-id="${scrimId}"]`);
  const panel = page.locator(`[data-game-view-area] [data-entity-id="${panelId}"]`);
  const panelChild = page.locator(`[data-game-view-area] [data-entity-id="${panelChildId}"]`);
  await scrim.waitFor({ state: 'visible', timeout: 10_000 });
  await waitForFrames(page);

  const scrimBox = await scrim.boundingBox();
  const panelBox = await panel.boundingBox();
  const panelChildBox = await panelChild.boundingBox();
  if (!scrimBox || !panelBox || !panelChildBox) throw new Error('fixture entity has no bounding box');

  const startX = panelChildBox.x + panelChildBox.width / 2;
  const startY = panelChildBox.y + panelChildBox.height / 2;
  const endX = scrimBox.x + 12;
  const endY = scrimBox.y + scrimBox.height - 12;
  expect(endX).toBeLessThan(panelBox.x);
  expect(endY).toBeGreaterThan(panelBox.y + panelBox.height);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY);
  await page.mouse.up();
  await waitForFrames(page);

  // This is the assertion that a missing `UI_PRESS_ORIGIN_ATTR` stamp breaks, and the ONLY one.
  // Unstamped, the press's `closest('[data-press-origin]')` resolves past Panel to Scrim, the
  // gate reads the click as belonging to Scrim, and the binding fires.
  await expect(scrim).toHaveText('');
});

test('a plain click on a swallowClicks panel does not reach the scrim (#728)', async ({ page }) => {
  await playScene(page, SWALLOW_SCENE);

  const scrimId = await idByName(page, 'Scrim');
  const panelId = await idByName(page, 'Panel');
  const scrim = page.locator(`[data-game-view-area] [data-entity-id="${scrimId}"]`);
  const panel = page.locator(`[data-game-view-area] [data-entity-id="${panelId}"]`);
  await scrim.waitFor({ state: 'visible', timeout: 10_000 });
  await waitForFrames(page);

  const panelBox = await panel.boundingBox();
  if (!panelBox) throw new Error('fixture entity has no bounding box');

  // Dead centre of the panel — the case the owner reported: tapping a dialog's own body closed it.
  await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await waitForFrames(page);

  await expect(scrim).toHaveText('');
});

// The control for the two above, load-bearing for the same reason as the one further up: without
// it, both pass just as happily if this fixture never wired up, never reached PLAYING, or the
// Scrim's binding is broken for some reason having nothing to do with swallowing.
test('a plain click on the scrim still fires its binding, with a swallowClicks panel present (#728)', async ({ page }) => {
  await playScene(page, SWALLOW_SCENE);

  const scrimId = await idByName(page, 'Scrim');
  const panelId = await idByName(page, 'Panel');
  const scrim = page.locator(`[data-game-view-area] [data-entity-id="${scrimId}"]`);
  const panel = page.locator(`[data-game-view-area] [data-entity-id="${panelId}"]`);
  await scrim.waitFor({ state: 'visible', timeout: 10_000 });
  await waitForFrames(page);

  const scrimBox = await scrim.boundingBox();
  const panelBox = await panel.boundingBox();
  if (!scrimBox || !panelBox) throw new Error('fixture entity has no bounding box');

  const x = scrimBox.x + 12;
  const y = scrimBox.y + scrimBox.height - 12;
  expect(x).toBeLessThan(panelBox.x);
  expect(y).toBeGreaterThan(panelBox.y + panelBox.height);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await waitForFrames(page);

  await expect(scrim).toHaveText('DISMISSED');
});

// ── #977: a minTapSize zone must LOSE to real content underneath it ──
//
// The unit tests in `pressOrigin.test.ts` pin the DECISION (`resolveTapZoneVeto`) against a stack
// the test hands it. They cannot pin the WIRING, and the wiring is most of the risk: that the stack
// really comes from the hit point, that the zone genuinely covers the neighbour at a real layout,
// and that the replacement click reaches the neighbour's binding through React. jsdom has no
// layout, so `document.elementsFromPoint` answers nothing there — only a real browser can produce
// any of it. Same argument as this file's own header makes for `pressBelongsTo`.
//
// The fixture reproduces #973's geometry: a 20px control carrying `minTapSize: 48`, directly below
// a 100px sibling, so the expander overhangs the sibling's bottom by 14px. One column has an
// INTERACTIVE sibling (the zone must lose), the other a DECORATIVE one (the zone must win).
const TAP_ZONE_SCENE = '/tests/e2e/fixtures/e2e-tap-zone-veto.scene.json';

/** A point inside the arrow's 48px expander but vertically inside the sibling ABOVE it. */
async function overlapPoint(
  page: import('@playwright/test').Page,
  arrow: number | null,
  sibling: number | null,
) {
  const a = await stableBoundingBox(page.locator(`[data-entity-id="${arrow}"]`));
  const s = await stableBoundingBox(page.locator(`[data-entity-id="${sibling}"]`));
  const x = a.x + a.width / 2;                       // horizontally centred on the arrow
  const y = Math.min(a.y - 3, s.y + s.height - 3);   // ~3px above the arrow: inside the pad, inside the sibling
  expect(y, 'the probe point must lie inside the sibling, or this test proves nothing')
    .toBeGreaterThan(s.y);
  return { x, y };
}

test('a tap zone overhanging an INTERACTIVE sibling hands the press back to it (#977)', async ({ page }) => {
  await playScene(page, TAP_ZONE_SCENE, 'Arrow');
  const tileId = await idByName(page, 'Tile');
  const arrowId = await idByName(page, 'Arrow');

  const { x, y } = await overlapPoint(page, arrowId, tileId);
  await page.mouse.click(x, y);
  await waitForFrames(page, 3);

  await expect(page.locator(`[data-entity-id="${tileId}"]`), 'the tile owns this pixel').toContainText('TILE-HIT');
  await expect(page.locator(`[data-entity-id="${arrowId}"]`), 'and the arrow must not have fired').not.toContainText('ARROW-HIT');
});

// ⚠️ THE ACCEPT SIDE, and the assertion this change most needs. A zone overhanging DECORATION is
// the normal, intended use of minTapSize — if the veto fires here, every enlarged tap target in
// every project silently shrinks back to its artwork, which is a far worse regression than the
// defect being fixed.
test('a tap zone overhanging DECORATION still wins the press (#977)', async ({ page }) => {
  await playScene(page, TAP_ZONE_SCENE, 'Arrow');
  const decorId = await idByName(page, 'Decor');
  const arrowId = await idByName(page, 'DecorArrow');

  const { x, y } = await overlapPoint(page, arrowId, decorId);
  await page.mouse.click(x, y);
  await waitForFrames(page, 3);

  await expect(page.locator(`[data-entity-id="${arrowId}"]`), 'the courtesy area still works over decoration').toContainText('DECORARROW-HIT');
});

test('a press on the control ITSELF is unaffected — a zone never vetoes its own host (#977)', async ({ page }) => {
  await playScene(page, TAP_ZONE_SCENE, 'Arrow');
  const arrowId = await idByName(page, 'Arrow');

  const a = await stableBoundingBox(page.locator(`[data-entity-id="${arrowId}"]`));
  await page.mouse.click(a.x + a.width / 2, a.y + a.height / 2);
  await waitForFrames(page, 3);

  await expect(page.locator(`[data-entity-id="${arrowId}"]`)).toContainText('ARROW-HIT');
});
