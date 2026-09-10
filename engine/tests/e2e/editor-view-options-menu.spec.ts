/** Real-browser E2E for the SceneView "View ▾" dropdown chrome (ViewOptionsMenu,
 *  see docs/editor.md). ViewOptionsMenu.test.tsx (jsdom/RTL) covers the same
 *  open/close/toggle logic already — this spec exists for the ONE thing jsdom can't prove:
 *  real keyboard dispatch through the editor's global keymap resolver (`useOverlayEscape` /
 *  `register`), which needs the actual window-level dispatcher mounted by the app shell. No
 *  other `useOverlayEscape` consumer in this codebase is unit-tested for Escape either — this
 *  is the established pattern (see editor-input.md). */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene } from './helpers';

const VIEW_MENU_3D = '[data-ui-id="sceneView.toolbar.viewOptions3d"]';
const GRID_ITEM = '[data-ui-id="sceneView.toolbar.grid"]';

test('Escape closes the View menu (real keyboard dispatch through the editor keymap)', async ({ page }) => {
  await gotoEditorWithScene(page);
  await page.locator(VIEW_MENU_3D).click();
  await expect(page.locator(GRID_ITEM)).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator(GRID_ITEM)).toBeHidden();
});

test('clicking anywhere outside the dropdown closes it (real pointer event, not synthetic mousedown)', async ({ page }) => {
  await gotoEditorWithScene(page);
  await page.locator(VIEW_MENU_3D).click();
  await expect(page.locator(GRID_ITEM)).toBeVisible();

  // The 3D viewport is a safe, always-present target well outside the dropdown's own DOM subtree.
  await page.locator('[data-scene-viewport]').click({ position: { x: 5, y: 5 } });
  await expect(page.locator(GRID_ITEM)).toBeHidden();
});

test('the trigger badge NAMES the live checked options as items are toggled (#1003)', async ({ page }) => {
  await gotoEditorWithScene(page);
  const trigger = page.locator(VIEW_MENU_3D);
  // #1003 replaced the count with names, so this asserts WHICH option is on, not how many.
  // `viewBadgeLabel`'s rule (the cap, the `notable` ordering) is unit-tested in
  // ViewOptionsMenu.test.tsx — what only a real editor can prove is that a toggle re-renders
  // the live trigger. Matched loosely at the start so the trailing ▾ chrome stays incidental.
  // Grid defaults on, FX/Colliders default off → `View: Grid`.
  await expect(trigger).toHaveText(/^View: Grid\b/);

  await trigger.click();
  await page.locator(GRID_ITEM).click(); // uncheck Grid
  // Nothing checked → a bare `View`. The negative lookahead is what proves no option is named:
  // a plain `not.toHaveText(/name/)` would also pass if the badge stopped rendering entirely.
  await expect(trigger).toHaveText(/^View(?!:)/);

  await page.locator('[data-ui-id="sceneView.toolbar.colliders"]').click(); // check Colliders
  await expect(trigger).toHaveText(/^View: Colliders\b/);
});
