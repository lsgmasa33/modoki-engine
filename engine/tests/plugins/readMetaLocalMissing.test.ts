/** `/api/read-meta` reports which cache blocks this host has no peeled values for (#1305).
 *
 *  The route REPORTS and does not repair: the header is what lets the Inspector say "re-import to
 *  compute stats" instead of rendering a blank row — or, as texture and model did before #1305, a
 *  confidently defaulted `0 B`. Re-importing is the human's click, because for half the affected
 *  textures a re-derive is a full `toktx` encode rather than a re-probe.
 *
 *  ⚠️ **Driven through the ROUTE on purpose.** The predicate itself is covered in
 *  `metaSidecarLocalHalf.test.ts`; what is only covered here is that the route CALLS it and emits
 *  the header, which is exactly the wiring a unit test that injects its own seams cannot see. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { peelSchemaId } from '../../plugins/meta-sidecar';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let projectRoot = '';

function makeCtx(): BackendContext {
  const manifest: Manifest = { version: 2, assets: [] };
  return {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, decodeURIComponent(p).replace(/^\//, '')),
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => manifest,
    rebuildManifest: () => manifest,
    requestBrowser: async () => ({}),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const ASSET = '/clip.mp3';
const assetAbs = () => path.join(projectRoot, 'clip.mp3');

type RouteResult = { status?: number; headers?: Record<string, string>; body?: unknown };
const read = (): Promise<RouteResult> =>
  handleBackendRequest(makeCtx(), {
    method: 'GET', urlPath: '/api/read-meta',
    query: new URLSearchParams(`path=${encodeURIComponent(ASSET)}`), body: undefined,
  }) as Promise<RouteResult>;

beforeEach(() => {
  projectRoot = makeScratchDir('modoki-local-missing-');
  fs.writeFileSync(assetAbs(), 'not-really-an-mp3');
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

/** A post-migration checkout: the committed block is there, the peeled values are not. */
function seedUnhealed(): void {
  fs.writeFileSync(`${assetAbs()}.meta.json`, `${JSON.stringify({ id: 'clip-guid', version: 2, audioCache: { hash: 'h', ext: 'mp3' } }, null, 2)}\n`);
}

describe('/api/read-meta — X-Meta-Local-Missing', () => {
  it('names the block whose peeled values this host does not hold', async () => {
    seedUnhealed();
    const res = await read();
    expect(res.headers?.['X-Meta-Local-Missing']).toBe('audioCache');
  });

  /** ⚠️ The accept side, and the one that decides whether the hint ever goes away. If the header
   *  were unconditional the panel would show "re-import to compute stats" over numbers that are
   *  sitting right beside it. */
  it('omits the header entirely once the local half is current', async () => {
    seedUnhealed();
    fs.writeFileSync(`${assetAbs()}.meta.local.json`, JSON.stringify({ audioCache: { durationSec: 1.5 }, __peel: peelSchemaId() }));
    const res = await read();
    expect(res.headers?.['X-Meta-Local-Missing']).toBeUndefined();
  });

  /** A local half written under an EARLIER peel table holds a non-empty subset of today's keys, so
   *  a naive "holds any peeled key" read calls it healed. Measured on the hub: 19 audio halves,
   *  every one `{bytes}` only. The header must still fire for those. */
  it('still names the block when the local half predates the current peel table', async () => {
    seedUnhealed();
    fs.writeFileSync(`${assetAbs()}.meta.local.json`, JSON.stringify({ audioCache: { bytes: 2012492 } }));
    const res = await read();
    expect(res.headers?.['X-Meta-Local-Missing']).toBe('audioCache');
  });

  it('keeps sending the CAS baseline alongside it', async () => {
    seedUnhealed();
    const res = await read();
    // The two headers are independent; adding one must not have displaced the other.
    expect(res.headers?.['X-Meta-Sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers?.['X-Meta-Local-Missing']).toBe('audioCache');
  });

  it('sends neither header shape for an asset with no sidecar at all', async () => {
    const res = await read();
    expect(res.headers?.['X-Meta-Local-Missing']).toBeUndefined();
  });
});
