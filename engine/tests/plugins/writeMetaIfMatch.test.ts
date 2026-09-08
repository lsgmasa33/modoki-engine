/** `POST /api/write-meta`'s `ifMatch` precondition, and the baseline `/api/read-meta` hands out
 *  (#845 phase 2).
 *
 *  Before #845 an Inspector field change POSTed this route immediately, so the window between the
 *  read a panel serialised onto and the write was one keystroke. Parking made the write wait for
 *  Cmd+S — which is the fix, and which also stretched that window to however long the human takes
 *  to press it. `/api/write-meta` was the one JSON write route with NEITHER a precondition nor a
 *  self-write fingerprint, so for as long as the edit sat parked, anything else touching the
 *  sidecar (a `git checkout` under a live editor — CLAUDE.md's documented hazard — an agent, a
 *  re-import from another panel) would be silently overwritten at the flush.
 *
 *  ⚠️ **The baseline CANNOT be computed on the client, and that is why it travels in a header.**
 *  `/api/read-meta` returns `readMetaSidecar`, which merges the gitignored `.meta.local.json` cache
 *  blocks back in; `writeMetaSidecar` stamps `version`, may salvage an `id`, and splits those
 *  blocks back out. So the document a panel holds is never the bytes on disk, and a client-side
 *  hash of it could never match — every conditional write would 409 forever with no way to
 *  succeed, the exact failure `contentHash.ts`'s docblock warns about. The server hashes the file;
 *  both ends then agree by construction. These tests pin that agreement, because it is invisible
 *  from either side alone.
 *
 *  Both directions are asserted. A guard tested only on its REJECT side is half a guard — the
 *  accept case is what stops the next author "fixing" a spurious 409 by deleting the precondition,
 *  and the absent-`ifMatch` case is what keeps the eight explicit-action writers working exactly
 *  as before. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

let projectRoot = '';

/** A renderer that answers the #889 unsaved-work probe and holds NOTHING.
 *
 *  ⚠️ `covers` is not decoration — `unsavedGate` treats a reply that omits it as a SKEWED renderer
 *  and answers `unknown`, which refuses. That check is deliberate (a renderer that answers but does
 *  not implement a registry the caller asked about is otherwise indistinguishable from a clean
 *  one), so a stub standing in for "answers normally" has to send it. */
const clearUnsavedReply = (params: unknown) => ({
  ok: true,
  holds: [],
  discarded: [],
  covers: (params as { registries?: string[] } | undefined)?.registries
    ?? ['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene'],
});

function makeCtx(over: Partial<BackendContext> = {}): BackendContext {
  const base = {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async (_op: string, params: unknown) => clearUnsavedReply(params),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  };
  return { ...base, ...over } as unknown as BackendContext;
}

const post = (urlPath: string, body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body });

const get = (urlPath: string, query: Record<string, string>, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'GET', urlPath, query: new URLSearchParams(query), body: undefined });

const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

/** The asset the sidecar belongs to. `resolveAssetPath` gets the ASSET path; the sidecar is
 *  `<asset>.meta.json`, and conflating the two is the mistake this route could easily have made —
 *  hashing the PNG would 409 every conditional write forever. */
const ASSET = '/rock.png';
const assetAbs = () => path.join(projectRoot, 'rock.png');
const metaAbs = () => `${assetAbs()}.meta.json`;

function seed(meta: Record<string, unknown>): Buffer {
  fs.writeFileSync(assetAbs(), 'not-really-a-png');
  fs.writeFileSync(metaAbs(), `${JSON.stringify(meta, null, 2)}\n`);
  return fs.readFileSync(metaAbs());
}

