/** Hierarchy folder-drag-sync (2026-07-27 fix, hierarchyFolders.ts's
 *  `resolveDropFolderSync`) — the REAL browser wiring, not just the pure decision logic
 *  hierarchyFolders.test.ts covers. Before this fix, dropping a folder member next to an
 *  already-ungrouped sibling reparented it (sortOrder/parentId) but silently left the
 *  stale `editorFolder` tag — the only WORKING "drag out of a folder" gesture was
 *  dropping on the panel's empty background, which is unreachable once the tree overflows
 *  the panel (any real scene). This drives a REAL HTML5 drag (Playwright's `dragTo`, which
 *  Chromium turns into native dragstart/dragover/drop over `draggable` rows) so a future
 *  refactor of the drop handler can't silently regress the fix jsdom/unit tests can't see. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene, idByName, stableBoundingBox } from './helpers';

// `EntityAttributes.editorFolder` isn't in the curated Inspector field subset `traitField`
// reads (entityUtils.ts's readTraitData) — it's surfaced on getAllEntities()'s EntityInfo
// instead (entityUtils.ts buildEntityTree/getAllEntities, line ~376), same as the Hierarchy
// panel itself reads it.
const editorFolderOf = (page: import('@playwright/test').Page, id: number): Promise<string | undefined> =>
  page.evaluate((i) => (window as any).__modokiEditorTest.getAllEntities().find((e: any) => e.id === i)?.editorFolder, id);

/** Right-click `name`'s row and fold it into a fresh "New Folder" via the entity's own
 *  context menu (Hierarchy.tsx ctxMenuItems — distinct from the root/empty-area menu's
 *  copy of the same item). Commits the folder's auto-opened rename with the default name
 *  so the row isn't left in an editable state before the drag. */
async function foldIntoNewFolder(page: import('@playwright/test').Page, name: string) {
  await page.getByText(name, { exact: true }).click({ button: 'right' });
  await page.locator('[data-menu-item="New Folder"]').click();
  await page.keyboard.press('Enter'); // commit the rename input with the default name
}

test('Hierarchy: dropping a folder member next to an ungrouped sibling clears its folder tag', async ({ page }) => {
  await gotoEditorWithScene(page);
  const offsetId = await idByName(page, 'OffsetSphere');
  const centerId = await idByName(page, 'CenterCube');

  await foldIntoNewFolder(page, 'OffsetSphere');
  await expect.poll(() => editorFolderOf(page, offsetId!)).toBe('New Folder');

  const source = page.locator(`[data-entity-row="${offsetId}"]`);
  const target = page.locator(`[data-entity-row="${centerId}"]`);
  // Retry the geometry READ — folding re-parents rows, so there is a real window where they are
  // remounting and `boundingBox()` returns null. A `toBeVisible()` gate before the read is NOT
  // enough (check-then-act); see stableBoundingBox.
  const targetBox = await stableBoundingBox(target);
  // Bottom ~90% of the row → the "after" zone (detectZone: bottom 25% = after). CenterCube
  // is ungrouped, so this is the "drag out of a folder by dropping near an ungrouped
  // sibling" gesture — the one the original bug report actually meant.
  await source.dragTo(target, { targetPosition: { x: 20, y: Math.floor(targetBox!.height * 0.9) } });

  await expect.poll(() => editorFolderOf(page, offsetId!)).toBe('');
  // The drop target itself is untouched — only the dragged entity's tag changes.
  expect(await editorFolderOf(page, centerId!)).toBeFalsy();
});

test('Hierarchy: dropping next to a folder member adopts that folder', async ({ page }) => {
  await gotoEditorWithScene(page);
  const offsetId = await idByName(page, 'OffsetSphere');
  const centerId = await idByName(page, 'CenterCube');

  await foldIntoNewFolder(page, 'OffsetSphere');
  await expect.poll(() => editorFolderOf(page, offsetId!)).toBe('New Folder');

  // CenterCube (ungrouped) drops next to OffsetSphere (now inside "New Folder") →
  // adopts the same folder, the inverse of the case above.
  const source = page.locator(`[data-entity-row="${centerId}"]`);
  const target = page.locator(`[data-entity-row="${offsetId}"]`);
  // See the sibling test above. This is the case that actually flaked — twice, and the second
  // time (ci/main, 2026-08-03) THROUGH the `toBeVisible()` gate that was added for the first:
  // the target here is the row that was just folded, so it is the one remounting when the
  // geometry read lands.
  const targetBox = await stableBoundingBox(target);
  await source.dragTo(target, { targetPosition: { x: 20, y: Math.floor(targetBox!.height * 0.9) } });

  await expect.poll(() => editorFolderOf(page, centerId!)).toBe('New Folder');
});
