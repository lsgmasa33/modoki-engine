/** SceneView-viewport multi-select E2E — the interaction paths `editor-multi-select.spec.ts`
 *  doesn't cover: that spec drives multi-select entirely through the Hierarchy panel (DOM
 *  clicks). This file drives it through the SceneView canvas itself — real WebGL raycast
 *  shift/ctrl-click, marquee (box) select, the Pivot/Center gizmo toggle, and an actual group
 *  gizmo drag with undo — none of which had any coverage before (commit cd594f99 added the
 *  feature with only headless unit tests for its pure math).
 *
 *  3D cases use the `e2e-smoke` fixture (CenterCube @ origin, OffsetSphere @ (0,8,0)) and the
 *  new `screenPositionOf` bridge helper (projects a world position through the LIVE editor
 *  camera into page coordinates — the same math the real marquee uses) so click/drag targets
 *  don't depend on a hand-derived projection. The 2D group-drag case reuses the established
 *  Hierarchy-select + canvas-drag pattern from `editor-2d-ui.spec.ts`. */

import { test, expect, type Page } from '@playwright/test';
import { gotoEditorWithScene, switchToUIMode, idByName, traitField, waitForFrames, screenPositionOf, SCENE_2D } from './helpers';

const selectedIds = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as any).__modokiEditorTest.store.getState().selectedEntityIds);
const primarySelectedId = (page: Page): Promise<number | null> =>
  page.evaluate(() => (window as any).__modokiEditorTest.store.getState().selectedEntityId);
const gizmoPivot = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).__modokiEditorTest.store.getState().gizmoPivot);

/** Poll-click a viewport pixel with a held modifier, re-clicking until the selection settles —
 *  a synthetic click can land before the renderer has a pickable frame (same rationale as
 *  editor-smoke.spec.ts's clickUntilSelected, extended with the modifier key). */
async function modifierClickUntil(
  page: Page, x: number, y: number, modifierKey: 'Shift' | 'ControlOrMeta', check: () => Promise<boolean>,
) {
  await expect.poll(async () => {
    await page.keyboard.down(modifierKey);
    await page.mouse.click(x, y);
    await page.keyboard.up(modifierKey);
    return check();
  }, { timeout: 15_000, intervals: [150, 300, 500, 800] }).toBe(true);
}

