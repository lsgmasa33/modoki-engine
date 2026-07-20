/** E2E — particle effects are referenced by GUID (not literal path), end-to-end in a
 *  real browser through the live /api asset pipeline.
 *
 *  Regression: particles used to be referenced by literal path, so a scene reference
 *  dangled the moment the file moved/renamed. The fix gives every .particle.json a
 *  GUID in-file (`id`) that the scanner bakes into the manifest, so scenes reference
 *  the GUID. This test proves the full chain works in-browser:
 *    1. the scene loads its ParticleEmitter with a GUID effect ref,
 *    2. the live manifest resolves that GUID → the confetti .particle.json path,
 *    3. that file's own in-file `id` round-trips back to the same GUID.
 *  Before the fix, step 2 fails — the scanner never read particle GUIDs, so the
 *  manifest had no entry for this id. */

import { test, expect } from '@playwright/test';
import { gotoEditorWithScene, idByName, traitField } from './helpers';

const SCENE = '/tests/e2e/fixtures/e2e-particle.scene.json';
// confetti.particle.json's stable in-file GUID (games/3d-test/runtime/assets/particles).
const CONFETTI_GUID = '1cd1ed3b-4d9a-4b19-9e93-0ff54eb79e32';

test('scene loads a ParticleEmitter that references its effect by GUID', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE, 'Confetti Emitter');
  const id = await idByName(page, 'Confetti Emitter');
  expect(id).not.toBeNull();
  // The emitter's effect ref is the GUID — not a /games/... path.
  expect(await traitField(page, id!, 'ParticleEmitter', 'effect')).toBe(CONFETTI_GUID);
});

test('the live manifest resolves the particle GUID → its .particle.json, and the file round-trips', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE, 'Confetti Emitter');

  // 1. The dev manifest (built by the scanner reading each particle's in-file `id`)
  //    must contain an entry for the confetti GUID pointing at its .particle.json.
  const manifestPath = await page.evaluate(async (guid) => {
    const res = await fetch('/assets.manifest.json');
    if (!res.ok) return null;
    const data = await res.json();
    const entry = (data.assets as { guid?: string; path: string; type: string }[])
      .find((a) => a.guid?.toLowerCase() === guid && a.type === 'particle');
    return entry?.path ?? null;
  }, CONFETTI_GUID);

  expect(manifestPath).not.toBeNull();
  expect(manifestPath).toMatch(/confetti\.particle\.json$/);

  // 2. The resolved file's own in-file id round-trips back to the same GUID.
  const fileId = await page.evaluate(async (p) => {
    const res = await fetch(p!);
    if (!res.ok) return null;
    return (await res.json()).id ?? null;
  }, manifestPath);

  expect(String(fileId).toLowerCase()).toBe(CONFETTI_GUID);
});
