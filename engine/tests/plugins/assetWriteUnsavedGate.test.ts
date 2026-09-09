/** `POST /api/asset-write`'s dirty-asset gate (#889 phase 3).
 *
 *  ## Why this route was the hard one
 *
 *  It was left in `KNOWN_GAPS` through phase 1 not because nobody got to it, but because the
 *  obvious fix breaks the editor. `flushDirtyAssets` POSTs here — this route is the ONLY path from
 *  a parked document to disk — so a gate that refuses whenever `dirtyAsset` holds the path refuses
 *  the editor's own save and wedges the registry shut. Every parked document, not one panel.
 *
 *  `selfWrite` is what makes it safe, and it already existed: `flushDirtyAssets` sets it, a
 *  file-direct `write_asset` must not. It asserts something about the CALLING PROCESS rather than
 *  the document — a write issued from the renderer is never blind to the registry, because it IS
 *  the flush.
 *
 *  ## The consequence class is not a guess
 *
 *  An agent write is not fingerprinted as an editor write, so the file-change event reads as
 *  EXTERNAL and `dropParkedWriteFor` (agentBridge.ts) discards the parked document, deliberately,
 *  on the grounds that "disk becomes the truth for that asset". So proceeding really does destroy
 *  the human's unsaved work — `destroys`, override `discardUnsaved`, not `stale-write`/`force`.
 *
 *  ## Both directions, deliberately
 *
 *  A guard proven only to REJECT is half a guard: nothing then stops the next author deleting it
 *  to fix a spurious 409. The accept side here is three separate claims — a clean write is
 *  untouched, the editor's own flush is never refused, and a document held under a DIFFERENT
 *  registry does not refuse this one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { relay } from './backendRelay';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

let projectRoot = '';

function makeCtx(over: Partial<BackendContext> = {}): BackendContext {
  const base = {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: relay(),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  };
  return { ...base, ...over } as unknown as BackendContext;
}

const post = (urlPath: string, body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body });

const PATH = '/assets/particles/spark.particle.json';
const onDisk = { id: 'p-guid', version: 1, rate: 10 };
const incoming = { id: 'p-guid', version: 1, rate: 99 };
/** The row `resolve-unsaved` really returns for a parked asset document. */
const parked = [{ path: PATH, registry: 'dirtyAsset', detail: 'an unsaved asset document' }];

const write = (body: Record<string, unknown>, ctx: BackendContext) =>
  post('/api/asset-write', { path: PATH, type: 'particle', data: incoming, ...body }, ctx) as Promise<{
    status?: number;
    body: {
      ok?: boolean; code?: string; error?: string; options?: string[];
      parked?: string[]; discardedParked?: string[]; discardWarning?: string;
    };
  }>;
