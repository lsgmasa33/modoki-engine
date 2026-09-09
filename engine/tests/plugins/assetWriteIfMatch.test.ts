/** `POST /api/asset-write`'s optional `ifMatch` precondition (#831).
 *
 *  `AtlasAssetView` used to write on every control interaction through `/api/write-file`, guarded
 *  by that route's `ifMatch` (#439, #469). Since #831 it PARKS instead, and the write happens in
 *  `flushDirtyAssets` at Cmd+S — on this route, which validates and normalizes an asset document.
 *  The compare-and-swap had to come with it, and it matters MORE than it did: the window between
 *  the read the panel serializes onto and the write is no longer one keystroke, it is however long
 *  the human takes to press Cmd+S. A `git checkout` under a live editor (CLAUDE.md's documented
 *  hazard) lands squarely in it.
 *
 *  Both directions are asserted, because a guard tested only on its REJECT side is half a guard:
 *  the accept case (a matching baseline still writes) is what stops the next author "fixing" a
 *  spurious 409 by deleting the precondition. Absent `ifMatch` the route must behave exactly as
 *  before — every other caller (the four parking panels, every agent op) never sends one. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { relay } from './backendRelay';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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

const sha256 = (text: string) => crypto.createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');

/** A committed-looking atlas document, written the way the editor writes one (2-space, trailing
 *  newline — `assetJsonBytes`). Its exact bytes ARE the baseline, which is the point: a client
 *  hashes what it read, not what it thinks the document means. */
const onDisk = `${JSON.stringify({ id: 'a-guid', version: 1, members: ['s1'], pageSize: 1024, padding: 2, extrude: 1 }, null, 2)}\n`;
const edited = { id: 'a-guid', version: 1, members: ['s1'], pageSize: 1024, padding: 7, extrude: 1 };

beforeEach(() => { projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-asset-if-match-')); });
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('/api/asset-write — ifMatch precondition (#831)', () => {
  it('WRITES when ifMatch matches the sha256 of the current on-disk bytes', async () => {
    const abs = path.join(projectRoot, 'a.atlas.json');
    fs.writeFileSync(abs, onDisk);

    const res = (await post('/api/asset-write', {
      path: '/a.atlas.json', type: 'atlas', data: edited, replace: true, ifMatch: sha256(onDisk),
    }, makeCtx())) as { status?: number; body: { ok?: boolean } };

    expect(res.body.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(abs, 'utf-8')).padding).toBe(7);
  });

  it('409s and does NOT write when the file changed since it was read', async () => {
    const abs = path.join(projectRoot, 'a.atlas.json');
    fs.writeFileSync(abs, onDisk);
    const staleBaseline = sha256(onDisk);
    // Someone else — `git checkout`, another clone, a hand edit — moves the file underneath.
    const theirs = `${JSON.stringify({ id: 'a-guid', version: 1, members: ['s1', 's2'], pageSize: 1024, padding: 2, extrude: 1 }, null, 2)}\n`;
    fs.writeFileSync(abs, theirs);

    const res = (await post('/api/asset-write', {
      path: '/a.atlas.json', type: 'atlas', data: edited, replace: true, ifMatch: staleBaseline,
    }, makeCtx())) as { status?: number; body: { ok?: boolean; conflict?: boolean; reason?: string } };

    expect(res.status).toBe(409);
    expect(res.body.conflict).toBe(true);
    expect(res.body.reason).toBe('if-match');
    // The whole point: their change is still there. `members` would have gone back to one entry.
    expect(fs.readFileSync(abs, 'utf-8')).toBe(theirs);
  });

  it('409s when ifMatch is given but the file does not exist', async () => {
    // "Absent" is not "matches nothing" — a baseline for a file that has since been deleted or
    // renamed is a claim about content that is gone, and writing it back would resurrect the file
    // under a stale document.
    const res = (await post('/api/asset-write', {
      path: '/never-existed.atlas.json', type: 'atlas', data: edited, replace: true, ifMatch: sha256(onDisk),
    }, makeCtx())) as { status?: number; body: { conflict?: boolean } };

    expect(res.status).toBe(409);
    expect(res.body.conflict).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'never-existed.atlas.json'))).toBe(false);
  });

  it('writes UNCONDITIONALLY when ifMatch is absent — every other caller is unaffected', async () => {
    const abs = path.join(projectRoot, 'a.mat.json');
    fs.writeFileSync(abs, '{"id":"m","roughness":1}');

    const res = (await post('/api/asset-write', {
      path: '/a.mat.json', type: 'material', data: { id: 'm', roughness: 0.25 }, replace: true,
    }, makeCtx())) as { body: { ok?: boolean } };

    expect(res.body.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(abs, 'utf-8')).roughness).toBe(0.25);
  });

  it('a leading UTF-8 BOM on disk does not defeat ifMatch — the server hashes what the browser saw', async () => {
    // The client's baseline comes from `Response.text()`, which strips a leading BOM as part of
    // decoding. Hashing the raw buffer here would make a BOM'd file (a Windows-authored
    // `.atlas.json`) 409 on every write forever, with no way to ever succeed (#490 finding 2).
    const abs = path.join(projectRoot, 'bom.atlas.json');
    fs.writeFileSync(abs, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(onDisk, 'utf-8')]));

    const res = (await post('/api/asset-write', {
      path: '/bom.atlas.json', type: 'atlas', data: edited, replace: true, ifMatch: sha256(onDisk),
    }, makeCtx())) as { body: { ok?: boolean } };

    expect(res.body.ok).toBe(true);
  });
});

