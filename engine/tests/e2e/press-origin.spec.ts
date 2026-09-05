/** #664 press-origin gate, end-to-end in a real browser (`pressOrigin.ts`'s module doc).
 *
 *  `pressOrigin.ts`'s own unit tests exercise the module directly, so reverting the
 *  `pressBelongsTo(...)` call in `UINode.tsx` leaves every one of them green — the WIRING is
 *  uncovered, not the mechanism. Only a real browser can produce the thing under test: a DOM
 *  `click` whose target the browser resolves to the nearest common ancestor of the pointerdown
 *  and pointerup targets. Playwright's `page.mouse` generates that natively via real mouse
 *  events, which is exactly what a synthetic `dispatchEvent` cannot faithfully reproduce. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene, idByName, waitForFrames } from './helpers';

// Dedicated fixture: a Scrim with a click binding, a Panel child (itself interactive, so
// UINode marks it a valid press origin — mirroring wordweave's deliberate no-op
// `dictionaryPanelSwallow`), and a PanelChild with NO binding of its own. The press starts on
// PanelChild precisely because it has nothing to swallow the click itself — the only thing
// standing between the press and the Scrim's binding is the pressBelongsTo gate.
const SCENE = '/tests/e2e/fixtures/e2e-press-origin.scene.json';

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
