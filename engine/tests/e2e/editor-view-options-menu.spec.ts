/** Real-browser E2E for the SceneView "View ▾" dropdown chrome (ViewOptionsMenu,
 *  docs/todo.md "manual edit"). ViewOptionsMenu.test.tsx (jsdom/RTL) covers the same
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

test('the trigger badge reflects the live checked count as items are toggled', async ({ page }) => {
  await gotoEditorWithScene(page);
  const trigger = page.locator(VIEW_MENU_3D);
  // Grid defaults on, FX/Colliders default off → (1).
  await expect(trigger).toHaveText(/\(1\)/);

  await trigger.click();
  await page.locator(GRID_ITEM).click(); // uncheck Grid
  await expect(trigger).not.toHaveText(/\(\d/);

  await page.locator('[data-ui-id="sceneView.toolbar.colliders"]').click(); // check Colliders
  await expect(trigger).toHaveText(/\(1\)/);
});
