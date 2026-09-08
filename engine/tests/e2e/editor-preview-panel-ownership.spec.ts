/** E2E — ▶ in the Animation panel plays the ANIMATION panel's clip, with the Timeline docked (#810).
 *
 *  The seam no unit test reaches. `isPreviewPlaying` is ONE editor-store flag and BOTH preview
 *  panels key their preview effect on it, so a single ▶ press ran both. Each then called
 *  `enterPreviewMode`, taking the single-valued `RunMode` from the other — and the Timeline ALWAYS
 *  lands second, because its entry sits behind an awaited `beginTimelinePreviewSession()`. It
 *  therefore always won `_modeOwner`, and once #810 gave displacement real teeth it stopped the
 *  Animation panel's rAF every time. Both panels auto-dock into the SAME tabset
 *  (`EditorApp.tsx`'s two auto-dock effects) and FlexLayout keeps a tab mounted once shown, so
 *  "both docked" is the ordinary configuration, not a contrived one.
 *
 *  ⚠️ WHY THIS IS AN E2E AND NOT A UNIT TEST. The decision itself lives in
 *  `editor/panels/previewOwnership.ts` and is unit-tested there, and
 *  `tests/architecture/previewOwnershipCallSites.test.ts` proves each panel passes its OWN id. But
 *  neither reaches the two `.tsx` call sites as production runs them: an adversarial review swapped
 *  `TimelineEditor`'s `'timeline'` for `'animation'` — reintroducing #810 verbatim — and all 3379
 *  editor tests stayed green. `CLAUDE.md` forbids mounting these panels in jsdom (that asserts the
 *  mock), so a real browser is the only place the wiring can be checked.
 *
 *  ⚠️ WHY THE PLAYHEAD ALONE IS NOT THE ASSERTION. With a timeline doc open, the Timeline's own
 *  loop advances `playheadTime` too — so "the playhead moved" passes under BOTH the correct and the
 *  broken behaviour. `previewModeOwner()` is the discriminating read: it must be the panel whose ▶
 *  was pressed. Asserting only the visible outcome here would have been the same vacuum this
 *  change's first test fell into.
 */

import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { gotoEditorWithScene } from './helpers';
import { pickHostProject } from './hostProject';

const HOST = pickHostProject();
test.skip(!HOST, 'editor-preview-panel-ownership: this snapshot ships no project to host the generated clip');

// `<root>/<name>/runtime/assets/<dir>` is served as `/<root>/<name>/assets/<dir>` — same mapping
// editor-particles.spec.ts relies on. See hostProject.ts for the pick and why it cannot throw.
const ABS_DIR = HOST ? path.join(HOST.dir, 'runtime/assets/__e2e_preview_owner__') : '';
const URL_DIR = HOST ? `/${HOST.root}/${HOST.name}/assets/__e2e_preview_owner__` : '';

/** A long, looping clip: the preview must still be running when we sample it, and `loop` keeps a
 *  slow CI machine from finishing the clip before the assertion (a finished clip calls
 *  `setPreviewPlaying(false)` itself, which would look exactly like the bug). */
const ANIM_JSON = {
  id: 'b1e4b0de-6f1f-4a0a-9a0e-2f0f5a6c7d81',
  name: 'E2E Preview Owner Clip',
  duration: 60,
  frameRate: 60,
  loop: true,
  tracks: [{
    path: '', trait: 'UIElement', field: 'textOpacity', type: 'number',
    keys: [
      { t: 0, v: 1, inTangent: 0, outTangent: 0, tangentMode: 'auto', broken: false },
      { t: 60, v: 0, inTangent: 0, outTangent: 0, tangentMode: 'auto', broken: false },
    ],
  }],
};

/** A REAL timeline doc, deliberately — not a missing file. A Timeline panel with no doc has its
 *  tick early-return every frame, which would make the playhead assertion discriminating for the
 *  wrong reason and hide whether ownership is actually correct. A healthy Timeline is the harder
 *  case: if it steals the mode, the playhead still advances and only the owner betrays it. */
const TIMELINE_JSON = {
  id: 'c2f5c1ef-7a2b-4b1b-8b1f-3a1f6b7d8e92',
  name: 'E2E Preview Owner Timeline',
  duration: 60,
  frameRate: 30,
  tracks: [],
};

test.beforeAll(async () => {
  // Explicit guard: with no host, ABS_DIR is '' and mkdirSync('') throws, which would turn the
  // clean file-level skip above into a failure on exactly the project-less snapshot it exists for.
  if (!HOST) return;
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
  fs.mkdirSync(ABS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ABS_DIR, 'e2e.anim.json'), JSON.stringify(ANIM_JSON, null, 2));
  fs.writeFileSync(path.join(ABS_DIR, 'e2e.timeline.json'), JSON.stringify(TIMELINE_JSON, null, 2));
});

