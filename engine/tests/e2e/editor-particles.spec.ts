/** E2E — particle effects are referenced by GUID (not literal path), end-to-end in a
 *  real browser through the live /api asset pipeline.
 *
 *  Regression: particles used to be referenced by literal path, so a scene reference
 *  dangled the moment the file moved/renamed. The fix gives every .particle.json a
 *  GUID in-file (`id`) that the scanner bakes into the manifest, so scenes reference
 *  the GUID. This test proves the full chain works in-browser:
 *    1. the scene loads its ParticleEmitter with a GUID effect ref,
 *    2. the live manifest resolves that GUID → a generated .particle.json path,
 *    3. that file's own in-file `id` round-trips back to the same GUID.
 *  Before the fix, step 2 fails — the scanner never read particle GUIDs, so the
 *  manifest had no entry for this id.
 *
 *  The particle asset is GENERATED at test time (a small synthetic effect, not
 *  games/3d-test's confetti.particle.json) so this spec needs only *a* served
 *  project asset root — never games/3d-test's content. It used to hardcode
 *  confetti's GUID, which meant it could not run anywhere games/ is absent (the
 *  public OSS snapshot).
 */

import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { gotoEditorWithScene, idByName, traitField } from './helpers';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
import { pickHostProject, type HostProject } from './hostProject';

const SCENE = '/tests/e2e/fixtures/e2e-particle.scene.json';
// Minted once for this fixture — NOT the confetti GUID. Kept stable so the scene
// fixture's ParticleEmitter.effect can reference it as a literal.
const PARTICLE_GUID = 'e78aaf22-bd6b-4eec-86a1-34fe9863566a';

// A `<root>/<name>/runtime/assets` dir maps to the URL `/<root>/<name>/assets`
// (vite-asset-scanner). See hostProject.ts for the pick and why it can't throw.
const HOST = pickHostProject(discoverProjects(process.cwd()) as HostProject[]);
test.skip(!HOST, 'editor-particles: this snapshot ships no project to host the generated particle asset');
const ABS_DIR = HOST ? path.join(HOST.dir, 'runtime/assets/__e2e_particle__') : '';

const PARTICLE_JSON = {
  version: 1,
  name: 'E2E Particle',
  duration: 1,
  looping: true,
  maxParticles: 10,
  worldSpace: false,
  emission: { rateOverTime: 5 },
  shape: { type: 'cone', angle: 10, radius: 0.1 },
  startLifetime: { min: 1, max: 1 },
  startSpeed: { min: 1, max: 1 },
  startSize: { min: 0.1, max: 0.1 },
  startColor: { r: 1, g: 1, b: 1 },
  startOpacity: 1,
  gravity: 0,
  render: { blend: 'normal', mode: 'mesh', meshPrimitive: 'box', meshLit: false },
  id: PARTICLE_GUID,
};

test.beforeAll(async () => {
  // The file-level test.skip above covers the tests, but whether Playwright still runs a
  // beforeAll/afterAll when every test in the file is skipped is a semantic this repo cannot
  // observe from a clone (which always HAS a project). Guard explicitly: with no host,
  // ABS_DIR is '' and mkdirSync('') throws — which would turn a clean skip into a failure on
  // exactly the project-less snapshot this change exists for.
  if (!HOST) return;
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
  fs.mkdirSync(ABS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ABS_DIR, 'e2e.particle.json'), JSON.stringify(PARTICLE_JSON, null, 2));
});

test.afterAll(() => {
  if (!HOST) return;
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
});

test('scene loads a ParticleEmitter that references its effect by GUID', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE, 'Confetti Emitter');
  const id = await idByName(page, 'Confetti Emitter');
  expect(id).not.toBeNull();
  // The emitter's effect ref is the GUID — not a /games/... path.
  expect(await traitField(page, id!, 'ParticleEmitter', 'effect')).toBe(PARTICLE_GUID);
});

test('the live manifest resolves the particle GUID → its .particle.json, and the file round-trips', async ({ page }) => {
  await gotoEditorWithScene(page, SCENE, 'Confetti Emitter');

  // 1. The dev manifest (built by the scanner reading each particle's in-file `id`)
  //    must contain an entry for our GUID pointing at its .particle.json. The
  //    scanner rescans asynchronously on a filesystem watcher `add` event and the
  //    file was written in beforeAll (after the server started), so the entry may
  //    not be present on the first fetch — poll instead of a bare fetch+assert.
  let manifestPath: string | null = null;
  await expect.poll(async () => {
    manifestPath = await page.evaluate(async (guid) => {
      const res = await fetch('/assets.manifest.json');
      if (!res.ok) return null;
      const data = await res.json();
      const entry = (data.assets as { guid?: string; path: string; type: string }[])
        .find((a) => a.guid?.toLowerCase() === guid && a.type === 'particle');
      return entry?.path ?? null;
    }, PARTICLE_GUID);
    return manifestPath;
  }, { timeout: 15_000, intervals: [250, 500, 1000] }).not.toBeNull();

  expect(manifestPath).toMatch(/e2e\.particle\.json$/);

  // 2. The resolved file's own in-file id round-trips back to the same GUID.
  const fileId = await page.evaluate(async (p) => {
    const res = await fetch(p!);
    if (!res.ok) return null;
    return (await res.json()).id ?? null;
  }, manifestPath);

  expect(String(fileId).toLowerCase()).toBe(PARTICLE_GUID);
});
