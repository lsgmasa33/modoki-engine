/** End-to-end cover for the manifest-RESOLUTION half of `/api/validate-scene` (#292) —
 *  specifically `makeAssetResolver` in editorBackendRouter.ts. Until #292 the ref check
 *  was GUID *shape* only, so a scene pointing at an asset that had been deleted from the
 *  manifest validated completely clean and failed later, at load/render time (that is how
 *  a ref survives a deleted asset).
 *
 *  The validator's own unit tests (`sceneValidation.test.ts`) inject a fake resolver, so
 *  they prove the warning LOGIC but never exercise the wiring: a resolver that the router
 *  forgot to pass would leave every one of them green while the shipped surface checked
 *  nothing. That is the exact defect class this repo keeps hitting, so everything here is
 *  REAL — a temp project dir, a real scene on disk, the real manifest lookup, through
 *  `handleBackendRequest`. Sibling of `validateScenePrefabResolver.test.ts`. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

const LIVE_GUID = 'a1b2c3d4-1111-2222-3333-444455556666';
const DEAD_GUID = 'deadbeef-0000-1111-2222-333344445555';
const SCENE_REL = '/assets/scenes/main.json';
const MESH_REL = '/assets/meshes/thing.mesh.json';

let tmp: string;

function writeJson(rel: string, data: unknown): void {
  const abs = path.join(tmp, 'runtime', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data, null, 2));
}

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

const validate = (ctx: BackendContext) =>
  handleBackendRequest(ctx, {
    method: 'GET',
    urlPath: '/api/validate-scene',
    query: new URLSearchParams({ path: SCENE_REL }),
    body: undefined,
  });

/** One entity carrying one ref field. `traits` is written verbatim so a case can aim
 *  the ref at whichever trait/field it is about. */
const sceneWith = (traits: Record<string, unknown>) => ({
  version: 8,
  entities: [{ id: 1, name: 'Thing', traits }],
});

/** Only the resolution findings — the scene may legitimately produce others. */
const dangling = (warnings: string[]) => warnings.filter((w) => /no asset in the manifest has it/.test(w));

