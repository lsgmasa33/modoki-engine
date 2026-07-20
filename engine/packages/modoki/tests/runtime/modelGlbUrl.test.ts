import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import { modelGlbUrl } from '../../src/runtime/loaders/meshTemplateCache';

const GUID = '22222222-2222-4222-8222-222222222222';
const MODEL = '/games/g/assets/models/island.glb';

beforeEach(() => clearManifest());

describe('modelGlbUrl', () => {
  it('returns the plain URL when the model has no hash', () => {
    registerAsset(GUID, MODEL, 'model');
    expect(modelGlbUrl(MODEL)).toContain(MODEL);
    expect(modelGlbUrl(MODEL)).not.toContain('?v=');
  });

  it('does NOT append ?v in dev even with a hash', () => {
    registerAsset(GUID, MODEL, 'model', undefined, undefined, 'cafe1234');
    expect(modelGlbUrl(MODEL)).not.toContain('?v=');
  });

  it('appends ?v=<hash> for the base model path in production', () => {
    vi.stubEnv('PROD', 'true');
    try {
      registerAsset(GUID, MODEL, 'model', undefined, undefined, 'cafe1234');
      expect(modelGlbUrl(MODEL)).toContain(`${MODEL}?v=cafe1234`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('derives the base hash for LOD paths in production', () => {
    vi.stubEnv('PROD', 'true');
    try {
      registerAsset(GUID, MODEL, 'model', undefined, undefined, 'cafe1234');
      // LOD URLs are <model>.glb.processed.glb / <model>.glb.lod<N>.glb — no entry
      // of their own, so the hash comes from the base model entry.
      expect(modelGlbUrl(MODEL + '.processed.glb')).toContain('?v=cafe1234');
      expect(modelGlbUrl(MODEL + '.lod2.glb')).toContain('?v=cafe1234');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('produces exactly one query separator (no double-? — B4)', () => {
    vi.stubEnv('PROD', 'true');
    try {
      registerAsset(GUID, MODEL, 'model', undefined, undefined, 'cafe1234');
      const url = modelGlbUrl(MODEL);
      expect((url.match(/\?/g) || []).length).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('no ?v when the base entry is missing in production (no ?v=undefined)', () => {
    vi.stubEnv('PROD', 'true');
    try {
      // No registerAsset → no entry for the LOD path nor its base.
      expect(modelGlbUrl(MODEL + '.processed.glb')).not.toContain('?v=');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
