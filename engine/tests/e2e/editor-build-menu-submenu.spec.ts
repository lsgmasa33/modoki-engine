/** Real-browser E2E for the Build menu's device-target SUBMENU (#170).
 *
 *  buildTargetMenu.test.ts already covers WHICH rows exist and what picking one writes — that half
 *  is pure. What no unit test can prove is that a `submenu` item actually renders a flyout in the
 *  in-window `MenuBar`: the hover state, and the wrapper that keeps the flyout alive while the
 *  pointer crosses from the row to it. (Under Electron the OS menu replaces this bar entirely and
 *  is covered by projectsMenu.test.ts instead; the browser editor is where this component runs.)
 *
 *  Deliberately READ-ONLY — no device row is clicked. Picking one POSTs `user.device.*` to a live
 *  /api/project-settings, which would write the e2e project's real project.user.json; the flyout
 *  rendering is the only thing this layer adds. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene } from './helpers';

test('hovering the iOS build item opens its device submenu', async ({ page }) => {
  await gotoEditorWithScene(page);

  await page.getByRole('button', { name: 'Build', exact: true }).click();
  // The parent names its current target, so match on the stable prefix rather than the device.
  const iosItem = page.getByRole('button', { name: /^\s*iOS Device — / });
  await expect(iosItem).toBeVisible();

  // "Refresh devices" is the one row present in EVERY state of the submenu — with no phone
  // attached, no adb, or off-Mac, the device rows are replaced by an explanation but this stays.
  const refresh = page.getByRole('button', { name: 'Refresh devices' });
  await expect(refresh).toBeHidden();

  await iosItem.hover();
  await expect(refresh.first()).toBeVisible();
});

test('CLICKING the parent row opens its submenu (it is not the build button any more)', async ({ page }) => {
  // The parent used to BE the build item. It now carries a submenu, and Electron ignores a click
  // on a submenu parent — so the in-window bar must not act on one either, or the two renderers
  // would disagree about what the same row does. "Build now" inside the submenu is the build.
  //
  // This asserts the POSITIVE consequence (the flyout opens) rather than "no build started", and
  // that is deliberate: a negative network assertion here was measured USELESS. Restoring the
  // parent's action does not reach `/api/build` at all in this environment — `runBuild`'s
  // toolchain preflight fails first and opens Build Support — and asserting that dialog is hidden
  // passes instantly, before the async preflight could ever have opened it. The OS-menu side of
  // this rule is pinned deterministically in engine/tests/electron/projectsMenu.test.ts, which
  // asserts a submenu parent gets no click handler at all.
  await gotoEditorWithScene(page);
  await page.getByRole('button', { name: 'Build', exact: true }).click();
  await page.getByRole('button', { name: /^\s*iOS Device — / }).click();

  await expect(page.getByRole('button', { name: 'Refresh devices' }).first()).toBeVisible();
});

test('the submenu closes when the pointer leaves its parent row', async ({ page }) => {
  await gotoEditorWithScene(page);

  await page.getByRole('button', { name: 'Build', exact: true }).click();
  await page.getByRole('button', { name: /^\s*iOS Device — / }).hover();
  await expect(page.getByRole('button', { name: 'Refresh devices' }).first()).toBeVisible();

  // Another top-level Build row — leaving the parent must retract the flyout, or two submenus
  // could be open at once over the same space.
  await page.getByRole('button', { name: /^\s*Build Support…/ }).hover();
  await expect(page.getByRole('button', { name: 'Refresh devices' })).toBeHidden();
});
