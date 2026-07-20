/** E2E — Assets panel Finder-like interactions in a real browser: multi-select
 *  (modifier-click + Cmd/Ctrl+A), New Folder, context-menu Duplicate, and inline
 *  Rename. Mutation endpoints (/api/create-folder, /api/duplicate-asset,
 *  /api/move-file) are intercepted so nothing touches the repo on disk — the
 *  test asserts the request was made with the right payload and that the UI
 *  reacts, which is what e2e (vs the fs-ops integration test) is here to prove:
 *  real DOM events, real context menus, real keyboard routing. */

import { test, expect, type Page } from '@playwright/test';
import { gotoEmptyEditor } from './helpers';

/** Category groups are collapsed by default (empty `expanded` set). Seed the
 *  type-keyed expanded set + section header + folder root so asset rows are actually
 *  rendered in a fresh browser context. Keys mirror Assets.tsx: the expanded set lives
 *  under 'editor:assets:expanded:v2' and category groups key on the asset TYPE name
 *  (ASSET_TYPE_ORDER); '@@assets-section' is the v2 top-level "Assets" header. */
async function gotoEditorWithAssets(page: Page) {
  await page.addInitScript(() => {
    const types = [
      'scene', 'prefab', 'model', 'mesh', 'material', 'texture', 'sprite', 'atlas',
      'animation', 'animset', 'particle', 'shader', 'environment', 'font', 'script', 'layout',
      '@@assets-section', '/',
    ];
    localStorage.setItem('editor:assets:viewMode', 'category');
    localStorage.setItem('editor:assets:expanded:v2', JSON.stringify(types));
  });
  await gotoEmptyEditor(page);
  // The default FlexLayout shows the Game tab in the bottom tabset; activate the
  // Assets tab so the panel (and its asset rows) actually mount.
  await page.locator('.flexlayout__tab_button', { hasText: 'Assets' }).click();
  await page.locator('[data-asset-path]').first().waitFor({ state: 'visible', timeout: 30_000 });
}

const rowPaths = (page: Page) =>
  page.$$eval('[data-asset-path]', (els) => els.map((e) => e.getAttribute('data-asset-path')!));

test('modifier-click builds a multi-selection (footer shows the count)', async ({ page }) => {
  await gotoEditorWithAssets(page);
  const rows = page.locator('[data-asset-path]');
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['ControlOrMeta'] });
  await rows.nth(4).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByText('3 selected', { exact: true })).toBeVisible();
});

test('Cmd/Ctrl+A selects every visible asset', async ({ page }) => {
  await gotoEditorWithAssets(page);
  const total = (await rowPaths(page)).length;
  expect(total).toBeGreaterThan(1);
  await page.locator('[data-asset-path]').first().click(); // focuses the list container
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.getByText(`${total} selected`, { exact: true })).toBeVisible();
});

test('type filter narrows the list to one kind (footer shows N of M)', async ({ page }) => {
  await gotoEditorWithAssets(page);
  // Open the "Type" filter dropdown (replaced the old chip row).
  await page.locator('button[title="Filter by asset type"]').click();
  // The 'texture' row shows its count (e.g. "texture27"); read it, then enable it.
  const row = page.locator('label', { hasText: 'texture' }).first();
  await row.waitFor({ state: 'visible' });
  const count = Number((await row.textContent())!.trim().match(/(\d+)\s*$/)![1]);
  await row.locator('input[type="checkbox"]').click();

  // Footer switches to the "N of M assets" form, and every visible row is a texture.
  await expect(page.getByText(/^\d+ of \d+ assets$/)).toBeVisible();
  const paths = await rowPaths(page);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.length).toBeLessThanOrEqual(count);
  // "All types" clears the filter → full list again.
  await page.locator('label', { hasText: 'All types' }).locator('input[type="checkbox"]').click();
  await expect(page.getByText(/^\d+ assets$/)).toBeVisible();
});

