/** assetInvalidation — the ONE re-import event the three caches emit through (#304).
 *
 *  Before this, `invalidateModel` had listeners and `invalidateTexture` /
 *  `invalidateAudio` had none, so nothing on the texture or audio side could be told
 *  a re-import had happened. These tests drive the REAL invalidate* functions, not a
 *  stub of the registry: the failure being guarded against is a cache that evicts
 *  without announcing, which a stubbed emitter would hide completely.
 *
 *  The model half is covered end-to-end by meshTemplateCacheLod.test.ts's
 *  `onModelInvalidated listener` block, which now runs through this registry. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  onAssetInvalidated, emitAssetInvalidated, clearAssetInvalidationListeners,
  type InvalidatedAssetKind,
} from '../../src/runtime/core/assetInvalidation';

const TEX = '/games/fixture/assets/textures/brick.png';
const CLIP = '/games/fixture/assets/audio/hit.wav';

type Fired = [InvalidatedAssetKind, string, string[]];
const record = (out: Fired[]) =>
  onAssetInvalidated((kind, path, targets) => { out.push([kind, path, [...targets]]); });

beforeEach(() => { clearAssetInvalidationListeners(); });

describe('emitAssetInvalidated', () => {
  it('delivers kind + path, defaulting targets to the path itself', () => {
    const fired: Fired[] = [];
    record(fired);
    emitAssetInvalidated('texture', TEX);
    expect(fired).toEqual([['texture', TEX, [TEX]]]);
  });

  it('stops delivering after unsubscribe', () => {
    const fired: Fired[] = [];
    const unsub = record(fired);
    unsub();
    emitAssetInvalidated('model', '/x.glb');
    expect(fired).toEqual([]);
  });

  it('isolates a throwing listener so the others still run — and the caller still evicts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fired: Fired[] = [];
    onAssetInvalidated(() => { throw new Error('boom'); });
    record(fired);
    // The emit happens BEFORE eviction, so a listener that throws through it would
    // leave a half-evicted cache — worse than a stale panel.
    expect(() => emitAssetInvalidated('audio', CLIP)).not.toThrow();
    expect(fired).toEqual([['audio', CLIP, [CLIP]]]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the caches emit through it', () => {
  it('invalidateTexture announces the resolved source path under kind "texture"', async () => {
    const { invalidateTexture } = await import('../../src/runtime/loaders/textureResolver');
    const fired: Fired[] = [];
    record(fired);
    invalidateTexture(TEX);
    expect(fired).toEqual([['texture', TEX, [TEX]]]);
  });

  it('invalidateAudio announces the resolved PATH under kind "audio", given a guid', async () => {
    const { invalidateAudio } = await import('../../src/runtime/loaders/audioBufferCache');
    const { registerAsset } = await import('../../src/runtime/loaders/assetManifest');
    // Audio resolves its ref through the manifest and accepts a GUID only (a bare
    // internal path is rejected by resolveRef by design), so a subscriber must be
    // handed the resolved path — a panel is keyed on the path, never the guid.
    const guid = '55555555-5555-4555-8555-555555555555';
    registerAsset(guid, CLIP, 'audio');
    const fired: Fired[] = [];
    record(fired);
    invalidateAudio(guid);
    expect(fired).toEqual([['audio', CLIP, [CLIP]]]);
  });

  it('invalidateAudio accepts a PATH — its only production caller passes one', async () => {
    const { invalidateAudio } = await import('../../src/runtime/loaders/audioBufferCache');
    const fired: Fired[] = [];
    record(fired);
    // Regression (#304 close-out): this used to resolve every ref through the manifest,
    // and resolveRef rejects an internal asset path — so the Audio Inspector's Apply
    // button, which passes the path, evicted NOTHING and the game kept playing the old
    // decoded buffer until an editor restart. An unregistered path must work too: the
    // caller has the file, not a guid.
    invalidateAudio('/assets/audio/unregistered.wav');
    expect(fired).toEqual([['audio', '/assets/audio/unregistered.wav', ['/assets/audio/unregistered.wav']]]);
  });

  it('invalidateEnvironment announces under kind "environment"', async () => {
    const { invalidateEnvironment } = await import('../../src/runtime/loaders/meshTemplateCache');
    const fired: Fired[] = [];
    record(fired);
    invalidateEnvironment('/assets/env/studio.hdr');
    expect(fired).toEqual([['environment', '/assets/env/studio.hdr', ['/assets/env/studio.hdr']]]);
  });

  it('a texture re-import is not reported as a model one (and vice versa)', async () => {
    const { invalidateTexture } = await import('../../src/runtime/loaders/textureResolver');
    const { invalidateModel } = await import('../../src/runtime/loaders/meshTemplateCache');
    const kinds: string[] = [];
    onAssetInvalidated((kind) => { kinds.push(kind); });
    invalidateTexture(TEX);
    invalidateModel('/games/fixture/assets/models/thing.glb');
    // The kind is what every subscriber filters on, so a mislabelled emit would
    // refresh the wrong panel and leave the right one stale.
    expect(kinds).toEqual(['texture', 'model']);
  });
});
