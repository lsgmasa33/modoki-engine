/** Phase 3 (extended) — UI-mode selection and 2D gizmo drag, the two interaction
 *  paths that only exist in the browser:
 *   - UI selection is a DOM hit-test on the rendered UI element (not a WebGL raycast).
 *   - The 2D gizmo drag runs the real pointer → toGame → applyGizmoDrag2D → ECS loop.
 *
 *  The two use separate fixtures on purpose: the 2D Canvas overlay (pointerEvents:auto)
 *  would otherwise sit over the UI elements and swallow their clicks. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene, switchToUIMode, selectedName, idByName, traitField, waitForFrames, SCENE_2D } from './helpers';

test('UI mode: clicking a UI element in the preview selects its entity', async ({ page }) => {
  await gotoEditorWithScene(page); // main fixture (has a UIButton, no Canvas2D → no 2D overlay)
  await switchToUIMode(page);

  const id = await idByName(page, 'UIButton');
  const el = page.locator(`[data-ui-preview-frame] [data-entity-id="${id}"]`);
  await el.waitFor({ state: 'visible', timeout: 10_000 });
  await el.click();

  await expect.poll(() => selectedName(page)).toBe('UIButton');
});

test('2D gizmo: dragging the free handle moves the sprite in the ECS', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE_2D, 'CenterSprite');
  await switchToUIMode(page);

  // Select the sprite so its gizmo is drawn on the 2D overlay.
  await page.getByText('CenterSprite', { exact: true }).click();
  await expect.poll(() => selectedName(page)).toBe('CenterSprite');
  await waitForFrames(page); // let the overlay draw the gizmo handle before grabbing it
  const id = await idByName(page, 'CenterSprite');
  const startX = (await traitField(page, id!, 'Transform', 'x')) as number;

  // The sprite sits at the Canvas2D reference center (540,960); with fitH scaling that
  // projects to the overlay canvas's center pixel — i.e. the free-move handle.
  // `data-2d-pick` is the PixiJS capture layer (SceneView.tsx:1957). It replaced the old
  // `data-2d-overlay` DOM canvas in b60ebc2d (the SceneView 2D Pixi cutover); this spec was
  // never updated and has been failing silently ever since, because e2e runs in no gate.
  const canvas = page.locator('[data-2d-pick]');
  await canvas.waitFor({ state: 'visible', timeout: 10_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('2D overlay canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy, { steps: 8 }); // drag right
  await page.mouse.up();

  const endX = (await traitField(page, id!, 'Transform', 'x')) as number;
  expect(endX).toBeGreaterThan(startX); // moved right in reference space
});
