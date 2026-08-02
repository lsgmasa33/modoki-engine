/** Pointer-block roots, end-to-end in a real browser (`docs/input.md` "Pointer-block roots").
 *  The unit/component layers already prove the mechanism in isolation (pointerSource.test.ts's
 *  block-root suite, uiRenderer.test.tsx's registration/gating tests) — this is the one thing
 *  those can't: GameView and SceneView mount the SAME UIRenderer component simultaneously in the
 *  real editor, and only GameView's instance may claim the pointer (SceneView clicks manipulate
 *  gizmos/authoring, never the running game — see docs/todo.md's "Input" section decision log).
 *  Proves it against the real `Input` ECS resource every game/UI system reads from, via
 *  `devTestBridge.getPointerState()` — not a mock of the mechanism. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene, idByName, waitForFrames } from './helpers';

// Dedicated fixture (not the shared e2e-smoke one): needs a UIButton with a REAL UIAction
// binding — UINode only sets `pointerEvents:auto` on an interactive element
// (`isInteractive`, UINode.tsx), so a plain text-label UIElement with no action is inert to
// clicks by design and can't demonstrate blocking either way (the click passes straight
// through to whatever is under it).
const SCENE = '/tests/e2e/fixtures/e2e-pointer-block.scene.json';

test('a real mouse press on a GameView UI button never reaches the Input resource the game reads', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE, 'UIButton');

  // The "Game" tab shares a tabset with "Console"/"Assets" — select it explicitly rather
  // than assuming it's the active one. Scoped to the FlexLayout tab-strip class: a plain
  // text locator also matches the "Game" entry FlexLayout renders a second time (an
  // overflow/menu affordance for the same tabset).
  await page.locator('.flexlayout__tab_button_content', { hasText: 'Game' }).first().click();
  await page.locator('[data-game-view-area]').waitFor({ state: 'visible', timeout: 10_000 });

  // The game starts Stopped — a full-area "Press Play" overlay covers the whole preview
  // (GameView.tsx, zIndex 3) and would swallow every click if left in place.
  await page.getByTitle('Play (⌘P)').click();
  await expect(page.getByText('PLAYING', { exact: true })).toBeVisible({ timeout: 10_000 });

  const buttonId = await idByName(page, 'UIButton');
  const button = page.locator(`[data-game-view-area] [data-entity-id="${buttonId}"]`);
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await waitForFrames(page);

  const buttonBox = await button.boundingBox();
  if (!buttonBox) throw new Error('UI button has no bounding box in GameView');
  const bx = buttonBox.x + buttonBox.width / 2;
  const by = buttonBox.y + buttonBox.height / 2;

  await page.mouse.move(bx, by);
  await page.mouse.down();
  await waitForFrames(page); // let inputSystem sample this frame's press
  const blockedState = await page.evaluate(() => (window as any).__modokiEditorTest.getPointerState());
  await page.mouse.up();

  expect(blockedState).not.toBeNull();
  expect(blockedState.down).toBe(false); // blocked: the game's Input never saw the press

  // Sanity check: the SAME harness DOES observe a press elsewhere in the game area, so the
  // previous assertion is proving real containment, not a vacuously-blocking mechanism (e.g.
  // Input never updating in this test setup at all). Pick a corner far from the button.
  const areaBox = await page.locator('[data-game-view-area]').boundingBox();
  if (!areaBox) throw new Error('game view area has no bounding box');
  const ax = areaBox.x + 12;
  const ay = areaBox.y + areaBox.height - 12;
  // Guard against the fixture's UI button happening to sit near this corner.
  expect(Math.hypot(ax - bx, ay - by)).toBeGreaterThan(Math.max(buttonBox.width, buttonBox.height));

  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await waitForFrames(page);
  const unblockedState = await page.evaluate(() => (window as any).__modokiEditorTest.getPointerState());
  await page.mouse.up();

  expect(unblockedState).not.toBeNull();
  expect(unblockedState.down).toBe(true);

  // And the button's OWN action still fires — blocking the game's Input is not blocking
  // the UI itself from working.
  await button.click();
  await expect(button).toHaveText('Clicked!');
});
