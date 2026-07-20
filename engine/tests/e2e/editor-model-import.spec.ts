/** Model pipeline — full browser E2E.
 *
 *  Generates a GLB fixture (Root → BoxA → {Terrain, BoxB → BoxC}, embedded
 *  texture+material), drops it under a gitignored game asset dir, drives the REAL editor
 *  import in a live browser: GLTFLoader decodes the GLB, textures are extracted
 *  to PNG via a 2D canvas, mesh/material assets are written, and entities are
 *  spawned + rendered by the SceneView.
 *
 *  Asserts the end-to-end chain the user asked for — "load the generated prefab
 *  along with texture and material":
 *    • entities spawn with the GLB's named parent-child hierarchy,
 *    • the import writes .mesh.json + .mat.json + an extracted texture PNG,
 *    • the material references the extracted texture,
 *    • the viewport actually renders the mesh (before/after WebGL pixel diff).
 *
 *  Writes land in the main worktree's games/ dir; afterAll removes them and the
 *  dir is gitignored, so nothing is left behind.
 */

import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { gotoEmptyEditor } from './helpers';
import { makeTestGlb } from '../plugins/fixtures/makeTestGlb';

// Asset dir served by the dev server: games/3d-test/runtime/assets/__e2e_model__
// maps to URL /games/3d-test/assets/__e2e_model__ (see vite-asset-scanner roots).
const ABS_DIR = path.join(process.cwd(), 'games/3d-test/runtime/assets/__e2e_model__');
const URL_GLB = '/games/3d-test/assets/__e2e_model__/test-model.glb';

test.beforeAll(async () => {
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
  fs.mkdirSync(ABS_DIR, { recursive: true });
  await makeTestGlb({ dir: ABS_DIR, fileName: 'test-model.glb', gridSegments: 16 });
});

test.afterAll(() => {
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
});

/** Count pixels that differ beyond `tol` between two PNG screenshots. */
async function pixelDelta(a: Buffer, b: Buffer, tol = 16): Promise<number> {
  const toRaw = (buf: Buffer) => sharp(buf).resize(400, 300, { fit: 'fill' }).raw().toBuffer();
  const [ra, rb] = await Promise.all([toRaw(a), toRaw(b)]);
  let diff = 0;
  for (let i = 0; i < ra.length; i += 4) {
    if (Math.abs(ra[i] - rb[i]) > tol || Math.abs(ra[i + 1] - rb[i + 1]) > tol || Math.abs(ra[i + 2] - rb[i + 2]) > tol) diff++;
  }
  return diff;
}

