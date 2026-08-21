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
 *  Both entry points are covered, because they have DIFFERENT preconditions: the
 *  Hierarchy item needs the entity's `EntityAttributes.guid` and is disabled
 *  without one, while the Assets item falls back to the asset's path and so can
 *  never be disabled. `fixtures/e2e-smoke.scene.json` originally had no guids on
 *  any entity, which made the Hierarchy half untestable and is why guids were
 *  backfilled into it — that was the fixture being old rather than a real-world
 *  shape, since across all 40 committed scenes 80-100% of entities carry a guid,
 *  the lone exception per scene being the resource entity, which has nothing to
 *  find references to anyway. */

import { test, expect } from '@playwright/test';
import { gotoEmptyEditor, gotoEditorWithScene } from './helpers';

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

/** The Hierarchy half, and the §5 refusal it happens to exercise.
 *
 *  `fixtures/e2e-smoke.scene.json` is loaded through the test bridge and lives under
 *  `engine/tests/e2e/`, NOT under a project's asset roots — so the on-disk graph the
 *  route walks does not contain its entities. That makes this the ideal place to pin
 *  the rule that matters most on this surface: an entity the graph cannot find is
 *  REFUSED, naming what was expected. It must never come back as "nothing references
 *  this", which a reader acts on by deleting something.
 *
 *  So this test proves three things at once — the menu item is enabled when the
 *  entity has a guid, clicking it reaches the route, and an unresolvable target
 *  refuses rather than lying. */
test('Hierarchy → Find References is enabled on a guid-bearing entity, and an unresolvable target refuses', async ({ page }) => {
  await gotoEditorWithScene(page);

  await page.getByText('CenterCube', { exact: true }).click({ button: 'right' });
  const item = page.locator('[data-menu-item="Find References"]');
  await expect(item).toBeVisible();
  // The precondition that makes this half of the feature reachable at all: the item
  // is disabled without `EntityAttributes.guid`. This assertion is also what stops
  // the fixture's backfilled guids being dropped later as noise.
  await expect(item).not.toHaveCSS('color', 'rgb(85, 85, 85)');
  await item.click();

  const dialog = page.locator('[data-testid="find-references-dialog"]');
  await expect(dialog).toBeVisible();

  // Asserted STRUCTURALLY, on the error element, not by matching the route's refusal
  // text: that string lives in editorBackendRouter.ts, and a spec matching it across
  // files is two copies of one sentence that must stay equal. The marker cannot drift.
  await expect(dialog.locator('[data-testid="find-references-error"]')).toBeVisible();

  // The load-bearing half: a refusal, NOT a green "nothing references this" banner.
  // Getting this wrong is the §5 false success — a reader deletes something.
  await expect(dialog.locator('[data-testid="find-references-unreferenced"]')).toHaveCount(0);
  await expect(dialog.locator('[data-testid="find-references-hit"]')).toHaveCount(0);

  await page.locator('[data-testid="find-references-close"]').click();
  await expect(dialog).toHaveCount(0);
});