test.describe('3D viewport multi-select', () => {
  test('shift-click builds a multi-selection via real WebGL raycast', async ({ page }) => {
    await gotoEditorWithScene(page);
    await waitForFrames(page);
    const cube = await idByName(page, 'CenterCube');
    const sphere = await idByName(page, 'OffsetSphere');

    const cubePos = await screenPositionOf(page, cube!);
    const spherePos = await screenPositionOf(page, sphere!);
    expect(cubePos).not.toBeNull();
    expect(spherePos).not.toBeNull();

    // Plain click selects CenterCube alone.
    await expect.poll(async () => {
      await page.mouse.click(cubePos!.x, cubePos!.y);
      return selectedIds(page);
    }, { timeout: 15_000, intervals: [150, 300, 500, 800] }).toEqual([cube]);

    // Shift-click OffsetSphere adds it, becoming the active (primary) member.
    await modifierClickUntil(page, spherePos!.x, spherePos!.y, 'Shift', async () =>
      (await selectedIds(page)).sort((a, b) => a - b).join(',') === [cube!, sphere!].sort((a, b) => a - b).join(','));
    expect(await primarySelectedId(page)).toBe(sphere);
  });

  test('ctrl/cmd-click toggles a member out of the selection without clearing the rest', async ({ page }) => {
    await gotoEditorWithScene(page);
    await waitForFrames(page);
    const cube = await idByName(page, 'CenterCube');
    const sphere = await idByName(page, 'OffsetSphere');
    const cubePos = await screenPositionOf(page, cube!);
    const spherePos = await screenPositionOf(page, sphere!);

    await expect.poll(async () => {
      await page.mouse.click(cubePos!.x, cubePos!.y);
      return selectedIds(page);
    }, { timeout: 15_000, intervals: [150, 300, 500, 800] }).toEqual([cube]);
    await modifierClickUntil(page, spherePos!.x, spherePos!.y, 'Shift', async () =>
      (await selectedIds(page)).length === 2);

    // Ctrl/Cmd-click the (non-primary) cube again → removed, sphere stays selected + primary.
    await modifierClickUntil(page, cubePos!.x, cubePos!.y, 'ControlOrMeta', async () =>
      (await selectedIds(page)).length === 1);
    expect(await selectedIds(page)).toEqual([sphere]);
    expect(await primarySelectedId(page)).toBe(sphere);
  });

  test('shift-drag over empty space marquee-selects every enclosed entity', async ({ page }) => {
    await gotoEditorWithScene(page);
    await waitForFrames(page);
    const cube = await idByName(page, 'CenterCube');
    const sphere = await idByName(page, 'OffsetSphere');
    // The fixture's Ambient Light sits at the same world origin as CenterCube and renders as a
    // gizmo icon in the 3D viewport — a box enclosing the cube necessarily encloses it too
    // (marquee's selectable set intentionally includes light/camera gizmos, matching click-pick).
    const light = await idByName(page, 'Ambient Light');
    const cubePos = await screenPositionOf(page, cube!);
    const spherePos = await screenPositionOf(page, sphere!);
    expect(cubePos).not.toBeNull();
    expect(spherePos).not.toBeNull();

    const minX = Math.min(cubePos!.x, spherePos!.x) - 40;
    const maxX = Math.max(cubePos!.x, spherePos!.x) + 40;
    const minY = Math.min(cubePos!.y, spherePos!.y) - 40;
    const maxY = Math.max(cubePos!.y, spherePos!.y) + 40;

    await page.keyboard.down('Shift');
    await page.mouse.move(minX, minY);
    await page.mouse.down();
    await page.mouse.move(maxX, maxY, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Shift');

    await expect.poll(async () => (await selectedIds(page)).sort((a, b) => a - b))
      .toEqual([cube!, sphere!, light!].sort((a, b) => a - b));
  });

  test('Z toggles the multi-select Pivot/Center gizmo mode, only once >1 entity is selected', async ({ page }) => {
    await gotoEditorWithScene(page);
    await waitForFrames(page);
    const cube = await idByName(page, 'CenterCube');
    const sphere = await idByName(page, 'OffsetSphere');
    const cubePos = await screenPositionOf(page, cube!);

    expect(await gizmoPivot(page)).toBe('pivot'); // store default

    // A single selection: Z is scoped to a multi-selection and must NOT toggle it.
    await page.mouse.click(cubePos!.x, cubePos!.y);
    await expect.poll(() => selectedIds(page)).toEqual([cube]);
    await page.keyboard.press('z');
    expect(await gizmoPivot(page)).toBe('pivot');

    // With >1 selected, Z flips pivot -> center -> pivot.
    const spherePos = await screenPositionOf(page, sphere!);
    await modifierClickUntil(page, spherePos!.x, spherePos!.y, 'Shift', async () =>
      (await selectedIds(page)).length === 2);
    await page.keyboard.press('z');
    await expect.poll(() => gizmoPivot(page)).toBe('center');
    await page.keyboard.press('z');
    await expect.poll(() => gizmoPivot(page)).toBe('pivot');
  });
});

test.describe('2D viewport group gizmo drag', () => {
  test('dragging the group free handle moves every selected sprite together, and undo reverts both', async ({ page }) => {
    await gotoEditorWithScene(page, SCENE_2D, 'OffsetSprite');
    await switchToUIMode(page);

    // Multi-select via the Hierarchy (the click-to-select DOM wiring is already covered
    // elsewhere); this test's subject is the DRAG, run on the real 2D canvas.
    await page.getByText('CenterSprite', { exact: true }).click();
    await page.getByText('OffsetSprite', { exact: true }).click({ modifiers: ['Shift'] });
    await expect.poll(() => selectedIds(page)).toHaveLength(2);
    await expect.poll(() => primarySelectedId(page)).toBe(await idByName(page, 'OffsetSprite'));
    await waitForFrames(page); // let the overlay draw the group gizmo before grabbing it

    const centerId = (await idByName(page, 'CenterSprite'))!;
    const offsetId = (await idByName(page, 'OffsetSprite'))!;
    const startCenterX = (await traitField(page, centerId, 'Transform', 'x')) as number;
    const startOffsetX = (await traitField(page, offsetId, 'Transform', 'x')) as number;

    // Pivot mode (the store default) sits the group gizmo ON the active entity — OffsetSprite,
    // at reference (540, 660). CenterSprite (540, 960) is the canvas's reference centre, which
    // (per editor-2d-ui.spec.ts) projects to the overlay canvas's centre pixel with fitH scaling
    // — so OffsetSprite's screen X matches the canvas centre X (same reference X, 540) and its
    // screen Y is offset from centre by (960-660) reference units, scaled by box.height/1920.
    const canvas = page.locator('[data-2d-pick]');
    await canvas.waitFor({ state: 'visible', timeout: 10_000 });
    const box = await canvas.boundingBox();
    if (!box) throw new Error('2D overlay canvas has no bounding box');
    const scale = box.height / 1920;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const gizmoX = cx;
    const gizmoY = cy - (960 - 660) * scale;

    await page.mouse.move(gizmoX, gizmoY);
    await page.mouse.down();
    await page.mouse.move(gizmoX + 80, gizmoY, { steps: 8 }); // drag right
    await page.mouse.up();

    const draggedCenterX = (await traitField(page, centerId, 'Transform', 'x')) as number;
    const draggedOffsetX = (await traitField(page, offsetId, 'Transform', 'x')) as number;
    expect(draggedCenterX).toBeGreaterThan(startCenterX);
    expect(draggedOffsetX).toBeGreaterThan(startOffsetX);
    // Group translate applies the SAME delta to every member (multiTransform.ts).
    expect(draggedCenterX - startCenterX).toBeCloseTo(draggedOffsetX - startOffsetX, 0);

    // One batched undo step reverts BOTH members (buildGroupTransformUndoAction).
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => Math.abs(((await traitField(page, centerId, 'Transform', 'x')) as number) - startCenterX) < 1e-5).toBe(true);
    await expect.poll(async () => Math.abs(((await traitField(page, offsetId, 'Transform', 'x')) as number) - startOffsetX) < 1e-5).toBe(true);
  });

  /** #1161 — every 2D drag COMMITS in the pick canvas's pointerup. Without pointer capture a
   *  release off that canvas never reached it: no undo entry, and the drag stayed live, so a
   *  buttonless move back over the canvas kept dragging. `scene2DDragCapture.test.ts` can only
   *  pin the helper (jsdom does not route by capture); this is the spec that fails when the
   *  SceneView WIRING is wrong: the capture call dropped, or run before the press handler. It
   *  drags ONE entity, so only `dragRef` is exercised; dropping `groupDragRef`/`vertexDragRef`
   *  from the predicate is caught by QA-SVIEW-0011, not here. Playwright's mouse is trusted input, so Chromium's
   *  real capture routing is what runs here. */
  test('a gizmo drag RELEASED OUTSIDE the 2D canvas still commits one undo step, and a buttonless move after it drags nothing', async ({ page }) => {
    await gotoEditorWithScene(page, SCENE_2D, 'CenterSprite');
    await switchToUIMode(page);
    await page.getByText('CenterSprite', { exact: true }).click();
    const centerId = (await idByName(page, 'CenterSprite'))!;
    await expect.poll(() => primarySelectedId(page)).toBe(centerId);
    await waitForFrames(page);

    const canvas = page.locator('[data-2d-pick]');
    await canvas.waitFor({ state: 'visible', timeout: 10_000 });
    const box = await canvas.boundingBox();
    if (!box) throw new Error('2D overlay canvas has no bounding box');
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('no viewport size');
    // CenterSprite sits at the reference centre, so its free handle is the canvas centre pixel.
    const gizmoX = box.x + box.width / 2;
    const gizmoY = box.y + box.height / 2;
    // Past the canvas's right edge, still inside the window (a release outside the window is a
    // different gesture). Guard the premise: if the canvas reaches the window edge this spec
    // would release ON the canvas and pass without testing anything.
    const releaseX = Math.min(box.x + box.width + 60, viewport.width - 4);
    expect(releaseX, 'premise: the release point is outside the pick canvas').toBeGreaterThan(box.x + box.width);
    const startX = (await traitField(page, centerId, 'Transform', 'x')) as number;

    await page.mouse.move(gizmoX, gizmoY);
    await page.mouse.down();
    await page.mouse.move(releaseX, gizmoY, { steps: 12 });
    await page.mouse.up();

    const releasedX = (await traitField(page, centerId, 'Transform', 'x')) as number;
    expect(releasedX).toBeGreaterThan(startX);

    // No button held: a live (uncaptured, never-finished) drag would follow this move.
    await page.mouse.move(gizmoX - 40, gizmoY, { steps: 6 });
    await waitForFrames(page);
    expect((await traitField(page, centerId, 'Transform', 'x')) as number).toBeCloseTo(releasedX, 5);

    // The release committed a Transform step: undo lands back on the start. Without that entry
    // the top of the stack is the Hierarchy click's 'Select entity', and x would not move.
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => Math.abs(((await traitField(page, centerId, 'Transform', 'x')) as number) - startX) < 1e-5).toBe(true);
  });
});
