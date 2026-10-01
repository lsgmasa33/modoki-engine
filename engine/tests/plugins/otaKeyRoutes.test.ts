/** #1983: the editor's OTA key routes answer about the PROJECT's key, through the real router.
 *  `/api/ota/keys` copies a key an earlier editor left under the editor root (the packaged bundle, in
 *  production) into the project on its first read, leaving the original; `/api/ota/keygen` writes into
 *  the project, and refuses to mint where it can copy. The editor root here is a scratch stand-in for
 *  the bundle; the keygen route runs the real script from this checkout. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LEGACY = { publicKey: 'legacy-pub', privateKey: 'legacy-priv' };

let scratch: string;
let projectRoot: string;
let bundle: string;
const keyAt = (root: string, name = 'default') => path.join(root, 'build', 'ota-keys', `${name}.json`);
const plant = (root: string, name = 'default') => {
  fs.mkdirSync(path.dirname(keyAt(root, name)), { recursive: true });
  fs.writeFileSync(keyAt(root, name), JSON.stringify(LEGACY, null, 2) + '\n', { mode: 0o600 });
  return fs.readFileSync(keyAt(root, name));
};
const bake = (publicKey: string) => fs.writeFileSync(path.join(projectRoot, 'project.config.json'), JSON.stringify({ ota: { enabled: true, publicKey } }));
const ctxWith = (editorRoot: string) => ({ projectRoot, editorRoot } as unknown as BackendContext);
const call = async (ctx: BackendContext, method: string, urlPath: string, name: string) => {
  const r = await handleBackendRequest(ctx, { method, urlPath, query: new URLSearchParams({ name }), body: undefined });
  if (!r || r.kind !== 'json') throw new Error(`${urlPath}: no json reply`);
  return { status: r.status ?? 200, body: r.body as Record<string, unknown> };
};

beforeEach(() => {
  scratch = makeScratchDir('modoki-ota-key-routes-');
  projectRoot = path.join(scratch, 'project');
  bundle = path.join(scratch, 'Modoki.app', 'Contents', 'Resources', 'app.asar.unpacked');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(bundle, { recursive: true });
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

describe('GET /api/ota/keys (#1983)', () => {
  it('copies the bundle\'s key into the project on first read, and the original stays', async () => {
    const original = plant(bundle);
    bake(LEGACY.publicKey);
    const r = await call(ctxWith(bundle), 'GET', '/api/ota/keys', 'default');
    expect(r.body).toMatchObject({ ok: true, exists: true, publicKey: LEGACY.publicKey, copiedFrom: keyAt(bundle) });
    expect(fs.readFileSync(keyAt(projectRoot)).equals(original)).toBe(true);
    expect(fs.readFileSync(keyAt(bundle)).equals(original)).toBe(true);
    // A second read finds the project's own copy and copies nothing.
    const again = await call(ctxWith(bundle), 'GET', '/api/ota/keys', 'default');
    expect(again.body).toMatchObject({ ok: true, exists: true });
    expect(again.body.copiedFrom).toBeUndefined();
  });

  it('the PACKAGED editor opening a game inside a clone finds the key the dev editor left at the clone\'s root', async () => {
    // Not the editor root (that is the bundle, with no key): an ancestor of the project.
    const clone = path.join(scratch, 'clone');
    projectRoot = path.join(clone, 'games', 'p');
    fs.mkdirSync(projectRoot, { recursive: true });
    const original = plant(clone);
    bake(LEGACY.publicKey);
    const r = await call(ctxWith(bundle), 'GET', '/api/ota/keys', 'default');
    expect(r.body).toMatchObject({ ok: true, exists: true, copiedFrom: keyAt(clone) });
    expect(fs.readFileSync(keyAt(projectRoot)).equals(original)).toBe(true);
    expect(fs.readFileSync(keyAt(clone)).equals(original)).toBe(true);
  });

  it('answers about the project\'s key, never the editor root\'s, once the project has one', async () => {
    plant(bundle);
    fs.mkdirSync(path.dirname(keyAt(projectRoot)), { recursive: true });
    fs.writeFileSync(keyAt(projectRoot), JSON.stringify({ publicKey: 'project-own', privateKey: 'x' }));
    const r = await call(ctxWith(bundle), 'GET', '/api/ota/keys', 'default');
    expect(r.body).toMatchObject({ exists: true, publicKey: 'project-own' });
  });

  it('an UNREADABLE project.config.json with an earlier key present is refused, not passed over', async () => {
    const original = plant(bundle);
    fs.writeFileSync(path.join(projectRoot, 'project.config.json'), '<<<<<<< HEAD\n');
    const r = await call(ctxWith(bundle), 'GET', '/api/ota/keys', 'default');
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/could not be read, so whether this project shipped with .* is unknown/);
    expect(fs.existsSync(keyAt(projectRoot))).toBe(false);
    expect(fs.readFileSync(keyAt(bundle)).equals(original)).toBe(true);
  });

  it('with no key anywhere, answers "none" and writes nothing', async () => {
    const r = await call(ctxWith(bundle), 'GET', '/api/ota/keys', 'default');
    expect(r.body).toMatchObject({ ok: true, exists: false, publicKey: null });
    expect(fs.existsSync(path.join(projectRoot, 'build'))).toBe(false);
  });
});

describe('POST /api/ota/keygen (#1983)', () => {
  it('writes the new key into the PROJECT', async () => {
    const r = await call(ctxWith(CHECKOUT), 'POST', '/api/ota/keygen', 'route-test');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const written = JSON.parse(fs.readFileSync(keyAt(projectRoot, 'route-test'), 'utf8')) as { publicKey: string };
    expect(r.body.publicKey).toBe(written.publicKey);
  });

  it('refuses to mint over a key it can copy from the editor root, and copies it instead', async () => {
    // The editor root here must hold the script AND the legacy key, so the legacy key goes into a
    // scratch "checkout" that symlinks the real engine/ in.
    const checkout = path.join(scratch, 'checkout');
    fs.mkdirSync(checkout);
    fs.symlinkSync(path.join(CHECKOUT, 'engine'), path.join(checkout, 'engine'), 'junction');
    const original = plant(checkout);
    bake(LEGACY.publicKey);
    const r = await call(ctxWith(checkout), 'POST', '/api/ota/keygen', 'default');
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/copied from .*Not minting a new one/);
    expect(fs.readFileSync(keyAt(projectRoot)).equals(original)).toBe(true);
    expect(fs.readFileSync(keyAt(checkout)).equals(original)).toBe(true);
  });
});
