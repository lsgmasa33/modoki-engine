/** `POST /api/toolchain/settings` and `POST /api/toolchain/uninstall` through the real router (#1985).
 *  `toolchainResolve.test.ts` drives `writeToolchainSettings` / `uninstall` / `uninstallAll` directly, so the routes'
 *  own decisions — which tool the body names, the `id: 'all'` branch, the dev-editor refusal — had no test. Each case
 *  runs against a scratch `MODOKI_TOOLCHAIN_DIR` and asserts on the tree, not only the reply. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let scratch: string;
let tc: string;
const savedDir = process.env.MODOKI_TOOLCHAIN_DIR;

const post = async (urlPath: string, body: unknown) => {
  const r = await handleBackendRequest({ projectRoot: scratch } as unknown as BackendContext, { method: 'POST', urlPath, query: new URLSearchParams(), body });
  if (!r || r.kind !== 'json') throw new Error(`${urlPath}: no json reply`);
  return { status: r.status ?? 200, body: r.body as Record<string, unknown> };
};
const settingsFile = () => path.join(tc, 'settings.json');

beforeEach(() => {
  scratch = makeScratchDir('modoki-toolchain-routes-');
  tc = path.join(scratch, 'toolchain');
  fs.mkdirSync(tc);
  process.env.MODOKI_TOOLCHAIN_DIR = tc;
});
afterEach(() => {
  if (savedDir === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR; else process.env.MODOKI_TOOLCHAIN_DIR = savedDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('POST /api/toolchain/settings (#1985)', () => {
  it('persists the toggle to the toolchain dir\'s settings.json, keeping the fields it does not name', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ allowSystemToolchain: false, wdaTeamId: 'TEAM1985' }));
    const on = await post('/api/toolchain/settings', { allowSystemToolchain: true });
    expect(on.body).toEqual({ ok: true, settings: { allowSystemToolchain: true, wdaTeamId: 'TEAM1985' } });
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))).toEqual({ allowSystemToolchain: true, wdaTeamId: 'TEAM1985' });
    const off = await post('/api/toolchain/settings', { allowSystemToolchain: false });
    expect(off.body).toMatchObject({ ok: true, settings: { allowSystemToolchain: false } });
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).allowSystemToolchain).toBe(false);
  });

  // #1962: the route read the field by truthiness, so `{}` wrote OFF and the STRING "false" wrote ON.
  it('is a PARTIAL patch: an omitted field leaves the stored value alone', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ allowSystemToolchain: true }));
    const r = await post('/api/toolchain/settings', {});
    expect(r.body).toMatchObject({ ok: true, settings: { allowSystemToolchain: true } });
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).allowSystemToolchain).toBe(true);
  });

  it('refuses a non-boolean (the string "false" used to turn it ON) and writes nothing', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ allowSystemToolchain: false }));
    const r = await post('/api/toolchain/settings', { allowSystemToolchain: 'false' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).allowSystemToolchain).toBe(false);
  });

  it('a dev editor (no toolchain dir) is a 400, as /uninstall answers it — not a thrown 500', async () => {
    delete process.env.MODOKI_TOOLCHAIN_DIR;
    const r = await post('/api/toolchain/settings', { allowSystemToolchain: true });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/no toolchain directory/);
  });
});

describe('POST /api/toolchain/uninstall (#1985)', () => {
  it('removes the ONE tool the body names, and leaves the others', async () => {
    fs.mkdirSync(path.join(tc, 'jdk', '21.0.11+10'), { recursive: true });
    fs.mkdirSync(path.join(tc, 'node'), { recursive: true });
    const r = await post('/api/toolchain/uninstall', { id: 'java' });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(fs.existsSync(path.join(tc, 'jdk'))).toBe(false);
    expect(fs.existsSync(path.join(tc, 'node'))).toBe(true);
  });

  it('id "all" removes the whole toolchain folder, settings included', async () => {
    fs.mkdirSync(path.join(tc, 'node'), { recursive: true });
    fs.writeFileSync(settingsFile(), '{}');
    const r = await post('/api/toolchain/uninstall', { id: 'all' });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(fs.existsSync(tc)).toBe(false);
  });

  it('no id is 400, and nothing is removed', async () => {
    fs.mkdirSync(path.join(tc, 'node'), { recursive: true });
    const r = await post('/api/toolchain/uninstall', {});
    expect(r.status).toBe(400);
    expect(fs.existsSync(path.join(tc, 'node'))).toBe(true);
  });

  it('a dev editor (no MODOKI_TOOLCHAIN_DIR) is 400 — there is nothing of its own to uninstall', async () => {
    delete process.env.MODOKI_TOOLCHAIN_DIR;
    fs.mkdirSync(path.join(tc, 'node'), { recursive: true });
    const r = await post('/api/toolchain/uninstall', { id: 'all' });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/no toolchain directory/);
    expect(fs.existsSync(path.join(tc, 'node'))).toBe(true);
  });
});
