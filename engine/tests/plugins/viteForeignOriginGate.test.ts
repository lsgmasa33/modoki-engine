// @vitest-environment node
/**
 * #1648 S3 — the cross-origin gate in the REAL Vite middleware `configureServer` registers (the browser-dev host; the
 * Electron backend's twin is electron/foreignOriginGate.test.ts). A refused request answers 403; one that passes reaches
 * the router, which 404s an unknown /api route as JSON. So 404 here means "the gate let it through".
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, resolveConfig, type ViteDevServer } from 'vite';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { assetScannerPlugin } from '../../plugins/vite-asset-scanner';

type Middleware = (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
class FakeRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  writableEnded = false;
  headersSent = false;
  setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  getHeader(k: string) { return this.headers[k.toLowerCase()]; }
  write(c: string) { this.headersSent = true; this.body += c; return true; }
  end(c?: string) { if (c) this.body += c; this.writableEnded = true; this.headersSent = true; this.emit('finish'); return this; }
}

const VITE_PORT = 5174;
let middleware: Middleware;
let projectRoot: string;
const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string) => { if (!(k in saved)) saved[k] = process.env[k]; process.env[k] = v; };

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  projectRoot = fs.realpathSync(makeScratchDir('modoki-vite-origin-'));
  fs.writeFileSync(path.join(projectRoot, 'game.ts'), 'export const game = {};');
  fs.writeFileSync(path.join(projectRoot, 'project.config.json'), JSON.stringify({ app: { appId: 'com.example.fixture', appName: 'Fixture' } }));
  setEnv('MODOKI_PROJECT', projectRoot);
  setEnv('MODOKI_HOME', makeScratchDir('modoki-vite-origin-home-'));
  const p = assetScannerPlugin() as unknown as { configResolved: (c: { root: string }) => void; configureServer: (s: unknown) => void };
  p.configResolved({ root: path.join(projectRoot, 'engine') });
  let captured: Middleware | undefined;
  p.configureServer({
    ws: { send: () => {}, on: () => {} },
    config: { server: { watch: null } },
    middlewares: { use: (fn: Middleware) => { captured ??= fn; } },
    httpServer: null,
    resolvedUrls: { local: [`http://localhost:${VITE_PORT}/`], network: ['http://192.168.1.20:5174/'] },
  });
  if (!captured) throw new Error('fixture: configureServer registered no middleware');
  middleware = captured;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

/** Drive one request through the middleware and wait for the response to end. */
async function drive(url: string, origin?: string, method = 'POST', extra: Record<string, string> = {}): Promise<{ status: number; next: boolean }> {
  const req = Object.assign(new EventEmitter(), {
    url, method, headers: { ...(origin ? { origin } : {}), ...extra }, socket: { localPort: VITE_PORT },
  });
  const res = new FakeRes();
  let nextCalled = false;
  const done = new Promise<void>((resolve) => { res.on('finish', () => resolve()); });
  middleware(req, res, () => { nextCalled = true; res.end(); });
  setImmediate(() => { req.emit('data', Buffer.from('{}')); req.emit('end'); });
  await done;
  return { status: res.statusCode, next: nextCalled };
}

describe('the Vite middleware refuses a foreign Origin ahead of every /api route', () => {
  it('a POST from a public page is 403', async () => {
    expect((await drive('/api/no-such-route', 'https://evil.example')).status).toBe(403);
  });

  // A rebound page's POST names the foreign host in its Origin, so the Origin check refuses it. Its same-origin GET
  // carries NO Origin: that one is stopped by Vite's own host check, pinned below — not by this gate (#1982).
  it('a rebound page\'s POST — Origin a foreign NAME on our own port — is 403', async () => {
    expect((await drive('/api/no-such-route', `http://evil.example:${VITE_PORT}`)).status).toBe(403);
  });

  it('/api/exit is behind the gate for a request that CARRIES a foreign Origin', async () => {
    expect((await drive('/api/exit', 'https://evil.example')).status).toBe(403);
  });

  it('ACCEPT: a loopback page on the port the request arrived on reaches the router', async () => {
    expect((await drive('/api/no-such-route', `http://127.0.0.1:${VITE_PORT}`)).status).toBe(404);
  });

  it('ACCEPT: a LAN URL Vite reports serving reaches the router', async () => {
    expect((await drive('/api/no-such-route', 'http://192.168.1.20:5174')).status).toBe(404);
  });

  it('ACCEPT: no Origin at all (curl, MCP) reaches the router', async () => {
    expect((await drive('/api/no-such-route')).status).toBe(404);
  });
});

