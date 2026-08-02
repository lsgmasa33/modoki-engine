/** End-to-end cover for `GET /api/validate-scene`'s prefab-instance inert-size check
 *  (#35) — specifically `makePrefabResolver` in editorBackendRouter.ts, the piece
 *  most likely to be wrong in the real world (GUID → manifest lookup → path →
 *  `resolveAssetPath` → disk read → JSON.parse). The validator's own unit tests
 *  (`sceneValidation.test.ts`) all inject a fake `PrefabResolver`, so they prove the
 *  warning LOGIC but never exercise the real resolver — a broken manifest lookup or
 *  a wrong path resolution would still ship green. Here everything is REAL: a temp
 *  project dir, real files on disk, a real manifest, and the real GUID→path→fs.read
 *  chain the router builds. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

const PREFAB_GUID = 'b2c3d4e5-1111-2222-3333-444455556666';
const SCENE_REL = '/assets/scenes/main.json';
const PREFAB_REL = '/assets/prefabs/thing.prefab.json';

let tmp: string;

function writeJson(rel: string, data: unknown): void {
  const abs = path.join(tmp, 'runtime', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data, null, 2));
}

function writeRaw(rel: string, text: string): void {
  const abs = path.join(tmp, 'runtime', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** A ctx with a REAL asset-root resolver and a REAL manifest lookup — the same
 *  shape `makePrefabResolver` reads (`ctx.getManifest().assets` for the guid,
 *  `ctx.resolveAssetPath` + `fs.readFileSync` for the bytes). No schema (the
 *  inert-size check doesn't need one — it's schema-independent). */
