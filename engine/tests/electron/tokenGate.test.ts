// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startBackendServer, type BackendServerHandle, type HostRoutes } from '../../electron/backendServer';
import type { BackendContext } from '../../plugins/backend/editorBackendRouter';

/**
 * C6 integration gate — the token check over a REAL HTTP server
 * (docs/connect-claude-code.md, C6).
 *
 * The unit tests pin the policy; this pins the WIRING, which is where it would actually
 * fail: a header read with the wrong case, a route accidentally exempt, the gate placed
 * after the SSE proxy so the privileged build endpoint stays open. The bug this exists to
 * prevent is silent by construction — a mis-wired gate looks exactly like a working one
 * until another editor recycles your port.
 */
const PROJECT_ROOT = '/Users/me/moge';
const OURS = 'tok-ours';

let handle: BackendServerHandle;
let expectedToken: string | null = OURS;
let served: string[] = [];

const hostRoutes: HostRoutes = async ({ urlPath, tokenCheck }) => {
  served.push(urlPath);
  if (urlPath === '/api/identity') return { kind: 'json', body: { projectRoot: PROJECT_ROOT, tokenCheck } };
  if (urlPath === '/api/ping') return { kind: 'json', body: { pong: true, tokenCheck } };
  return null;
};

const ctx = { projectRoot: PROJECT_ROOT } as unknown as BackendContext;

const get = (path: string, token?: string) =>
  fetch(`http://127.0.0.1:${handle.port}${path}`, token ? { headers: { 'X-Modoki-Token': token } } : undefined);

beforeAll(async () => {
  handle = await startBackendServer(ctx, { hostRoutes, getExpectedToken: () => expectedToken });
});
afterAll(async () => { await handle.close(); });

describe('the token gate over real HTTP', () => {
  it('a matching token is served, and the route sees tokenCheck "ok"', async () => {
    const res = await get('/api/ping', OURS);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pong: true, tokenCheck: 'ok' });
  });

  it('NO token is served — curl / game-debug / pre-C6 configs keep working', async () => {
    const res = await get('/api/ping');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tokenCheck: 'absent' });
  });

  it('THE BUG: another editor’s token gets a 403 with an actionable message', async () => {
    served = [];
    const res = await get('/api/ping', 'tok-someone-else');
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/WRONG EDITOR/);
    expect(body.error).toMatch(/moge/);            // which project actually answered
    expect(body.error).toMatch(/Connect Claude Code/); // how to fix it
    // Rejected BEFORE the handler — a 403 that still ran the mutation would be theatre.
    expect(served).toEqual([]);
  });

  it('the header is matched case-INSENSITIVELY (HTTP headers are)', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/ping`, { headers: { 'x-MODOKI-token': OURS } });
    expect(res.status).toBe(200);
  });

  it('/api/identity is the ONE exempt route — it REPORTS the mismatch instead of hiding it', async () => {
    // 403ing the diagnostic would hide the explanation for every other 403.
    const res = await get('/api/identity', 'tok-someone-else');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tokenCheck: 'mismatch', projectRoot: PROJECT_ROOT });
  });

  it('a POST is gated too, not just GETs', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Modoki-Token': 'tok-someone-else' },
      body: JSON.stringify({ mutate: true }),
    });
    expect(res.status).toBe(403);
  });

  it('the privileged SSE build proxy is gated too (it is not an /api/* router route)', async () => {
    // /api/build is intercepted BEFORE the router — if the gate sat downstream of it, a
    // foreign config could still run builds. 403, not the 503 an ungated miss would give.
    const res = await get('/api/build', 'tok-someone-else');
    expect(res.status).toBe(403);
  });

  it('an editor with NO token still serves a tokened request’s... rejection', async () => {
    expectedToken = null;
    try {
      expect((await get('/api/ping', 'tok-anything')).status).toBe(403); // names another editor
      expect((await get('/api/ping')).status).toBe(200);                 // un-tokened still fine
    } finally {
      expectedToken = OURS;
    }
  });

  it('the expected token is read LIVE, so "Open Project" re-arms the gate', async () => {
    // Open Project rebinds the running server; a token captured by value at startBackendServer
    // would keep validating against the OLD project forever.
    expectedToken = 'tok-after-open-project';
    try {
      expect((await get('/api/ping', OURS)).status).toBe(403);
      expect((await get('/api/ping', 'tok-after-open-project')).status).toBe(200);
    } finally {
      expectedToken = OURS;
    }
  });

  it('an OPTIONS preflight is never gated (it carries no header value to judge)', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/ping`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });
});
