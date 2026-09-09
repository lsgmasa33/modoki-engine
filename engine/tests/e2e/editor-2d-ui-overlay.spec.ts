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
import { gotoEditorWithScene, switchToUIMode, idByName, stableBoundingBox, clickUntilSelected, selectedName } from './helpers';

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

/** #999/#1001 — the OTHER half of this seam: a click whose DOM target IS the `[data-2d-pick]`
 *  canvas, with no UI element above it.
 *
 *  The spec above covers a UI element ON TOP of the canvas, which is the only arrangement in
 *  which `SceneView.tsx`'s arbiter actually runs — its pick-canvas branch returns early. That
 *  early return was the defect: the canvas's own handler selects correctly on `pointerdown`, but
 *  the browser then dispatches a SEPARATE `click` for the same gesture, and a Canvas2D host is a
 *  LEAF in the UI tree (UINode gives it neither an `onClick` nor pointer events), so that click
 *  bubbles PAST it to the nearest ancestor UI node that does have a handler — here `ScreenRoot` —
 *  which re-selects itself and silently overwrites the correct pick milliseconds later.
 *
 *  ⚠️ The fixture needs a UI ANCESTOR above the canvas host, which is why it is not
 *  `e2e-2d.scene.json` (Canvas2D at the root there, so there is nothing to escape TO and this
 *  would pass by construction). `ScreenRoot` is the ancestor; `BoardHost` is the Canvas2D.
 *  Nothing covers the canvas, so the pick canvas is genuinely the click target.
 *
 *  Reproduced by hand in three games before this was written (wordweave #999, court #1001,
 *  chess) — and the winner's own opacity was irrelevant in all three, because the winner is
 *  simply the nearest ancestor with a click handler. */
const SCENE_2D_NESTED = '/tests/e2e/fixtures/e2e-2d-nested-canvas.scene.json';

test('UI mode: a click straight on the 2D pick canvas selects the 2D entity, not the UI ancestor above it', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE_2D_NESTED, 'ScreenRoot');
  await switchToUIMode(page);

  const hostId = await idByName(page, 'BoardHost');

  const canvas = page.locator('[data-2d-pick]');
  const box = await stableBoundingBox(canvas);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2; // CenterSprite sits at the Canvas2D reference center

  // Sanity, and what makes this spec non-vacuous: the DOM target here really IS the pick canvas
  // (not some UI element on top, which would put us back in the first spec's arrangement), and
  // that canvas sits inside BoardHost. BoardHost is the Canvas2D, so UINode gives it no onClick —
  // which is why the trailing click escapes past it to ScreenRoot. Without these two assertions
  // the spec could pass on a fixture where no escape was ever possible.
  const probe = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return {
      isPickCanvas: !!el?.closest('[data-2d-pick]'),
      nearestUi: el?.closest('[data-entity-id]')?.getAttribute('data-entity-id') ?? null,
    };
  }, { x: cx, y: cy });
  expect(probe.isPickCanvas).toBe(true);
  expect(Number(probe.nearestUi)).toBe(hostId);

  await clickUntilSelected(page, cx, cy, 'CenterSprite');

  // ⚠️ The overwrite arrives on the `click` that FOLLOWS the pointerdown, so a selection read
  // taken too eagerly sees the correct pick and passes through the bug. Settle, then re-assert:
  // pre-fix this flips to ScreenRoot, post-fix it stays put.
  await page.waitForTimeout(250);
  expect(await selectedName(page), 'the trailing click must not re-select the UI ancestor')
    .toBe('CenterSprite');
});

