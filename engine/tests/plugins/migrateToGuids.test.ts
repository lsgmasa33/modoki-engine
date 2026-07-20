/** End-to-end tests for scripts/migrate-to-guids.mjs.
 *
 *  Runs the script against a temp project containing synthetic assets, then
 *  inspects the rewritten files + generated manifest. The script is invoked
 *  as a subprocess via `node` so the tests exercise the real entry point.
 *
 *  Each test creates a fresh temp project so they're isolated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SCRIPT = path.resolve(__dirname, '../../scripts/migrate-to-guids.mjs');

/** Spin up a temp project that mirrors the real layout's URL → FS rewrite:
 *    games/<id>/runtime/assets/...  →  /games/<id>/assets/...
 *  The migration script's fsToUrl logic depends on this convention. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-migrate-'));
  const gameAssets = path.join(root, 'games', 'test', 'runtime', 'assets');
  fs.mkdirSync(gameAssets, { recursive: true });
  fs.mkdirSync(path.join(gameAssets, 'models'), { recursive: true });
  fs.mkdirSync(path.join(gameAssets, 'meshes'), { recursive: true });
  fs.mkdirSync(path.join(gameAssets, 'materials'), { recursive: true });
  fs.mkdirSync(path.join(gameAssets, 'scenes'), { recursive: true });
  fs.mkdirSync(path.join(gameAssets, 'textures'), { recursive: true });
  return { root, gameAssets };
}

/** Drop the script + a sibling "package.json" in the temp project so the
 *  script can find its expected layout. The script computes ROOT as
 *  resolve(__dirname, '..'); we symlink-or-copy the script into a sibling
 *  `scripts/` directory of the temp project. */
