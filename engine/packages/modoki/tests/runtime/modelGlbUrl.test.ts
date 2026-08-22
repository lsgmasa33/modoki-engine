import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import { modelGlbUrl } from '../../src/runtime/loaders/meshTemplateCache';
import { resolveRefWarnOnce } from '../../src/runtime/loaders/modelGlbUrl';

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
    vi.stubEnv('PROD', true);
    try {
      registerAsset(GUID, MODEL, 'model', undefined, undefined, 'cafe1234');
      expect(modelGlbUrl(MODEL)).toContain(`${MODEL}?v=cafe1234`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('derives the base hash for LOD paths in production', () => {
    vi.stubEnv('PROD', true);
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
    vi.stubEnv('PROD', true);
    try {
      registerAsset(GUID, MODEL, 'model', undefined, undefined, 'cafe1234');
      const url = modelGlbUrl(MODEL);
      expect((url.match(/\?/g) || []).length).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('no ?v when the base entry is missing in production (no ?v=undefined)', () => {
    vi.stubEnv('PROD', true);
    try {
      // No registerAsset → no entry for the LOD path nor its base.
      expect(modelGlbUrl(MODEL + '.processed.glb')).not.toContain('?v=');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('resolveRefWarnOnce — a transient miss must not silence the guid forever (QA-ASSET-0005)', () => {
  // `seen` is module-level in every real caller and never cleared, so ONE failed lookup in the
  // window before the manifest reaches the client bought silence for the whole session. Delete
  // that asset an hour later and the entity fell back to nothing with a clean console — the exact
  // "blank screen, clean console" failure this warning exists to prevent, and worse than never
  // having warned. The 2D twin (`warnUnresolvedSprite`) already forgot a resolving ref; its
  // header named this gap as a separate change. This is that change.
  let warn: ReturnType<typeof vi.spyOn>;
  let seen: Set<string>;
  beforeEach(() => {
    seen = new Set<string>();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('warns once for an unresolvable guid, then stays quiet', () => {
    expect(resolveRefWarnOnce(GUID, 'MeshCache', seen)).toBeUndefined();
    expect(resolveRefWarnOnce(GUID, 'MeshCache', seen)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(GUID);
  });

  it('FORGETS a ref that later resolves, so a genuine later break still warns', () => {
    expect(resolveRefWarnOnce(GUID, 'MeshCache', seen)).toBeUndefined();  // transient miss
    expect(warn).toHaveBeenCalledTimes(1);

    registerAsset(GUID, MODEL, 'model');                                   // manifest arrives
    expect(resolveRefWarnOnce(GUID, 'MeshCache', seen)).toBe(MODEL);
    expect(seen.has(GUID)).toBe(false);

    clearManifest();                                                       // now genuinely deleted
    expect(resolveRefWarnOnce(GUID, 'MeshCache', seen)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);                                 // warns AGAIN, not silently
  });

  it('does not warn for a non-guid ref (an external URL)', () => {
    resolveRefWarnOnce('https://example.com/x.glb', 'MeshCache', seen);
    expect(warn).not.toHaveBeenCalled();
  });
});
