// @vitest-environment node
/** #1991: Open Project's write fence over a REAL backend server and a stand-in for the child Vite it proxies to.
 *  - The fence runs ahead of the build proxy, which used to forward the build family before the gate (in `hostRoutes`)
 *    was ever asked.
 *  - The proxy stamps the root the backend serves, so Vite can refuse a job meant for another project.
 *  - A request whose project is switched away under it answers the switch's 503 instead of acting on the other one. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startBackendServer, type BackendServerHandle, type HostRoutes } from '../../electron/backendServer';
import { bindToArrival } from '../../electron/requestContext';
import { createSwitchGate } from '../../electron/projectSwitch';
import { PROJECT_ROOT_HEADER } from '../../plugins/backend/projectStamp';
import type { BackendContext } from '../../plugins/backend/editorBackendRouter';

/** The child Vite: records what reaches it, and answers a build-family request with a short SSE stream. */
let vite: http.Server;
let viteOrigin: string;
let seen: { method?: string; url?: string; stamp?: string }[] = [];
let handle: BackendServerHandle;
const gate = createSwitchGate();
const state = { root: '/projects/A', backend: { name: 'A' } };

beforeAll(async () => {
  vite = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, stamp: req.headers[PROJECT_ROOT_HEADER] as string | undefined });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: "step one"\n\n');
      // The final status comes after a pause: a proxy that tore the stream down early (on the request's own `close`,
      // which fires once its body is read) never delivers it.
      setTimeout(() => { res.write('event: status\ndata: "DONE"\n\n'); res.end(); }, 30);
    });
  });
  await new Promise<void>((r) => vite.listen(0, '127.0.0.1', () => r()));
  viteOrigin = `http://127.0.0.1:${(vite.address() as AddressInfo).port}`;
  const live = {
    get projectRoot() { return state.root; },
    resolveAssetPath: () => { throw new Error('no asset here'); },
  } as unknown as BackendContext;
  const arrivedWith = () => { const b = state.backend; return bindToArrival(live, () => state.backend === b); };
  handle = await startBackendServer(arrivedWith, { viteOrigin, fence: (m, p) => gate.refusal(m, p) });
});
afterAll(async () => { await handle.close(); await new Promise((r) => vite.close(r)); });
beforeEach(() => { seen = []; gate.open(); state.root = '/projects/A'; state.backend = { name: 'A' }; });

const post = (path: string) => fetch(`http://127.0.0.1:${handle.port}${path}`, { method: 'POST' });

describe('the fence sits ahead of the build proxy (#1991)', () => {
  it('while a switch is in flight, POST /api/build is the 503 and NOTHING reaches Vite', async () => {
    gate.close('opening B');
    const res = await post('/api/build?platform=web');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ switching: true, reason: 'project-switching' });
    expect(seen).toEqual([]);
  });

  it('ACCEPT: with the gate open the POST reaches Vite as a POST, and the whole stream comes back', async () => {
    const res = await post('/api/build?platform=web');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('step one');
    expect(body).toContain('"DONE"');
    expect(seen).toEqual([{ method: 'POST', url: '/api/build?platform=web', stamp: encodeURIComponent('/projects/A') }]);
  });
});

describe('the proxy stamps the root this backend serves (#1991)', () => {
  it('a non-ASCII project path arrives intact (encoded: Node refuses a raw one in a header)', async () => {
    state.root = '/Users/me/プロジェクト/ünï game';
    const res = await post('/api/ota/publish?version=v1');
    expect(res.status).toBe(200);
    await res.text();
    expect(decodeURIComponent(seen[0].stamp ?? '')).toBe('/Users/me/プロジェクト/ünï game');
  });

  it('the stamp is the root at the request\'s ARRIVAL, read per request (Open Project rebinds the running server)', async () => {
    await (await post('/api/build?platform=web')).text();
    state.root = '/projects/B';
    state.backend = { name: 'B' };
    await (await post('/api/build?platform=web')).text();
    expect(seen.map((s) => decodeURIComponent(s.stamp ?? ''))).toEqual(['/projects/A', '/projects/B']);
  });
});

describe('a request whose project was switched away under it (#1991)', () => {
  it('answers the switch\'s 503, not a 500 and not the other project', async () => {
    // A stand-in for "the backend was replaced while this ran": bound to a backend that is already gone.
    const gone = await startBackendServer(() => bindToArrival(
      { projectRoot: '/projects/A', resolveAssetPath: () => '/projects/B/assets/x.png' } as unknown as BackendContext,
      () => false,
    ));
    try {
      const res = await fetch(`http://127.0.0.1:${gone.port}/assets/x.png`);
      expect(res.status).toBe(503);
      const body = await res.json() as { switching?: boolean; error?: string };
      expect(body.switching).toBe(true);
      expect(body.error).toContain('/projects/A');
    } finally { await gone.close(); }
  });
});

describe('#1991 review: the two holes the first cut left', () => {
  it('a write whose HEAD arrived before the switch and whose BODY finished after it is still refused, and no route runs', async () => {
    const lateGate = createSwitchGate();
    const ran: string[] = [];
    const hostRoutes: HostRoutes = async ({ urlPath }) => { ran.push(urlPath); return { kind: 'json', body: { ok: true } }; };
    const srv = await startBackendServer({ projectRoot: '/projects/A' } as unknown as BackendContext, { hostRoutes, fence: (m, p) => lateGate.refusal(m, p) });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/write-file', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.write('{"path":"/assets/a.json",');                  // the head, and half the body: the arrival check passes
        setTimeout(() => { lateGate.close('opening B'); req.end('"content":"{}"}'); }, 30); // the switch begins mid-body
      });
      expect(status).toBe(503);
      expect(ran).toEqual([]);
    } finally { await srv.close(); }
  });

  it('a re-root that stops a route whose own catch-all answers 500 is still the switch\'s 503 (the issue\'s reimport)', async () => {
    const srv = await startBackendServer(() => bindToArrival(
      { projectRoot: '/projects/A', getManifest: () => ({ version: 2, assets: [] }) } as unknown as BackendContext,
      () => false, // the backend this request arrived with is already gone
    ));
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/reimport`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/assets/folder', recursive: true }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ switching: true, reason: 'project-switching' });
    } finally { await srv.close(); }
  });

  it('ACCEPT: a route that CAUGHT the stop and finished keeps its own honest answer (an import whose rebuild was skipped)', async () => {
    const ctxs: BackendContext[] = [];
    const hostRoutes: HostRoutes = async ({ urlPath }) => {
      const ctx = ctxs[ctxs.length - 1];
      let manifestRebuilt = true;
      try { ctx.rebuildManifest(); } catch { manifestRebuilt = false; } // rebuildManifestInline's shape
      if (urlPath === '/api/then-throws') throw new Error('something else on the way out');
      return { kind: 'json', body: { ok: true, imported: true, manifestRebuilt } };
    };
    const srv = await startBackendServer(() => {
      const ctx = bindToArrival({ projectRoot: '/projects/A', rebuildManifest: () => ({}) } as unknown as BackendContext, () => false);
      ctxs.push(ctx);
      return ctx;
    }, { hostRoutes });
    try {
      const ok = await fetch(`http://127.0.0.1:${srv.port}/api/import-file`, { method: 'POST' });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, imported: true, manifestRebuilt: false });
      // …but one that caught it and then failed some other way is still the switch, not a bare 500.
      const failed = await fetch(`http://127.0.0.1:${srv.port}/api/then-throws`, { method: 'POST' });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ switching: true });
    } finally { await srv.close(); }
  });
});
