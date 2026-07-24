/** Real-browser E2E for the SceneView "Colliders" checkbox (collider-only mode,
 *  docs/todo.md "manual edit"), inside the toolbar's "View ▾" dropdown (ViewOptionsMenu):
 *  pressing it must actually hide regular mesh rendering, not just flip the checkbox — a
 *  jsdom/headless-logic test can't prove a THREE.Mesh's `.visible` flag flipped inside
 *  SceneView's closure-scoped render loop. Observation is via the dev-only
 *  devTestBridge.isMeshVisible, which reads the live `renderState.ecsObjects` registry
 *  (see sceneViewBus.ts). */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene, idByName, isMeshVisible, has2DSprite, switchToUIMode, waitForFrames, clickViewOption, SCENE_2D } from './helpers';

const VIEW_MENU_3D = 'sceneView.toolbar.viewOptions3d';
const VIEW_MENU_UI = 'sceneView.toolbar.viewOptionsUi';
const COLLIDERS_ITEM = 'sceneView.toolbar.colliders';
const COLLIDERS_2D_ITEM = 'sceneView.toolbar.colliders2d';

test('Colliders checkbox hides regular meshes, and restores them when unchecked', async ({ page }) => {
  await gotoEditorWithScene(page);
  const cubeId = await idByName(page, 'CenterCube');
  expect(cubeId).not.toBeNull();

  await waitForFrames(page);
  expect(await isMeshVisible(page, cubeId!)).toBe(true);

  await clickViewOption(page, VIEW_MENU_3D, COLLIDERS_ITEM);
  await waitForFrames(page);
  await expect.poll(() => isMeshVisible(page, cubeId!)).toBe(false);

  await clickViewOption(page, VIEW_MENU_3D, COLLIDERS_ITEM);
  await waitForFrames(page);
  await expect.poll(() => isMeshVisible(page, cubeId!)).toBe(true);
});

test('switching to UI mode with Colliders still checked does not leave meshes hidden', async ({ page }) => {
  // The View menu's 3D variant only renders in 3D mode (mode === '3d' in SceneView's
  // toolbar JSX), so the realistic repro is: check it in 3D, THEN switch to UI — not try to
  // click a checkbox that isn't there. `showColliders` is local React state that survives
  // the mode switch.
  await gotoEditorWithScene(page);
  const cubeId = await idByName(page, 'CenterCube');

  await clickViewOption(page, VIEW_MENU_3D, COLLIDERS_ITEM);
  await waitForFrames(page);
  await expect.poll(() => isMeshVisible(page, cubeId!)).toBe(false);

  await page.locator('select:has(option[value="ui"])').selectOption('ui');
  await waitForFrames(page);

  // UI mode has no Collider3D gizmos to show in a mesh's place, so hiding it there would
  // leave nothing at all — the mode is 3D-only by design (shouldHideMeshesForColliderMode).
  await expect.poll(() => isMeshVisible(page, cubeId!)).toBe(true);
});

test('2D Colliders checkbox hides sprites, and restores them when unchecked', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE_2D, 'CenterSprite');
  await switchToUIMode(page);
  const spriteId = await idByName(page, 'CenterSprite');
  expect(spriteId).not.toBeNull();

  await waitForFrames(page);
  await expect.poll(() => has2DSprite(page, spriteId!)).toBe(true);

  await clickViewOption(page, VIEW_MENU_UI, COLLIDERS_2D_ITEM);
  await waitForFrames(page);
  await expect.poll(() => has2DSprite(page, spriteId!)).toBe(false);

  await clickViewOption(page, VIEW_MENU_UI, COLLIDERS_2D_ITEM);
  await waitForFrames(page);
  await expect.poll(() => has2DSprite(page, spriteId!)).toBe(true);
});
