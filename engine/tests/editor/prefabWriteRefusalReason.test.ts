/** #1776 — a refused prefab write names its reason, to the agent and to the human.
 *
 *  `/api/write-file` refused a path outside the asset roots with a 403 and an EMPTY body, and `prefabCommit`'s `post()`
 *  built `error` only from the body — so the agent `prefab create` answered `{ok:false}` with nothing else, and the
 *  human Create Prefab got a `null` both panels only logged. Four links, each with its case:
 *  - the route's refusal carries `error` + `options` (the real router, a context whose asset roots exclude the path);
 *  - `post()` falls back to the HTTP status when a body names nothing (the `{}` body, as the route answered);
 *  - the agent create REFUSES with the commit's reason, rather than answering ok:false;
 *  - `createPrefabFromEntity` returns it as `refused`, which the Hierarchy and the Assets panel toast.
 *  Only the write route is a fake in the three client cases; it refuses a path outside `/assets/` as told.
 *
 *  Mutation checked (each goes red here, nothing else in this file does):
 *  - the route answers the old empty body → the route case.
 *  - `post()` drops the status fallback → the `{}` case and the agent's `{}` case.
 *  - the agent create returns `{ok:false}` again instead of refusing → both agent refusal cases.
 *  - `createPrefabFromEntity` returns null again → the human case.
 *  - (close-out review) `post()` drops the body's `options` → the options case. `createPrefabFromEntity`'s three
 *    other refusals, each returning null again → its own case: the unreadable file (`prior === null`), the file a newer
 *    build wrote (the classify refusal), the self-nesting Replace (`serializePrefab`'s null). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

const route = vi.hoisted(() => ({ body: {} as object, writes: [] as string[], unreadable: null as string | null, files: new Map<string, string>() }));
const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (p: string) => {
    if (!p.startsWith('/assets/')) return answer(403, route.body);
    route.writes.push(p);
    return answer(200, { ok: true, path: p });
  },
}));

import { createTestWorld, type TestWorld, setPlayState } from '@modoki/engine/runtime';
import { markSceneSaved, clearHistory, clearDirtyAssets, createEntityWithUndo } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { commitPrefabWrite } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { ensureGuid } from '../../packages/modoki/src/editor/undo/entityRef';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { relay } from '../plugins/backendRelay';
import { PREFAB_FORMAT_VERSION, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache, setPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefab } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { getTraitByName } from '@modoki/engine/runtime';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';

registerAllTraits();
registerEditorAgentOps();

const OUTSIDE = '/games/wordweave/runtime/assets/prefabs/Probe.prefab.json';
const INSIDE = '/assets/prefabs/Probe.prefab.json';
const doc = { id: 'eeeeeeee-0000-4000-8000-000000001776', version: 6, name: 'Probe', rootLocalId: 1, entities: [] } as unknown as PrefabFile;

const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};
// Nothing is on disk: every read answers 404, and `/api/exists` says so.
// `route.unreadable` is a file that IS there and answers a read with a 500.
const serve = async (url: string): Promise<Response> => {
  if (url.includes('/api/exists')) {
    const asked = decodeURIComponent(url.split('path=')[1] ?? '');
    return answer(200, asked === route.unreadable || route.files.has(asked) ? { exists: true, path: asked } : { exists: false });
  }
  const file = [...route.files.keys()].find((f) => url.endsWith(f));
  if (file) return new Response(route.files.get(file)!, { status: 200 });
  return route.unreadable && url.endsWith(route.unreadable) ? answer(500, {}) : answer(404, {});
};

let game: TestWorld | undefined;
let src = 0;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  markSceneSaved();
  route.body = {};
  route.writes = [];
  route.unreadable = null;
  route.files.clear();
  vi.stubGlobal('fetch', serve);
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  src = createEntityWithUndo('Add', 0, [{ name: 'Transform', data: {} }, { name: 'EntityAttributes', data: { name: 'Probe', parentId: 0 } }], () => {})!;
});
afterEach(() => {
  game?.dispose(); game = undefined;
  vi.unstubAllGlobals();
});

describe('POST /api/write-file outside the asset roots says why (#1776)', () => {
  it('a 403 whose body names the path and the form to pass, and nothing is written', async () => {
    const ctx = {
      projectRoot: '/tmp/none', editorRoot: '/tmp/none',
      resolveAssetPath: (p: string) => (p.startsWith('/assets/') ? path.join('/tmp/none', p) : null),
      absToAssetUrl: (p: string) => p, firstRootDir: () => null,
      getManifest: () => ({ version: 2, assets: [] }) as Manifest, rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
      requestBrowser: relay(), getSchema: () => undefined, markEditorWrite: () => {}, ssrLoadModule: async () => ({}), invalidateProjectConfig: () => {},
    } as unknown as BackendContext;
    const res = await handleBackendRequest(ctx, { method: 'POST', urlPath: '/api/write-file', query: new URLSearchParams(), body: { path: OUTSIDE, content: '{}' } }) as unknown as { status: number; body: { error?: string; options?: string[] } };
    expect(res.status).toBe(403);
    expect(res.body.error).toContain(OUTSIDE);
    expect(res.body.error).toMatch(/outside this project's asset roots/);
    expect(res.body.options?.[0]).toMatch(/asset-root URL/);
  });
});

describe('a refused prefab write carries a reason to every caller (#1776)', () => {
  it('post(): a refusal whose body is {} still fails with a reason — the HTTP status', async () => {
    const r = await quietly(() => commitPrefabWrite(OUTSIDE, doc, { expected: null }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('the request was refused (HTTP 403)');
  });

  it("post(): the body's own reason wins over the status", async () => {
    route.body = { error: 'outside the roots' };
    expect((await quietly(() => commitPrefabWrite(OUTSIDE, doc, { expected: null }))).error).toBe('outside the roots');
  });

  it('the agent create REFUSES with the reason, instead of answering a bare ok:false', async () => {
    route.body = { error: `"${OUTSIDE}" is outside this project's asset roots, so nothing was written` };
    const err = await quietly(() => runAgentOp('prefab', { prefabAction: 'create', entityGuid: ensureGuid(src), path: OUTSIDE })).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // The Hierarchy's own text (#1873 C1: the agent create IS Create Prefab).
    expect((err as Error).message).toBe(`Create Prefab failed — ${OUTSIDE} was not written: "${OUTSIDE}" is outside this project's asset roots, so nothing was written.`);
  });

  it('the agent create over a {} body still names a reason', async () => {
    const err = await quietly(() => runAgentOp('prefab', { prefabAction: 'create', entityGuid: ensureGuid(src), path: OUTSIDE })).catch((e: Error) => e);
    expect((err as Error).message).toContain('the request was refused (HTTP 403)');
  });

  it("the human Create Prefab returns the reason as `refused`, which the panels toast", async () => {
    route.body = { error: 'outside the roots' };
    const r = await quietly(() => createPrefabFromEntity(src, OUTSIDE, 'Create Prefab "Probe"', async () => true));
    expect(r).toEqual({ refused: `Create Prefab failed — ${OUTSIDE} was not written: outside the roots.` });
  });

  it('ACCEPT SIDE: a path under an asset root is written, on both surfaces', async () => {
    const reply = await quietly(() => runAgentOp('prefab', { prefabAction: 'create', entityGuid: ensureGuid(src), path: INSIDE })) as { ok?: boolean; source?: string };
    expect(reply.ok).toBe(true);
    expect(reply.source).toBe(INSIDE);
    const human = await quietly(() => createPrefabFromEntity(src, '/assets/prefabs/Other.prefab.json', 'Create Prefab "Probe"', async () => true));
    expect(human && typeof human === 'object' && 'refused' in human).toBe(false);
    expect(route.writes).toEqual([INSIDE, '/assets/prefabs/Other.prefab.json']);
  });
});

describe('the rest of the refusal reaches its reader (#1776 close-out review)', () => {
  it("the route's options reach the agent refusal", async () => {
    route.body = { error: 'outside the roots', options: ['pass an asset-root URL'] };
    const err = await quietly(() => runAgentOp('prefab', { prefabAction: 'create', entityGuid: ensureGuid(src), path: OUTSIDE })).catch((e: Error) => e) as Error & { options?: string[] };
    expect(err.options).toEqual(['pass an asset-root URL']);
  });

  it('the human Create Prefab over a file it cannot read says so, rather than a bare null', async () => {
    route.unreadable = INSIDE;
    const r = await quietly(() => createPrefabFromEntity(src, INSIDE, 'Create Prefab "Probe"', async () => true));
    expect(r).toMatchObject({ refused: expect.stringMatching(/^Create Prefab refused — .*Probe\.prefab\.json/) });
    expect(route.writes).toEqual([]);
  });
});

describe('every other Create Prefab refusal is said too (#1776 close-out review)', () => {
  it('a file a newer build wrote is refused with the reason, not replaced', async () => {
    // Its own path and id: a path the manifest already knows answers 'known' before the version check (#1678).
    const NEWER = '/assets/prefabs/Newer.prefab.json';
    route.files.set(NEWER, JSON.stringify({ id: 'abababab-0000-4000-8000-000000001776', version: PREFAB_FORMAT_VERSION + 1, name: 'Newer', rootLocalId: 1, entities: [] }));
    const r = await quietly(() => createPrefabFromEntity(src, NEWER, 'Create Prefab "Probe"', async () => true));
    expect(r).toMatchObject({ refused: expect.stringMatching(/^Create Prefab refused — .* was not replaced: .*newer build/) });
    expect(route.writes).toEqual([]);
  });

  it('a Replace whose tree holds an instance of the prefab it replaces is refused — a prefab cannot contain itself', async () => {
    const X = 'ffffffff-0000-4000-8000-000000001776';
    const xDoc = { id: X, version: 6, name: 'X', rootLocalId: 1, entities: [{ localId: 1, nodeGuid: 'ffffffff-0000-4000-8000-000000011776', name: 'X', traits: { EntityAttributes: { name: 'X', parentId: 0, guid: '' }, Transform: { x: 0, y: 0, z: 0 } } }] } as unknown as PrefabFile;
    route.files.set(INSIDE, JSON.stringify(xDoc));
    registerAsset(X, INSIDE, 'prefab');
    setPrefabCache(X, xDoc);
    const inst = instantiatePrefab(xDoc);
    setPrefabSource(inst, { id: X });
    const ea = getTraitByName('EntityAttributes')!;
    const e = findEntity(inst)!;
    e.set(ea.trait, { ...(e.get(ea.trait) as Record<string, unknown>), parentId: src }); // X's instance, under the selection
    const r = await quietly(() => createPrefabFromEntity(src, INSIDE, 'Create Prefab "Probe"', async () => true));
    expect(r).toMatchObject({ refused: expect.stringMatching(/cannot contain itself/) });
    expect(route.writes).toEqual([]);
    setPrefabCache(X, null);
  });
});