test('editor imports a GLB and renders it with material + texture', async ({ page }) => {
  await gotoEmptyEditor(page);

  const canvas = page.locator('[data-scene-viewport] canvas').first();
  await canvas.waitFor({ state: 'visible' });
  const before = await canvas.screenshot();

  // Drive the real import pipeline in the browser (texture extraction via
  // canvas, mesh/material asset writes, entity spawn).
  const rootId = await page.evaluate(async (glb) => {
    return await (window as any).__modokiEditorTest.importModel(glb, 'e2eimp', 'none');
  }, URL_GLB);
  expect(typeof rootId).toBe('number');

  // --- Hierarchy: Root → BoxA → { Terrain, BoxB → BoxC } --------------------
  const entities = await page.evaluate(() => (window as any).__modokiEditorTest.getAllEntities().map((e: any) => ({ id: e.id, name: e.name })));
  const byName = (n: string) => entities.find((e: { id: number; name: string }) => e.name === n);
  for (const n of ['BoxA', 'Terrain', 'BoxB', 'BoxC']) expect(byName(n)).toBeTruthy();

  const parentOf = (id: number) => page.evaluate((i) => (window as any).__modokiEditorTest.traitField(i, 'EntityAttributes', 'parentId'), id);
  // BoxA is root-parented; Terrain and BoxB are SIBLINGS under BoxA (the fix:
  // they must both resolve to BoxA, not chain Terrain→BoxB); BoxC nests under BoxB.
  expect(await parentOf(byName('BoxA').id)).toBe(rootId);
  expect(await parentOf(byName('Terrain').id)).toBe(byName('BoxA').id);
  expect(await parentOf(byName('BoxB').id)).toBe(byName('BoxA').id);
  expect(await parentOf(byName('BoxC').id)).toBe(byName('BoxB').id);

  // The spawned meshes carry a Renderable3D mesh ref (the created .mesh.json).
  const boxMeshRef = await page.evaluate((i) => (window as any).__modokiEditorTest.traitField(i, 'Renderable3D', 'mesh'), byName('BoxA').id);
  expect(typeof boxMeshRef).toBe('string');
  expect((boxMeshRef as string).length).toBeGreaterThan(0);

  // --- Transforms are LOCAL to the resolved parent (not world-space) ---------
  // Fixture (authored local TRS): Root(0,1,0) → BoxA(3,0,0) → { Terrain(-2,0,1),
  // BoxB(0,2,0) → BoxC(1,0,0) }. BoxA is root-parented so its stored transform is
  // world (3,1,0); every nested entity must store its AUTHORED LOCAL, not its
  // world — proving the renderer's parent.world × child.local won't double-apply.
  const tf = (id: number, f: string) => page.evaluate(({ i, fld }) => (window as any).__modokiEditorTest.traitField(i, 'Transform', fld), { i: id, fld: f });
  expect(await tf(byName('BoxA').id, 'x') as number).toBeCloseTo(3, 1);
  expect(await tf(byName('BoxA').id, 'y') as number).toBeCloseTo(1, 1);
  expect(await tf(byName('Terrain').id, 'x') as number).toBeCloseTo(-2, 1); // local under BoxA, world would be 1
  expect(await tf(byName('Terrain').id, 'z') as number).toBeCloseTo(1, 1);
  expect(await tf(byName('BoxB').id, 'y') as number).toBeCloseTo(2, 1);     // local under BoxA, world would be 3
  expect(await tf(byName('BoxC').id, 'x') as number).toBeCloseTo(1, 1);     // local under BoxB, world would be 4

  // --- Derived assets written to disk ---------------------------------------
  // The import writes synchronously via /api/write-file before resolving, so
  // the files exist by the time importModel() returns.
  const meshDir = path.join(ABS_DIR, 'meshes');
  const matDir = path.join(ABS_DIR, 'materials');
  const texDir = path.join(ABS_DIR, 'textures');

  await expect.poll(() => fs.existsSync(meshDir) && fs.readdirSync(meshDir).filter((f) => f.endsWith('.mesh.json')).length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(4); // BoxA + Terrain + BoxB + BoxC
  const matFiles = fs.existsSync(matDir) ? fs.readdirSync(matDir).filter((f) => f.endsWith('.mat.json')) : [];
  expect(matFiles.length).toBeGreaterThanOrEqual(1);
  const texFiles = fs.existsSync(texDir) ? fs.readdirSync(texDir).filter((f) => f.endsWith('.png')) : [];
  expect(texFiles.length).toBeGreaterThanOrEqual(1); // the embedded checker texture, extracted

  // The material references the extracted texture (guid or path) — proving the
  // material+texture wiring survived extraction.
  const mat = JSON.parse(fs.readFileSync(path.join(matDir, matFiles[0]), 'utf-8'));
  expect(mat.texture).toBeTruthy();

  // --- Render proof: the mesh actually drew into the WebGL viewport ----------
  await expect.poll(async () => pixelDelta(before, await canvas.screenshot()), { timeout: 10_000, intervals: [250, 500, 1000] })
    .toBeGreaterThan(800);

  // Cleanup the spawned entities (asset files removed in afterAll).
  await page.evaluate((id) => (window as any).__modokiEditorTest.deleteEntity(id), rootId);
});
