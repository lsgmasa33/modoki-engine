/** E2E — Hierarchy context-menu improvements in a real browser: the reorganized
 *  menu (entity actions on top, shortcut hints, separators, collapsed "Create ▸"
 *  submenu), Copy → Paste (+ undo), Create Prefab (write intercepted — nothing
 *  touches disk), Focus (F key reframes the SceneView orbit camera), and Toggle
 *  Active. These exercise wiring jsdom can't: real context menus, real keyboard
 *  routing, and the real serialize → POST prefab path. */

import { test, expect, type Page } from '@playwright/test';
import { gotoEditorWithScene, entityNames, idByName, traitField, selectedName } from './helpers';

/** Read the currently-open ContextMenu (the fixed div at zIndex 10000) as a
 *  structured list, so we can assert order/shortcuts/separators precisely. */
function readMenu(page: Page) {
  return page.evaluate(() => {
    const menu = [...document.querySelectorAll('div')].find(
      (d) => d.style.position === 'fixed' && d.style.zIndex === '10000',
    );
    if (!menu) return null;
    return [...menu.children].map((c) => {
      const el = c as HTMLElement;
      const separator = el.style.height === '1px';
      const shortcutEl = [...el.querySelectorAll('span')].find((s) => (s as HTMLElement).style.fontSize === '11px');
      // The label is the row's first text node; shortcut hint + ▶ arrow live in
      // sibling spans, so reading textContent would smear them together.
      const label = (el.childNodes[0]?.nodeValue ?? '').trim();
      return {
        text: label,
        separator,
        disabled: el.style.color === 'rgb(85, 85, 85)', // #555
        shortcut: shortcutEl?.textContent ?? null,
        hasSubmenu: (el.textContent ?? '').includes('▶'),
      };
    });
  });
}

const camPos = (page: Page) =>
  page.evaluate(() => {
    const c = (window as any).__sceneViewCamera;
    return c ? [c.position.x, c.position.y, c.position.z] : null;
  });

test('context menu is reorganized: actions on top, shortcuts, separators, disabled Paste', async ({ page }) => {
  await gotoEditorWithScene(page);
  await page.getByText('CenterCube', { exact: true }).click({ button: 'right' });

  const items = await readMenu(page);
  expect(items).not.toBeNull();
  const byText = (t: string) => items!.find((i) => i.text.startsWith(t));

  // Entity actions come first, with shortcut hints.
  expect(items![0].text.startsWith('Rename')).toBe(true);
  expect(byText('Rename')!.shortcut).toBe('F2');
  expect(byText('Duplicate')!.shortcut).toBe('⌘D');
  expect(byText('Copy')!.shortcut).toBe('⌘C');
  expect(byText('Cut')!.shortcut).toBe('⌘X');
  // Paste is disabled with an empty clipboard.
  expect(byText('Paste')!.disabled).toBe(true);
  // Focus + the collapsed Create submenu + a danger Delete with ⌫.
  expect(byText('Focus')!.shortcut).toBe('F');
  expect(items!.find((i) => i.text === 'Create' && i.hasSubmenu)).toBeTruthy();
  expect(byText('Delete')!.shortcut).toBe('⌫');
  // At least two divider rows group the sections.
  expect(items!.filter((i) => i.separator).length).toBeGreaterThanOrEqual(2);
});

test('Copy → Paste deep-copies the entity under the target, and undo reverts it', async ({ page }) => {
  await gotoEditorWithScene(page);
  const countCube = async () => (await entityNames(page)).filter((n) => n === 'CenterCube').length;
  expect(await countCube()).toBe(1);

  await page.getByText('CenterCube', { exact: true }).click({ button: 'right' });
  await page.locator('[data-menu-item="Copy"]').click();

  await page.getByText('OffsetSphere', { exact: true }).click({ button: 'right' });
  await page.locator('[data-menu-item="Paste"]').click();

  await expect.poll(countCube).toBe(2);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(countCube).toBe(1);
});

test('F key frames the selected entity in the SceneView orbit camera', async ({ page }) => {
  await gotoEditorWithScene(page);
  await page.getByText('CenterCube', { exact: true }).click();
  await expect.poll(() => selectedName(page)).toBe('CenterCube');

  // Park the camera far away, then press F to reframe.
  await page.evaluate(() => { (window as any).__sceneViewCamera.position.set(99, 99, 99); });
  await page.keyboard.press('f');

  await expect.poll(async () => (await camPos(page))![0]).not.toBe(99);
  const [x, y, z] = (await camPos(page))!;
  // Reframed near the cube (fixture cube sits at/near the origin), not at (99,99,99).
  expect(Math.hypot(x - 99, y - 99, z - 99)).toBeGreaterThan(10);
});

test('Create Prefab serializes the subtree and POSTs a .prefab.json (write intercepted)', async ({ page }) => {
  await gotoEditorWithScene(page);

  // Pin the writable root resolution so the test doesn't depend on real assets.
  await page.route('**/api/rescan-assets', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ assets: [{ path: '/games/3d-test/assets/seed.png', name: 'seed', type: 'texture' }] }),
    }));
  let write: { path?: string; content?: string } | null = null;
  await page.route('**/api/write-file', async (route) => {
    write = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.getByText('CenterCube', { exact: true }).click({ button: 'right' });
  await page.getByText('Create Prefab', { exact: true }).click();

  await expect.poll(() => write).not.toBeNull();
  expect(write!.path).toMatch(/\/games\/3d-test\/assets\/prefabs\/CenterCube\.prefab\.json$/);
  const prefab = JSON.parse(write!.content!);
  expect(prefab.version).toBe(1);
  expect(prefab.name).toBe('CenterCube');
});

test('Deactivate flips EntityAttributes.isActive', async ({ page }) => {
  await gotoEditorWithScene(page);
  const id = await idByName(page, 'CenterCube');
  expect(await traitField(page, id!, 'EntityAttributes', 'isActive')).toBe(true);

  await page.getByText('CenterCube', { exact: true }).click({ button: 'right' });
  await page.getByText('Deactivate', { exact: true }).click();

  await expect.poll(() => traitField(page, id!, 'EntityAttributes', 'isActive')).toBe(false);
});
