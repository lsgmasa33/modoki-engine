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
import path from 'node:path';
import { serveProjectAsset } from '../../plugins/backend/staticAssets';
import { getModelCacheDir, lodCachePath } from '../../plugins/model-cache';
import { registerReimportHandler, type ReimportHandler } from '../../plugins/reimport-registry';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

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
  root = makeScratchDir('modoki-sa-');
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
    expect((res as { contentType: string }).contentType).toBe('model/gltf-binary');
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
    expect((res as { contentType: string }).contentType).toBe('model/gltf-binary');
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
    expect((res as { contentType: string }).contentType).toBe('model/gltf-binary');
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
    expect((res as { contentType: string }).contentType).toBe('model/gltf-binary');
    expect(bakeCalls).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('degrades to the source GLB when the bake throws (e.g. toktx missing)', async () => {
    registerReimportHandler('model', async () => { throw new Error('toktx not found'); });
    writeModel('stalecommittedhash');
    const res = await serveProjectAsset(autoCtx(), '/assets/models/x.glb.processed.glb');
    expect(res!.kind).toBe('file'); // bake failed → source-GLB fallback, not 404
    expect((res as { contentType: string }).contentType).toBe('model/gltf-binary');
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('serveProjectAsset — ~env.hdr on-demand bake follows the ON-DISK format (#1314)', () => {
  let bakes = 0;
  beforeEach(() => {
    bakes = 0;
    registerReimportHandler('environment', async () => { bakes += 1; });
  });

  function writeEnv(format: 'hdr' | 'ultrahdr') {
    const dir = path.join(root, 'assets', 'env');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sky.hdr'), Buffer.from('#?RADIANCE'));
    fs.writeFileSync(path.join(dir, 'sky.hdr.meta.json'), JSON.stringify({
      environment: { format, maxSize: 1024 }, environmentCache: { hash: 'committedhash0001' },
    }));
  }

  it('bakes an hdr asset whose ~env.hdr is missing locally', async () => {
    writeEnv('hdr');
    await serveProjectAsset({ ...ctx(), autoConvert: true }, '/assets/env/sky.hdr~env.hdr');
    expect(bakes).toBe(1);
  });

  // A stale renderer can ask for ~env.hdr after the asset switched to ultrahdr. Baking then runs
  // the ultrahdr encode — rewriting the COMMITTED ~ultrahdr.jpg — and 404s regardless.
  it('does NOT bake an ultrahdr asset, and 404s', async () => {
    writeEnv('ultrahdr');
    const res = await serveProjectAsset({ ...ctx(), autoConvert: true }, '/assets/env/sky.hdr~env.hdr');
    expect(bakes).toBe(0);
    expect(res!.kind).toBe('raw');
    expect((res as { status: number }).status).toBe(404);
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
    expect((res as { contentType: string }).contentType).toBe('model/gltf-binary');
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
    expect((res as { contentType: string }).contentType).toBe('model/gltf-binary');
    expect(res!.headers?.ETag).toBe(`"${hash}"`);
  });
});

/** #1979: the request pathname is the asset path ENCODED, and `serveProjectAsset` is the ONE place
 *  it is decoded — once. `ctx().resolveAssetPath` above does not decode, exactly like production
 *  since #1979, so every assertion here is about this function's own decode. */
describe('serveProjectAsset — decodes the request path exactly once (#1979)', () => {
  const put = (rel: string, bytes: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), bytes);
  };
  const servedPath = (res: unknown) => (res as { path?: string } | null)?.path;

  it('serves a file whose name holds a literal % (the URL carries it as %25)', async () => {
    put('assets/100%.png', 'P');
    expect(servedPath(await serveProjectAsset(ctx(), '/assets/100%25.png'))).toBe(path.join(root, 'assets/100%.png'));
  });

  it('tells `my%20tex.png` from `my tex.png` — each URL serves its OWN file', async () => {
    put('assets/my tex.png', 'SPACE');
    put('assets/my%20tex.png', 'PERCENT');
    expect(servedPath(await serveProjectAsset(ctx(), '/assets/my%20tex.png'))).toBe(path.join(root, 'assets/my tex.png'));
    expect(servedPath(await serveProjectAsset(ctx(), '/assets/my%2520tex.png'))).toBe(path.join(root, 'assets/my%20tex.png'));
  });

  it('a malformed escape is not an asset: it falls through (null), never throws a 500', async () => {
    put('assets/100%.png', 'P');
    await expect(serveProjectAsset(ctx(), '/assets/100%.png')).resolves.toBeNull();
  });

  it('a VARIANT URL of a %-named source decodes once too (it used to decode twice and throw)', async () => {
    put('assets/models/50%.glb', 'GLB-SOURCE-BYTES');
    put('assets/models/50%.glb.meta.json', JSON.stringify({ modelCache: { hash: 'deadbeefdeadbeef' } }));
    const res = await serveProjectAsset(ctx(), '/assets/models/50%25.glb.processed.glb');
    expect(servedPath(res), 'degrades to the %-named source GLB').toBe(path.join(root, 'assets/models/50%.glb'));
  });
});
