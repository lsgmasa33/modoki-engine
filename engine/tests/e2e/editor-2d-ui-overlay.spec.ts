/** #337 — the seam a real click actually takes through the SceneView's "ui" preview mode.
 *
 *  `editor-2d-ui.spec.ts` deliberately uses a fixture with NO Canvas2D for its UI-selection
 *  spec, precisely because a UI-vs-2D combined preview is where a real click can disagree with
 *  what `pick2D` alone would say (its own header comment). That means the arbiter this issue
 *  added (`uiPreviewPick.ts`'s `resolvePreviewPick`, wired into `SceneView.tsx`'s
 *  `UIEditorOverlay`) was previously exercised ONLY by pure unit tests calling
 *  `resolvePreviewPick` directly — never by an actual browser dispatching a real pointerdown/
 *  click through the real DOM. A pure test cannot fail if the WIRING is wrong: delete the
 *  capture-phase listener, or drop its `stopPropagation()`, and every unit test still passes
 *  (opus-reviewer, #337 close-out). This spec is that seam.
 *
 *  OWN fixture, not `e2e-2d.scene.json`: a full-bleed `pointerEvents:auto` UI sibling on TOP of
 *  the Canvas2D — needed to reproduce this bug — also sits on top of the `[data-2d-pick]` canvas
 *  the existing gizmo-drag spec drags directly, and swallows that drag's raw mousedown (a real
 *  regression, caught by actually running that spec after adding the overlay to the shared
 *  fixture — see `editor-2d-ui.spec.ts`'s own "separate fixtures on purpose" header). `DecorativeOverlay`
 *  here is fully transparent (`backgroundOpacity:0`), full-bleed over the whole Canvas2D — the
 *  same shape as Court's `HintCatcher`, the entity #337 was filed against. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene, switchToUIMode, idByName, stableBoundingBox, clickUntilSelected } from './helpers';

const SCENE_2D_UI_OVERLAY = '/tests/e2e/fixtures/e2e-2d-ui-overlay.scene.json';

test('UI mode: a real click on a decorative UI overlay falls through to the 2D entity beneath it', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE_2D_UI_OVERLAY, 'DecorativeOverlay');
  await switchToUIMode(page);

  // Sanity: the overlay really is mounted and really does cover the sprite — otherwise this
  // spec would pass by construction (clicking empty overlay space) rather than by reconciling
  // the paint stack.
  const overlayId = await idByName(page, 'DecorativeOverlay');
  const overlay = page.locator(`[data-ui-preview-frame] [data-entity-id="${overlayId}"]`);
  await overlay.waitFor({ state: 'visible', timeout: 10_000 });

  const canvas = page.locator('[data-2d-pick]');
  const box = await stableBoundingBox(canvas);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2; // CenterSprite sits at the Canvas2D reference center

  // A plain DOM hit-test at this point resolves to the overlay (it is on top and pointerEvents
  // auto) — confirms the click really would have landed on the wrong element pre-fix.
  const domTarget = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest('[data-entity-id]')?.getAttribute('data-entity-id') ?? null;
  }, { x: cx, y: cy });
  expect(Number(domTarget)).toBe(overlayId);

  // `clickUntilSelected`, not a bare click+poll (helpers.ts's own warning: a single synthetic
  // click can land before the renderer has a pickable frame, and a missed pick can't recover on
  // its own with `retries:0`/`workers:1`) — selection is idempotent, so re-clicking is safe.
  await clickUntilSelected(page, cx, cy, 'CenterSprite');
});

test('UI mode: clicking the overlay where NO 2D entity sits still selects the overlay (no regression)', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE_2D_UI_OVERLAY, 'DecorativeOverlay');
  await switchToUIMode(page);

  const canvas = page.locator('[data-2d-pick]');
  const box = await stableBoundingBox(canvas);
  // Top-left corner: far from CenterSprite (mid-canvas in Canvas2D reference space) —
  // decorative overlay over empty 2D space must stay selectable, matching pre-#337 behavior for
  // a fully-transparent full-bleed container.
  const x = box.x + 4;
  const y = box.y + 4;

  // Note: this one passes even with the whole arbiter deleted (it agrees with plain DOM routing
  // and returns early) — it is the no-regression guard, not itself proof the fix works. The test
  // above is the one that actually exercises the reconciliation.
  await clickUntilSelected(page, x, y, 'DecorativeOverlay');
});
