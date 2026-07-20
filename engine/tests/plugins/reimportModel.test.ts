/** reimport-model — Node-side postprocessor resolution + handler. The handler
 *  invokes the model converter (CLI-driven), so we mock that out and verify
 *  the orchestration: sidecar read, settings merged, converter invoked, cache
 *  bookkeeping persisted, GUID minted on first import. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolvePostprocessorForId, modelReimportHandler, isRiggedMeta } from '../../plugins/reimport-model';
import * as modelConvert from '../../plugins/model-convert';
import type { ReimportContext } from '../../plugins/reimport-registry';
import { readMetaSidecar } from '../../plugins/meta-sidecar';

// Postprocessors are now declared by the PROJECT in project.config.json (the
// engine no longer hardcodes per-game paths). Each test gets a temp project
// root carrying the island declaration; `file` is project-relative and the
// engine resolves it to an absolute path for SSR loading.
const ISLAND_DECL = { recipeVersion: 2, file: 'runtime/postprocessor.ts', registerFn: 'registerIslandPostprocessor' };

function makeProject(postprocessors: Record<string, unknown> = { island: ISLAND_DECL }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-proj-'));
  fs.writeFileSync(path.join(dir, 'project.config.json'), JSON.stringify({ postprocessors }));
  return dir;
}

describe('isRiggedMeta (C5 — rigged routing gate)', () => {
  it('is true only for a rig block carrying a clips ARRAY', () => {
    expect(isRiggedMeta({ rig: { clips: ['Idle', 'Walk'] } })).toBe(true);
    expect(isRiggedMeta({ rig: { clips: [] } })).toBe(true); // rigged with no clips is still rigged
  });

  it('is false for a stray/empty rig:{} on a static model (would break it)', () => {
    expect(isRiggedMeta({ rig: {} })).toBe(false);
    expect(isRiggedMeta({ rig: { clips: 'Idle' } })).toBe(false); // not an array
    expect(isRiggedMeta({ rig: null as unknown as object })).toBe(false);
    expect(isRiggedMeta({})).toBe(false);
  });
});

describe('resolvePostprocessorForId', () => {
  let projectRoot: string;
  let islandAbsFile: string;
  let baseCtx: Omit<ReimportContext, 'ssrLoadModule'>;

  beforeEach(() => {
    projectRoot = makeProject();
    islandAbsFile = path.resolve(projectRoot, ISLAND_DECL.file);
    baseCtx = { projectRoot, resolveAssetPath: () => null };
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns null for the built-in "none" postprocessor (no Stage A bake)', async () => {
    const ctx: ReimportContext = { ...baseCtx, ssrLoadModule: vi.fn() };
    expect(await resolvePostprocessorForId('none', ctx)).toBeNull();
    expect(ctx.ssrLoadModule).not.toHaveBeenCalled();
  });

  it('returns null when the id has no declaration in project.config.json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx: ReimportContext = { ...baseCtx, ssrLoadModule: vi.fn() };
    expect(await resolvePostprocessorForId('not-a-real-id', ctx)).toBeNull();
    log.mockRestore();
  });

  it('returns null when ssrLoadModule is missing (build path)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx: ReimportContext = { ...baseCtx };
    expect(await resolvePostprocessorForId('island', ctx)).toBeNull();
    log.mockRestore();
  });

  it('SSR-loads the project-relative file resolved to an ABSOLUTE path, calling the named registerFn', async () => {
    const registerFnSpy = vi.fn();
    const fakePostprocessor = { recipeVersion: 1, name: 'island', fixupMesh: () => {} };
    const getModelPostprocessor = vi.fn().mockReturnValue(fakePostprocessor);
    const ssrLoadModule = vi.fn(async (url: string) => {
      if (url.includes('modelPostprocessorRegistry')) return { getModelPostprocessor };
      if (url === islandAbsFile) {
        return { [ISLAND_DECL.registerFn]: registerFnSpy };
      }
      throw new Error('unexpected import: ' + url);
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx: ReimportContext = { ...baseCtx, ssrLoadModule };
    const result = await resolvePostprocessorForId('island', ctx);
    log.mockRestore();

    expect(result).toBe(fakePostprocessor);
    expect(ssrLoadModule).toHaveBeenCalledWith(
      expect.stringContaining('modelPostprocessorRegistry'),
    );
    // Absolute path (project-relative `file` resolved against projectRoot) — not
    // the root-relative form that broke for flat one-game projects.
    expect(islandAbsFile).toBe(path.join(projectRoot, 'runtime', 'postprocessor.ts'));
    expect(ssrLoadModule).toHaveBeenCalledWith(islandAbsFile);
    expect(registerFnSpy).toHaveBeenCalledTimes(1);
    expect(getModelPostprocessor).toHaveBeenCalledWith('island');
  });

  it('returns null + warns when the registry falls back to the "None" no-op', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ssrLoadModule = vi.fn(async (url: string) => {
      if (url.includes('modelPostprocessorRegistry')) {
        return { getModelPostprocessor: () => ({ name: 'None', fixupMesh: () => {} }) };
      }
      return { [ISLAND_DECL.registerFn]: () => {} };
    });
    const ctx: ReimportContext = { ...baseCtx, ssrLoadModule };
    expect(await resolvePostprocessorForId('island', ctx)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns null + warns when ssrLoadModule throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ssrLoadModule = vi.fn(async () => { throw new Error('module load failed'); });
    const ctx: ReimportContext = { ...baseCtx, ssrLoadModule };
    expect(await resolvePostprocessorForId('island', ctx)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('modelReimportHandler', () => {
  let tmpDir: string;
  let glbPath: string;
  let projectRoot: string;
  let baseCtx: Omit<ReimportContext, 'ssrLoadModule'>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-reimport-test-'));
    glbPath = path.join(tmpDir, 'thing.glb');
    fs.writeFileSync(glbPath, Buffer.from([0x67, 0x6c, 0x54, 0x46])); // bogus GLB header bytes
    projectRoot = makeProject(); // declares island → recipeVersion read from here
    baseCtx = { projectRoot, resolveAssetPath: () => null };
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('mints a GUID, persists model + modelCache, and invokes convertModel with sidecar settings', async () => {
    // Seed a partial sidecar — handler should merge it over defaults.
    fs.writeFileSync(glbPath + '.meta.json', JSON.stringify({
      postprocessor: 'island',
      model: { encoder: 'gltfpack', lodCount: 2 },
    }));

    const convertSpy = vi.spyOn(modelConvert, 'convertModel').mockResolvedValue({
      hash: 'abc123',
      cached: false,
      processedPath: '/cache/.processed.glb',
      lodPaths: ['/cache/.processed.glb', '/cache/.lod1.glb'],
      lodDistances: [0, 80],
      triCounts: [1000, 400],
      lodBytes: [10000, 4000],
    });

    const ctx: ReimportContext = { ...baseCtx, ssrLoadModule: vi.fn() };
    await modelReimportHandler('/games/g/assets/models/thing.glb', glbPath, ctx);

    // convertModel was invoked with the merged settings + recipe version from
    // the postprocessor registry.
    expect(convertSpy).toHaveBeenCalledTimes(1);
    const call = convertSpy.mock.calls[0][0];
    expect(call.absSource).toBe(glbPath);
    expect(call.sourceUrlPath).toBe('/games/g/assets/models/thing.glb');
    expect(call.postprocessorId).toBe('island');
    expect(call.recipeVersion).toBe(ISLAND_DECL.recipeVersion);
    expect(call.settings.encoder).toBe('gltfpack'); // from sidecar
    expect(call.settings.lodCount).toBe(2);          // from sidecar

    // Sidecar was rewritten with id + cache bookkeeping. Read via readMetaSidecar,
    // which merges the machine-local byte-stats sidecar back over the committed
    // `.meta.json` — the reimport contract is "the data is retrievable", not "every
    // field lives in one physical file" (byte sizes are peeled into `.meta.local.json`).
    const persisted = readMetaSidecar(glbPath) as { id: string; version: number; model: { encoder: string }; modelCache: { hash: string; processedPath: string; lodPaths: string[]; triCounts: number[]; lodBytes: number[] } };
    expect(persisted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(persisted.version).toBe(2);
    expect(persisted.model.encoder).toBe('gltfpack');
    expect(persisted.modelCache.hash).toBe('abc123');
    // URL-form LOD paths are deterministic — `.processed.glb` then `.lod<N>.glb`.
    expect(persisted.modelCache.processedPath).toBe('/games/g/assets/models/thing.glb.processed.glb');
    expect(persisted.modelCache.lodPaths).toEqual([
      '/games/g/assets/models/thing.glb.processed.glb',
      '/games/g/assets/models/thing.glb.lod1.glb',
    ]);
    expect(persisted.modelCache.triCounts).toEqual([1000, 400]);
    expect(persisted.modelCache.lodBytes).toEqual([10000, 4000]);
    // The byte-size stats were peeled OUT of the committed sidecar (host-stable commit).
    const committed = JSON.parse(fs.readFileSync(glbPath + '.meta.json', 'utf-8'));
    expect(committed.modelCache).not.toHaveProperty('triCounts');
    expect(committed.modelCache).not.toHaveProperty('lodBytes');
    expect(committed.modelCache.hash).toBe('abc123'); // …but structural fields stay committed
  });

  it('defaults to postprocessor "none" + recipeVersion 0 when the sidecar omits it', async () => {
    // No sidecar at all — handler should still proceed with defaults.
    const convertSpy = vi.spyOn(modelConvert, 'convertModel').mockResolvedValue({
      hash: 'def',
      cached: true,
      processedPath: '/c/.processed.glb',
      lodPaths: ['/c/.processed.glb'],
      lodDistances: [0],
      triCounts: [50],
      lodBytes: [500],
    });

    const ctx: ReimportContext = { ...baseCtx };
    await modelReimportHandler('/games/g/assets/models/legacy.glb', glbPath, ctx);

    const call = convertSpy.mock.calls[0][0];
    expect(call.postprocessorId).toBe('none');
    expect(call.recipeVersion).toBe(0);
  });

  it('preserves an existing sidecar id across reimport', async () => {
    const existingId = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(glbPath + '.meta.json', JSON.stringify({ id: existingId }));

    vi.spyOn(modelConvert, 'convertModel').mockResolvedValue({
      hash: 'h',
      cached: false,
      processedPath: '/c/.processed.glb',
      lodPaths: ['/c/.processed.glb'],
      lodDistances: [0],
      triCounts: [0],
      lodBytes: [0],
    });

    const ctx: ReimportContext = { ...baseCtx };
    await modelReimportHandler('/games/g/assets/models/preserve.glb', glbPath, ctx);

    const persisted = JSON.parse(fs.readFileSync(glbPath + '.meta.json', 'utf-8'));
    expect(persisted.id).toBe(existingId);
  });
});
