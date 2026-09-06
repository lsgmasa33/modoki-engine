/** The two routes behind Project Settings' image preview and drag-and-drop (#408 follow-up).
 *
 *  `planDroppedFileDest` (plugins/projectPaths.test.ts) covers the NAMING decision in isolation.
 *  This covers the half that only exists once a real filesystem is involved, and specifically the
 *  owner's rule — **copy a dropped file into the project, but never one that is already in it**.
 *  The interesting assertions are all negative: that nothing was written. A test that only checks
 *  the returned path passes just as happily when a duplicate lands beside the original, which is
 *  the exact defect the rule exists to prevent, so every no-copy case also counts the files on
 *  disk.
 *
 *  `/api/adopt-file` writes, so it owes `markEditorWrite` the sha1 of the bytes that landed — the
 *  lesson `createAssetSelfWrite.test.ts` was written for: a write route that skips it makes the
 *  editor treat its own write as an external edit and discard parked edits for that path. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { readScannedSource } from '@modoki/engine/testing';

let projectRoot = '';
let outsideRoot = '';

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
const get = (urlPath: string, query: Record<string, string>, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'GET', urlPath, query: new URLSearchParams(query), body: undefined });

/** A real, tiny PNG (1x1, transparent) — a plausible dropped file rather than a text stub, so the
 *  content-type and byte round-trip are asserted against something a decoder would accept. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([0])]);

const filesIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-drop-'));
  outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-elsewhere-'));
  fs.mkdirSync(path.join(projectRoot, 'art'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'art', 'splash-master.png'), PNG);
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
});

describe('/api/adopt-file — a file dropped on a Project Settings path field', () => {
  it('REFERENCES a file already inside the project instead of copying it', async () => {
    const markEditorWrite = vi.fn();
    const ctx = makeCtx({ markEditorWrite });
    // Deliberately NOT in `art/`, and deliberately not byte-identical to anything there. A source
    // that already sits at the copy destination cannot tell the two branches apart: the dedupe
    // would answer 'same' and report `copied:false` from the COPY path, so the test would pass
    // with the reference branch deleted. (It did — caught by mutating that branch out during this
    // change's own close-out.) From here, referencing gives `sprites/logo.png` and copying gives
    // `art/logo.png`, so only one hypothesis survives.
    fs.mkdirSync(path.join(projectRoot, 'sprites'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'sprites', 'logo.png'), OTHER_PNG);
    const abs = path.join(projectRoot, 'sprites', 'logo.png');
    // The bytes are sent too — the renderer has them either way. The route must still decline to
    // write, because the deciding fact is WHERE the file is, not whether a copy is possible.
    const res = (await post('/api/adopt-file', { abs, name: 'logo.png', content: OTHER_PNG.toString('base64') }, ctx)) as
      { body: { path?: string; copied?: boolean } };

    expect(res.body).toEqual({ path: 'sprites/logo.png', copied: false });
    expect(filesIn(path.join(projectRoot, 'art'))).toEqual(['splash-master.png']);
    expect(markEditorWrite).not.toHaveBeenCalled();
  });

  it('references a drag out of the ASSETS PANEL, which is inside the project by construction', async () => {
    fs.mkdirSync(path.join(projectRoot, 'runtime', 'assets', 'textures'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'runtime', 'assets', 'textures', 'icon.png'), PNG);
    const ctx = makeCtx();
    const res = (await post('/api/adopt-file', { assetPath: '/runtime/assets/textures/icon.png' }, ctx)) as
      { body: { path?: string; copied?: boolean } };

    expect(res.body).toEqual({ path: 'runtime/assets/textures/icon.png', copied: false });
    expect(filesIn(path.join(projectRoot, 'art'))).toEqual(['splash-master.png']);
  });

  it('COPIES a file from outside the project, and stores the project-relative path', async () => {
    const markEditorWrite = vi.fn();
    const ctx = makeCtx({ markEditorWrite });
    const abs = path.join(outsideRoot, 'downloaded-icon.png');
    fs.writeFileSync(abs, PNG);
    const res = (await post('/api/adopt-file', { abs, name: 'downloaded-icon.png', content: PNG.toString('base64') }, ctx)) as
      { body: { path?: string; copied?: boolean } };

    expect(res.body).toEqual({ path: 'art/downloaded-icon.png', copied: true });
    // The BYTES, not just the name: a base64 round-trip that drops the data: prefix wrongly writes
    // a file that exists, is the right size to a glance, and is not the image that was dropped.
    expect(fs.readFileSync(path.join(projectRoot, 'art', 'downloaded-icon.png')).equals(PNG)).toBe(true);
    expect(markEditorWrite).toHaveBeenCalledWith(
      path.join(projectRoot, 'art', 'downloaded-icon.png'),
      crypto.createHash('sha1').update(PNG).digest('hex'),
    );
    expect(fs.existsSync(path.join(projectRoot, 'art', 'downloaded-icon.png.tmp'))).toBe(false);
  });

  it('re-dropping the SAME outside file twice does not mint a second copy', async () => {
    const ctx = makeCtx();
    const payload = { abs: path.join(outsideRoot, 'logo.png'), name: 'logo.png', content: PNG.toString('base64') };
    const first = (await post('/api/adopt-file', payload, ctx)) as { body: { path?: string; copied?: boolean } };
    const second = (await post('/api/adopt-file', payload, ctx)) as { body: { path?: string; copied?: boolean } };

    expect(first.body).toEqual({ path: 'art/logo.png', copied: true });
    expect(second.body).toEqual({ path: 'art/logo.png', copied: false });
    expect(filesIn(path.join(projectRoot, 'art'))).toEqual(['logo.png', 'splash-master.png']);
  });

  it('does NOT overwrite a different file of the same name', async () => {
    const ctx = makeCtx();
    const res = (await post('/api/adopt-file', {
      abs: path.join(outsideRoot, 'splash-master.png'), name: 'splash-master.png', content: OTHER_PNG.toString('base64'),
    }, ctx)) as { body: { path?: string; copied?: boolean } };

    expect(res.body).toEqual({ path: 'art/splash-master-1.png', copied: true });
    // The original is untouched — the assertion the "same name" case is really about.
    expect(fs.readFileSync(path.join(projectRoot, 'art', 'splash-master.png')).equals(PNG)).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, 'art', 'splash-master-1.png')).equals(OTHER_PNG)).toBe(true);
  });

  it('asks for the bytes when the file is outside the project and none were sent', async () => {
    // The renderer's two-step: probe with the path alone (cheap), upload only if this says so.
    // A 400 here is a REQUEST for the upload, so the status is load-bearing, not decorative.
    const ctx = makeCtx();
    const res = (await post('/api/adopt-file', { abs: path.join(outsideRoot, 'icon.png'), name: 'icon.png' }, ctx)) as
      { status?: number; body: { error?: string } };

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside the project/);
    expect(filesIn(path.join(projectRoot, 'art'))).toEqual(['splash-master.png']);
  });

  it('copies when the host could not supply a source path at all (no Electron preload)', async () => {
    // A browser-hosted editor has no `webUtils`, so a drop arrives as bytes + a name and nothing
    // else. Copying is the safe direction: a redundant copy, never a dead reference.
    const ctx = makeCtx();
    const res = (await post('/api/adopt-file', { name: 'pasted.png', content: PNG.toString('base64') }, ctx)) as
      { body: { path?: string; copied?: boolean } };

    expect(res.body).toEqual({ path: 'art/pasted.png', copied: true });
  });

  it('will NOT read a client-supplied `abs` off disk — only an asset the editor resolved', async () => {
    // The exfiltration this closes: without the assetAbs/sourceAbs split, `{abs: <any file>}` with
    // no bytes copies that file into the project as `art/<name>.png`, which /api/source-image then
    // serves back under an extension it trusts — and leaves the contents in the project for a
    // commit to pick up. The asset branch is a different kind of input: the editor's own roots
    // resolved it. This is a REGRESSION TEST for a fix made during close-out, not a hypothetical.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-secret-'));
    const secret = path.join(secretDir, 'id_ed25519');
    fs.writeFileSync(secret, 'PRIVATE-KEY-BYTES');
    const ctx = makeCtx();
    const res = (await post('/api/adopt-file', { abs: secret, name: 'innocent.png' }, ctx)) as
      { status?: number; body: { error?: string } };

    expect(res.status).toBe(400);
    expect(filesIn(path.join(projectRoot, 'art'))).toEqual(['splash-master.png']);
    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('refuses an assetPath that traverses out of its root — the guard the read branch RESTS on', async () => {
    // The read branch has no containment check of its own: an asset root may legitimately sit
    // outside the project (that is the case it exists for), so the route cannot re-derive one.
    // Its whole safety is `resolveAssetPath` rejecting traversal — a coupling this route did not
    // have before the read branch existed, and one nothing pinned. The stub above is deliberately
    // permissive (it is a harness), which is exactly why THIS case uses a production-shaped one:
    // the real guard is `vite-asset-scanner.ts` ~1149, `path.relative` + reject `..`/absolute.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-secret-'));
    fs.writeFileSync(path.join(secretDir, 'id_ed25519'), 'PRIVATE-KEY-BYTES');
    const rootDir = path.join(projectRoot, 'runtime', 'assets');
    fs.mkdirSync(rootDir, { recursive: true });
    const ctx = makeCtx({
      resolveAssetPath: (p: string) => {
        const abs = path.resolve(rootDir, p.replace(/^\/+/, ''));
        const rel = path.relative(rootDir, abs);
        return (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) ? null : abs;
      },
    });
    const traversal = `/${path.relative(rootDir, path.join(secretDir, 'id_ed25519')).split(path.sep).join('/')}`;
    const res = (await post('/api/adopt-file', { assetPath: traversal, name: 'innocent.png' }, ctx)) as
      { status?: number; body: { error?: string } };

    expect(res.status).toBe(400);
    expect(filesIn(path.join(projectRoot, 'art'))).toEqual(['splash-master.png']);
    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('cannot be steered out of the project by a crafted copyFolder', async () => {
    // The sibling of the crafted-NAME case below, and the half that was missing: `name` was
    // sanitised to a leaf and tested; `copyFolder` reached path.join unchecked, so this body
    // wrote outside the project entirely. Reachable from a page in the owner's browser, because
    // the host parses a POST body regardless of Content-Type and a no-preflight cross-origin POST
    // does not need to read the reply — the write IS the payload.
    const ctx = makeCtx();
    // The target is DERIVED (os.tmpdir(), then relativised off the project root) rather than a
    // `/tmp/…` literal: on Windows a POSIX-absolute literal is drive-relative and the assertion
    // would pass vacuously. `posixPathGuard.test.ts` fails the build on the literal spelling, and
    // did on this very test.
    const escapeTarget = path.join(os.tmpdir(), 'modoki-adopt-escape');
    const res = (await post('/api/adopt-file', {
      name: 'evil.png', copyFolder: path.relative(projectRoot, escapeTarget), content: PNG.toString('base64'),
    }, ctx)) as { status?: number; body: { error?: string } };

    expect(res.status).toBe(403);
    // The message is asserted SPECIFICALLY. There is a second, belt-and-braces containment check
    // on the resolved destination, and a loose /escapes the project/ match passes on either — so
    // deleting the copyFolder guard left this test green (measured). Naming the guard pins the
    // guard. The first one is not redundant: without it the naming probe still byte-compares files
    // OUTSIDE the project looking for a match, which is an equality oracle even though the write
    // is refused. (The second check is unreachable while the first stands, so nothing tests it —
    // it is there for a future edit to the naming policy, and that is stated, not pretended.)
    expect(res.body.error).toMatch(/copyFolder escapes the project/);
    expect(fs.existsSync(path.join(escapeTarget, 'evil.png'))).toBe(false);
  });

  it('accepts a copyFolder that stays inside, including a `..` that cancels out', async () => {
    // The guard must not be a blanket ban on `..`: `art/../sprites` is inside the project and has
    // a perfectly good resolved form. A guard that refuses it would be measuring spelling.
    const ctx = makeCtx();
    const res = (await post('/api/adopt-file', {
      name: 'ok.png', copyFolder: 'art/../sprites', content: PNG.toString('base64'),
    }, ctx)) as { body: { path?: string; copied?: boolean } };

    expect(res.body).toEqual({ path: 'sprites/ok.png', copied: true });
  });

  it('refuses content that is not valid base64 instead of writing an empty file', async () => {
    // Buffer.from is lenient: without this the route reports copied:true and the field points at
    // a 0-byte file that only the preview would ever complain about.
    const ctx = makeCtx();
    const res = (await post('/api/adopt-file', { name: 'junk.png', content: '!!!!' }, ctx)) as
      { status?: number; body: { error?: string } };

    expect(res.status).toBe(400);
    expect(filesIn(path.join(projectRoot, 'art'))).toEqual(['splash-master.png']);
  });

  it('copies an ASSET drag from a root outside the project by reading the file itself', async () => {
    // An asset drag carries no File, so the renderer has no bytes to upload on the 400 — and an
    // asset root can sit outside the project root. Without this the editor offers a drag that
    // dead-ends in an error the user cannot act on. The server has the file; it just reads it.
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-shared-'));
    fs.writeFileSync(path.join(shared, 'shared-icon.png'), OTHER_PNG);
    const ctx = makeCtx({ resolveAssetPath: (p: string) => path.join(shared, p.replace(/^\//, '')) });
    const res = (await post('/api/adopt-file', { assetPath: '/shared-icon.png' }, ctx)) as
      { body: { path?: string; copied?: boolean } };

    expect(res.body).toEqual({ path: 'art/shared-icon.png', copied: true });
    expect(fs.readFileSync(path.join(projectRoot, 'art', 'shared-icon.png')).equals(OTHER_PNG)).toBe(true);
    fs.rmSync(shared, { recursive: true, force: true });
  });

  it('cannot be steered out of the project by a crafted file name', async () => {
    const ctx = makeCtx();
    const res = (await post('/api/adopt-file', {
      name: '../../escaped.png', content: PNG.toString('base64'),
    }, ctx)) as { body: { path?: string } };

    expect(res.body.path).toBe('art/escaped.png');
    expect(fs.existsSync(path.join(projectRoot, '..', '..', 'escaped.png'))).toBe(false);
  });
});

describe('/api/source-image — the preview bytes', () => {
  it('serves an in-project image with its content type and exact bytes', async () => {
    const ctx = makeCtx();
    const res = (await get('/api/source-image', { path: 'art/splash-master.png' }, ctx)) as
      { kind?: string; contentType?: string; body: Buffer; headers?: Record<string, string> };

    expect(res.kind).toBe('raw');
    expect(res.contentType).toBe('image/png');
    expect(Buffer.isBuffer(res.body) && res.body.equals(PNG)).toBe(true);
    // Art is repainted in another tool; a cached preview of an icon is the lie this removes.
    expect(res.headers?.['Cache-Control']).toBe('no-store');
  });

  it('distinguishes MISSING from outside-the-project from not-an-image', async () => {
    // Three different problems with three different fixes. `<img onError>` — the shape this route
    // was written to avoid — reports one indistinguishable failure for all three.
    const ctx = makeCtx();
    const missing = (await get('/api/source-image', { path: 'art/gone.png' }, ctx)) as { status?: number };
    const outside = (await get('/api/source-image', { path: path.join(outsideRoot, 'x.png') }, ctx)) as { status?: number };
    const notImage = (await get('/api/source-image', { path: 'art/notes.txt' }, ctx)) as { status?: number };

    expect(missing.status).toBe(404);
    expect(outside.status).toBe(403);
    expect(notImage.status).toBe(400);
  });

  it('refuses a non-image extension BEFORE resolving it, so it can never serve a keystore', async () => {
    // `user.keystore.storeFile` is a real path field pointing at a signing key inside the project.
    // "Every path field previews" must not become "every path field is readable over HTTP".
    fs.writeFileSync(path.join(projectRoot, 'upload.jks'), 'secret-key-bytes');
    const ctx = makeCtx();
    const res = (await get('/api/source-image', { path: 'upload.jks' }, ctx)) as { status?: number; body: { error?: string } };

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not an image/);
  });
});

/** The two image-extension lists must agree. They cannot import one another — one is a Node-side
 *  content-type table in the backend router, the other a regex in an editor module that must not
 *  pull the router into the renderer bundle — so this reads both from SOURCE and diffs them.
 *
 *  Neither direction of drift errors. Adding `.heic` to the RENDERER alone puts a permanent "not
 *  an image path" under a perfectly good icon; adding it to the BACKEND alone does nothing at all,
 *  visibly. A guard is cheap; noticing either by hand is not. */
