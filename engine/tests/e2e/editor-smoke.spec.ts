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

/** The pick PREDICTION must agree with the real click.
 *
 *  `modoki_tap`'s entity aim asks the surface's own hit-test what a click would select and refuses
 *  when the answer is not the target (reporting it as `occludedByEntity`). That guarantee is only
 *  worth anything if the prediction matches what actually happens — and it did not: the transform
 *  gizmo of the SELECTED entity sits exactly where an aim lands, TransformControls consumes the
 *  press, and the selection does not move, while the predictor happily named whatever mesh was
 *  behind the gizmo (testboard UfbeEfhHmNwd0GVVnESC, 2026-08-19). The gizmo is now part of the
 *  prediction, so this asserts the invariant rather than the mechanism: predict, click, compare. */
test('the pick prediction agrees with what the click actually selects, gizmo included', async ({ page }) => {
  await gotoEditorWithScene(page);
  const { cx, cy } = await viewportCenter(page);
  // Select the cube first — that is what puts a transform gizmo over the viewport centre.
  await expect.poll(async () => {
    await page.mouse.click(cx, cy);
    return selectedName(page);
  }, { timeout: 15_000, intervals: [150, 300, 500, 800] }).toBe('CenterCube');

  // WAIT for the gizmo to actually attach before predicting anything. Selection is committed on
  // pointer-up but the gizmo is attached by the render loop a frame or more later, so a prediction
  // read in that window says "nothing here" while the click that follows is already being eaten by
  // the arm — a real race that failed this spec once in a full-suite run. Poll a point ON the arm
  // until it predicts SOMETHING; that is the steady state the agreement claim is about. (A timeout
  // here means the prediction never accounts for the gizmo at all — the bug this spec guards.)
  await expect.poll(
    () => page.evaluate(([x, y]) => (window as any).__modokiEditorTest.predictPickAt(x, y) ?? null, [cx + 60, cy] as const),
    { timeout: 15_000, intervals: [100, 200, 400, 800] },
  ).not.toBeNull();

  // A ring around the gizmo, wide enough to leave the cube's own silhouette (~30 px) but inside
  // the gizmo arms' reach (~110 px), plus one point far outside everything. The interesting
  // candidates are the ones over EMPTY SKY but ON an arm: there the naive predictor says "nothing
  // here" while the click is eaten by the gizmo and the selection does not clear.
  const ring = ([60, 90] as const).flatMap((r) =>
    ([[1, 0], [0, -1], [-1, 0], [0, 1], [0.7, -0.7], [-0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]] as const)
      .map(([ux, uy]) => [Math.round(ux * r), Math.round(uy * r)] as const));
  for (const [dx, dy] of [[0, 0] as const, ...ring, [200, 140] as const]) {
    const predicted = await page.evaluate(
      ([x, y]) => (window as any).__modokiEditorTest.predictPickAt(x, y) ?? null,
      [cx + dx, cy + dy] as const,
    );
    await page.mouse.click(cx + dx, cy + dy);
    const actual = await selectedId(page);
    expect(actual, `prediction disagreed with the click at (+${dx}, +${dy})`).toBe(predicted);
    // Re-arm: leave the cube selected so the next iteration still has a gizmo on screen — and wait
    // for the gizmo to be back before the next prediction, for the same reason as above.
    if (actual === null) {
      await expect.poll(async () => {
        await page.mouse.click(cx, cy);
        return selectedName(page);
      }, { timeout: 15_000, intervals: [150, 300, 500] }).toBe('CenterCube');
      await expect.poll(
        () => page.evaluate(([x, y]) => (window as any).__modokiEditorTest.predictPickAt(x, y) ?? null, [cx + 60, cy] as const),
        { timeout: 15_000, intervals: [100, 200, 400, 800] },
      ).not.toBeNull();
    }
  }
});
