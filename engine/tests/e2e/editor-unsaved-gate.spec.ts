/** E2E — opening a scene over unsaved edits asks first (#1419).
 *
 *  Before #1419 `openAssetInEditor`'s scene branch called `loadScene` directly, so a human opening
 *  another scene from Assets (or the Inspector's Open Scene button — the same function) lost the
 *  open scene's edits with no prompt, and since #1409 the undo stack with them. The unit tests
 *  cover the decision (`unsavedGate.test.ts`) and that `openAssetInEditor` consults it
 *  (`openAssetInEditorGate.test.ts`); this spec proves the parts only a browser can: the modal
 *  actually appears over the live editor, lists the real cause, and each button does what it says
 *  to the real world.
 *
 *  It calls `openAssetInEditor` rather than double-clicking an Assets row: the fixture scenes live
 *  under `tests/e2e/fixtures/`, outside the open project's Assets panel, and the double-click →
 *  `openAssetInEditor` hop is pre-existing wiring (`Assets.tsx` `handleDoubleClick`). */

import { test, expect, type Page } from '@playwright/test';
import { gotoEditorWithScene, SCENE, SCENE_2D } from './helpers';

// Runtime URLs served by the Vite dev server — the same module instances the editor runs. Held in
// variables so they stay dynamic imports tsc does not try to follow.
const SERIALIZE = '/packages/modoki/src/editor/scene/serialize.ts';
const OPEN = '/packages/modoki/src/editor/panels/openAssetInEditor.ts';

const scenePath = (page: Page) => page.evaluate(async (u) => {
  const m = await import(/* @vite-ignore */ u) as { getCurrentScenePath: () => string | null };
  return m.getCurrentScenePath();
}, SERIALIZE);

const unsaved = (page: Page) => page.evaluate(async (u) => {
  const m = await import(/* @vite-ignore */ u) as { hasUnsavedChanges: () => boolean };
  return m.hasUnsavedChanges();
}, SERIALIZE);

/** Make a real edit: delete the fixture's first entity through the editor's UNDOABLE delete (the
 *  test bridge's `deleteEntity` is the raw runtime one, which is not an authoring edit and leaves
 *  the scene clean). */
async function dirtyTheScene(page: Page): Promise<number> {
  const before = await page.evaluate(() => (window as any).__modokiEditorTest.getAllEntities().length as number);
  await page.evaluate(async (u) => {
    const m = await import(/* @vite-ignore */ u) as { deleteEntityWithUndo: (id: number) => void };
    m.deleteEntityWithUndo((window as any).__modokiEditorTest.getAllEntities()[0].id);
  }, '/packages/modoki/src/editor/undo/entityActions.ts');
  expect(await unsaved(page), 'the delete must leave the scene dirty, or this spec proves nothing').toBe(true);
  return before - 1;
}

/** Start opening the 2D fixture the way Assets does. Not awaited: it waits on the modal. */
function startOpen(page: Page) {
  return page.evaluate(async ({ u, path }) => {
    const m = await import(/* @vite-ignore */ u) as { openAssetInEditor: (a: unknown) => Promise<void> };
    void m.openAssetInEditor({ path, type: 'scene', name: 'e2e-2d' });
  }, { u: OPEN, path: SCENE_2D });
}

const entityCount = (page: Page) =>
  page.evaluate(() => (window as any).__modokiEditorTest.getAllEntities().length as number);

test('opening a scene over unsaved edits shows Save / Discard / Cancel; Cancel and Escape keep the scene', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE);
  const remaining = await dirtyTheScene(page);

  await startOpen(page);
  const dialog = page.locator('[data-ui-id="unsaved-gate"]');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText('open scene e2e-2d');
  await expect(dialog).toContainText('unsaved scene changes');
  for (const b of ['save', 'discard', 'cancel']) await expect(page.locator(`[data-ui-id="unsaved-gate.${b}"]`)).toBeVisible();

  await page.locator('[data-ui-id="unsaved-gate.cancel"]').click();
  await expect(dialog).toBeHidden();
  expect(await scenePath(page)).toBe(SCENE);
  expect(await entityCount(page)).toBe(remaining);
  expect(await unsaved(page)).toBe(true);

  // Escape is Cancel too.
  await startOpen(page);
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await scenePath(page)).toBe(SCENE);
  expect(await entityCount(page)).toBe(remaining);
});

test('Discard opens the other scene', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE);
  await dirtyTheScene(page);

  await startOpen(page);
  await page.locator('[data-ui-id="unsaved-gate.discard"]').click();
  await expect.poll(() => scenePath(page), { timeout: 20_000 }).toBe(SCENE_2D);
  await expect(page.locator('[data-ui-id="unsaved-gate"]')).toHaveCount(0);
});

test('a clean scene opens the other scene without asking', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE);
  expect(await unsaved(page)).toBe(false);
  await startOpen(page);
  await expect.poll(() => scenePath(page), { timeout: 20_000 }).toBe(SCENE_2D);
  await expect(page.locator('[data-ui-id="unsaved-gate"]')).toHaveCount(0);
});
