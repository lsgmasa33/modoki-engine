/** `/api/asset-write` must refuse to overwrite a `.particle.json`/`.mat.json` document it cannot
 *  read, the same way every other write in the format-versioning family does
 *  (docs/format-versioning.md § 2b: "a writer that ... can overwrite an existing document must
 *  refuse a too-new one").
 *
 *  WHY THIS EXISTS (#784 phase C adversarial review, finding 2). Before this fix the route did:
 *
 *  ```
 *  try { prevDoc = JSON.parse(fs.readFileSync(abs, 'utf-8')); } catch { prevDoc = null; }
 *  ```
 *
 *  A corrupt file (unresolved `<<<<<<<` merge markers — #778's own input) made `prevDoc` `null`,
 *  which SKIPPED the dropped-top-level-fields 409 guard entirely (it is gated on `prevDoc &&`) and
 *  fell through to the id-preservation branch, which swallowed the SAME parse throw in its own
 *  `catch { /* ignore *\/ }`. `writeJsonAtomic` then replaced the file wholesale WITHOUT its `id`,
 *  and the watcher's heal minted a fresh GUID — every scene/prefab reference to the old asset
 *  dangled. A `too-new` file parsed fine and was simply overwritten, no verdict at all.
 *
 *  Both are refused now: the route classifies the on-disk bytes with `classifyJsonFormatVersion`
 *  BEFORE ever touching `prevDoc`, for the two asset types that carry a real format constant
 *  (`material`, `particle`) — `animation`/`spriteanim`/`timeline`/`rig2d` have no format constant
 *  and keep today's behaviour. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { PARTICLE_FORMAT_VERSION, defaultParticleEffect } from '../../packages/modoki/src/runtime/particles/types';

let projectRoot = '';

function makeCtx(over: Partial<BackendContext> = {}): BackendContext {
  const base = {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async () => ({}),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  };
  return { ...base, ...over } as unknown as BackendContext;
}

const post = (urlPath: string, body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body });

const ASSET_PATH = '/assets/probe.particle.json';

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-assetwrite-'));
  fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

function absPath(): string {
  return path.join(projectRoot, 'assets/probe.particle.json');
}

describe('/api/asset-write — refuses to overwrite a document it cannot read', () => {
  it('refuses a corrupt (merge-markered) file and leaves its bytes untouched', async () => {
    const corrupt =
      '<<<<<<< HEAD\n{"version":1,"id":"guid-1","name":"Mine"}\n=======\n{"version":1,"id":"guid-1","name":"Theirs"}\n>>>>>>> branch\n';
    fs.writeFileSync(absPath(), corrupt);

    const res = (await post('/api/asset-write', {
      path: ASSET_PATH, type: 'particle', data: { ...defaultParticleEffect(), id: 'guid-2', name: 'New' },
    }, makeCtx())) as { status?: number; body: { ok?: boolean; error?: string } };

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/corrupt|unreadable|hand-edited/i);
    expect(fs.readFileSync(absPath(), 'utf-8')).toBe(corrupt);
  });

  it('refuses a too-new file and leaves its bytes untouched', async () => {
    const tooNewDoc = { ...defaultParticleEffect(), version: PARTICLE_FORMAT_VERSION + 1, id: 'guid-1', name: 'FromTheFuture' };
    const tooNewText = JSON.stringify(tooNewDoc, null, 2);
    fs.writeFileSync(absPath(), tooNewText);

    const res = (await post('/api/asset-write', {
      path: ASSET_PATH, type: 'particle', data: { ...defaultParticleEffect(), id: 'guid-1', name: 'Overwrite' },
    }, makeCtx())) as { status?: number; body: { ok?: boolean; error?: string } };

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/newer than this build/i);
    expect(fs.readFileSync(absPath(), 'utf-8')).toBe(tooNewText);
  });

  it('still writes normally over an `ok` document (the fix does not over-refuse)', async () => {
    const okDoc = { ...defaultParticleEffect(), id: 'guid-1', name: 'Old' };
    fs.writeFileSync(absPath(), JSON.stringify(okDoc, null, 2));

    const res = (await post('/api/asset-write', {
      path: ASSET_PATH, type: 'particle', data: { ...defaultParticleEffect(), id: 'guid-1', name: 'Updated' },
    }, makeCtx())) as { status?: number; body: { ok?: boolean } };

    expect(res.body.ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(absPath(), 'utf-8'));
    expect(onDisk.name).toBe('Updated');
  });
});
