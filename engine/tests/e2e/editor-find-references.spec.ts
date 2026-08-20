/** E2E — "Find References" reaches the screen (#284).
 *
 *  This spec exists because of a specific failure class, not for coverage: the
 *  repo's dominant defect is a mechanism that is correct but cannot FIRE — a menu
 *  item nothing renders, a dialog nothing mounts, a store flag no component reads.
 *  Every other layer of this feature is verified elsewhere (the graph by unit +
 *  integration tests, the route and the MCP tool live against a running editor),
 *  and all of that passes whether or not a human can actually reach it.
 *
 *  Only a real browser can answer that: a jsdom mount would assert the mock, and
 *  hand-driving the Electron window through the agent surface proved unreliable
 *  (an unfocused window produces no context menu at all).
 *
 *  Kept deliberately shallow — that the item is there, that it opens the dialog,
 *  and that the dialog settles on an answer. The CONTENT of that answer is the
 *  graph's job and is pinned in `engine/tests/plugins/assetRefGraph*.test.ts`;
 *  asserting a reference COUNT here would pin the fixture's contents, not the
 *  feature.
 *
 *  Driven from the ASSETS panel rather than the Hierarchy on purpose. The
 *  Hierarchy item needs the entity's `EntityAttributes.guid` and is disabled
 *  without one — and `fixtures/e2e-smoke.scene.json` has no guids on any entity,
 *  so every row there would correctly render the item greyed out. (That is the
 *  fixture being old, not a real-world shape: measured across all 40 committed
 *  scenes, 80-100% of entities carry a guid, the lone exception per scene being
 *  the resource entity, which has nothing to find references to anyway.) The
 *  Assets item has no such precondition — it falls back to the asset's path. */

import { test, expect } from '@playwright/test';
import { gotoEmptyEditor } from './helpers';

/** Category groups collapse by default, so seed the expanded set to get rows.
 *  Mirrors `gotoEditorWithAssets` in editor-assets.spec.ts. */
async function gotoEditorWithAssets(page: import('@playwright/test').Page) {
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
  await page.locator('.flexlayout__tab_button', { hasText: 'Assets' }).click();
  await page.locator('[data-asset-path]').first().waitFor({ state: 'visible', timeout: 30_000 });
}

test('Assets → Find References opens the dialog and it settles on an answer', async ({ page }) => {
  await gotoEditorWithAssets(page);

  await page.locator('[data-asset-path]').first().click({ button: 'right' });
  const item = page.locator('[data-menu-item="Find References"]');
  await expect(item).toBeVisible();
  // #555 is ContextMenu's disabled colour. The Assets item must never be disabled —
  // it falls back to the asset path when there is no guid.
  await expect(item).not.toHaveCSS('color', 'rgb(85, 85, 85)');
  await item.click();

  const dialog = page.locator('[data-testid="find-references-dialog"]');
  await expect(dialog).toBeVisible();

  // The scan is a filesystem walk behind a fetch — wait for it to settle into an
  // answer rather than asserting on the "Scanning…" frame. Either outcome (a hit
  // list, or the "nothing references this" banner) is a real answer.
  await expect(async () => {
    const settled = await dialog.evaluate((d) =>
      !!d.querySelector('[data-testid="find-references-unreferenced"]')
      || d.querySelectorAll('[data-testid="find-references-hit"]').length > 0);
    expect(settled).toBe(true);
  }).toPass({ timeout: 20_000 });

  await page.locator('[data-testid="find-references-close"]').click();
  await expect(dialog).toHaveCount(0);
});
