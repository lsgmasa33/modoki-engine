/**
 * Electron main HTTP backend (ELECTRON_PLAN Phase 2). A tiny localhost HTTP
 * server that wraps the transport-agnostic editorBackendRouter — the *same*
 * router the Vite middleware mounts. The renderer's editorBackend client is
 * pointed here via `window.__modokiBackendBase`, so daily Electron use exercises
 * the production backend path (parity), not Vite's.
 *
 * Only the JSON `/api/*` command routes are served by the shared router. Asset
 * *bytes* come from the Vite server (which main owns). `/api/build` is an SSE
 * stream owned by the Vite middleware (it runs `vite build` + gcloud/gradle), so
 * the backend PROXIES it to the Vite server rather than duplicating the pipeline —
 * the renderer's EventSource targets this backend (one base), and we pipe the
 * Vite server's event stream straight back.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { handleBackendRequest, type BackendContext, type BackendResult } from '../plugins/backend/editorBackendRouter';
import { serveProjectAsset, serveAppShell } from '../plugins/backend/staticAssets';
import { writeBackendResult } from '../plugins/backend/writeResult';
import { checkToken, tokenMismatchError, TOKEN_HEADER, type TokenCheck } from './instanceToken';

/** The one route exempt from the C6 token gate: identity is the DIAGNOSTIC — "which editor
 *  am I actually talking to?" is exactly the question a rejected client needs answered, so
 *  403ing it would hide the explanation for the 403. It reports `tokenCheck` instead. */
const TOKEN_EXEMPT = '/api/identity';

/** Cap on a request body (base64 asset writes are the largest legit payload).
 *  Guards the in-process backend against an unbounded-buffer OOM. */
const MAX_BODY_BYTES = 256 * 1024 * 1024; // 256 MB

