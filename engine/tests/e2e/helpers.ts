import { type Page, expect } from '@playwright/test';

export const SCENE = '/tests/e2e/fixtures/e2e-smoke.scene.json';
export const SCENE_2D = '/tests/e2e/fixtures/e2e-2d.scene.json';

/** Pin the dock layout to the SHIPPED DEFAULT for every spec, in both directions.
 *
 *  WRITE (`POST`) is swallowed so a spec cannot persist a dock-layout change into this
 *  clone's `.modoki/layouts/autosave.layout.json`.
 *
 *  That file is gitignored and is read back on EVERY editor boot, including a fresh Playwright
 *  context — so a layout written by one spec is inherited by every later run AND by the human's
 *  next editor launch. It is not covered by "e2e leaves the working tree unchanged": `git diff`
 *  cannot see an ignored file. Measured 2026-08-19: a spec that opened the Particle Editor panel
 *  left a `particle-editor` tab SELECTED over the Scene tab, so `[data-scene-viewport] canvas`
 *  never mounted again and the whole suite timed out at boot — at HEAD, with no source change,
 *  which reads exactly like a real regression. Blocked in the goto helpers so a spec cannot
 *  forget; `page.unroute('**\/api/layout')` if you are actually testing layout persistence.
 *
 *  READ (`GET`) is answered 404 for the same reason, and blocking only the write was NOT
 *  enough: `loadInitialModel` reads the autosave on every boot, so a developer's saved
 *  arrangement silently replaced the default in local runs while CI — which has no autosave
 *  — booted the default. The two were testing different editors, and that is not academic:
 *  a change to `defaultLayout` left the Assets type-filter menu covered by a sibling panel,
 *  `editor-assets.spec.ts` went red on the public runner, and the local suite stayed 55/55
 *  green on this clone for three merges. A 404 falls through `readLayout`'s `!res.ok` arm to
 *  the default, which is exactly the fresh-clone state CI reproduces. */
async function blockLayoutAutosave(page: Page) {
  // ⚠️ Routed by PATHNAME, not by the glob `**/api/layout`. Playwright matches a glob against
  // the FULL url including the query, so `**/api/layout` matches the write (`POST /api/layout`,
  // no query) and silently MISSES the read (`GET /api/layout?name=autosave`) — a no-op that
  // looks like an interception. Measured: with the glob, a spec still booted this clone's saved
  // layout. Pathname equality also keeps `/api/layout-bounds` and `/api/layout-delete` — real,
  // unrelated endpoints — out of the match, which a `**/api/layout*` glob would swallow.
  await page.route((url) => url.pathname === '/api/layout', (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"e2e":"layout write suppressed"}' });
    }
    if (method === 'GET') {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false,"e2e":"layout read pinned to default"}' });
    }
    return route.continue();
  });
}

/** Navigate to the editor with a fixture scene loaded and the WebGL2 path forced.
 *  Waits until the scene has populated (optionally until a named entity exists). */
export async function gotoEditorWithScene(page: Page, scene = SCENE, waitForEntity?: string) {
  // Force WebGL2 (detection does requestAdapter/Device → "no WebGPU" → WebGL2/SwiftShader).
  await page.addInitScript(() => { try { delete (navigator as any).gpu; } catch { /* ignore */ } });
  await blockLayoutAutosave(page);
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
  await blockLayoutAutosave(page);
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

/** Read a locator's box, retrying until it HAS one. `boundingBox()` — unlike an action — does
 *  NOT auto-wait: it returns null the instant the element is detached, and the caller's
 *  `box!.height` then throws a bare `TypeError: Cannot read properties of null`.
 *
 *  The obvious guard, `await expect(loc).toBeVisible()` before the read, does not work and was
 *  already tried: it is a check-then-act race, and the element can remount in the gap between
 *  the assertion resolving and the read landing. That is precisely how it failed again on the
 *  public gate (ci/main, 2026-08-03) after being "fixed" — passing locally, and passing on CI
 *  until a loaded runner widened the gap.
 *
 *  Retrying the READ closes the window, because the poll re-measures rather than trusting an
 *  earlier observation. Only needed for elements that genuinely remount (Hierarchy rows during
 *  a re-parent); a canvas is stable and can be read directly. */
export async function stableBoundingBox(loc: import('@playwright/test').Locator) {
  let box: Awaited<ReturnType<typeof loc.boundingBox>> = null;
  await expect
    .poll(async () => {
      box = await loc.boundingBox();
      return box?.height ?? 0;
    }, { timeout: 10_000 })
    .toBeGreaterThan(0);
  return box!;
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