const MESH_ENTRY = { path: MESH_REL, type: 'mesh', guid: LIVE_GUID };

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-validate-scene-asset-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('GET /api/validate-scene — real asset resolver (#292)', () => {
  it('flags a ref to a guid the REAL manifest does not have', async () => {
    writeJson(SCENE_REL, sceneWith({ Renderable3D: { mesh: DEAD_GUID } }));
    const r = (await validate(makeCtx([MESH_ENTRY]))) as { body: { warnings: string[] } };
    expect(dangling(r.body.warnings)).toHaveLength(1);
    expect(dangling(r.body.warnings)[0]).toContain(DEAD_GUID);
    expect(dangling(r.body.warnings)[0]).toMatch(/Renderable3D\.mesh/);
  });

  it('stays silent for a ref the manifest does have', async () => {
    writeJson(SCENE_REL, sceneWith({ Renderable3D: { mesh: LIVE_GUID } }));
    const r = (await validate(makeCtx([MESH_ENTRY]))) as { body: { warnings: string[] } };
    expect(dangling(r.body.warnings)).toEqual([]);
  });

  /** The OTHER direction: the scene is lowercase and the MANIFEST entry is uppercase.
   *  Distinct from the sibling below, and it is the direction a hand-edited `.meta.json`
   *  produces. Both must be `case-mismatch`, never silence.
   *
   *  This case previously read "matches the manifest guid case-insensitively, both
   *  directions" and asserted only that no *dangling* warning appeared — which the
   *  case-mismatch message does not match either, so it passed whether the resolver was
   *  correct OR folded case. Proven by mutation: folding case in `makeAssetRefResolver`
   *  left it green while its sibling went red. A test whose name asserts the design you
   *  disproved is worse than no test. */
  it('flags a manifest-side casing difference too, not just a scene-side one', async () => {
    writeJson(SCENE_REL, sceneWith({ Renderable3D: { mesh: LIVE_GUID } }));
    const r = (await validate(
      makeCtx([{ ...MESH_ENTRY, guid: LIVE_GUID.toUpperCase() }]),
    )) as { body: { warnings: string[] } };
    expect(r.body.warnings.join('\n')).toMatch(/matches a manifest asset only when letter case is ignored/);
    expect(dangling(r.body.warnings)).toEqual([]);
  });

  /** THE load-bearing case. An empty manifest means "I cannot check", not "every asset
   *  in this project is gone". Reporting every ref in a healthy scene as dangling would
   *  be far worse than the gap #292 closes, and it is the shape a naive wiring takes:
   *  the resolver is only passed when it can answer authoritatively. */
  it('reports NOTHING when the manifest is empty — cannot-check is not everything-dangling', async () => {
    writeJson(SCENE_REL, sceneWith({ Renderable3D: { mesh: DEAD_GUID } }));
    const r = (await validate(makeCtx([]))) as { status?: number; body: { warnings: string[] } };
    expect(r.status).toBeUndefined(); // still a 200 answer, not an error
    expect(dangling(r.body.warnings)).toEqual([]);
  });

  it('reports nothing when every manifest entry is guid-less', async () => {
    writeJson(SCENE_REL, sceneWith({ Renderable3D: { mesh: DEAD_GUID } }));
    const r = (await validate(makeCtx([{ path: MESH_REL, type: 'mesh' }]))) as { body: { warnings: string[] } };
    expect(dangling(r.body.warnings)).toEqual([]);
  });

  it('survives a manifest that throws, and checks nothing', async () => {
    writeJson(SCENE_REL, sceneWith({ Renderable3D: { mesh: DEAD_GUID } }));
    const ctx = { ...makeCtx([MESH_ENTRY]), getManifest: () => { throw new Error('scan in flight'); } } as unknown as BackendContext;
    const r = (await validate(ctx)) as { status?: number; body: { warnings: string[] } };
    expect(r.status).toBeUndefined();
    expect(dangling(r.body.warnings)).toEqual([]);
  });

  /** The REAL resolver must answer case-SENSITIVELY, because it is predicting `resolveRef`,
   *  which is `guidToEntry.get(ref)` over guids stored verbatim — while `isGuid`'s regex
   *  carries `/i` and accepts uppercase. A resolver that folded case would vouch for a ref
   *  that resolves to `undefined` at load: the exact false negative this check removes.
   *  Its own message, because "deleted or never imported" would be a lie here. */
  it('flags a folded-case-only match with the case message, not the deleted one', async () => {
    writeJson(SCENE_REL, sceneWith({ Renderable3D: { mesh: LIVE_GUID.toUpperCase() } }));
    const r = (await validate(makeCtx([MESH_ENTRY]))) as { body: { warnings: string[] } };
    const w = r.body.warnings.join('\n');
    expect(w).toMatch(/matches a manifest asset only when letter case is ignored/);
    expect(w).not.toMatch(/deleted or never imported/);
    expect(dangling(r.body.warnings)).toEqual([]);
  });

  /** `makeAssetResolver`'s try/catch wraps only the `getManifest()` call, so a malformed
   *  ENTRY is read outside it. A null in `assets[]` used to throw out of the resolver and
   *  through the route's outer catch — turning a validation that always answered 200 into a
   *  500. "Cannot check" must degrade to silence, never to a failed call. */
  it('survives a null/malformed entry in manifest.assets instead of 500ing', async () => {
    writeJson(SCENE_REL, sceneWith({ Renderable3D: { mesh: DEAD_GUID } }));
    const ctx = makeCtx([null as never, MESH_ENTRY, 7 as never, { path: '/x', type: 'mesh' }]);
    const r = (await validate(ctx)) as { status?: number; body: { warnings: string[] } };
    expect(r.status).toBeUndefined();
    // The good entry still indexed, so the dead ref is still correctly reported.
    expect(dangling(r.body.warnings)).toHaveLength(1);
  });

  /** A sliced sprite and the auto-emitted whole-image sprite are `type:'sprite'` SUB-entries
   *  with guids of their own, and a `Renderable2D.sprite` / `UIElement.imageSrc` holds one of
   *  those — never the parent texture's guid. Sweeping `assets[]` covers them; a resolver that
   *  filtered to file-backed assets would report every 2D sprite in the project as dangling. */
  it('resolves a sprite SUB-entry guid, not just file-backed assets', async () => {
    const SPRITE_GUID = 'c0ffee00-1111-2222-3333-444455556666';
    const TEX_REL = '/assets/textures/sheet.png';
    writeJson(SCENE_REL, sceneWith({ Renderable2D: { sprite: SPRITE_GUID } }));
    const r = (await validate(makeCtx([
      { path: TEX_REL, type: 'texture', guid: 'aaaaaaaa-1111-2222-3333-444455556666' },
      { path: `${TEX_REL}#0`, type: 'sprite', guid: SPRITE_GUID },
    ]))) as { body: { warnings: string[] } };
    expect(dangling(r.body.warnings)).toEqual([]);
  });

  it('still lets a primitive sprite keyword and an external URL through', async () => {
    writeJson(SCENE_REL, {
      version: 8,
      entities: [
        { id: 1, name: 'A', traits: { Renderable2D: { sprite: 'circle' } } },
        { id: 2, name: 'B', traits: { UIElement: { imageSrc: 'https://example.com/x.png' } } },
      ],
    });
    const r = (await validate(makeCtx([MESH_ENTRY]))) as { body: { warnings: string[] } };
    expect(dangling(r.body.warnings)).toEqual([]);
  });
});

/** The SECOND call site — an agent editing scene JSON through `/api/scene-mutate` is the
 *  reader this check exists for, and it is a different code path (post-`applyOps`, the
 *  file-direct branch), not the same handler with another verb. Wired separately, so it
 *  can be forgotten separately. */
describe('POST /api/scene-mutate — real asset resolver (#292)', () => {
  const headless = (assets: Manifest['assets']): BackendContext => ({
    ...makeCtx(assets),
    requestBrowser: () => Promise.reject(new Error('no renderer')),
  }) as unknown as BackendContext;

  const mutate = (ctx: BackendContext) =>
    handleBackendRequest(ctx, {
      method: 'POST',
      urlPath: '/api/scene-mutate',
      query: new URLSearchParams(),
      body: { path: SCENE_REL, ops: [] },
    });

  it('returns the dangling-ref warning after mutating', async () => {
    writeJson(SCENE_REL, sceneWith({ Renderable3D: { mesh: DEAD_GUID } }));
    const r = (await mutate(headless([MESH_ENTRY]))) as { body: { warnings: string[] } };
    expect(dangling(r.body.warnings)).toHaveLength(1);
    expect(dangling(r.body.warnings)[0]).toContain(DEAD_GUID);
  });

  it('stays silent for a live ref', async () => {
    writeJson(SCENE_REL, sceneWith({ Renderable3D: { mesh: LIVE_GUID } }));
    const r = (await mutate(headless([MESH_ENTRY]))) as { body: { warnings: string[] } };
    expect(dangling(r.body.warnings)).toEqual([]);
  });

  it('reports nothing when the manifest is empty', async () => {
    writeJson(SCENE_REL, sceneWith({ Renderable3D: { mesh: DEAD_GUID } }));
    const r = (await mutate(headless([]))) as { body: { warnings: string[] } };
    expect(dangling(r.body.warnings)).toEqual([]);
  });
});