/** #1955 close-out review: a no-cors GET carries no Origin, so the Origin check alone let `<img src=".../api/exit">`
 *  stop the dev server. With no Origin, `Sec-Fetch-Site: cross-site` is refused. (Host is Vite's own check.) */
describe('the Vite middleware refuses a cross-site GET with no Origin', () => {
  it('GET /api/exit marked cross-site with no Origin (an <img src>) is 403 — the dev server is not stopped', async () => {
    expect((await drive('/api/exit', undefined, 'GET', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it.each(['same-origin', 'same-site', 'none'])('ACCEPT: a no-Origin GET marked %s reaches the router', async (v) => {
    expect((await drive('/api/no-such-route', undefined, 'GET', { 'sec-fetch-site': v })).status).toBe(404);
  });

  it('ACCEPT: an own Origin reaches the router even when marked cross-site', async () => {
    expect((await drive('/api/no-such-route', `http://127.0.0.1:${VITE_PORT}`, 'GET', { 'sec-fetch-site': 'cross-site' })).status).toBe(404);
  });
});

/** #1982: a DNS-rebound page's same-origin GET sends NO Origin, so the gate above cannot see it. On the Vite host the
 *  only defence is Vite's own Host check (`server.allowedHosts`), which the middleware fixture above does not include.
 *  So this resolves the REAL `engine/vite.config.ts` — the file the editor's dev server is launched with
 *  (`electron/devServer.ts`, `--config engine/vite.config.ts`) — and serves a real Vite server with its `allowedHosts`.
 *  `allowedHosts: true` in that config turns this red. Vite installs the Host check only WITHOUT `server.https` too, so a
 *  config (or a plugin's `config` hook) turning https on also drops it: that is asserted on the resolved config.
 *  ⚠️ Resolving the real config runs the asset scanner's `configResolved`, which scans and HEALS (writes sidecars) under
 *  `MODOKI_PROJECT`, else the repo root. It is safe here only because the file-level `beforeAll` above points
 *  `MODOKI_PROJECT` at a scratch project first — keep this block in this file, after that hook. */
describe('Vite\'s own Host check refuses a rebound GET that carries no Origin', () => {
  let vite: ViteDevServer;
  let port: number;
  let realHttps: unknown;
  const get = (host: string): Promise<number> => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/exit', method: 'GET', agent: false, headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });

  beforeAll(async () => {
    const real = await resolveConfig({ configFile: path.resolve(__dirname, '../../vite.config.ts'), logLevel: 'silent' }, 'serve');
    realHttps = real.server.https;
    vite = await createServer({
      configFile: false, root: projectRoot, logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, allowedHosts: real.server.allowedHosts, hmr: false, watch: null },
    });
    await vite.listen();
    port = (vite.httpServer!.address() as AddressInfo).port;
  }, 30_000);
  afterAll(async () => { await vite?.close(); });

  it('the editor\'s config leaves the Host check ON: no server.https (Vite drops the check under https)', () => {
    expect(realHttps).toBeFalsy();
  });

  it('a foreign Host with no Origin (a rebound page\'s same-origin GET) is 403', async () => {
    expect(await get(`evil.example:${port}`)).toBe(403);
  });

  it.each(['localhost', '127.0.0.1'])('ACCEPT: a loopback Host spelled %s is not refused by the Host check', async (h) => {
    expect(await get(`${h}:${port}`)).not.toBe(403);
  });
});
