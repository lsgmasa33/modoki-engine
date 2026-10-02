// @vitest-environment node
/**
 * #1648 S3 — the cross-origin gate in the REAL Vite middleware `configureServer` registers (the browser-dev host; the
 * Electron backend's twin is electron/foreignOriginGate.test.ts). A refused request answers 403; one that passes reaches
 * the router, which 404s an unknown /api route as JSON. So 404 here means "the gate let it through".
 */
import { describe, it, expect, afterEach, vi, beforeAll, afterAll } from 'vitest';
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
async function drive(url: string, origin?: string, method = 'POST', extra: Record<string, string> = {}): Promise<{ status: number; next: boolean; headers: Record<string, string>; body: string }> {
  const req = Object.assign(new EventEmitter(), {
    url, method, headers: { ...(origin ? { origin } : {}), ...extra }, socket: { localPort: VITE_PORT },
  });
  const res = new FakeRes();
  let nextCalled = false;
  const done = new Promise<void>((resolve) => { res.on('finish', () => resolve()); });
  middleware(req, res, () => { nextCalled = true; res.end(); });
  setImmediate(() => { req.emit('data', Buffer.from('{}')); req.emit('end'); });
  await done;
  return { status: res.statusCode, next: nextCalled, headers: res.headers, body: res.body };
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

/** #1967: a GET never changes state. These routes STOP the server or START a job, and a GET is assumed safe by everything
 *  from a link prefetcher to an `<img src>` — and an EventSource reconnect re-sends it. Here with NO Origin and no
 *  Sec-Fetch-Site (curl's shape, and a LAN-bound page's, which carries neither), so the cross-site gate above passes it
 *  and only the method rule stands between the request and the job. */
describe('#1967: the routes that stop the server or start a job take POST only', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it('GET /api/exit is 405 and the server is NOT stopped; the POST stops it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const got = await drive('/api/exit', undefined, 'GET');
      expect(got.status).toBe(405);
      expect(got.headers.allow).toBe('POST');
      vi.advanceTimersByTime(1_000);
      expect(exit).not.toHaveBeenCalled();
      expect((await drive('/api/exit', undefined, 'POST')).status).toBe(200);
      vi.advanceTimersByTime(1_000);
      expect(exit).toHaveBeenCalledWith(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['/api/build?platform=web', '/api/add-native-target?platform=ios', '/api/toolchain/install?id=toktx', '/api/ota/publish?version=v1'])(
    'GET %s is 405 before any job starts, not a fall-through to the SPA', async (url) => {
      const got = await drive(url, undefined, 'GET');
      expect(got.status).toBe(405);
      expect(got.next).toBe(false);
      expect(got.headers['content-type']).toBe('application/json');
    },
  );

  it('ACCEPT: the POST reaches the route itself (its own in-stream refusal of a bad platform, not a 405)', async () => {
    const got = await drive('/api/build?platform=nonsense', undefined, 'POST');
    expect(got.status).not.toBe(405);
    expect(got.headers['content-type']).toBe('text/event-stream');
    expect(got.body).toContain('FAILED:Invalid build request');
  });
});

/** #1991: under the Electron editor (`MODOKI_VITE_UNDER_ELECTRON`), this server takes a state-changing request only from
 *  the editor's backend, stamped with the root it serves, and only when that root is this server's. That covers the
 *  window in which Open Project has moved Vite to the new project while the backend still serves the old one, and the
 *  shared router mounted here, which has no switch gate. Reads pass; a standalone `npm run dev` is left alone. */
describe('#1991: under Electron, a write needs the backend\'s stamp for THIS server\'s project', () => {
  const stamp = (root: string) => ({ 'x-modoki-project-root': encodeURIComponent(root) });
  const underElectron = async <T>(fn: () => Promise<T>) => {
    const before = process.env.MODOKI_VITE_UNDER_ELECTRON;
    process.env.MODOKI_VITE_UNDER_ELECTRON = '1';
    try { return await fn(); } finally { if (before === undefined) delete process.env.MODOKI_VITE_UNDER_ELECTRON; else process.env.MODOKI_VITE_UNDER_ELECTRON = before; }
  };

  it('a POST stamped for ANOTHER project (Vite already moved by the open) is 409, and the route never runs', async () => {
    const got = await underElectron(() => drive('/api/build?platform=web', undefined, 'POST', stamp('/elsewhere/project-A')));
    expect(got.status).toBe(409);
    expect(got.body).toContain('switching project');
  });

  it('an UNSTAMPED write (an agent or curl on the Vite port) is 409 — the router mounted here is fenced too', async () => {
    const got = await underElectron(() => drive('/api/write-file', undefined, 'POST'));
    expect(got.status).toBe(409);
    expect(got.body).toContain('backend');
  });

  it('an unstamped POST /api/exit is refused before it stops anything', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      expect((await underElectron(() => drive('/api/exit', undefined, 'POST'))).status).toBe(409);
      await new Promise((r) => setTimeout(r, 150));
      expect(exit).not.toHaveBeenCalled();
    } finally { exit.mockRestore(); }
  });

  it('ACCEPT: a write stamped with THIS server\'s root reaches the router', async () => {
    expect((await underElectron(() => drive('/api/no-such-route', undefined, 'POST', stamp(projectRoot)))).status).toBe(404);
  });

  it('ACCEPT: the same root spelled differently (a trailing separator) is the same project — compared as paths, not strings', async () => {
    expect((await underElectron(() => drive('/api/no-such-route', undefined, 'POST', stamp(`${projectRoot}/`)))).status).toBe(404);
  });

  it('ACCEPT: a read needs no stamp', async () => {
    expect((await underElectron(() => drive('/api/no-such-route', undefined, 'GET'))).status).toBe(404);
  });

  it('ACCEPT: a standalone dev server (no marker) takes an unstamped write, as before', async () => {
    expect((await drive('/api/no-such-route', undefined, 'POST')).status).toBe(404);
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
