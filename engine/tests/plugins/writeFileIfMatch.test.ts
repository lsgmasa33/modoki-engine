/** `POST /api/write-file`'s optional `ifMatch` precondition (#469).
 *
 *  #439's original CAS guard was a client-side read → compare → write with a gap: two rapid
 *  edits (e.g. two clicks of a stepper) both read the same unchanged baseline, both pass the
 *  compare, and both write — the second silently overwrites the first. #469 moves the compare
 *  AND the write into this one route handler so there is no gap between them for a second write
 *  to land in.
 *
 *  Absent `ifMatch`, the route MUST behave exactly as before (every existing caller — Save All,
 *  every other asset panel — never sends it). That backwards-compat guarantee gets its own test
 *  below, not just an implicit assumption. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    requestBrowser: async () => ({}),
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

beforeEach(() => { projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-write-if-match-')); });
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('/api/write-file — no ifMatch (backwards compat)', () => {
  it('writes unconditionally when ifMatch is absent, even over content that has since changed', async () => {
    const abs = path.join(projectRoot, 'a.atlas.json');
    fs.writeFileSync(abs, 'whatever is currently on disk');

    const res = (await post('/api/write-file', { path: '/a.atlas.json', content: 'new content' }, makeCtx())) as { status?: number; body: { ok?: boolean } };

    expect(res.body.ok).toBe(true);
    expect(fs.readFileSync(abs, 'utf-8')).toBe('new content');
  });

  it('writes unconditionally to a brand-new path with no ifMatch', async () => {
    const res = (await post('/api/write-file', { path: '/fresh.json', content: '{}' }, makeCtx())) as { body: { ok?: boolean } };
    expect(res.body.ok).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, 'fresh.json'), 'utf-8')).toBe('{}');
  });
});

describe('/api/write-file — ifMatch precondition', () => {
  it('writes when ifMatch matches the sha256 of the current on-disk content', async () => {
    const abs = path.join(projectRoot, 'a.atlas.json');
    const current = '{"members":[]}\n';
    fs.writeFileSync(abs, current);

    const res = (await post('/api/write-file', { path: '/a.atlas.json', content: '{"members":["x"]}\n', ifMatch: sha256(current) }, makeCtx())) as { status?: number; body: { ok?: boolean } };

    expect(res.body.ok).toBe(true);
    expect(fs.readFileSync(abs, 'utf-8')).toBe('{"members":["x"]}\n');
  });

  it('409s and does NOT write when ifMatch does not match the current on-disk content', async () => {
    const abs = path.join(projectRoot, 'a.atlas.json');
    fs.writeFileSync(abs, '{"members":["changed-on-disk"]}\n');

    const res = (await post('/api/write-file', { path: '/a.atlas.json', content: '{"members":["x"]}\n', ifMatch: sha256('{"members":[]}\n') }, makeCtx())) as { status?: number; body: unknown };

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, conflict: true, reason: 'if-match' });
    expect(fs.readFileSync(abs, 'utf-8')).toBe('{"members":["changed-on-disk"]}\n');
  });

  it('409s and does NOT write when ifMatch is given but the file does not exist', async () => {
    const res = (await post('/api/write-file', { path: '/never-existed.json', content: '{}', ifMatch: sha256('anything') }, makeCtx())) as { status?: number; body: unknown };

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, conflict: true, reason: 'if-match' });
    expect(fs.existsSync(path.join(projectRoot, 'never-existed.json'))).toBe(false);
  });

  // #490 review finding 2: a file on disk carrying a leading UTF-8 BOM (Windows-authored, or an
  // externally-tooled `.atlas.json` — the `win` clone is a live workspace) hashes DIFFERENTLY on
  // the two sides forever, because the browser's `Response.text()` strips a leading BOM before the
  // client ever hashes the text, while this route hashes the raw file buffer, BOM included. Without
  // a fix here every conditional write against a BOM'd file 409s, no matter how fresh the baseline.
  it('a leading UTF-8 BOM on disk does not defeat ifMatch — the server hashes what the browser saw (#490 review finding 2)', async () => {
    const abs = path.join(projectRoot, 'bom.atlas.json');
    const withoutBom = '{"members":[]}\n';
    const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(withoutBom, 'utf-8')]);
    fs.writeFileSync(abs, bomBytes);
    // This IS what a real client sends: `Response.text()` already stripped the BOM, so the panel's
    // `loadedText` — and therefore its ifMatch hash — never sees it.
    const ifMatch = sha256(withoutBom);

    const res = (await post('/api/write-file', { path: '/bom.atlas.json', content: '{"members":["x"]}\n', ifMatch }, makeCtx())) as { status?: number; body: { ok?: boolean } };

    expect(res.body.ok).toBe(true);
    expect(fs.readFileSync(abs, 'utf-8')).toBe('{"members":["x"]}\n');
  });
});

describe('/api/write-file — the actual #469 regression: two racing conditional writes', () => {
  // The bug this closes: two edits captured the SAME baseline (same `loadedText`, same `ifMatch`
  // hash) and both raced a client-side read-compare-write, so both passed and the second clobbered
  // the first. Simulated here by firing two `ifMatch`-guarded POSTs against the same starting
  // content, in parallel, at this route directly (no client-side race to reproduce — the fix moved
  // the compare into this synchronous handler, so calling it twice IS the race). Exactly one must
  // land as 'written' and the other as a 409 conflict, and the file must hold exactly the winning
  // write's content — never a silent second overwrite.
  it('exactly one of two concurrent same-baseline writes succeeds; the other conflicts', async () => {
    const abs = path.join(projectRoot, 'a.atlas.json');
    const baseline = '{"padding":1}\n';
    fs.writeFileSync(abs, baseline);
    const ifMatch = sha256(baseline);

    const ctx = makeCtx();
    const [r1, r2] = await Promise.all([
      post('/api/write-file', { path: '/a.atlas.json', content: '{"padding":2}\n', ifMatch }, ctx),
      post('/api/write-file', { path: '/a.atlas.json', content: '{"padding":3}\n', ifMatch }, ctx),
    ]) as Array<{ status?: number; body: { ok?: boolean; conflict?: boolean } }>;

    const outcomes = [r1, r2].map((r) => (r.body.ok ? 'written' : 'conflict'));
    expect(outcomes.sort()).toEqual(['conflict', 'written']);

    const winner = r1.body.ok ? '{"padding":2}\n' : '{"padding":3}\n';
    expect(fs.readFileSync(abs, 'utf-8')).toBe(winner);
  });
});
