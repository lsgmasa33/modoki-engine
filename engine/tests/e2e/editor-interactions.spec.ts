/** Phase 3 (extended) — real-browser editor interactions beyond click-to-select:
 *  Inspector field edit → ECS, keyboard undo + delete, context-menu create, and the
 *  Cmd+S save path (intercepted so no file is written). These exercise wiring that
 *  jsdom/headless can't: real keyboard routing, real context menus, the real
 *  Inspector → writeField path, and the real serialize → POST save payload. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene, selectedName, entityNames, idByName, traitField, setInputByValue } from './helpers';

test('Inspector edit: changing the name field updates the entity in the ECS', async ({ page }) => {
  await gotoEditorWithScene(page);
  await page.getByText('CenterCube', { exact: true }).click();
  await expect.poll(() => selectedName(page)).toBe('CenterCube');

  await setInputByValue(page, 'CenterCube', 'RenamedCube');

  await expect.poll(() => selectedName(page)).toBe('RenamedCube');
});

test('keyboard Cmd+Z reverts an Inspector edit', async ({ page }) => {
  await gotoEditorWithScene(page);
  const id = await idByName(page, 'CenterCube');
  await page.getByText('CenterCube', { exact: true }).click();

  await setInputByValue(page, 'CenterCube', 'RenamedCube');
  await expect.poll(() => traitField(page, id!, 'EntityAttributes', 'name')).toBe('RenamedCube');

  await page.keyboard.press('Meta+z');
  await expect.poll(() => traitField(page, id!, 'EntityAttributes', 'name')).toBe('CenterCube');
});

test('Hierarchy context menu → Create Empty adds a child entity', async ({ page }) => {
  await gotoEditorWithScene(page);
  const before = (await entityNames(page)).length;

  await page.getByText('OffsetSphere', { exact: true }).click({ button: 'right' });
  // "Create" is now a submenu — hover to open it, then pick "Empty".
  await page.locator('[data-menu-item="Create"]').hover();
  await page.locator('[data-menu-item="Empty"]').click();

  await expect.poll(async () => (await entityNames(page)).length).toBe(before + 1);
  expect(await entityNames(page)).toContain('New Entity');
});

test('keyboard delete removes the selected entity', async ({ page }) => {
  await gotoEditorWithScene(page);
  await page.getByText('OffsetSphere', { exact: true }).click();
  await expect.poll(() => selectedName(page)).toBe('OffsetSphere');

  await page.keyboard.press('Meta+Backspace'); // macOS delete-entity shortcut
  await expect.poll(async () => (await entityNames(page)).includes('OffsetSphere')).toBe(false);
});

test('Cmd+S serializes the live scene and POSTs it to /api/write-file', async ({ page }) => {
  await gotoEditorWithScene(page);
  // Make a change so we can prove the saved payload reflects current ECS state.
  await page.getByText('CenterCube', { exact: true }).click();
  await setInputByValue(page, 'CenterCube', 'SavedCube');

  // Intercept the write so nothing touches disk (the fixture stays pristine).
  let body: { path?: string; content?: string } | null = null;
  await page.route('**/api/write-file', async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.keyboard.press('Meta+s');

  await expect.poll(() => body).not.toBeNull();
  const scene = JSON.parse(body!.content!);
  expect(scene.version).toBe(9);
  expect(scene.entities.some((e: any) => e.name === 'SavedCube')).toBe(true);
});