describe('/api/asset-write — the sha256 it reports back (#831)', () => {
  it('reports the sha256 of the bytes it actually wrote, so a CAS caller can advance its baseline', async () => {
    // Without this a panel's SECOND save always 409s: its baseline is still the text it loaded,
    // and it cannot recompute the server's bytes (`normalizeAssetData` + id preservation + the
    // trailing newline) without keeping a second copy of that serialisation.
    const abs = path.join(projectRoot, 'a.atlas.json');
    fs.writeFileSync(abs, onDisk);

    const res = (await post('/api/asset-write', {
      path: '/a.atlas.json', type: 'atlas', data: edited, replace: true, ifMatch: sha256(onDisk),
    }, makeCtx())) as { body: { sha256?: string } };

    expect(res.body.sha256).toBe(sha256(fs.readFileSync(abs, 'utf-8')));
  });

  it('the reported hash is usable as the NEXT write\'s ifMatch', async () => {
    // The round trip is the assertion that matters — a hash that is merely "a hash" would pass the
    // test above and still leave the panel permanently conflicted.
    const abs = path.join(projectRoot, 'a.atlas.json');
    fs.writeFileSync(abs, onDisk);

    const first = (await post('/api/asset-write', {
      path: '/a.atlas.json', type: 'atlas', data: edited, replace: true, ifMatch: sha256(onDisk),
    }, makeCtx())) as { body: { sha256?: string } };

    const second = (await post('/api/asset-write', {
      path: '/a.atlas.json', type: 'atlas', data: { ...edited, padding: 9 }, replace: true, ifMatch: first.body.sha256,
    }, makeCtx())) as { status?: number; body: { ok?: boolean } };

    expect(second.body.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(abs, 'utf-8')).padding).toBe(9);
  });
});

describe('/api/asset-write — atlas is a first-class asset type now (#831)', () => {
  it('refuses to overwrite a `.atlas.json` written by a NEWER build', async () => {
    // The panel already refused a too-new document client-side (`classifyAtlasLoad`); the route
    // has to refuse it too, or an agent's `modoki_write_asset` walks straight past that.
    const abs = path.join(projectRoot, 'future.atlas.json');
    const future = `${JSON.stringify({ id: 'f', version: 99, members: [] }, null, 2)}\n`;
    fs.writeFileSync(abs, future);

    const res = (await post('/api/asset-write', {
      path: '/future.atlas.json', type: 'atlas', data: { id: 'f', version: 1, members: ['x'] }, replace: true,
    }, makeCtx())) as { status?: number; body: { ok?: boolean; error?: string } };

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(fs.readFileSync(abs, 'utf-8')).toBe(future);
  });

  it('preserves a top-level key the atlas panel does not render', async () => {
    // QA-ASSET-0013, at the route rather than in the panel: the `texture` block decides how the
    // packed page is ENCODED, and a writer that does not know about it deletes it silently. The
    // panel carries it forward (`buildAtlasDocToPark`), and nothing on this route strips it.
    const abs = path.join(projectRoot, 'a.atlas.json');
    const texture = { format: 'ktx2-uastc', maxSize: 2048, mipmaps: false };
    fs.writeFileSync(abs, `${JSON.stringify({ id: 'a-guid', version: 1, members: ['s1'], texture, pageSize: 1024, padding: 2, extrude: 1 }, null, 2)}\n`);

    await post('/api/asset-write', {
      path: '/a.atlas.json', type: 'atlas', data: { id: 'a-guid', version: 1, members: ['s1'], texture, pageSize: 1024, padding: 7, extrude: 1 }, replace: true,
    }, makeCtx());

    expect(JSON.parse(fs.readFileSync(abs, 'utf-8')).texture).toEqual(texture);
  });
});