beforeEach(() => { projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-write-meta-if-match-')); });
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('/api/read-meta — the baseline it hands the client (#845)', () => {
  it('returns X-Meta-Sha256 over the SIDECAR bytes, not the asset', async () => {
    const bytes = seed({ id: 'a-guid', version: 1, texture: { format: 'png' } });

    const res = (await get('/api/read-meta', { path: ASSET }, makeCtx())) as
      { headers?: Record<string, string>; body: string };

    expect(res.headers?.['X-Meta-Sha256']).toBe(sha256(bytes));
    // …and emphatically not the asset's own bytes, which is the easy way to get this wrong.
    expect(res.headers?.['X-Meta-Sha256']).not.toBe(sha256(fs.readFileSync(assetAbs())));
  });

  it('omits the header when there is no sidecar — "no baseline", not "unchanged"', async () => {
    fs.writeFileSync(assetAbs(), 'not-really-a-png');

    const res = (await get('/api/read-meta', { path: ASSET }, makeCtx())) as
      { headers?: Record<string, string> };

    expect(res.headers?.['X-Meta-Sha256']).toBeUndefined();
  });
});

describe('/api/write-meta — ifMatch precondition (#845 phase 2)', () => {
  it('WRITES when ifMatch matches the current on-disk sidecar bytes', async () => {
    const bytes = seed({ id: 'a-guid', version: 1, texture: { format: 'png' } });

    const res = (await post('/api/write-meta', {
      path: ASSET, meta: { id: 'a-guid', texture: { format: 'webp' } }, ifMatch: sha256(bytes),
    }, makeCtx())) as { status?: number; body: { ok?: boolean; sha256?: string } };

    expect(res.body.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(metaAbs(), 'utf-8')).texture.format).toBe('webp');
  });

  it('409s and does NOT write when the sidecar changed since it was read', async () => {
    const bytes = seed({ id: 'a-guid', version: 1, texture: { format: 'png' } });
    const staleBaseline = sha256(bytes);
    // Somebody else writes it — a git checkout, an agent, another panel.
    fs.writeFileSync(metaAbs(), `${JSON.stringify({ id: 'a-guid', version: 1, texture: { format: 'ktx2-uastc' } }, null, 2)}\n`);

    const res = (await post('/api/write-meta', {
      path: ASSET, meta: { id: 'a-guid', texture: { format: 'webp' } }, ifMatch: staleBaseline,
    }, makeCtx())) as { status?: number; body: { ok?: boolean; conflict?: boolean } };

    expect(res.status).toBe(409);
    expect(res.body.conflict).toBe(true);
    // The other writer's content survives — that is the whole point.
    expect(JSON.parse(fs.readFileSync(metaAbs(), 'utf-8')).texture.format).toBe('ktx2-uastc');
  });

  /** The ACCEPT side for every caller that never sends a baseline: the eight explicit-action
   *  writers (SpriteEditor/NineSliceEditor Save, makeTexture2D, the re-import handlers) build
   *  their document from a fresh read moments earlier and the human asked for the write.
   *  Regressing this would break them silently. */
  it('writes UNCONDITIONALLY when no ifMatch is sent, exactly as before', async () => {
    seed({ id: 'a-guid', version: 1, texture: { format: 'png' } });
    fs.writeFileSync(metaAbs(), `${JSON.stringify({ id: 'a-guid', version: 1, texture: { format: 'ktx2-uastc' } }, null, 2)}\n`);

    const res = (await post('/api/write-meta', {
      path: ASSET, meta: { id: 'a-guid', texture: { format: 'webp' } },
    }, makeCtx())) as { status?: number; body: { ok?: boolean } };

    expect(res.body.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(metaAbs(), 'utf-8')).texture.format).toBe('webp');
  });

  /** The reply's `sha256` is what lets a still-mounted panel keep editing after a save. Without
   *  it, its next write carries the PRE-save baseline and 409s under "the file changed on disk"
   *  when the only thing that changed it was us. It must therefore describe what was ACTUALLY
   *  written — which is not the posted document, because `writeMetaSidecar` stamps `version`. */
  it('returns the sha256 of what it actually wrote, not of what was posted', async () => {
    seed({ id: 'a-guid', version: 1, texture: { format: 'png' } });

    const res = (await post('/api/write-meta', {
      path: ASSET, meta: { id: 'a-guid', texture: { format: 'webp' } },
    }, makeCtx())) as { body: { sha256?: string } };

    expect(res.body.sha256).toBe(sha256(fs.readFileSync(metaAbs())));
    // A second write using that reply as the baseline must be ACCEPTED — this is the round trip
    // the panel actually performs, and asserting the hash alone would not prove it agrees with
    // what `ifMatchRefusal` computes.
    const again = (await post('/api/write-meta', {
      path: ASSET, meta: { id: 'a-guid', texture: { format: 'ktx2-uastc' } }, ifMatch: res.body.sha256,
    }, makeCtx())) as { status?: number; body: { ok?: boolean } };
    expect(again.body.ok).toBe(true);
  });
});