function installScript(projectRoot: string) {
  const scriptsDir = path.join(projectRoot, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const dest = path.join(scriptsDir, 'migrate-to-guids.mjs');
  fs.copyFileSync(SCRIPT, dest);
  return dest;
}

function runMigration(projectRoot: string): string {
  const scriptPath = installScript(projectRoot);
  return execFileSync('node', [scriptPath], { cwd: projectRoot, encoding: 'utf-8' });
}

function readJson(p: string) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

const isGuid = (s: unknown) => typeof s === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

describe('migrate-to-guids', () => {
  let proj: ReturnType<typeof makeProject>;

  beforeEach(() => { proj = makeProject(); });
  afterEach(() => { fs.rmSync(proj.root, { recursive: true, force: true }); });

  it('assigns a GUID to every JSON asset and writes sidecars for binaries', () => {
    const meshPath = path.join(proj.gameAssets, 'meshes', 'cube.mesh.json');
    const matPath = path.join(proj.gameAssets, 'materials', 'red.mat.json');
    const glbPath = path.join(proj.gameAssets, 'models', 'cube.glb');
    fs.writeFileSync(meshPath, JSON.stringify({ version: 1, model: '/games/test/assets/models/cube.glb', mesh: 'cube' }));
    fs.writeFileSync(matPath, JSON.stringify({ version: 1, color: 0xff0000 }));
    fs.writeFileSync(glbPath, 'pretend-glb');

    runMigration(proj.root);

    const mesh = readJson(meshPath);
    const mat = readJson(matPath);
    const glbMeta = readJson(glbPath + '.meta.json');
    expect(isGuid(mesh.id)).toBe(true);
    expect(isGuid(mat.id)).toBe(true);
    expect(isGuid(glbMeta.id)).toBe(true);
  });

  it('rewrites path refs in a mesh.json to GUIDs (model + material)', () => {
    const meshPath = path.join(proj.gameAssets, 'meshes', 'cube.mesh.json');
    const matPath = path.join(proj.gameAssets, 'materials', 'red.mat.json');
    const glbPath = path.join(proj.gameAssets, 'models', 'cube.glb');
    fs.writeFileSync(meshPath, JSON.stringify({
      version: 1,
      model: '/games/test/assets/models/cube.glb',
      mesh: 'cube',
      material: '/games/test/assets/materials/red.mat.json',
    }));
    fs.writeFileSync(matPath, JSON.stringify({ version: 1, color: 0xff0000 }));
    fs.writeFileSync(glbPath, 'pretend-glb');

    runMigration(proj.root);

    const mesh = readJson(meshPath);
    const glbMeta = readJson(glbPath + '.meta.json');
    const mat = readJson(matPath);
    expect(mesh.model).toBe(glbMeta.id);
    expect(mesh.material).toBe(mat.id);
  });

  it('rewrites a scene file (v6 → v8) including resources + entity trait refs', () => {
    const matPath = path.join(proj.gameAssets, 'materials', 'red.mat.json');
    fs.writeFileSync(matPath, JSON.stringify({ version: 1, color: 0xff0000 }));
    const scenePath = path.join(proj.gameAssets, 'scenes', 'level1.json');
    fs.writeFileSync(scenePath, JSON.stringify({
      version: 6,
      createdAt: 'whenever',
      resources: [
        { type: 'material', path: '/games/test/assets/materials/red.mat.json' },
      ],
      entities: [{
        id: 1,
        traits: {
          Renderable3DPrimitive: { mesh: 'cube', material: '/games/test/assets/materials/red.mat.json', color: 0xff0000, size: 1 },
          EntityAttributes: { name: 'cube', parentId: 0 },
        },
      }],
    }));

    runMigration(proj.root);

    const scene = readJson(scenePath);
    const mat = readJson(matPath);
    expect(scene.version).toBe(8);
    expect(isGuid(scene.id)).toBe(true);
    expect(scene.resources[0].path).toBe(mat.id);
    expect(scene.entities[0].traits.Renderable3DPrimitive.material).toBe(mat.id);
  });

  it('migrates v7 Persistent.guid → EntityAttributes.guid', () => {
    const scenePath = path.join(proj.gameAssets, 'scenes', 'world.json');
    fs.writeFileSync(scenePath, JSON.stringify({
      version: 7,
      createdAt: 'whenever',
      resources: [],
      entities: [{
        id: 1,
        traits: {
          EntityAttributes: { name: 'Player', parentId: 0 },
          Persistent: { guid: 'player-guid-1' },
        },
      }],
    }));

    runMigration(proj.root);

    const scene = readJson(scenePath);
    expect(scene.version).toBe(8);
    expect(scene.entities[0].traits.EntityAttributes.guid).toBe('player-guid-1');
    expect(scene.entities[0].traits.Persistent).toBe(true);
  });

  it('is idempotent: second run leaves GUIDs unchanged', () => {
    const meshPath = path.join(proj.gameAssets, 'meshes', 'cube.mesh.json');
    const glbPath = path.join(proj.gameAssets, 'models', 'cube.glb');
    fs.writeFileSync(meshPath, JSON.stringify({ version: 1, model: '/games/test/assets/models/cube.glb', mesh: 'cube' }));
    fs.writeFileSync(glbPath, 'pretend-glb');

    runMigration(proj.root);
    const meshFirst = readJson(meshPath);
    const glbMetaFirst = readJson(glbPath + '.meta.json');

    runMigration(proj.root);
    const meshSecond = readJson(meshPath);
    const glbMetaSecond = readJson(glbPath + '.meta.json');

    expect(meshSecond.id).toBe(meshFirst.id);
    expect(glbMetaSecond.id).toBe(glbMetaFirst.id);
  });

  it('regenerates GUIDs on collision (manual file copy)', () => {
    const guid = randomUUID();
    const a = path.join(proj.gameAssets, 'meshes', 'a.mesh.json');
    const b = path.join(proj.gameAssets, 'meshes', 'b.mesh.json');
    fs.writeFileSync(a, JSON.stringify({ id: guid, version: 1, model: '/games/test/assets/models/x.glb', mesh: 'x' }));
    fs.writeFileSync(b, JSON.stringify({ id: guid, version: 1, model: '/games/test/assets/models/x.glb', mesh: 'x' }));

    runMigration(proj.root);

    const aFile = readJson(a);
    const bFile = readJson(b);
    expect(aFile.id).not.toBe(bFile.id);
    // One of them keeps the original; the other gets regenerated. Either order
    // is fine — the contract is just "no collisions after migration".
    expect([aFile.id, bFile.id].includes(guid)).toBe(true);
  });

  it('writes an assets.manifest.json at the project root', () => {
    const meshPath = path.join(proj.gameAssets, 'meshes', 'cube.mesh.json');
    const glbPath = path.join(proj.gameAssets, 'models', 'cube.glb');
    fs.writeFileSync(meshPath, JSON.stringify({ version: 1, model: '/games/test/assets/models/cube.glb', mesh: 'cube' }));
    fs.writeFileSync(glbPath, 'pretend-glb');

    runMigration(proj.root);

    const manifestPath = path.join(proj.root, 'assets.manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = readJson(manifestPath);
    expect(manifest.version).toBe(2);
    expect(Array.isArray(manifest.assets)).toBe(true);
    expect(manifest.assets.length).toBe(2); // mesh + glb

    const mesh = readJson(meshPath);
    const glbMeta = readJson(glbPath + '.meta.json');
    const guids = manifest.assets.map((a: { guid: string }) => a.guid);
    expect(guids).toContain(mesh.id);
    expect(guids).toContain(glbMeta.id);
  });

  it('emits manifest paths matching the Vite plugin URL convention', () => {
    const meshPath = path.join(proj.gameAssets, 'meshes', 'cube.mesh.json');
    fs.writeFileSync(meshPath, JSON.stringify({ version: 1, model: '/games/test/assets/models/cube.glb', mesh: 'cube' }));

    runMigration(proj.root);
    const manifest = readJson(path.join(proj.root, 'assets.manifest.json'));
    // FS path was games/test/runtime/assets/meshes/cube.mesh.json
    // URL should be /games/test/assets/meshes/cube.mesh.json (no /runtime/)
    const entry = manifest.assets.find((a: { path: string }) => a.path === '/games/test/assets/meshes/cube.mesh.json');
    expect(entry).toBeDefined();
  });

  it('--dry-run does not write any files', () => {
    const meshPath = path.join(proj.gameAssets, 'meshes', 'cube.mesh.json');
    const before = JSON.stringify({ version: 1, model: '/games/test/assets/models/cube.glb', mesh: 'cube' });
    fs.writeFileSync(meshPath, before);

    const scriptPath = installScript(proj.root);
    execFileSync('node', [scriptPath, '--dry-run'], { cwd: proj.root, encoding: 'utf-8' });

    expect(fs.readFileSync(meshPath, 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(proj.root, 'assets.manifest.json'))).toBe(false);
  });
});