const onDiskNow = () => JSON.parse(fs.readFileSync(path.join(projectRoot, PATH.replace(/^\//, '')), 'utf-8'));

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-asset-write-gate-'));
  fs.mkdirSync(path.dirname(path.join(projectRoot, PATH.replace(/^\//, ''))), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, PATH.replace(/^\//, '')), `${JSON.stringify(onDisk, null, 2)}\n`);
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('/api/asset-write — the dirty-asset gate (#889 phase 3)', () => {
  it('REFUSES 409 when the editor holds a parked copy, leaving the file untouched', async () => {
    const r = await write({}, makeCtx({ requestBrowser: relay({ holds: parked }) }));

    expect(r.status).toBe(409);
    expect(r.body.code).toBe('REQUIRES_SAVE');
    expect(r.body.parked).toEqual([PATH]);
    // The refusal must name the real consequence — that the editor DROPS its copy when this
    // write lands — not a generic "there is unsaved work".
    expect(r.body.error).toMatch(/DESTROYS/);
    expect(r.body.options?.join(' ')).toMatch(/discardUnsaved/);
    expect(onDiskNow().rate, 'nothing was written').toBe(10);
  });

  it('lets the EDITOR\'S OWN flush through — selfWrite is the whole reason this can be gated', async () => {
    // The case that makes the difference between a gate and a deadlock. flushDirtyAssets sends
    // exactly this, for a path that is BY CONSTRUCTION in the registry it would otherwise be
    // refused by. If this ever goes red, the editor cannot save.
    const r = await write({ selfWrite: true }, makeCtx({ requestBrowser: relay({ holds: parked }) }));

    expect(r.body.ok).toBe(true);
    expect(onDiskNow().rate).toBe(99);
  });

  it('proceeds on discardUnsaved:true and REPORTS what it dropped', async () => {
    const r = await write({ discardUnsaved: true }, makeCtx({ requestBrowser: relay({ holds: parked }) }));

    expect(r.body.ok).toBe(true);
    expect(onDiskNow().rate).toBe(99);
    // Not "will be dropped" — the route asks for the discard itself and reports the answer, because
    // a park that SURVIVES gets flushed back over this write at the next save_all.
    expect(r.body.discardedParked).toEqual([PATH]);
    expect(r.body.discardWarning, 'the discard was confirmed, so no warning').toBeUndefined();
  });

  it('WARNS when the discard could not be confirmed, instead of reporting a clean write', async () => {
    // `unknown` is the likely branch, not the exotic one — a GLB parse eats the budget. Collapsing
    // it to "nothing discarded" would let a surviving park read as a clean overwrite.
    let call = 0;
    const ctx = makeCtx({
      requestBrowser: async (op: string, params?: unknown) => {
        if (op !== 'resolve-unsaved') return {};
        // First ask (the gate) answers; the second (the discard) does not.
        if (++call > 1) throw new Error('timed out waiting for the renderer');
        return {
          ok: true, holds: parked, discarded: [],
          covers: (params as { registries?: string[] })?.registries ?? [],
        };
      },
    } as Partial<BackendContext>);

    const r = await write({ discardUnsaved: true }, ctx);

    expect(r.body.ok).toBe(true);
    expect(r.body.discardedParked, 'nothing was confirmed dropped').toBeUndefined();
    expect(r.body.discardWarning).toMatch(/could not be confirmed discarded/);
  });

  it('discardUnsaved past an UNANSWERABLE probe warns instead of reporting a clean write', async () => {
    // Close-out review finding. `discardUnsaved:true` bypasses the refusal for BOTH `held` and
    // `unknown`, but the discard only runs for `held` — so passing the flag while the renderer was
    // busy produced a bare {ok:true, saved:true}: nothing discarded, nothing said. If a park
    // existed it survives and the human's next save_all flushes their older document over this
    // write. #872's defect wearing a success, which is what discardWarning exists to prevent.
    const ctx = makeCtx({ requestBrowser: async (op: string) => {
      if (op === 'resolve-unsaved') throw new Error('timed out waiting for the renderer');
      return {};
    } } as Partial<BackendContext>);

    const r = await write({ discardUnsaved: true }, ctx);

    expect(r.body.ok, 'the caller asked to proceed, so it proceeds').toBe(true);
    expect(r.body.discardedParked, 'nothing could be discarded').toBeUndefined();
    expect(r.body.discardWarning).toMatch(/did not answer/);
    expect(r.body.discardWarning).toMatch(/save_all/);
  });

  it('ACCEPT — a clean editor writes exactly as before, with no gate fields', async () => {
    const r = await write({}, makeCtx());

    expect(r.body.ok).toBe(true);
    expect(onDiskNow().rate).toBe(99);
    // Absent, not empty. A field present on every call is a field readers learn to skip.
    expect('discardedParked' in r.body).toBe(false);
    expect('discardWarning' in r.body).toBe(false);
  });

  it('ACCEPT — the SAME path held under a different registry does not refuse this write', async () => {
    // ⚠️ **Same path, different registry — and the "same path" half is the whole test.** This case
    // first used a `liveScene` hold on an unrelated SCENE path, and it passed with the registry
    // scope widened to all four: the path filter excluded the row before the scope ever mattered,
    // so it proved nothing about scoping. A mutation check is what found that; the assertion
    // looked completely reasonable.
    //
    // `pendingMeta` is keyed on the ASSET path, exactly as this route's `dirtyAsset` ask is, so it
    // is the one registry that can collide here. Parked import settings for this particle do not
    // make writing the particle DOCUMENT destructive — they are a different file — and refusing on
    // them is the over-reach the old single-registry gate avoided only by not knowing the others
    // existed.
    const sidecarPark = [{ path: PATH, registry: 'pendingMeta', detail: 'unsaved import settings' }];
    const r = await write({}, makeCtx({ requestBrowser: relay({ holds: sidecarPark }) }));

    expect(r.body.ok).toBe(true);
    expect(onDiskNow().rate).toBe(99);
  });

  it('REFUSES 503 when the renderer may be attached and did not answer', async () => {
    const ctx = makeCtx({ requestBrowser: async () => { throw new Error('timed out waiting for the renderer'); } } as Partial<BackendContext>);

    const r = await write({}, ctx);

    expect(r.status).toBe(503);
    expect(r.body.code).toBe('NO_RENDERER');
    expect(onDiskNow().rate, 'nothing was written').toBe(10);
  });

  it('proceeds when NO renderer exists at all — the headless write still works', async () => {
    const ctx = makeCtx({ requestBrowser: async () => { throw new Error('no editor renderer window'); } } as Partial<BackendContext>);

    const r = await write({}, ctx);

    expect(r.body.ok).toBe(true);
    expect(onDiskNow().rate).toBe(99);
  });
});