/** A leading UTF-8 BOM on an asset file used to break THREE guards on this route at once, and all
 *  three failed in the direction that destroys data. Found 2026-09-07 while writing the `ifMatch`
 *  BOM case above: a BOM'd atlas came back `400 REFUSED: could not be classified (unparsable)`.
 *
 *  `prevText` was read with `readFileSync(abs, 'utf-8')`, BOM included, and `JSON.parse` rejects
 *  that — so the format-version classifier called the file corrupt and refused every write to it
 *  FOREVER, `prevDoc` fell to null so the dropped-field guard passed anything, and id preservation
 *  was skipped so a doc whose `id` the caller omitted got a brand-new GUID minted by the watcher's
 *  heal (the C7 class: every reference to the old guid dangles). Pre-existing and type-agnostic —
 *  a Windows-authored `.mat.json` hits it identically, which is CLAUDE.md's recurring Windows
 *  class showing up on a Mac-only gate. */
describe('/api/asset-write — a BOM on disk does not disarm the guards (#831 close-out finding)', () => {
  const bom = (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf-8')]);

  it('does not call a BOM\'d file corrupt and refuse the write', async () => {
    const abs = path.join(projectRoot, 'a.atlas.json');
    fs.writeFileSync(abs, bom(onDisk));

    const res = (await post('/api/asset-write', {
      path: '/a.atlas.json', type: 'atlas', data: edited, replace: true,
    }, makeCtx())) as { status?: number; body: { ok?: boolean; error?: string } };

    expect(res.body.error ?? '').not.toContain('could not be classified');
    expect(res.body.ok).toBe(true);
    // And the BOM is gone from what was written — `assetJsonBytes` never emits one, so the file
    // heals in place rather than staying a trap for the next writer.
    expect(fs.readFileSync(abs)[0]).not.toBe(0xef);
  });

  it('still REFUSES a too-new version through a BOM — the fix must not turn the guard off', async () => {
    // The other direction, and the one a sloppy "just make it parse" fix loses: reading the file
    // correctly has to make the refusal WORK, not disappear.
    const abs = path.join(projectRoot, 'future.atlas.json');
    const future = `${JSON.stringify({ id: 'f', version: 99, members: [] }, null, 2)}\n`;
    fs.writeFileSync(abs, bom(future));

    const res = (await post('/api/asset-write', {
      path: '/future.atlas.json', type: 'atlas', data: { id: 'f', version: 1, members: ['x'] }, replace: true,
    }, makeCtx())) as { status?: number; body: { ok?: boolean } };

    expect(res.status).toBe(409);
    expect(fs.readFileSync(abs)).toEqual(bom(future));
  });

  it('the dropped-field guard still fires on a BOM\'d file', async () => {
    const abs = path.join(projectRoot, 'a.atlas.json');
    fs.writeFileSync(abs, bom(onDisk));

    // No `replace`, and `padding`/`extrude`/`pageSize` omitted — an agent read-modify-write that
    // lost fields. With `prevDoc` null this used to sail through and delete them.
    const res = (await post('/api/asset-write', {
      path: '/a.atlas.json', type: 'atlas', data: { id: 'a-guid', version: 1, members: ['s1'] },
    }, makeCtx())) as { status?: number; body: { ok?: boolean; dropped?: string[] } };

    expect(res.status).toBe(409);
    expect(res.body.dropped).toEqual(expect.arrayContaining(['pageSize', 'padding', 'extrude']));
  });

  it('preserves the id of a BOM\'d file when the incoming doc omits it', async () => {
    const abs = path.join(projectRoot, 'a.atlas.json');
    fs.writeFileSync(abs, bom(onDisk));

    await post('/api/asset-write', {
      path: '/a.atlas.json', type: 'atlas', data: { version: 1, members: ['s1'], pageSize: 1024, padding: 7, extrude: 1 }, replace: true,
    }, makeCtx());

    expect(JSON.parse(fs.readFileSync(abs, 'utf-8')).id).toBe('a-guid');
  });
});
