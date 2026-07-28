/** Phase 3 (extended) — real-browser editor interactions beyond click-to-select:
 *  Inspector field edit → ECS, keyboard undo + delete, context-menu create, and the
 *  Cmd+S save path (intercepted so no file is written). These exercise wiring that
 *  jsdom/headless can't: real keyboard routing, real context menus, the real
 *  Inspector → writeField path, and the real serialize → POST save payload. */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gotoEditorWithScene, selectedName, entityNames, idByName, traitField, setInputByValue } from './helpers';

// Read the constant from source TEXT, not a module import: Playwright loads .spec.ts
// files directly in Node (see the `module.register()` hook), which does not run Vite's
// `define` replacement — importing `@modoki/engine/runtime` here pulls in code with a
// bare `__MODOKI_MODULE_RENDER2D__` reference (a Vite-only global) and throws
// `ReferenceError` before a single test can even be listed. Mirrors
// engine/tests/plugins/scaffoldVersion.test.ts's own text-parse technique, used for
// exactly this reason.
function readSceneFormatVersion(): number {
  const versionTs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/modoki/src/runtime/core/version.ts');
  const src = readFileSync(versionTs, 'utf8');
  const m = src.match(/SCENE_FORMAT_VERSION\s*=\s*(\d+)/);
  if (!m) throw new Error('SCENE_FORMAT_VERSION not found in version.ts');
  return Number(m[1]);
}
const SCENE_FORMAT_VERSION = readSceneFormatVersion();

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

  await page.keyboard.press('ControlOrMeta+z');
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

  // Hierarchy registers BOTH 'mod+Backspace' and 'Delete', and 'mod' is Cmd on mac /
  // Ctrl elsewhere — so ControlOrMeta+Backspace hits the real binding on either platform.
  await page.keyboard.press('ControlOrMeta+Backspace');
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

  await page.keyboard.press('ControlOrMeta+s');

  await expect.poll(() => body).not.toBeNull();
  const scene = JSON.parse(body!.content!);
  // Must track SCENE_FORMAT_VERSION (runtime/core/version.ts) — this rotted silently
  // after the base-scene plan's Phase 1 bump (9→10, commit 0657034e) because
  // e2e isn't gated in CI (see CLAUDE.md "Tests"); caught running the suite by
  // hand for an unrelated editor-DOM change (base-scene plan Phase 8). Now
  // imported symbolically so a future bump can't silently rot this again.
  expect(scene.version).toBe(SCENE_FORMAT_VERSION);
  expect(scene.entities.some((e: any) => e.name === 'SavedCube')).toBe(true);
});
