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
import { relay } from './backendRelay';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { PARTICLE_FORMAT_VERSION, defaultParticleEffect } from '../../packages/modoki/src/runtime/particles/types';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

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
    requestBrowser: relay(),
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
  projectRoot = makeScratchDir('modoki-assetwrite-');
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

/** #1590 — the route STAMPS the format version (docs/format-versioning.md § 2b). The schema tells
 *  a writer never to hand-author `version`; a `particle_set` that obeyed was parked versionless, and
 *  the dropped-field guard then refused every save because the file on disk has `version`. */
describe('/api/asset-write — stamps the format version itself', () => {
  const versionless = () => {
    const { version: _drop, ...rest } = defaultParticleEffect();
    return rest;
  };

  it('a versionless write over a versioned file is NOT refused as a drop, and lands stamped', async () => {
    fs.writeFileSync(absPath(), JSON.stringify({ ...defaultParticleEffect(), id: 'guid-1', name: 'Old' }, null, 2));

    const res = (await post('/api/asset-write', {
      path: ASSET_PATH, type: 'particle', data: { ...versionless(), id: 'guid-1', name: 'Fireflies' },
    }, makeCtx())) as { body: { ok?: boolean; error?: string } };

    expect(res.body.error).toBeUndefined();
    expect(res.body.ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(absPath(), 'utf-8'));
    expect(onDisk.name).toBe('Fireflies');
    expect(onDisk.version).toBe(PARTICLE_FORMAT_VERSION);
  });

  it('keeps a present, readable caller version — it cannot migrate, so it does not relabel content current', async () => {
    fs.writeFileSync(absPath(), JSON.stringify({ ...defaultParticleEffect(), id: 'guid-1', name: 'Old' }, null, 2));

    const res = (await post('/api/asset-write', {
      path: ASSET_PATH, type: 'particle', data: { ...defaultParticleEffect(), version: 0, id: 'guid-1', name: 'Legacy' },
    }, makeCtx())) as { body: { ok?: boolean } };

    expect(res.body.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(absPath(), 'utf-8')).version).toBe(0);
  });

  it('REFUSES a too-new incoming version instead of stamping it down (close-out review)', async () => {
    const before = JSON.stringify({ ...defaultParticleEffect(), id: 'guid-1', name: 'Old' }, null, 2);
    fs.writeFileSync(absPath(), before);

    const res = (await post('/api/asset-write', {
      path: ASSET_PATH, type: 'particle',
      data: { ...defaultParticleEffect(), version: PARTICLE_FORMAT_VERSION + 1, id: 'guid-1', futureField: 1 },
    }, makeCtx())) as { status?: number; body: { ok?: boolean; errors?: string[] } };

    // Refused by `validateAssetData` — the SAME check `particle_set` runs before it parks, so the
    // op refuses at call time instead of parking a def every save_all then fails to flush.
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect((res.body.errors ?? []).join('\n')).toMatch(/particle\.version \d+ is newer than this build/);
    expect(fs.readFileSync(absPath(), 'utf-8')).toBe(before);
  });

  it('REFUSES a non-integer incoming version', async () => {
    const before = JSON.stringify({ ...defaultParticleEffect(), id: 'guid-1', name: 'Old' }, null, 2);
    fs.writeFileSync(absPath(), before);

    const res = (await post('/api/asset-write', {
      path: ASSET_PATH, type: 'particle', data: { ...defaultParticleEffect(), version: '1', id: 'guid-1' },
    }, makeCtx())) as { status?: number; body: { ok?: boolean; errors?: string[] } };

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect((res.body.errors ?? []).join('\n')).toMatch(/particle\.version must be an integer/);
    expect(fs.readFileSync(absPath(), 'utf-8')).toBe(before);
  });

  it('adds no version to a type with no format constant (animation)', async () => {
    const animAbs = path.join(projectRoot, 'assets/probe.anim.json');
    fs.writeFileSync(animAbs, JSON.stringify({ id: 'guid-a', name: 'Clip', duration: 1, frameRate: 60, tracks: [] }));
    const res = (await post('/api/asset-write', {
      path: '/assets/probe.anim.json', type: 'animation',
      data: { id: 'guid-a', name: 'Clip', duration: 1, frameRate: 60, tracks: [] },
    }, makeCtx())) as { body: { ok?: boolean; error?: string } };

    expect(res.body.error).toBeUndefined();
    expect(res.body.ok).toBe(true);
    expect('version' in JSON.parse(fs.readFileSync(animAbs, 'utf-8'))).toBe(false);
  });
});