test.afterAll(() => {
  if (!HOST) return;
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
});

/** Dock BOTH panels, Timeline first so the Animation panel ends up the selected one — the exact
 *  order a user produces by opening a timeline and then a clip. FlexLayout keeps the Timeline
 *  mounted once shown, which is what makes its effect fire on the same ▶. */
async function openBothPanels(page: import('@playwright/test').Page) {
  await page.evaluate((dir) => {
    const store = (window as any).__modokiEditorTest.store.getState();
    store.openTimelineEditor({ path: `${dir}/e2e.timeline.json`, type: 'timeline', name: 'e2e' }, null);
  }, URL_DIR);
  // Wait for the Timeline to have actually LOADED, not merely docked: its `enterPreviewMode` sits
  // behind that load, and racing it would mean the panel never competes and the test proves nothing.
  await page.waitForFunction(
    () => !!(window as any).__modokiEditorTest.store.getState().editingTimelineDoc,
    null, { timeout: 15_000 },
  );

  await page.evaluate((dir) => {
    const store = (window as any).__modokiEditorTest.store.getState();
    store.openAnimationEditor({ path: `${dir}/e2e.anim.json`, type: 'animation', name: 'e2e' }, null);
  }, URL_DIR);
  await page.waitForFunction(
    () => !!(window as any).__modokiEditorTest.store.getState().editingAnimationClip,
    null, { timeout: 15_000 },
  );
}

test('▶ in the Animation panel drives the ANIMATION panel, with the Timeline panel docked', async ({ page }) => {
  await gotoEditorWithScene(page);
  await openBothPanels(page);

  // Baseline: nothing owns the mode, nothing is playing.
  expect(await page.evaluate(() => (window as any).__modokiEditorTest.previewModeOwner())).toBeNull();
  expect(await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().isPreviewPlaying)).toBe(false);

  // ▶ in the ANIMATION panel — exactly what its transport button does, owner tag and all.
  await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().setPreviewPlaying(true, 'animation'));

  // Let both panels' effects run. The Timeline's entry lands a microtask (plus a session open)
  // after the Animation panel's, so this window has to be long enough for it to have competed —
  // sampling too early would pass even with the bug present.
  await page.waitForTimeout(1000);

  const after = await page.evaluate(() => {
    const t = (window as any).__modokiEditorTest;
    const s = t.store.getState();
    return { owner: t.previewModeOwner(), playing: s.isPreviewPlaying, previewOwner: s.previewOwner, playhead: s.playheadTime };
  });

  // THE discriminating assertion: the panel whose ▶ was pressed is the one driving. Before the fix
  // this read 'timeline' — the Timeline had taken the mode and stopped the Animation panel's loop.
  expect(after.owner).toBe('animation');
  expect(after.previewOwner).toBe('animation');
  // And the user-visible outcome: playback actually happened, and was not stopped by the other panel.
  expect(after.playing).toBe(true);
  expect(after.playhead).toBeGreaterThan(0);

  await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().setPreviewPlaying(false));
});

test('closing the idle Timeline panel does not stop an Animation-owned preview', async ({ page }) => {
  // The mirror face of the same defect, and the one the first fix missed: the shared flag is
  // written by every panel's teardown too, so an unguarded `setPreviewPlaying(false)` in the
  // Timeline's unmount cleanup stopped a RUNNING Animation preview when its idle tab was closed.
  await gotoEditorWithScene(page);
  await openBothPanels(page);

  await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().setPreviewPlaying(true, 'animation'));
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => (window as any).__modokiEditorTest.previewModeOwner())).toBe('animation');
  const before = await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().playheadTime);

  // Close the Timeline panel — it un-docks the tab, which unmounts the panel and runs the very
  // cleanup that used to clear the shared flag.
  await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().closeTimelineEditor());
  await page.waitForTimeout(600);

  const after = await page.evaluate(() => {
    const t = (window as any).__modokiEditorTest;
    const s = t.store.getState();
    return { playing: s.isPreviewPlaying, playhead: s.playheadTime, owner: t.previewModeOwner() };
  });

  expect(after.playing).toBe(true);            // the idle panel's close did not stop us
  expect(after.owner).toBe('animation');
  expect(after.playhead).toBeGreaterThan(before); // and it is still advancing

  await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().setPreviewPlaying(false));
});
