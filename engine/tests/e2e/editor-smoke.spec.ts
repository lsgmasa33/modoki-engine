/** Phase 3 — real-browser E2E smoke suite for the editor.
 *
 *  The irreplaceable bit: actual WebGL raycast picking. A click on a real pixel of
 *  the 3D viewport must select the right object — something jsdom/headless-logic
 *  tests can't prove. Plus the Hierarchy → selection DOM wiring end-to-end.
 *
 *  Observation is via the dev-only window bridge installed by createEditor
 *  (__modokiEditorTest). The editor's orbit camera is fixed at (12,15,20) looking
 *  at world origin, so the fixture's CenterCube (at origin) projects to the
 *  viewport center — a deterministic click target independent of projection. */

import { test, expect, type Page } from '@playwright/test';

const SCENE = '/tests/e2e/fixtures/e2e-smoke.scene.json';

const selectedName = (page: Page) =>
  page.evaluate(() => (window as { __modokiEditorTest?: any }).__modokiEditorTest?.selectedEntityName() ?? null);

const selectedId = (page: Page) =>
  page.evaluate(() => (window as { __modokiEditorTest?: any }).__modokiEditorTest?.store.getState().selectedEntityId ?? null);

async function gotoEditorWithScene(page: Page) {
  // Force the WebGL2 renderer path: the detection does requestAdapter/Device, so
  // removing navigator.gpu makes it report "no WebGPU" → WebGL2 (SwiftShader).
  await page.addInitScript(() => { try { delete (navigator as any).gpu; } catch { /* ignore */ } });

  await page.goto('/#/editor');
  await page.waitForSelector('[data-scene-viewport] canvas', { timeout: 30_000 });
  // Load the fixture through the bridge rather than seeding localStorage: the editor
  // scopes its last-scene key per project (`modoki-last-scene:<project>`), so a plain
  // `modoki-last-scene` write is silently ignored and the fixture never loads.
  await page.waitForFunction(() => !!(window as any).__modokiEditorTest, { timeout: 30_000 });
  const ok = await page.evaluate((scene) => (window as any).__modokiEditorTest.loadScene(scene), SCENE);
  if (!ok) throw new Error(`gotoEditorWithScene: loadScene('${SCENE}') returned false`);
  // Wait for the fixture entities to populate.
  await page.waitForFunction(() => {
    const b = (window as any).__modokiEditorTest;
    return !!b && b.getAllEntities().some((e: any) => e.name === 'CenterCube');
  }, { timeout: 30_000 });
}

/** Center of the 3D viewport canvas, in page coordinates. */
async function viewportCenter(page: Page) {
  const canvas = page.locator('[data-scene-viewport] canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('scene viewport canvas has no bounding box');
  return { canvas, box, cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

test('loads the fixture scene with its entities', async ({ page }) => {
  await gotoEditorWithScene(page);
  const names = await page.evaluate(() =>
    (window as any).__modokiEditorTest.getAllEntities().map((e: any) => e.name));
  expect(names).toContain('CenterCube');
  expect(names).toContain('OffsetSphere');
});

test('clicking the cube at viewport center selects it (real WebGL raycast)', async ({ page }) => {
  await gotoEditorWithScene(page);
  const { cx, cy } = await viewportCenter(page);
  // Re-click in the poll: a single click can land before the renderer has a
  // pickable frame, and polling the selection alone never re-fires the click.
  await expect.poll(async () => {
    await page.mouse.click(cx, cy);
    return selectedName(page);
  }, { timeout: 15_000, intervals: [150, 300, 500, 800] }).toBe('CenterCube');
});

test('clicking empty space deselects', async ({ page }) => {
  await gotoEditorWithScene(page);
  const { box, cx, cy } = await viewportCenter(page);
  // Select the cube first (re-click until the raycast lands — see above).
  await expect.poll(async () => {
    await page.mouse.click(cx, cy);
    return selectedName(page);
  }, { timeout: 15_000, intervals: [150, 300, 500, 800] }).toBe('CenterCube');
  // Top-left corner is empty sky (grid isn't pickable; only ECS objects are).
  await page.mouse.click(box.x + 6, box.y + 6);
  await expect.poll(() => selectedId(page)).toBeNull();
});

test('clicking an entity row in the Hierarchy selects it (DOM wiring)', async ({ page }) => {
  await gotoEditorWithScene(page);
  await page.getByText('OffsetSphere', { exact: true }).click();
  await expect.poll(() => selectedName(page)).toBe('OffsetSphere');
});
