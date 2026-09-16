/** `/api/read-meta`'s local-half heal, driven through the ROUTE (#1305 close-out R6).
 *
 *  ⚠️ **This file exists because deleting the heal from the route left every other test green.**
 *  `metaSidecarLocalHalf.test.ts` covers `scheduleLocalHalfHeal` and the predicate thoroughly, but
 *  it injects its own `getHandler`/`defer`/`beforeRun` — so the route's closure, the `heal=0`
 *  opt-out and the park gate were pinned by nothing but one manual observation in a running editor.
 *  That is the shape `docs/falsifiable-tests.md` calls a mechanism mocked away by its own test.
 *
 *  Driven the way `metaParkGate.test.ts` drives the same router, with the same renderer stubs,
 *  because the park gate is the same gate and a second harness would be a second set of
 *  assumptions. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { registerReimportHandler } from '../../plugins/reimport-registry';
import { healAttempts } from '../../plugins/backend/healLocalHalf';
import { peelSchemaId } from '../../plugins/meta-sidecar';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let projectRoot = '';
/** Asset urls the stub reimport handler was asked to bake, in order. */
let baked: string[] = [];
/** What the fake handler does when it runs — swapped per test. */
let handlerBody: (abs: string) => void = () => {};

type RendererStub = (op: string, params: unknown) => unknown;

/** Reports exactly `parked` as held in `pendingMeta`, in #889's `resolve-unsaved` shape (the
 *  mandatory `covers` included — without it the gate correctly answers `unknown`). */
const rendererWithParks = (parked: string[]): RendererStub => (op, params) => {
  if (op !== 'resolve-unsaved') return {};
  const p = (params ?? {}) as { paths?: string[]; registries?: string[] };
  const covers = p.registries ?? ['pendingMeta'];
  const hit = covers.includes('pendingMeta') ? (p.paths ?? []).filter((x) => parked.includes(x)) : [];
  return { ok: true, holds: hit.map((path) => ({ path, registry: 'pendingMeta', detail: 'unsaved import settings' })), discarded: [], covers };
};

function makeCtx(renderer: RendererStub): BackendContext {
  const manifest: Manifest = { version: 2, assets: [] };
  return {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, decodeURIComponent(p).replace(/^\//, '')),
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => manifest,
    rebuildManifest: () => manifest,
    requestBrowser: async (op: string, params: unknown) => renderer(op, params),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const ASSET = '/clip.mp3';
const assetAbs = () => path.join(projectRoot, 'clip.mp3');
const metaAbs = () => `${assetAbs()}.meta.json`;
const localAbs = () => `${assetAbs()}.meta.local.json`;

const get = (urlPath: string, query: string, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'GET', urlPath, query: new URLSearchParams(query), body: undefined }) as
    Promise<{ status?: number; body?: unknown; kind?: string }>;

/** The heal is deliberately fire-and-forget, so a test has to wait for it. Polls the recorded bakes
 *  rather than sleeping a fixed time — a fixed sleep is what makes this kind of test flaky under
 *  machine load (#1285). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50 && baked.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 10)); // let the restore + announce finish
}

beforeEach(() => {
  projectRoot = makeScratchDir('modoki-read-meta-heal-');
  baked = [];
  handlerBody = () => {};
  healAttempts.clear();
  registerReimportHandler('audio', async (url: string, abs: string) => { baked.push(url); handlerBody(abs); });
  fs.writeFileSync(assetAbs(), 'not-really-an-mp3');
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

/** A post-migration checkout: the committed block is there, the peeled values are not. */
function seedUnhealed(): void {
  fs.writeFileSync(metaAbs(), `${JSON.stringify({ id: 'clip-guid', version: 2, audioCache: { hash: 'h', ext: 'mp3' } }, null, 2)}\n`);
}

describe('/api/read-meta — heals a missing local half', () => {
  it('runs the reimport handler for an asset whose peeled values this machine lacks', async () => {
    seedUnhealed();
    const res = await get('/api/read-meta', `path=${encodeURIComponent(ASSET)}`, makeCtx(rendererWithParks([])));
    // The response is built and returned without waiting for the probe.
    expect(res.kind).toBe('raw');
    expect(baked).toEqual([]);
    await settle();
    expect(baked).toEqual([ASSET]);
  });

  /** ⚠️ The accept side. Without it, a route that healed unconditionally would pass every other
   *  case here while re-baking on every Inspector open. */
  it('does NOT heal an asset whose local half is already current', async () => {
    seedUnhealed();
    fs.writeFileSync(localAbs(), JSON.stringify({ audioCache: { durationSec: 1.5 }, __peel: peelSchemaId() }));
    await get('/api/read-meta', `path=${encodeURIComponent(ASSET)}`, makeCtx(rendererWithParks([])));
    await settle();
    expect(baked).toEqual([]);
  });

  /** `modoki_get_asset_meta` is an observer; an observer must not re-encode what it observes. */
  it('does NOT heal when the reader opted out with heal=0', async () => {
    seedUnhealed();
    await get('/api/read-meta', `path=${encodeURIComponent(ASSET)}&heal=0`, makeCtx(rendererWithParks([])));
    await settle();
    expect(baked).toEqual([]);
  });

  /** #882: the handler reads settings off DISK, so baking under a park converts with the pre-edit
   *  values and the human's next save flushes a stale block over the fresh bake. */
  it('does NOT heal while an import-settings edit is parked for that asset', async () => {
    seedUnhealed();
    await get('/api/read-meta', `path=${encodeURIComponent(ASSET)}`, makeCtx(rendererWithParks([ASSET])));
    await settle();
    expect(baked).toEqual([]);
  });

  /** ⚠️ The repo-hazard guard: a GET must not dirty a tracked file. The real handlers rebuild their
   *  block in canonical key order and stamp `meta.type`, which is byte-different on 43 of 282
   *  committed texture sidecars. */
  it('leaves the committed sidecar byte-identical even when the handler rewrites it', async () => {
    seedUnhealed();
    const before = fs.readFileSync(metaAbs());
    handlerBody = (abs) => {
      fs.writeFileSync(`${abs}.meta.json`, JSON.stringify({ version: 2, id: 'clip-guid', type: 'audio', audioCache: { ext: 'mp3', hash: 'h' } }, null, 2) + '\n');
      fs.writeFileSync(`${abs}.meta.local.json`, JSON.stringify({ audioCache: { durationSec: 3.5 }, __peel: peelSchemaId() }));
    };
    await get('/api/read-meta', `path=${encodeURIComponent(ASSET)}`, makeCtx(rendererWithParks([])));
    await settle();
    expect(baked).toEqual([ASSET]);
    expect(fs.readFileSync(metaAbs()).equals(before)).toBe(true);
    // ...and the heal's own product survived the restore.
    expect(JSON.parse(fs.readFileSync(localAbs(), 'utf-8')).audioCache.durationSec).toBe(3.5);
  });
});