describe('the image-extension allowlists', () => {
  const read = (rel: string) => readScannedSource(path.join(__dirname, '../..', rel)).code;

  it('the backend content-type table and the renderer regex cover the same extensions', () => {
    const routerSrc = read('plugins/backend/editorBackendRouter.ts');
    const table = routerSrc.match(/const IMAGE_CONTENT_TYPES[^=]*=\s*\{([^}]*)\}/)?.[1];
    expect(table, 'IMAGE_CONTENT_TYPES not found — repoint this guard').toBeTruthy();
    const backend = new Set([...table!.matchAll(/'\.([a-z0-9]+)'\s*:/g)].map((m) => m[1]));

    const rendererSrc = read('packages/modoki/src/editor/panels/projectSettingsPaths.ts');
    const re = rendererSrc.match(/const IMAGE_EXT_RE = \/\\\.\(([^)]*)\)/)?.[1];
    expect(re, 'IMAGE_EXT_RE not found — repoint this guard').toBeTruthy();
    // `jpe?g` in the alternation stands for both spellings; expand it the way the regex does.
    const renderer = new Set(re!.split('|').flatMap((a) => (a === 'jpe?g' ? ['jpe', 'jpeg', 'jpg'] : [a])));
    renderer.delete('jpe');

    // An absolute floor as well as the diff: a regex change that empties one side would otherwise
    // make two empty sets "agree".
    expect(backend.size).toBeGreaterThanOrEqual(6);
    expect([...backend].sort()).toEqual([...renderer].sort());
  });
});
