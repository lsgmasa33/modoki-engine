/** E2E — Inspector multi-entity editing in a real browser. Exercises wiring that
 *  jsdom can't: real modifier-key click routing (⌘/Ctrl + Shift), the Hierarchy →
 *  store multi-selection, the Inspector rendering shared traits with `----` for
 *  mixed values, broadcast edits across the selection, and keyboard-undo of a
 *  multi-entity write. Fixture: CenterCube and OffsetSphere share the same trait
 *  set and differ only in Transform.y (0 vs 8); Ambient Light has a Light trait
 *  the cube lacks. */

import { test, expect, type Page } from '@playwright/test';
import { gotoEditorWithScene, idByName, traitField } from './helpers';

/** The editor store's full multi-selection set, via the dev test bridge. */
const selectedIds = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as any).__modokiEditorTest.store.getState().selectedEntityIds);

test('⌘/Ctrl-click builds a multi-selection and the Inspector shows shared traits', async ({ page }) => {
  await gotoEditorWithScene(page);
  const cube = await idByName(page, 'CenterCube');
  const sphere = await idByName(page, 'OffsetSphere');

  await page.getByText('CenterCube', { exact: true }).click();
  await expect.poll(() => selectedIds(page)).toEqual([cube]);

  // Modifier-click adds the second entity to the set.
  await page.getByText('OffsetSphere', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(async () => (await selectedIds(page)).slice().sort((a, b) => a - b))
    .toEqual([cube, sphere].sort((a, b) => a - b));

  // Header reflects the count, and the shared Transform renders — with y (0 vs 8)
  // shown as the mixed placeholder (the trait read lands a tick after the header).
  await expect(page.getByText('2 entities selected')).toBeVisible();
  await expect.poll(() => page.locator('input[placeholder="----"]').count()).toBeGreaterThan(0);
});

test('Shift-click selects a contiguous range in visible order', async ({ page }) => {
  await gotoEditorWithScene(page);
  const cube = await idByName(page, 'CenterCube');
  const ambient = await idByName(page, 'Ambient Light');

  await page.getByText('CenterCube', { exact: true }).click();
  await page.getByText('Ambient Light', { exact: true }).click({ modifiers: ['Shift'] });

  // The range spans from the anchor (CenterCube, top row) down to Ambient Light,
  // so it includes both endpoints and the rows between them — strictly more than
  // the two clicked.
  await expect.poll(async () => {
    const ids = await selectedIds(page);
    return ids.includes(cube!) && ids.includes(ambient!) && ids.length >= 3;
  }).toBe(true);
});

test('editing in multi-select broadcasts to every entity, and Cmd+Z restores each', async ({ page }) => {
  await gotoEditorWithScene(page);
  const cube = await idByName(page, 'CenterCube');
  const sphere = await idByName(page, 'OffsetSphere');

  await page.getByText('CenterCube', { exact: true }).click();
  await page.getByText('OffsetSphere', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(async () => (await selectedIds(page)).length).toBe(2);

  // Both start active; toggling the header Active checkbox writes to both.
  await page.locator('input[title="Active"]').click();
  await expect.poll(() => traitField(page, cube!, 'EntityAttributes', 'isActive')).toBe(false);
  await expect.poll(() => traitField(page, sphere!, 'EntityAttributes', 'isActive')).toBe(false);

  // A single undo entry restores both entities.
  await page.keyboard.press('Meta+z');
  await expect.poll(() => traitField(page, cube!, 'EntityAttributes', 'isActive')).toBe(true);
  await expect.poll(() => traitField(page, sphere!, 'EntityAttributes', 'isActive')).toBe(true);
});

test('multi-select with differing components shows the "not shared" note', async ({ page }) => {
  await gotoEditorWithScene(page);

  // CenterCube has Renderable3DPrimitive; Ambient Light has Light. Their only
  // shared component is Transform — the rest are surfaced as a note.
  await page.getByText('CenterCube', { exact: true }).click();
  await page.getByText('Ambient Light', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(async () => (await selectedIds(page)).length).toBe(2);

  // The note label and the (alphabetically-sorted) trait names render in sibling
  // spans, so assert each separately.
  await expect(page.getByText(/Not shared by all/)).toBeVisible();
  await expect(page.getByText('Light, Renderable3DPrimitive')).toBeVisible();
});