/** #999/#1001, the second half — an EMPTY point on the same canvas.
 *
 *  Nothing above covers this: the spec before it clicks the canvas CENTRE, which is a 2D hit, so
 *  `pickUnderlyingUIEntity`'s host bound is never reached — delete the `canvasEntityId` argument
 *  at its call site and every other test in the change stays green. The older overlay fixture
 *  cannot cover it either: its `Canvas2D` is at the ROOT, so a miss there resolves to a SIBLING
 *  (`'unrelated'`), never `'ancestor-of-host'`.
 *
 *  It also pins the thing that made the two picking paths disagree: `resolvePreviewPickAt`
 *  (priority 20, which owns `modoki_tap`'s prediction) and `pickEntityAtViewportPoint`
 *  (priority 10, which a real click runs) must give the SAME answer here. Unbounded, the
 *  predictor said `ScreenRoot` — opaque, and an ancestor — where a real click selects `BoardHost`,
 *  so the tool refused a reachable entity as occluded and reported ok for one the click never
 *  landed on. `screenPick.ts`'s header is the rule; this is its test. */
test('UI mode: an EMPTY point on the canvas selects the canvas host, and the predictor agrees', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE_2D_NESTED, 'ScreenRoot');
  await switchToUIMode(page);

  const canvas = page.locator('[data-2d-pick]');
  const box = await stableBoundingBox(canvas);
  // Top-left corner — inside the canvas, far from CenterSprite at the reference centre.
  const x = box.x + 4;
  const y = box.y + 4;

  // The predictor's answer at this point, BEFORE any click perturbs the selection.
  const predicted = await page.evaluate(({ px, py }) => (window as unknown as {
    __modokiEditorTest: { predictPickAt: (x: number, y: number) => number | null | undefined };
  }).__modokiEditorTest.predictPickAt(px, py) ?? null, { px: x, py: y });

  await clickUntilSelected(page, x, y, 'BoardHost');
  await page.waitForTimeout(250);
  expect(await selectedName(page), 'an empty-canvas click selects the canvas host (owner, 2026-09-09)')
    .toBe('BoardHost');

  const hostId = await idByName(page, 'BoardHost');
  expect(predicted, 'the priority-20 predictor must agree with what the real click selected')
    .toBe(hostId);
});

/** #999/#1001 close-out §2d — the test that actually pins the MenuBar half.
 *
 *  ⚠️ Written after a mutation check showed the two dismiss tests in
 *  `editor-build-menu-submenu.spec.ts` pass under the PRE-FIX implementation too: they guard the
 *  new `mousedown` + containment-guard behaviour against a careless edit, but neither of them can
 *  fail for the reason the change was made. This one can.
 *
 *  The defect needs BOTH halves on screen at once, which is why it lives here and not with the
 *  other menu specs: the arbiter's `onClickCapture` calls `stopPropagation()` in the CAPTURE phase
 *  on the preview frame, so a click on the 2D pick canvas never reaches the target and never
 *  bubbles to `window`. `MenuBar` was the editor's only outside-dismiss keyed to `click` on
 *  `window`, so the dropdown survived and floated over the editor. `mousedown` is untouched by
 *  the swallow, so the fixed version dismisses.
 *
 *  ⚠️ Web editor only, and that is not a limitation of the test — `EditorApp.tsx` renders
 *  `MenuBar` under `!electronBridge` because the OS menu replaces it under Electron. So this
 *  defect was never reachable in the packaged/dev Electron editor at all. */
test('UI mode: clicking the 2D canvas dismisses an open menu (the swallow must not starve MenuBar)', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE_2D_NESTED, 'ScreenRoot');
  await switchToUIMode(page);

  await page.getByRole('button', { name: 'Build', exact: true }).click();
  const iosItem = page.getByRole('button', { name: /^\s*iOS Device — / });
  await expect(iosItem, 'precondition: the menu is open before the canvas click').toBeVisible();

  // Dead centre of the pick canvas — a genuine 2D hit, so this is the exact gesture whose
  // trailing click the arbiter swallows.
  const canvas = page.locator('[data-2d-pick]');
  const box = await stableBoundingBox(canvas);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect(iosItem, 'the swallowed click must still have dismissed the menu').toBeHidden();
});
