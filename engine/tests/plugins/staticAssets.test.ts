/** serveProjectAsset — the model-LOD branch on a cache miss. When the meta
 *  sidecar's cache hash has no local variant (stale / cross-toolchain / never
 *  generated) and auto-bake can't regenerate it, it degrades GRACEFULLY: if the
 *  source GLB is present it serves that (base mesh renders, with a loud WARN so the
 *  missing bake is still visible) rather than 404ing an empty viewport. Only when
 *  the source GLB is ALSO absent does it 404. The passthrough skips filterMesh +
 *  postprocessor geometry fixups, so a postprocessor-dependent model may render
 *  untextured until re-imported — an intentional trade-off (empty viewport is worse
 *  UX than a base mesh + a console warning). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveProjectAsset } from '../../plugins/backend/staticAssets';
import { getModelCacheDir, lodCachePath } from '../../plugins/model-cache';
import { registerReimportHandler, type ReimportHandler } from '../../plugins/reimport-registry';

let root: string;
let errSpy: ReturnType<typeof vi.spyOn>;
const ctx = () => ({
  projectRoot: root,
  editorRoot: root,
  // Map a root-absolute URL straight onto the temp project dir.
  resolveAssetPath: (u: string) => path.join(root, u.replace(/^\//, '')),
});

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-sa-'));
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { errSpy.mockRestore(); warnSpy.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); });

function writeModel(withMetaHash: string | null) {
  const dir = path.join(root, 'assets', 'models');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.glb'), Buffer.from('GLB-SOURCE-BYTES'));
  if (withMetaHash) {
    fs.writeFileSync(path.join(dir, 'x.glb.meta.json'), JSON.stringify({
      modelCache: { hash: withMetaHash, processedPath: '/assets/models/x.glb.processed.glb' },
    }));
  }
}

describe('serveProjectAsset — model LOD cache miss degrades to the source GLB (graceful)', () => {
  it('serves the source GLB (with a loud WARN) when the sidecar hash has no cached variant', async () => {
    writeModel('deadbeefdeadbeef'); // hash with no cache file on disk
    const res = await serveProjectAsset(ctx(), '/assets/models/x.glb.processed.glb');
    expect(res).not.toBeNull();
    // Degrades to the source bytes so the base mesh renders instead of an empty viewport.
    expect(res!.kind).toBe('file');
    expect(res!.contentType).toBe('model/gltf-binary');
    expect((res as { path?: string }).path).toBe(path.join(root, 'assets/models/x.glb'));
    // no-cache so a later real bake is picked up.
    expect((res as { headers?: Record<string, string> }).headers?.['Cache-Control']).toBe('no-cache');
    // Loud, not silent — the missing bake must still be visible.
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('serves the source GLB when the sidecar has no modelCache hash at all', async () => {
    writeModel(null); // source exists, no meta
    const res = await serveProjectAsset(ctx(), '/assets/models/x.glb.lod2.glb');
    expect(res!.kind).toBe('file');
    expect(res!.contentType).toBe('model/gltf-binary');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('404s only when neither a cached variant NOR the source GLB exists', async () => {
    // no writeModel — source absent, so there's nothing to fall back to.
    const res = await serveProjectAsset(ctx(), '/assets/models/missing.glb.processed.glb');
    expect(res!.kind).toBe('raw');
    expect((res as { status?: number }).status).toBe(404);
    expect(errSpy).toHaveBeenCalledOnce();
  });
});

describe('serveProjectAsset — auto-import on variant cache-miss (autoConvert)', () => {
  // A fake reimport handler standing in for the real (toktx/gltf-transform)
  // converter: it writes the LOD0 cache bytes + stamps the meta hash, exactly the
  // side effects serveProjectAsset re-reads to serve. Lets us exercise the
  // bake-then-serve plumbing (incl. concurrent-request de-dup) without encoders.
  let bakeCalls = 0;
  const fakeModelHandler: ReimportHandler = async (sourceUrl, absPath) => {
    bakeCalls += 1;
    const hash = 'bakedhash0000001';
    const cached = lodCachePath(getModelCacheDir(root), sourceUrl, hash, 0);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, Buffer.from('FRESHLY-BAKED-GLB'));
    fs.writeFileSync(`${absPath}.meta.json`, JSON.stringify({ modelCache: { hash } }));
  };

  beforeEach(() => { bakeCalls = 0; registerReimportHandler('model', fakeModelHandler); });

  const autoCtx = () => ({ ...ctx(), autoConvert: true });

  it('bakes the missing variant on demand and serves it (no 404)', async () => {
    writeModel('stalecommittedhash'); // committed hash, no local cache bytes
    const res = await serveProjectAsset(autoCtx(), '/assets/models/x.glb.processed.glb');
    expect(res!.kind).toBe('file');
    expect(res!.contentType).toBe('model/gltf-binary');
    expect(bakeCalls).toBe(1);
    expect(errSpy).not.toHaveBeenCalled(); // healed, not the loud miss
  });

  it('de-dupes concurrent requests for sibling variants into a single bake', async () => {
    writeModel('stalecommittedhash');
    const [a, b] = await Promise.all([
      serveProjectAsset(autoCtx(), '/assets/models/x.glb.processed.glb'),
      serveProjectAsset(autoCtx(), '/assets/models/x.glb.processed.glb'),
    ]);
    expect(a!.kind).toBe('file');
    expect(b!.kind).toBe('file');
    expect(bakeCalls).toBe(1); // both awaited the same in-flight bake
  });

  it('does not bake when autoConvert is OFF, but still degrades to the source GLB (packaged path)', async () => {
    writeModel('stalecommittedhash');
    const res = await serveProjectAsset(ctx(), '/assets/models/x.glb.processed.glb');
    expect(res!.kind).toBe('file'); // source-GLB fallback, not 404
    expect(res!.contentType).toBe('model/gltf-binary');
    expect(bakeCalls).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('degrades to the source GLB when the bake throws (e.g. toktx missing)', async () => {
    registerReimportHandler('model', async () => { throw new Error('toktx not found'); });
    writeModel('stalecommittedhash');
    const res = await serveProjectAsset(autoCtx(), '/assets/models/x.glb.processed.glb');
    expect(res!.kind).toBe('file'); // bake failed → source-GLB fallback, not 404
    expect(res!.contentType).toBe('model/gltf-binary');
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('serveProjectAsset — converted model variant is revalidatable, NOT immutable', () => {
  // The served URL (`x.glb.processed.glb`) is query-agnostic in dev/editor — the
  // hash lives only in the meta + cache disk path, never the URL. An `immutable`
  // header here poisons the browser cache for a year, so a re-bake (e.g. a recipe
  // bump that adds the island's grass UVs) is never picked up until "Disable cache".
  it('serves a cache HIT with no-cache + the content-hash ETag (re-bakes are picked up)', async () => {
    const hash = 'cafebabecafebabe';
    writeModel(hash);
    // Place the cached variant exactly where the server looks for it.
    const cached = lodCachePath(getModelCacheDir(root), '/assets/models/x.glb', hash, 0);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, Buffer.from('BAKED-GLB-WITH-UVS'));

    const res = await serveProjectAsset(ctx(), '/assets/models/x.glb.processed.glb');
    expect(res!.kind).toBe('file');
    expect(res!.contentType).toBe('model/gltf-binary');
    const cc = res!.headers?.['Cache-Control'] ?? '';
    expect(cc).toContain('no-cache');
    expect(cc).not.toContain('immutable'); // the regression we're guarding
    expect(res!.headers?.ETag).toBe(`"${hash}"`);
  });
});

describe('serveProjectAsset — .gltf-named source serves its baked LOD variants', () => {
  // A GLB-binary export named `foo.gltf` (Tripo / 3D AI Studio do this) goes
  // through the same LOD pipeline and produces `foo.gltf.processed.glb` variant
  // URLs. The serving regex must match `.gltf` sources too — otherwise the URL
  // falls through to the app-shell and GLTFLoader chokes on the returned
  // index.html ("Unexpected token '<' … is not valid JSON").
  it('serves the cached .processed.glb variant for a .gltf source', async () => {
    const hash = 'deadbeefdeadbeef';
    const dir = path.join(root, 'assets', 'models');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pad.gltf'), Buffer.from('GLB-BINARY-NAMED-GLTF'));
    fs.writeFileSync(path.join(dir, 'pad.gltf.meta.json'), JSON.stringify({
      modelCache: { hash, processedPath: '/assets/models/pad.gltf.processed.glb' },
    }));
    const cached = lodCachePath(getModelCacheDir(root), '/assets/models/pad.gltf', hash, 1);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, Buffer.from('BAKED-LOD1'));

    const res = await serveProjectAsset(ctx(), '/assets/models/pad.gltf.lod1.glb');
    expect(res!.kind).toBe('file');
    expect(res!.contentType).toBe('model/gltf-binary');
    expect(res!.headers?.ETag).toBe(`"${hash}"`);
  });
});
