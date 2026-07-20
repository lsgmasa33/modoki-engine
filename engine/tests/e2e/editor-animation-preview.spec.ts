/** E2E — the Animation-editor preview must NOT drive skeletal mixers, in a real browser.
 *
 *  Regression: pressing ▶ to preview a (keyframe) clip in the Scene window used to flip
 *  a GLOBAL "advance skeletal mixers while stopped" flag in SceneView's render loop. That
 *  animated every rig's baked skeletal clip out of Play mode AND made syncBones re-pose
 *  the previewed clip's bones from the stale ECS `Animator.time` (0) — so the keyframe
 *  looked frozen on screen. The fix never flips that flag for a keyframe preview.
 *
 *  This asserts the policy end-to-end: with the editor Stopped, turning the Animation
 *  preview on must leave the runtime skeletal-preview flag OFF. SceneView's render loop
 *  is what (used to) set it, so a real browser frame loop is the only faithful check —
 *  if the coupling is reintroduced, this flag flips to true and the test fails. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene } from './helpers';

test('enabling Animation preview does not turn on the skeletal-mixer flag', async ({ page }) => {
  // Any scene with a live SceneView render loop exercises the policy — the flag is set
  // by SceneView's animate(), independent of which entities the scene holds.
  await gotoEditorWithScene(page);

  // Baseline: nothing is previewing, so the flag is off.
  expect(await page.evaluate(() => (window as any).__modokiEditorTest.isSkeletalPreviewing())).toBe(false);

  // Turn on the Animation preview exactly as the transport ▶ does (sim stays Stopped).
  await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().setPreviewPlaying(true));
  expect(await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().isPreviewPlaying)).toBe(true);

  // Let many SceneView frames run — any one of them could have flipped the flag.
  await page.waitForTimeout(800);

  // The fix: a keyframe preview never drives the global skeletal mixers.
  expect(await page.evaluate(() => (window as any).__modokiEditorTest.isSkeletalPreviewing())).toBe(false);

  // And it clears cleanly when the preview stops.
  await page.evaluate(() => (window as any).__modokiEditorTest.store.getState().setPreviewPlaying(false));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).__modokiEditorTest.isSkeletalPreviewing())).toBe(false);
});
