/** A render names the take's assets that changed since it was recorded (#1509).
 *
 *  The fixture is a real project folder on disk: the take's fingerprint is made from it, the files
 *  are edited the way an owner would between Stop and the render, and the render's check runs
 *  against the edited folder. Each test edits one kind of file the closure has to reach. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import {
  fingerprintAssets, checkTakeAssets, sceneUrlToAsset, takeSceneUrls, TAKE_ASSETS_DIR, UNREADABLE,
} from '../../plugins/takeAssets';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';

const G = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SCENE = G(1), LEVEL2 = G(2), OTHER = G(3), PREFAB = G(4), MAT = G(5), MAT2 = G(6), MAT3 = G(7), TEX = G(8), SHEET = G(9), FRAME = G(10), NEW = G(11), ENTITY = G(12);

let project: string;
const assets = () => path.join(project, TAKE_ASSETS_DIR);
const write = (rel: string, body: unknown) => {
  const abs = path.join(assets(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};
const MAIN_URL = '/assets/scenes/main.scene.json';

beforeEach(() => {
  project = makeScratchDir('modoki-take-assets-');
  // main → a prefab → a material → a texture (with its sidecar), and a sliced sprite's FRAME.
  write('scenes/main.scene.json', { id: SCENE, entities: [{ guid: ENTITY, prefab: PREFAB }, { guid: G(13), sprite: FRAME }] });
  write('prefabs/badge.prefab.json', { id: PREFAB, material: MAT });
  write('materials/m1.material.json', { id: MAT, texture: TEX });
  write('textures/t1.png', 'png-bytes');
  write('textures/t1.png.meta.json', { version: 2, id: TEX, texture: { format: 'webp' } });
  write('sprites/sheet.png', 'sheet-bytes');
  write('sprites/sheet.png.meta.json', { version: 2, id: SHEET, sprites: [{ guid: FRAME, name: 'f0' }] });
  // A scene the game loads mid-take, and one this take never touches.
  write('scenes/level2.scene.json', { id: LEVEL2, entities: [{ material: MAT2 }] });
  write('materials/m2.material.json', { id: MAT2 });
  write('scenes/other.scene.json', { id: OTHER, entities: [{ material: MAT3 }] });
  write('materials/m3.material.json', { id: MAT3 });
});
afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });

describe('checkTakeAssets', () => {
  it('reports nothing when nothing changed — and counts what it checked, so "unchanged" is not "saw nothing"', async () => {
    const recorded = await fingerprintAssets(project);
    // main, prefab, m1, t1.png + sidecar, sheet.png + sidecar.
    expect(await checkTakeAssets(project, recorded, [MAIN_URL])).toEqual({ status: 'unchanged', checked: 7 });
  });

  it('names the scene when it was saved between Stop and the render — the issue as filed', async () => {
    const recorded = await fingerprintAssets(project);
    write('scenes/main.scene.json', { id: SCENE, entities: [{ guid: ENTITY, prefab: PREFAB, color: '#f00' }, { guid: G(13), sprite: FRAME }] });
    expect(await checkTakeAssets(project, recorded, [MAIN_URL])).toMatchObject({ status: 'changed', changed: ['scenes/main.scene.json'], added: [] });
  });

  it('follows the scene through its prefab and material to a texture', async () => {
    const recorded = await fingerprintAssets(project);
    write('textures/t1.png', 'repainted');
    expect(await checkTakeAssets(project, recorded, [MAIN_URL])).toMatchObject({ changed: ['textures/t1.png'] });
  });

  it("names a texture's sidecar, whose import settings change what the texture looks like", async () => {
    const recorded = await fingerprintAssets(project);
    write('textures/t1.png.meta.json', { version: 2, id: TEX, texture: { format: 'ktx2-uastc' } });
    expect(await checkTakeAssets(project, recorded, [MAIN_URL])).toMatchObject({ changed: ['textures/t1.png.meta.json'] });
  });

  it('reaches a sprite sheet through the GUID of one of its frames', async () => {
    const recorded = await fingerprintAssets(project);
    write('sprites/sheet.png', 'redrawn');
    expect(await checkTakeAssets(project, recorded, [MAIN_URL])).toMatchObject({ changed: ['sprites/sheet.png'] });
  });

  it('does not report an asset this take never used', async () => {
    const recorded = await fingerprintAssets(project);
    write('scenes/other.scene.json', { id: OTHER, entities: [] });
    write('materials/m3.material.json', { id: MAT3, color: 1 });
    expect(await checkTakeAssets(project, recorded, [MAIN_URL])).toMatchObject({ status: 'unchanged' });
  });

  // The journal as SceneManager writes it: a level change is `@scene-swapped {from, to}`, never
  // `@scene-loaded` (#1509 review — the first cut listened for the wrong one).
  const LEVEL2_URL = '/assets/scenes/level2.scene.json';
  const SWAP = { type: '@scene-swapped', payload: { from: MAIN_URL, to: LEVEL2_URL } };

  it('checks the level a take swapped to only when the render swapped to it', async () => {
    const recorded = await fingerprintAssets(project);
    write('materials/m2.material.json', { id: MAT2, color: 1 });
    expect(await checkTakeAssets(project, recorded, takeSceneUrls(MAIN_URL, []))).toMatchObject({ status: 'unchanged' });
    expect(await checkTakeAssets(project, recorded, takeSceneUrls(MAIN_URL, [SWAP])))
      .toMatchObject({ status: 'changed', changed: ['materials/m2.material.json'] });
  });

  it('still checks the scene a take BOOTED in after it moved on to another level', async () => {
    const recorded = await fingerprintAssets(project);
    write('materials/m1.material.json', { id: MAT, texture: TEX, color: 1 }); // only main uses it
    expect(await checkTakeAssets(project, recorded, takeSceneUrls(MAIN_URL, [SWAP])))
      .toMatchObject({ status: 'changed', changed: ['materials/m1.material.json'] });
  });

  it('names a file created since the take that the scene now uses as NEW', async () => {
    const recorded = await fingerprintAssets(project);
    write('materials/new.material.json', { id: NEW });
    write('scenes/main.scene.json', { id: SCENE, entities: [{ guid: ENTITY, prefab: PREFAB, material: NEW }, { guid: G(13), sprite: FRAME }] });
    expect(await checkTakeAssets(project, recorded, [MAIN_URL]))
      .toMatchObject({ status: 'changed', changed: ['scenes/main.scene.json'], added: ['materials/new.material.json'] });
  });

  it('is unchecked for a take recorded before takes stored a fingerprint', async () => {
    expect(await checkTakeAssets(project, undefined, [MAIN_URL])).toMatchObject({ status: 'unchecked' });
  });
});

describe('never fails the render (#1509 review)', () => {
  it('reads unchecked, with the reason, when the project folder is gone', async () => {
    const recorded = await fingerprintAssets(project);
    const r = await checkTakeAssets(path.join(project, 'nope'), recorded, [MAIN_URL]);
    expect(r).toMatchObject({ status: 'unchecked', reason: expect.stringMatching(/the check failed: no runtime\/assets folder/) });
  });

  // Root reads anything, so the unreadable cases cannot be staged there.
  const asRoot = process.getuid?.() === 0;
  const lock = (rel: string) => fs.chmodSync(path.join(assets(), rel), 0o000);
  const unlock = (rel: string) => fs.chmodSync(path.join(assets(), rel), 0o644);

  it.skipIf(asRoot)('marks a file it cannot read instead of throwing', async () => {
    const recorded = await fingerprintAssets(project);
    lock('textures/t1.png');
    try {
      expect((await fingerprintAssets(project)).files['textures/t1.png']).toBe(UNREADABLE);
      // Unknown, not changed — and not counted as checked.
      expect(await checkTakeAssets(project, recorded, [MAIN_URL])).toEqual({ status: 'unchanged', checked: 6 });
    } finally { unlock('textures/t1.png'); }
  });

  it.skipIf(asRoot)('does not call a file NEW because it was unreadable when the take was recorded (review 2)', async () => {
    lock('materials/m1.material.json');
    let recorded;
    try { recorded = await fingerprintAssets(project); } finally { unlock('materials/m1.material.json'); }
    expect(recorded.files['materials/m1.material.json']).toBe(UNREADABLE);
    const r = await checkTakeAssets(project, recorded, [MAIN_URL]);
    expect(r).toMatchObject({ status: 'unchanged' });
  });

  it.skipIf(asRoot)('refuses to fingerprint an assets folder it cannot list — that would be {} again', async () => {
    fs.chmodSync(assets(), 0o000);
    try {
      await expect(fingerprintAssets(project)).rejects.toThrow(/EACCES/);
    } finally { fs.chmodSync(assets(), 0o755); }
  });

  it('does not throw on a scene URL carrying a bare %', async () => {
    const recorded = await fingerprintAssets(project);
    expect(await checkTakeAssets(project, recorded, [MAIN_URL, '/assets/scenes/100%.scene.json'])).toMatchObject({ status: 'unchanged' });
  });

  it('refuses to fingerprint a project with no runtime/assets — an empty map would call every asset new', async () => {
    await expect(fingerprintAssets(path.join(project, 'nope'))).rejects.toThrow(/no runtime\/assets folder/);
  });
});

describe('takeSceneUrls', () => {
  it('is the boot scene, every first load and every swap target, once each', () => {
    expect(takeSceneUrls('/assets/a.json', [
      { type: '@scene-loaded', payload: { path: '/assets/b.json' } },
      { type: '@scene-swapped', payload: { from: '/assets/b.json', to: '/assets/c.json' } },
      { type: '@scene-swapped', payload: { from: '/assets/c.json', to: '/assets/a.json' } },
      { type: '@scene-loaded', payload: { path: '' } },
      { type: 'court.place', payload: { to: '/assets/not-a-scene.json' } },
    ])).toEqual(['/assets/a.json', '/assets/b.json', '/assets/c.json']);
  });

  it('works without a boot scene', () => {
    expect(takeSceneUrls(null, [])).toEqual([]);
  });
});

describe('sceneUrlToAsset', () => {
  const rels = ['scenes/main.scene.json', 'other/scenes/main.scene.json'];
  it('matches either URL layout — flat /assets/, or /games/<id>/assets/ on a multi-project server', () => {
    expect(sceneUrlToAsset('/assets/scenes/main.scene.json', rels)).toBe('scenes/main.scene.json');
    expect(sceneUrlToAsset('/games/court/assets/scenes/main.scene.json?x=1', rels)).toBe('scenes/main.scene.json');
  });
  it('prefers the longest match, and does not match a file name that merely ends the same', () => {
    expect(sceneUrlToAsset('/assets/other/scenes/main.scene.json', rels)).toBe('other/scenes/main.scene.json');
    expect(sceneUrlToAsset('/assets/xscenes/main.scene.json', rels)).toBeNull();
  });
  it("is null for a scene outside the project's assets (the engine's own)", () => {
    expect(sceneUrlToAsset('/modoki/assets/scenes/empty.scene.json', rels)).toBeNull();
  });
});

describe('POST /api/record/fingerprint', () => {
  it('fails, rather than answering an empty map, for a project with no runtime/assets', async () => {
    const ctx = { projectRoot: path.join(project, 'nope') } as unknown as BackendContext;
    const r = await handleBackendRequest(ctx, { method: 'POST', urlPath: '/api/record/fingerprint', query: new URLSearchParams(), body: undefined }) as { status?: number };
    expect(r.status).toBe(500);
  });

  it("answers the open project's fingerprint — the one a take stores at the Play press", async () => {
    const ctx = { projectRoot: project } as unknown as BackendContext;
    const r = await handleBackendRequest(ctx, { method: 'POST', urlPath: '/api/record/fingerprint', query: new URLSearchParams(), body: undefined }) as { status?: number; body: unknown };
    expect(r.status ?? 200).toBe(200);
    expect(r.body).toEqual(await fingerprintAssets(project));
    expect(Object.keys((r.body as { files: object }).files)).toContain('scenes/main.scene.json');
  });
});
