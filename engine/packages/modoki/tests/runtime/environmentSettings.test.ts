/** Environment settings + variant-URL resolution (Phase 4). */

import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock HDRLoader so acquireEnvironment can complete a "load" without real HDR bytes.
// Per-path load counter proves invalidateEnvironment forces a fresh fetch on re-acquire.
const hdr = vi.hoisted(() => ({ loads: {} as Record<string, number> }));
vi.mock('three/examples/jsm/loaders/HDRLoader.js', () => ({
  HDRLoader: class {
    load(path: string, onLoad: (texture: any) => void) {
      hdr.loads[path] = (hdr.loads[path] || 0) + 1;
      setTimeout(() => onLoad({ mapping: 0, dispose: vi.fn(), uuid: `hdr-${path}` }), 0);
    }
  },
}));

import {
  invalidateEnvironment, acquireEnvironment, getCachedEnvironment,
  getResourceStats, disposeAllCachedResources,
} from '../../src/runtime/loaders/meshTemplateCache';
import {
  DEFAULT_ENV_SETTINGS, resolveEnvSettings, envVariantUrl, envVariantSuffix,
  ENV_VARIANT_SUFFIX, ULTRAHDR_VARIANT_SUFFIX,
} from '../../src/runtime/loaders/environmentSettings';
import { resolveEnvVariantUrl, getEnvFormat } from '../../src/runtime/loaders/textureResolver';
import { registerAsset, clearManifest } from '../../src/runtime/loaders/assetManifest';

afterEach(() => { clearManifest(); hdr.loads = {}; });

const totalHdrLoads = () => Object.values(hdr.loads).reduce((a, b) => a + b, 0);

describe('resolveEnvSettings', () => {
  it('fills defaults for missing/empty meta', () => {
    expect(resolveEnvSettings(undefined)).toEqual(DEFAULT_ENV_SETTINGS);
    expect(resolveEnvSettings({})).toEqual(DEFAULT_ENV_SETTINGS);
  });
  it('merges a persisted environment block over the defaults', () => {
    expect(resolveEnvSettings({ environment: { maxSize: 512 } })).toEqual({ format: 'hdr', maxSize: 512 });
  });
});

describe('envVariantSuffix', () => {
  it('picks the per-format suffix', () => {
    expect(envVariantSuffix('hdr')).toBe(ENV_VARIANT_SUFFIX);       // ~env.hdr
    expect(envVariantSuffix('ultrahdr')).toBe(ULTRAHDR_VARIANT_SUFFIX); // ~ultrahdr.jpg
  });
});

describe('envVariantUrl', () => {
  it('appends the format suffix (hdr default)', () => {
    expect(envVariantUrl('/x/studio.hdr')).toBe('/x/studio.hdr' + ENV_VARIANT_SUFFIX);
    expect(envVariantUrl('/x/studio.hdr', 'ultrahdr')).toBe('/x/studio.hdr' + ULTRAHDR_VARIANT_SUFFIX);
  });
});

describe('resolveEnvVariantUrl', () => {
  const GUID = '11111111-2222-4333-8444-555555555555';
  const PATH = '/games/x/assets/env/studio.hdr';

  it('returns the ~env.hdr variant when the HDR is converted', () => {
    // (The ?v=<hash> cache-bust is appended only in the GCS prod build, not here.)
    registerAsset(GUID, PATH, 'environment', undefined, { environment: { format: 'hdr', maxSize: 1024 } }, 'deadbeef');
    expect(resolveEnvVariantUrl(GUID)).toContain(PATH + ENV_VARIANT_SUFFIX);
  });

  it('falls back to the raw source URL when unconverted (no environment block)', () => {
    registerAsset(GUID, PATH, 'environment');
    const url = resolveEnvVariantUrl(GUID);
    expect(url).toContain(PATH);
    expect(url).not.toContain(ENV_VARIANT_SUFFIX);
  });

  it('resolves by source PATH too (the runtime env loader has the path, not the guid)', () => {
    registerAsset(GUID, PATH, 'environment', undefined, { environment: { format: 'hdr', maxSize: 1024 } }, 'cafe');
    expect(resolveEnvVariantUrl(PATH)).toContain(PATH + ENV_VARIANT_SUFFIX);
  });

  it('resolves the ~ultrahdr.jpg variant + reports the format for ultrahdr', () => {
    registerAsset(GUID, PATH, 'environment', undefined, { environment: { format: 'ultrahdr', maxSize: 1024 } }, 'beef');
    expect(resolveEnvVariantUrl(GUID)).toContain(PATH + ULTRAHDR_VARIANT_SUFFIX);
    expect(getEnvFormat(GUID)).toBe('ultrahdr');
    expect(getEnvFormat(PATH)).toBe('ultrahdr');
  });

  it('getEnvFormat is undefined for an unconverted HDR', () => {
    registerAsset(GUID, PATH, 'environment');
    expect(getEnvFormat(GUID)).toBeUndefined();
  });
});

describe('invalidateEnvironment', () => {
  it('accepts a source PATH without the GUID-only "path reference no longer supported" error', () => {
    // The editor Environment Inspector calls this with the asset PATH (not a guid);
    // resolveRef rejects internal paths loudly, so invalidateEnvironment must accept a
    // path as-is (mirrors invalidateTexture) — regression for the Apply-time console error.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => invalidateEnvironment('/games/x/assets/env/studio.hdr')).not.toThrow();
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('path reference no longer supported'));
    spy.mockRestore();
  });

  it('disposes + evicts a live cached HDR but KEEPS owners so the next acquire reloads', async () => {
    // The re-import path: after the Environment Inspector re-bakes a downscaled ~env.hdr,
    // it calls invalidateEnvironment to drop the stale live texture. Ownership must be
    // retained so the scene's next syncEnvironment/re-acquire re-fetches the fresh bytes
    // (rather than silently going unlit because the owner was also dropped).
    const GUID = '22222222-3333-4444-8555-666666666666';
    const PATH = '/env/sky.hdr';
    registerAsset(GUID, PATH, 'environment'); // unconverted → load URL == source path
    try {
      await acquireEnvironment(1, GUID);
      const cached = getCachedEnvironment(GUID)!;
      expect(cached).toBeDefined();
      expect(totalHdrLoads()).toBe(1);
      expect(getResourceStats().environments[PATH]).toBe(1); // scene-1 owner present

      // Evict via the SOURCE PATH form (what the editor re-import call passes).
      invalidateEnvironment(PATH);
      expect(cached.dispose).toHaveBeenCalled();           // live texture disposed
      expect(getCachedEnvironment(GUID)).toBeUndefined();  // cache entry gone
      expect(getResourceStats().environments[PATH]).toBe(1); // ...but the owner survives

      // Next acquire re-fetches the fresh variant — load count climbs.
      await acquireEnvironment(1, GUID);
      expect(totalHdrLoads()).toBe(2);
      expect(getCachedEnvironment(GUID)).toBeDefined();
    } finally {
      disposeAllCachedResources(); // don't leak this scene's owner into sibling tests
    }
  });
});
