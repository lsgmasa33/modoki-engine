// @vitest-environment node
import http from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startBackendServer, type BackendServerHandle, type HostRoutes } from '../../electron/backendServer';
import type { BackendContext } from '../../plugins/backend/editorBackendRouter';

/**
 * #1648 S3 — the cross-origin gate over a REAL HTTP server. The rule is unit-tested in requestOrigin.test.ts; this pins
 * the WIRING: that the gate runs before every route (the SSE build proxy too), that a refused request never reaches
 * its handler, and that the editor's own renderer (the Vite page) and Origin-less callers still get through.
 */
const VITE_ORIGIN = 'http://127.0.0.1:5999';
let handle: BackendServerHandle;
let served: string[] = [];

const hostRoutes: HostRoutes = async ({ urlPath }) => {
  served.push(urlPath);
  return urlPath === '/api/ping' ? { kind: 'json', body: { pong: true } } : null;
};

/** Node `http`, not `fetch`: it sends exactly the headers given, so "no Origin" really is no Origin. */
function send(path: string, opts: { method?: string; origin?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const method = opts.method ?? 'POST';
    // `agent: false`: a fresh socket per request. A 403 answered before its body is read must not poison a pooled
    // keep-alive socket for the next case (ECONNRESET there, not a gate failure).
    const req = http.request({
      host: '127.0.0.1', port: handle.port, path, method, agent: false,
      headers: { 'Content-Type': 'text/plain', ...(opts.origin ? { Origin: opts.origin } : {}), ...(opts.headers ?? {}) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

beforeAll(async () => {
  handle = await startBackendServer({ projectRoot: '/nonexistent' } as unknown as BackendContext, { hostRoutes, viteOrigin: VITE_ORIGIN });
});
afterAll(async () => { await handle.close(); });

describe('the backend refuses a foreign Origin before any route runs', () => {
  it('a POST from a public page is 403, and the handler never runs', async () => {
    served = [];
    const r = await send('/api/ping', { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toMatch(/evil\.example/);
    expect(served).toEqual([]);
  });

  it('DNS rebinding — a foreign NAME on our own port — is 403', async () => {
    const r = await send('/api/ping', { origin: `http://evil.example:${handle.port}` });
    expect(r.status).toBe(403);
  });

  it('the SSE build proxy is behind the gate too (403, not its own 503 for a missing Vite)', async () => {
    const r = await send('/api/build?platform=web', { method: 'GET', origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });

  it('ACCEPT: the editor renderer (the Vite page origin) is served', async () => {
    const r = await send('/api/ping', { origin: VITE_ORIGIN });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ pong: true });
  });

  it('ACCEPT: a loopback page on the backend\'s own port (a renderer it serves itself) is served', async () => {
    const r = await send('/api/ping', { origin: `http://localhost:${handle.port}` });
    expect(r.status).toBe(200);
  });

  it('ACCEPT: no Origin at all (curl, the MCP server) is served, as before', async () => {
    const r = await send('/api/ping');
    expect(r.status).toBe(200);
  });
});

/** The two halves of "own" that the loopback-port rule alone does not cover. */
describe('the backend\'s own origins are derived from the Vite page it was started for', () => {
  it('ACCEPT: the Vite page under its other loopback spelling (localhost vs 127.0.0.1) is served', async () => {
    const r = await send('/api/ping', { origin: 'http://localhost:5999' });
    expect(r.status).toBe(200);
  });

  it('ACCEPT: a NON-loopback Vite page (MODOKI_DEV_URL on a LAN address) is served by exact origin', async () => {
    const lan = await startBackendServer({ projectRoot: '/nonexistent' } as unknown as BackendContext, { hostRoutes, viteOrigin: 'http://192.168.1.20:5999' });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: lan.port, path: '/api/ping', method: 'POST', agent: false,
          headers: { 'Content-Type': 'text/plain', Origin: 'http://192.168.1.20:5999' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
        req.on('error', reject);
        req.end('{}');
      });
      expect(status).toBe(200);
    } finally { await lan.close(); }
  });
});

/** #1955 close-out review: two vectors the Origin check alone does not see. */
describe('the backend refuses a cross-site GET with no Origin, and a rebinding Host', () => {
  it('a cross-site no-Origin GET (an <img src>) to the SSE build proxy is 403, and the handler never runs', async () => {
    served = [];
    const r = await send('/api/build?platform=web', { method: 'GET', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(r.status).toBe(403);
    const r2 = await send('/api/ping', { method: 'GET', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(r2.status).toBe(403);
    expect(served).toEqual([]);
  });

  it.each(['same-site', 'same-origin', 'none'])('ACCEPT: a no-Origin GET marked %s is served (the editor\'s own <img>, a typed URL)', async (v) => {
    const r = await send('/api/ping', { method: 'GET', headers: { 'Sec-Fetch-Site': v } });
    expect(r.status).toBe(200);
  });

  it('ACCEPT: the own Vite page origin passes even when marked cross-site', async () => {
    const r = await send('/api/ping', { origin: VITE_ORIGIN, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(r.status).toBe(200);
  });

  it('DNS rebinding with NO Origin — a same-origin GET from a rebound page — is refused by its Host', async () => {
    served = [];
    const r = await send('/api/ping', { method: 'GET', headers: { Host: `evil.example:${handle.port}` } });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toMatch(/evil\.example/);
    expect(served).toEqual([]);
  });

  it.each(['localhost', 'LOCALHOST', '[::1]'])('ACCEPT: a loopback Host spelled %s is served', async (h) => {
    const r = await send('/api/ping', { method: 'GET', headers: { Host: `${h}:${handle.port}` } });
    expect(r.status).toBe(200);
  });
});