function makeCtx(manifestAssets: Manifest['assets']): BackendContext {
  return {
    projectRoot: tmp,
    resolveAssetPath: (p: string) => (p.startsWith('/assets/') ? path.join(tmp, 'runtime', p) : null),
    getManifest: () => ({ version: 2, assets: manifestAssets }) as Manifest,
    getSchema: () => undefined,
    firstRootDir: () => null,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const validate = (scenePath: string, ctx: BackendContext) =>
  handleBackendRequest(ctx, {
    method: 'GET',
    urlPath: '/api/validate-scene',
    query: new URLSearchParams({ path: scenePath }),
    body: undefined,
  });

const scene = (overrides: Record<string, unknown>) => ({
  version: 8,
  entities: [
    {
      id: 1,
      name: 'Instance',
      traits: { PrefabInstance: { source: PREFAB_GUID, localId: 1, rootInstanceId: 1 } },
      overrides,
    },
  ],
});

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-validate-scene-prefab-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('GET /api/validate-scene — real prefab resolver (#35)', () => {
  it('reads the anchor off a REAL .prefab.json through the REAL manifest and warns', async () => {
    writeJson(PREFAB_REL, {
      id: PREFAB_GUID,
      version: 1,
      name: 'Thing',
      rootLocalId: 1,
      entities: [{ localId: 1, name: 'Root', traits: { UIAnchor: { anchor: 'bottom-stretch' } } }],
    });
    writeJson(SCENE_REL, scene({ 1: { UIElement: { width: 90, widthUnit: '%' } } }));

    const ctx = makeCtx([{ path: PREFAB_REL, type: 'prefab', guid: PREFAB_GUID }]);
    const r = (await validate(SCENE_REL, ctx)) as { body: { warnings: string[] } };
    expect(r.body.warnings.join('\n')).toMatch(/overrides\[1\]\.UIElement\.width is inert/);
  });

  it('matches the manifest guid case-insensitively', async () => {
    writeJson(PREFAB_REL, {
      id: PREFAB_GUID,
      version: 1,
      name: 'Thing',
      rootLocalId: 1,
      entities: [{ localId: 1, name: 'Root', traits: { UIAnchor: { anchor: 'stretch' } } }],
    });
    writeJson(SCENE_REL, scene({ 1: { UIElement: { width: 200, widthUnit: '%' } } }));

    const ctx = makeCtx([{ path: PREFAB_REL, type: 'prefab', guid: PREFAB_GUID.toUpperCase() }]);
    const r = (await validate(SCENE_REL, ctx)) as { body: { warnings: string[] } };
    expect(r.body.warnings.join('\n')).toMatch(/overrides\[1\]\.UIElement\.width is inert/);
  });

  it('unknown guid (manifest has no such entry) → 200, no crash, no inert warning', async () => {
    writeJson(PREFAB_REL, {
      id: PREFAB_GUID,
      version: 1,
      name: 'Thing',
      rootLocalId: 1,
      entities: [{ localId: 1, name: 'Root', traits: { UIAnchor: { anchor: 'bottom-stretch' } } }],
    });
    writeJson(SCENE_REL, scene({ 1: { UIElement: { width: 90, widthUnit: '%' } } }));

    // Manifest has a DIFFERENT guid — the real one is simply not registered.
    const ctx = makeCtx([{ path: PREFAB_REL, type: 'prefab', guid: 'ffffffff-0000-0000-0000-000000000000' }]);
    const r = (await validate(SCENE_REL, ctx)) as { status?: number; body: { warnings: string[] } };
    expect(r.status).toBeUndefined(); // json() with no explicit status = 200
    expect(r.body.warnings.filter((w) => /is inert/.test(w))).toEqual([]);
  });

  it('serves several instances of the SAME prefab from one memoized read', async () => {
    writeJson(PREFAB_REL, {
      id: PREFAB_GUID,
      version: 1,
      name: 'Thing',
      rootLocalId: 1,
      entities: [{ localId: 1, name: 'Root', traits: { UIAnchor: { anchor: 'bottom-stretch' } } }],
    });
    // Two instances of the same prefab — the resolver caches per call, so the file is read
    // once, but BOTH must still be reported (a cache that served only the first would be a
    // silent under-report, which is the failure mode this check exists to prevent).
    writeJson(SCENE_REL, {
      version: 8,
      entities: [
        { id: 1, name: 'A', traits: { PrefabInstance: { source: PREFAB_GUID, localId: 1, rootInstanceId: 1 } }, overrides: { 1: { UIElement: { width: 90, widthUnit: '%' } } } },
        { id: 2, name: 'B', traits: { PrefabInstance: { source: PREFAB_GUID, localId: 1, rootInstanceId: 2 } }, overrides: { 1: { UIElement: { width: 70, widthUnit: '%' } } } },
      ],
    });

    const ctx = makeCtx([{ path: PREFAB_REL, type: 'prefab', guid: PREFAB_GUID }]);
    const r = (await validate(SCENE_REL, ctx)) as { body: { warnings: string[] } };
    const inert = r.body.warnings.filter((w) => /is inert/.test(w));
    expect(inert).toHaveLength(2);
    expect(inert.join('\n')).toMatch(/'A'.*overridden 90%/s);
    expect(inert.join('\n')).toMatch(/'B'.*overridden 70%/s);
  });

  it('ignores a guid match on a NON-prefab asset (never reads a .glb to fail parsing it)', async () => {
    writeJson(PREFAB_REL, {
      id: PREFAB_GUID,
      version: 1,
      name: 'Thing',
      rootLocalId: 1,
      entities: [{ localId: 1, name: 'Root', traits: { UIAnchor: { anchor: 'bottom-stretch' } } }],
    });
    writeJson(SCENE_REL, scene({ 1: { UIElement: { width: 90, widthUnit: '%' } } }));

    // Same guid, but the manifest says it's a model — a `source` pointing at one is a data
    // error, and the resolver must not read it at all.
    const ctx = makeCtx([{ path: PREFAB_REL, type: 'model', guid: PREFAB_GUID }]);
    const r = (await validate(SCENE_REL, ctx)) as { body: { warnings: string[] } };
    expect(r.body.warnings.filter((w) => /is inert/.test(w))).toEqual([]);
  });

  it('malformed prefab JSON on disk → 200, no crash, no inert warning', async () => {
    writeRaw(PREFAB_REL, '{ this is not valid json');
    writeJson(SCENE_REL, scene({ 1: { UIElement: { width: 90, widthUnit: '%' } } }));

    const ctx = makeCtx([{ path: PREFAB_REL, type: 'prefab', guid: PREFAB_GUID }]);
    const r = (await validate(SCENE_REL, ctx)) as { status?: number; body: { warnings: string[] } };
    expect(r.status).toBeUndefined();
    expect(r.body.warnings.filter((w) => /is inert/.test(w))).toEqual([]);
  });
});

/** The SECOND call site. `/api/scene-mutate` validates the scene it just mutated and returns
 *  the findings in its response, so it needs the same resolver — an agent editing scene JSON
 *  through this route is exactly the reader the check was added for. Covered separately
 *  because it is a different code path (post-`applyOps`, file-direct branch), not the same
 *  handler with a different verb. */
describe('POST /api/scene-mutate — real prefab resolver (#35)', () => {
  /** File-direct branch: `requestBrowser` rejecting is how "no renderer connected" looks from
   *  the router, which is what sends the request down the fallback that validates. */
  const headless = (assets: Manifest['assets']): BackendContext => ({
    ...makeCtx(assets),
    requestBrowser: () => Promise.reject(new Error('no renderer')),
  }) as unknown as BackendContext;

  it('returns the prefab-aware inert warning after mutating', async () => {
    writeJson(PREFAB_REL, {
      id: PREFAB_GUID,
      version: 1,
      name: 'Thing',
      rootLocalId: 1,
      entities: [{ localId: 1, name: 'Root', traits: { UIAnchor: { anchor: 'bottom-stretch' } } }],
    });
    writeJson(SCENE_REL, scene({ 1: { UIElement: { width: 90, widthUnit: '%' } } }));

    const r = (await handleBackendRequest(headless([{ path: PREFAB_REL, type: 'prefab', guid: PREFAB_GUID }]), {
      method: 'POST',
      urlPath: '/api/scene-mutate',
      query: new URLSearchParams(),
      body: { path: SCENE_REL, ops: [] },
    })) as { body: { warnings: string[] } };

    expect(r.body.warnings.join('\n')).toMatch(/overrides\[1\]\.UIElement\.width is inert.*bottom-stretch/s);
  });
});
