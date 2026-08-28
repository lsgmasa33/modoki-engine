/** Real-browser E2E for #392: the Skin editor's weight-paint brush must not tunnel between
 *  brush stamps on a fast stroke.
 *
 *  Everything about the SWEEP MATH itself (`sweepSegment`, `paintStrokeCenters`,
 *  `advancePaintStroke`) is unit-tested headlessly (`tests/editor/skinPaintGesture.test.ts`,
 *  `tests/runtime/core/segmentSweep.test.ts`) — that is not what this spec is for.
 *
 *  What headless coverage CANNOT reach: whether `SkinCanvas.tsx`'s `onPointerMove` actually
 *  CALLS the sweep. `SkinCanvas` is a panel driven by raw `PointerEvent`s on a `<canvas>`, so
 *  it cannot be mounted in jsdom (docs/editor.md § Panels) — a close-out review on the #392
 *  fix confirmed this gap is real: reverting the panel's sweep call back to a single stamp
 *  per move (fully re-introducing #392) left `npm run verify` green, because nothing asserted
 *  the panel wires the tested pure functions in. This is the "one e2e spec for the real
 *  gesture" docs/editor.md's own Panels convention calls for.
 *
 *  The check doesn't try to reconstruct SkinCanvas's private canvas→texture-space transform
 *  (fit scale/pan/zoom are unexported React refs) — instead it compares the SET of vertices a
 *  FAST single-jump stroke paints against the set a SLOW, densely-sampled stroke over the
 *  IDENTICAL screen path paints. If the sweep fires, both strokes cover the same continuous
 *  band; if it's missing, the fast stroke leaves the INTERIOR of the path unpainted (the two
 *  stamps at its ends don't overlap) while the slow one — which Playwright itself samples
 *  densely via `steps` — does not. That difference is exactly what a broken `onPointerMove`
 *  produces and a correct one cannot, independent of the coordinate transform. */

import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gotoEditorWithScene, stableBoundingBox } from './helpers';

// games/skin-test is the documented fixture for the Skin editor (docs/2d-skinning.md
// "Fixture + tests"): a generated 64×256 striped bar.png + a 3-bone base→mid→tip
// bar.rig2d.json. Absent from the public OSS snapshot (games/ is private-only), so this
// spec skips there rather than failing — the same pattern editor-particles.spec.ts uses.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RIG_FS_PATH = path.join(REPO_ROOT, 'games/skin-test/runtime/assets/rigs/bar.rig2d.json');
const HAS_FIXTURE = fs.existsSync(RIG_FS_PATH);
test.skip(!HAS_FIXTURE, 'editor-skin-paint-sweep: games/skin-test is absent from this snapshot');

// Fully-qualified so it resolves regardless of which project (if any) the e2e dev server's
// MODOKI_PROJECT happens to be — every discovered project's assets are served under
// /<root>/<name>/assets/... independent of the "active" one (see hostProject.ts).
const RIG_PATH = '/games/skin-test/assets/rigs/bar.rig2d.json';
const MID_BONE_INDEX = 1; // bones: base(0) → mid(1) → tip(2), per bar.rig2d.json

// The default 1280x720 e2e viewport is narrow enough that the docked layout's Console
// tabset overlaps the Skin editor's — both report as "selected" (they're in different
// tabsets) but Console paints on top, so a synthetic click at the Skin canvas's own
// bounding-box coordinates lands on Console instead. A wider viewport (matching a real
// editor window, ~1600x968 measured live) gives every default panel its own screen area.
test.use({ viewport: { width: 1600, height: 1000 } });

/** Per-vertex weight for `boneIndex` across the whole (v1, top-level) mesh, read straight off
 *  the live (unsaved) rig doc — never off disk, never via a screenshot. `bar.rig2d.json` ships
 *  auto-weighted (its bones already carry nonzero weight from the auto-rig pipeline), so
 *  "painted" below is always a DELTA against a captured baseline, never an absolute threshold. */