test('Import writes picked files into the project as base64', async ({ page }) => {
  await gotoEditorWithAssets(page);
  const writes: any[] = [];
  await page.route('**/api/write-file', async (route) => {
    writes.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  // Imported .png triggers a conversion pass — intercept it too.
  await page.route('**/api/reimport', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ converted: 1, errors: [] }) }));

  // Drive the hidden picker directly (no native dialog). Target defaults to root.
  await page.locator('[data-import-input]').setInputFiles({
    name: 'imported-pixel.png', mimeType: 'image/png', buffer: Buffer.from('fake-png-bytes'),
  });

  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes[0].path).toMatch(/imported-pixel\.png$/);
  expect(writes[0].encoding).toBe('base64');
  // base64 of "fake-png-bytes"
  expect(writes[0].content).toBe(Buffer.from('fake-png-bytes').toString('base64'));
});

test('New Folder button creates a folder and drops it into inline rename', async ({ page }) => {
  await gotoEditorWithAssets(page);
  let createBody: any = null;
  await page.route('**/api/create-folder', async (route) => {
    createBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.getByTitle('New Folder (⇧⌘N)').click();

  await expect.poll(() => createBody?.path).toMatch(/New Folder$/);
  // The new folder enters inline rename immediately (folder view, focused input).
  await expect.poll(() =>
    page.evaluate(() => [...document.querySelectorAll('input')].some((i) => (i as HTMLInputElement).value === 'New Folder')),
  ).toBe(true);
});

test('context-menu Duplicate posts a copy request for the row', async ({ page }) => {
  await gotoEditorWithAssets(page);
  let dupBody: any = null;
  await page.route('**/api/duplicate-asset', async (route) => {
    dupBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, guid: 'e2e' }) });
  });

  const first = page.locator('[data-asset-path]').first();
  const fromPath = await first.getAttribute('data-asset-path');
  await first.click({ button: 'right' });
  await page.getByText('Duplicate', { exact: true }).click();

  await expect.poll(() => dupBody?.from).toBe(fromPath);
  expect(dupBody.to).toContain(' copy'); // collision-free " copy" name
});

test('context-menu Move to Trash posts ONE batched delete and drops the row', async ({ page }) => {
  await gotoEditorWithAssets(page);
  const deletes: any[] = [];
  // Intercept so nothing on disk is touched; assert the request + the UI reaction.
  await page.route('**/api/delete-asset', async (route) => {
    deletes.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  // collectDeletion also reads the asset (snapshot for undo) and, for models, its
  // meta; stub those so the flow completes without real fetches.
  await page.route('**/api/read-meta**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }));

  const first = page.locator('[data-asset-path]').first();
  const targetPath = await first.getAttribute('data-asset-path');
  await first.click({ button: 'right' });
  await page.getByText(/^Move to Trash/).click();

  // The delete is now a SINGLE request carrying a `paths` list (one OS-trash
  // call → one trash sound), not one POST per file.
  await expect.poll(() => deletes.length).toBe(1);
  await expect.poll(() => deletes[0]?.paths).toContain(targetPath);
  // The deleted row is removed from the panel.
  await expect.poll(() => rowPaths(page)).not.toContain(targetPath);
});

test('context-menu Rename → type → Enter posts a move-file', async ({ page }) => {
  await gotoEditorWithAssets(page);
  let moveBody: any = null;
  await page.route('**/api/move-file', async (route) => {
    moveBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  const first = page.locator('[data-asset-path]').first();
  const fromPath = await first.getAttribute('data-asset-path');
  await first.click({ button: 'right' });
  await page.getByText('Rename', { exact: true }).click();

  // The inline field is auto-focused with the current base name selected.
  await page.keyboard.type('e2e_renamed');
  await page.keyboard.press('Enter');

  await expect.poll(() => moveBody?.from).toBe(fromPath);
  expect(moveBody.to).toContain('e2e_renamed');
});
