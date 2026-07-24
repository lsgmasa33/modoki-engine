import { type Page, expect } from '@playwright/test';

export const SCENE = '/tests/e2e/fixtures/e2e-smoke.scene.json';
export const SCENE_2D = '/tests/e2e/fixtures/e2e-2d.scene.json';

/** Navigate to the editor with a fixture scene loaded and the WebGL2 path forced.
 *  Waits until the scene has populated (optionally until a named entity exists). */
export async function gotoEditorWithScene(page: Page, scene = SCENE, waitForEntity?: string) {
  // Force WebGL2 (detection does requestAdapter/Device → "no WebGPU" → WebGL2/SwiftShader).
  await page.addInitScript(() => { try { delete (navigator as any).gpu; } catch { /* ignore */ } });
  await page.goto('/#/editor');
  await page.waitForSelector('[data-scene-viewport] canvas', { timeout: 30_000 });
  // Load the fixture through the bridge rather than seeding localStorage: the editor
  // scopes its last-scene key per project (`modoki-last-scene:<project>`), so a plain
  // `modoki-last-scene` write is silently ignored and the fixture never loads.
  await page.waitForFunction(() => !!(window as any).__modokiEditorTest, null, { timeout: 30_000 });
  const ok = await page.evaluate((s) => (window as any).__modokiEditorTest.loadScene(s), scene);
  if (!ok) throw new Error(`gotoEditorWithScene: loadScene('${scene}') returned false`);
  await page.waitForFunction((name) => {
    const ents = (window as any).__modokiEditorTest.getAllEntities();
    return name ? ents.some((e: any) => e.name === name) : ents.length > 0;
  }, waitForEntity ?? null, { timeout: 30_000 });
}

/** Navigate to the editor (no fixture scene) with WebGL2 forced. Waits until
 *  the viewport canvas is up and the dev test bridge is installed. */
export async function gotoEmptyEditor(page: Page) {
  await page.addInitScript(() => { try { delete (navigator as any).gpu; } catch { /* ignore */ } });
  await page.goto('/#/editor');
  await page.waitForSelector('[data-scene-viewport] canvas', { timeout: 30_000 });
  await page.waitForFunction(() => !!(window as any).__modokiEditorTest, null, { timeout: 30_000 });
}

/** Switch the SceneView viewport to UI/2D mode (the select whose options include 'ui'). */
export async function switchToUIMode(page: Page) {
  await page.locator('select:has(option[value="ui"])').selectOption('ui');
}

/** Wait for the renderer to draw `n` frames — a synthetic click/drag fired the
 *  instant after a scene load or selection can land before the WebGL frame (and
 *  thus the raycast targets / gizmo overlay) is ready. */
export async function waitForFrames(page: Page, n = 2) {
  await page.evaluate(
    (count) => new Promise<void>((resolve) => {
      let left = count;
      const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    }),
    n,
  );
}

/** Click a viewport pixel and retry until `expected` is selected. A single synthetic
 *  click can land before the renderer has a pickable frame; expect.poll re-reads the
 *  selection but never re-clicks, so a missed pick can't recover on its own. */
export async function clickUntilSelected(page: Page, x: number, y: number, expected: string) {
  await expect.poll(async () => {
    await page.mouse.click(x, y);
    return selectedName(page);
  }, { timeout: 15_000, intervals: [150, 300, 500, 800] }).toBe(expected);
}

export const selectedName = (page: Page) =>
  page.evaluate(() => (window as any).__modokiEditorTest?.selectedEntityName() ?? null);

export const entityNames = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as any).__modokiEditorTest.getAllEntities().map((e: any) => e.name));

export const idByName = (page: Page, name: string): Promise<number | null> =>
  page.evaluate((n) => (window as any).__modokiEditorTest.getAllEntities().find((e: any) => e.name === n)?.id ?? null, name);

export const traitField = (page: Page, id: number, trait: string, field: string): Promise<unknown> =>
  page.evaluate(({ i, t, f }) => (window as any).__modokiEditorTest.traitField(i, t, f), { i: id, t: trait, f: field });

/** Whether an entity's rendered 3D object is currently visible in the SceneView — null when
 *  no 3D viewport is mounted or the entity has no rendered object. See devTestBridge's
 *  `isMeshVisible`. */
export const isMeshVisible = (page: Page, id: number): Promise<boolean | null> =>
  page.evaluate((i) => (window as any).__modokiEditorTest.isMeshVisible(i), id);

/** Whether an entity has a live 2D display-object slot in the editor's ui-mode Pixi renderer.
 *  See devTestBridge's `has2DSprite`. */
export const has2DSprite = (page: Page, id: number): Promise<boolean> =>
  page.evaluate((i) => (window as any).__modokiEditorTest.has2DSprite(i), id);

/** Click a checkbox row inside the SceneView's "View ▾" dropdown (ViewOptionsMenu,
 *  SceneView.tsx) — opens the menu first (via `menuUiId`) only if the row isn't already
 *  visible, so repeated toggles of the same session don't need to re-open it every time. */
export async function clickViewOption(page: Page, menuUiId: string, itemUiId: string) {
  const item = page.locator(`[data-ui-id="${itemUiId}"]`);
  if (!(await item.isVisible().catch(() => false))) {
    await page.locator(`[data-ui-id="${menuUiId}"]`).click();
    await item.waitFor({ state: 'visible', timeout: 5_000 });
  }
  await item.click();
}

/** Project an entity's WORLD position through the live 3D SceneView camera into PAGE (client)
 *  coordinates the same way the real marquee/raycast do — see devTestBridge's
 *  `screenPositionOf`. Lets a test compute a click/drag target for an arbitrary entity instead
 *  of relying on a hardcoded camera/projection fact. Null when no 3D viewport is mounted, the
 *  entity has no world transform yet, or it projects behind the camera. */
export const screenPositionOf = (page: Page, id: number): Promise<{ x: number; y: number } | null> =>
  page.evaluate((i) => (window as any).__modokiEditorTest.screenPositionOf(i), id);

/** Find the Inspector input currently showing `currentValue`, type `newValue`, and blur.
 *  Locating by live value (a DOM property React controls) sidesteps brittle label/index
 *  selectors — we tag the element, drive it via Playwright, then untag. */
export async function setInputByValue(page: Page, currentValue: string, newValue: string) {
  await page.waitForFunction(
    (cur) => [...document.querySelectorAll('input')].some((i) => (i as HTMLInputElement).value === cur),
    currentValue,
    { timeout: 10_000 },
  );
  await page.evaluate((cur) => {
    const inp = [...document.querySelectorAll('input')].find((i) => (i as HTMLInputElement).value === cur);
    inp?.setAttribute('data-e2e-target', '');
  }, currentValue);
  const field = page.locator('[data-e2e-target]');
  await field.fill(newValue);
  await field.blur();
  await page.evaluate(() => document.querySelector('[data-e2e-target]')?.removeAttribute('data-e2e-target'));
}