async function boneWeights(page: import('@playwright/test').Page, boneIndex: number): Promise<number[]> {
  return page.evaluate((bone) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const def = (window as any).__editorStore.getState().editingSkinDef as { skinIndices: number[]; skinWeights: number[] } | null;
    if (!def) return [];
    const { skinIndices: si, skinWeights: sw } = def;
    const out: number[] = [];
    for (let v = 0; v < sw.length / 4; v++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si[v * 4 + k] === bone) w += sw[v * 4 + k];
      out.push(w);
    }
    return out;
  }, boneIndex);
}

/** Vertices whose weight rose measurably above `baseline` — what THIS stroke painted, isolated
 *  from the rig's pre-existing auto-weight. */
function newlyPainted(after: number[], baseline: number[]): Set<number> {
  const out = new Set<number>();
  after.forEach((w, v) => { if (w - baseline[v] > 0.02) out.add(v); });
  return out;
}

test('a fast single-jump stroke paints the same interior vertices as an equivalent slow drag', async ({ page }) => {
  await gotoEditorWithScene(page);

  // Open the rig in Weights mode — a plain store mutation (mirrors what a double-click in
  // the Assets panel does); EditorApp's own effect auto-selects/creates the skin-editor tab.
  await page.evaluate((rigPath) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__editorStore;
    store.getState().openSkinEditor({ path: rigPath, type: 'rig2d', name: 'bar' });
    store.getState().setSkinMode('weights');
  }, RIG_PATH);
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => !!(window as any).__editorStore.getState().editingSkinDef,
    null,
    { timeout: 15_000 },
  );

  // Select the MIDDLE bone (not base or tip) — its footprint is a genuinely interior band a
  // broken (two-stamp) paint would visibly gap, unlike an end bone whose footprint could
  // plausibly be reached by a single stamp near the stroke's start or end alone.
  await page.locator(`[data-ui-id="skin.bones.row.${MID_BONE_INDEX}"]`).click();

  const canvas = page.locator('[data-ui-id="skin.canvas"]');
  const box = await stableBoundingBox(canvas);
  // Off-centre in x so the vertical stroke doesn't ride the bone chain itself (all three
  // bones sit at local x=0, i.e. canvas-centre) — painting empty space beside it, not
  // through a bone joint's own hit-test.
  const strokeX = box.x + box.width * 0.65;
  const topY = box.y + box.height * 0.2;
  const bottomY = box.y + box.height * 0.8;

  const baseline = await boneWeights(page, MID_BONE_INDEX);

  // ── FAST: one big jump, no intermediate frames — exactly #392's repro shape. ──
  await page.mouse.move(strokeX, topY);
  await page.mouse.down();
  await page.mouse.move(strokeX, bottomY); // Playwright's default (no `steps`): ONE mousemove.
  await page.mouse.up();
  const fast = newlyPainted(await boneWeights(page, MID_BONE_INDEX), baseline);
  expect(fast.size, 'the fast stroke painted nothing new at all — selection/setup is broken, not the sweep').toBeGreaterThan(0);

  await page.locator('[data-ui-id="skin.toolbar.undo"]').click();
  await expect.poll(() => boneWeights(page, MID_BONE_INDEX)).toEqual(baseline);

  // ── SLOW: the identical screen path, densely sampled — the reference footprint. ──
  await page.mouse.move(strokeX, topY);
  await page.mouse.down();
  await page.mouse.move(strokeX, bottomY, { steps: 80 });
  await page.mouse.up();
  const slow = newlyPainted(await boneWeights(page, MID_BONE_INDEX), baseline);

  await page.locator('[data-ui-id="skin.toolbar.undo"]').click();
  await expect.poll(() => boneWeights(page, MID_BONE_INDEX)).toEqual(baseline);

  const missing = [...slow].filter((v) => !fast.has(v));
  expect(missing, `fast stroke missed vertices the slow reference reached: [${missing.join(',')}] — the sweep did not fire`).toEqual([]);
});