export interface BackendServerHandle {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

/** A parsed backend request (same shape the shared router consumes), plus the C6 token
 *  verdict — computed ONCE per request here so no downstream route can invent a second,
 *  subtly different notion of "is this token valid". */
export interface HostRequest { method: string; urlPath: string; query: URLSearchParams; body: unknown; tokenCheck: TokenCheck }
/** Host-specific routes tried BEFORE the shared router — for renderer-bound ops
 *  (capture/input) that only the Electron main process can serve. Return null to
 *  fall through to the shared router. */
export type HostRoutes = (req: HostRequest) => Promise<BackendResult | null>;

export interface BackendServerOptions {
  hostRoutes?: HostRoutes;
  /** Packaged/prod only: serve the built renderer shell (index.html + assets/*)
   *  from this dist directory for non-`/api`, non-project-asset GETs, so the whole
   *  app loads from ONE origin (no Vite dev server). Omit in dev (Vite owns it). */
  appDistDir?: string;
  /** Fixed loopback port (e.g. for a stable MCP target via MODOKI_BACKEND_PORT).
   *  Default 0 = ephemeral. */
  port?: number;
  /** The main-owned Vite server origin (e.g. http://localhost:5173). The backend
   *  proxies the `/api/build` SSE stream there (the build pipeline lives in the
   *  Vite middleware). Omit ⇒ `/api/build` returns 503. */
  viteOrigin?: string;
  /** C6: this editor's token for the OPEN project, or null if it has none. A request
   *  presenting a DIFFERENT token is refused (see checkToken). Read through a getter, not
   *  captured by value — "Open Project" rebinds the running server, so the expected token
   *  changes under it. Omit ⇒ no gate (every request reads as `absent`). */
  getExpectedToken?: () => string | null;
}

export function startBackendServer(ctx: BackendContext, opts: BackendServerOptions = {}): Promise<BackendServerHandle> {
  const { hostRoutes, appDistDir, port = 0, viteOrigin, getExpectedToken } = opts;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    // CORS: the Vite dev renderer reaches this backend cross-origin (localhost vs
    // 127.0.0.1, or different port), so renderer→backend calls (save scene via
    // /api/write-file, /api/project-settings, /api/build) need ACAO. This backend
    // is PRIVILEGED (fs writes / builds), so restrict ACAO to the exact Vite origin
    // instead of '*' — a '*' lets any web page the user visits POST to a guessable
    // loopback port (CSRF / DNS-rebind). In prod the renderer is SAME-origin (served
    // here) so no header is needed; non-browser callers (MCP/curl) aren't subject to
    // CORS, so they're unaffected either way. (E5)
    if (viteOrigin) {
      res.setHeader('Access-Control-Allow-Origin', viteOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    // ── C6 token gate. Computed ONCE, here, for every request — including the privileged
    //    SSE build proxy below — so there is exactly one place that decides. A port names
    //    a socket, not an editor: without this, a `.mcp.json` whose port was recycled by a
    //    DIFFERENT editor drives that editor, and every call succeeds. Validate-if-present:
    //    a request with NO token is accepted (curl / game-debug / pre-C6 configs). ──
    const tokenCheck = checkToken(req.headers[TOKEN_HEADER], getExpectedToken?.() ?? null);
    if (tokenCheck === 'mismatch' && u.pathname !== TOKEN_EXEMPT) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: tokenMismatchError(ctx.projectRoot, (server.address() as AddressInfo | null)?.port ?? null) }));
      return;
    }
    // ── SSE build-family endpoints — proxy to the Vite server that owns them.
    //    The renderer's EventSource targets THIS backend (one base), but the
    //    handlers (vite build + gcloud/gradle; cap add scaffolding) live in the
    //    Vite middleware; pipe their event stream straight back instead of
    //    duplicating it. /api/build = build+deploy; /api/add-native-target =
    //    one-click `cap add` scaffold; /api/toolchain/install = auto-install a
    //    build tool into the userData toolchain dir (the JSON status sibling
    //    /api/toolchain falls through to the direct router below). ──
    if (req.method === 'GET' && (u.pathname === '/api/build' || u.pathname === '/api/add-native-target' || u.pathname === '/api/toolchain/install')) {
      if (!viteOrigin) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'no Vite server to run the build (MODOKI_NO_DEV_SERVER?)' }));
        return;
      }
      const target = new URL((req.url || u.pathname), viteOrigin);
      const proxyReq = http.get(target, (proxyRes) => {
        // Preserve the SSE headers (text/event-stream, no-cache); the CORS headers
        // set above survive (they aren't in proxyRes.headers).
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        // Upstream error AFTER headers (mid-stream) → tear down the downstream
        // socket instead of leaving it half-open. (E3)
        proxyRes.on('error', () => res.destroy());
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (e) => {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `build proxy to Vite failed: ${e.message}` }));
        } else { res.end(); }
      });
      // Tear down the upstream request when the client goes away — whether the
      // EventSource aborts (`req.close`) or the downstream socket closes for any
      // other reason (`res.close`). (E3) Both are idempotent.
      req.on('close', () => proxyReq.destroy());
      res.on('close', () => proxyReq.destroy());
      return;
    }
    // Buffer the body as binary chunks (not string concat — O(n²) + a UTF-8 decode
    // of base64-ish bytes), capped to guard against an OOM.
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `request body exceeds ${MAX_BODY_BYTES} bytes` }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (tooLarge) return;
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try { body = rawBody.trim() ? JSON.parse(rawBody) : undefined; }
      catch (e) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` }));
        return;
      }
      try {
        const parsed = { method: req.method || 'GET', urlPath: u.pathname, query: u.searchParams, body, tokenCheck };
        // Resolution order:
        //  1. Renderer-bound host routes (capture/input) — only main can serve.
        //  2. Project asset bytes + app shell — a non-`/api` GET, same single
        //     origin the dev server uses (parity). Project asset first; the built
        //     renderer shell is the SPA fallback (prod only).
        //  3. The shared `/api/*` command router.
        const isApi = parsed.urlPath.startsWith('/api/') || parsed.urlPath === '/assets.manifest.json';
        let result = (hostRoutes && (await hostRoutes(parsed))) || null;
        if (!result && parsed.method === 'GET' && !isApi) {
          result = (await serveProjectAsset(ctx, parsed.urlPath))
            || (appDistDir ? serveAppShell(appDistDir, parsed.urlPath) : null);
        }
        if (!result) result = await handleBackendRequest(ctx, parsed);
        if (!result) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `no backend route for ${req.method} ${u.pathname}` }));
          return;
        }
        writeBackendResult(res, result, req.headers['if-none-match']);
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only; fixed port if requested (stable MCP target), else ephemeral.
    server.listen(port, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
