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
 * the renderer's POST stream (`backendEventStream`) targets this backend (one base),
 * and we pipe the Vite server's event stream straight back.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { handleBackendRequest, type BackendContext, type BackendResult } from '../plugins/backend/editorBackendRouter';
import { reclaimStaleDeviceStateAtStartup } from '../plugins/backend/deviceConnection';
import { serveProjectAsset, serveAppShell } from '../plugins/backend/staticAssets';
import { writeBackendResult } from '../plugins/backend/writeResult';
import { foreignRequestRefusal } from '../plugins/backend/requestOrigin';
import { SSE_ROUTES } from '../plugins/backend/sseRoutes';
import { PROJECT_ROOT_HEADER, projectStamp } from '../plugins/backend/projectStamp';
import { ProjectSwitchedError, stoppedBySwitch } from './requestContext';
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
  /** Refuse a request before ANY route sees it — the build proxy, the host routes and the shared router alike — or
   *  null to let it through. main passes the Open Project switch gate (#1976). It sits here, after the token gate and
   *  ahead of the proxy, because a check inside `hostRoutes` runs after the proxy has already forwarded the build
   *  family (#1991). */
  fence?: (method: string, urlPath: string) => { status: number; body: unknown } | null;
}

/** `contextFor`: a context, or a factory called ONCE per request when it arrives, so a request keeps the project it
 *  arrived in even if Open Project re-roots the backend while it runs (#1991, `requestContext.ts`). */
export function startBackendServer(contextFor: BackendContext | (() => BackendContext), opts: BackendServerOptions = {}): Promise<BackendServerHandle> {
  const { hostRoutes, appDistDir, port = 0, viteOrigin, getExpectedToken, fence } = opts;
  // Take back the machine-wide device state this clone left behind last run: any adb forward on its
  // own ports (#160), and any claim in `~/.modoki/device-claims.json` whose pid is gone (#225).
  // Called from the two backend HOSTS rather than at module scope, so importing the module in a test
  // never shells out to adb; the other host is the Vite plugin's `configureServer`. Startup is the
  // only teardown point that a SIGTERM/`kill -9`/crash cannot skip — measured: the process-exit
  // hooks never fire under Electron, see the function's own doc.
  reclaimStaleDeviceStateAtStartup();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const ctx = typeof contextFor === 'function' ? contextFor() : contextFor;
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
    // ⚠️ RESPONSE headers a cross-origin renderer may READ. Without this, `headers.get(...)` for
    // anything outside the CORS-safelist returns null in the Electron editor — silently, with no
    // console error and a 200 response, so the caller sees a well-formed reply that is simply
    // missing a field. Everything above is about which REQUESTS are allowed; this is the other
    // direction and is easy to forget precisely because nothing complains.
    //
    // `X-Meta-Sha256` (#845) is the `.meta.json` CAS baseline. It cannot be computed client-side —
    // `/api/read-meta` returns the merged view and `writeMetaSidecar` transforms what it writes —
    // so a stripped header means `ifMatch` is never sent on the first write of a path, and the
    // precondition guarding a committed file is inert exactly where the editor actually runs.
    // ⚠️ `X-Meta-Sha256` is the only header this actually enables today — an earlier version of
    // this comment said `X-Writable` was "listed for the same reason", which overstates it: no
    // client reads that one (`ScriptTree.tsx` takes `writable` from the JSON body; the header is
    // consumed only by a server-side test). It is listed so that a future client CAN read it
    // without rediscovering this whole failure mode, not because anything is broken without it.
    // ⚠️ `X-Meta-Local-Missing` (#1305) joined it, and it arrived by walking straight into the
    // failure this comment describes. The route emitted it, the unit tests asserted the route
    // emitted it, a same-origin `fetch` through Vite READ it — and in the Electron editor the panel
    // got `null`, so the Inspector never showed "re-import to compute stats" and the whole feature
    // was inert exactly where the editor actually runs. Caught only by driving the live editor.
    // It names the cache blocks whose machine-local values this host lacks; the client cannot
    // compute it (which keys are peeled is `meta-sidecar.ts`'s LOCAL_KEYS, server-side).
    // `metaHeaderExposure.test.ts` now derives this list from the router so the next one cannot be
    // forgotten the same way.
    res.setHeader('Access-Control-Expose-Headers', 'X-Meta-Sha256, X-Writable, X-Meta-Local-Missing');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    // ── Cross-site gate (#1955), before the token gate and every route — the SSE build proxy included.
    //    ACAO above only stops a foreign page READING a reply; a simple POST and a no-cors GET (`<img
    //    src>`) are still delivered. Three checks (requestOrigin.ts): the Host must be a loopback name
    //    (this host's only DNS-rebinding defence); a present Origin must be own (the loopback hosts on
    //    this server's port or the Vite page's, or the Vite page origin exactly); with no Origin, a
    //    `Sec-Fetch-Site: cross-site` is refused. curl, MCP and Node send none of these and pass. ──
    const refusal = foreignRequestRefusal(req.headers, {
      ports: [req.socket.localPort, viteOrigin ? Number(new URL(viteOrigin).port || 80) : null],
      origins: [viteOrigin],
    }, { checkHost: true });
    if (refusal) {
      console.warn(`[modoki-backend] refused ${req.method} ${u.pathname}: ${refusal.reason}`);
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(refusal.body));
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
    // ── The fence (#1991): ahead of the build proxy and every route, so one check covers all three. ──
    const fenced = fence?.(req.method || 'GET', u.pathname);
    if (fenced) {
      res.statusCode = fenced.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(fenced.body));
      return;
    }
    // ── SSE build-family endpoints — proxy to the Vite server that owns them.
    //    The renderer's stream targets THIS backend (one base), but the
    //    handlers (vite build + gcloud/gradle; cap add scaffolding) live in the
    //    Vite middleware; pipe their event stream straight back instead of
    //    duplicating it. /api/build = build+deploy; /api/add-native-target =
    //    one-click `cap add` scaffold; /api/toolchain/install = auto-install a
    //    build tool into the userData toolchain dir (the JSON status sibling
    //    /api/toolchain falls through to the direct router below); /api/ota/publish =
    //    the OTA publish pipeline (fresh build + gcloud) — same reasoning, JSON
    //    siblings /api/ota/status and /api/ota/keygen fall through to the router. ──
    //    They are POSTs (#1967: each starts a job). Any method is forwarded as sent, so Vite's own 405 answers a GET —
    //    one place decides the method, not two. ──
    if (SSE_ROUTES.includes(u.pathname)) {
      if (!viteOrigin) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'no Vite server to run the build (MODOKI_NO_DEV_SERVER?)' }));
        return;
      }
      const target = new URL((req.url || u.pathname), viteOrigin);
      // Stamped with the root THIS backend serves (#1991, projectStamp.ts): Vite refuses it if Open Project has already
      // moved Vite to another project, so a Build or Publish OTA from the old window cannot run on the new one.
      const proxyReq = http.request(target, { method: req.method, headers: { [PROJECT_ROOT_HEADER]: projectStamp(ctx.projectRoot) } }, (proxyRes) => {
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
      // Tear down the upstream request when the client goes away (the stream's `close()` aborts its fetch) or the
      // downstream socket closes for any other reason. (E3) ⚠️ `res`, not `req`: piping `req` consumes it, and a
      // consumed request emits `close` as soon as its (empty) body has been read, which would kill every stream at
      // its first byte. `res` closes only when the reply finishes or the client goes away.
      res.on('close', () => proxyReq.destroy());
      req.pipe(proxyReq); // the params ride the query; this ends the upstream request (with any body sent)
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
      // The fence again, now the body is in (#1991 review): a write whose head arrived before the switch began and whose
      // body finished after it (a large upload) passed the check above, and would otherwise run past the gate.
      const fencedLate = fence?.(req.method || 'GET', u.pathname);
      if (fencedLate) {
        res.statusCode = fencedLate.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(fencedLate.body));
        return;
      }
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
        // A route a re-root stopped part way (#1991) that answered a FAILURE is the switch's 503: the router's catch-alls
        // turn the throw into a generic 500, whose words read as a fault to retry. Only a failure: a route that caught
        // the stop on purpose and finished (an import whose manifest rebuild was skipped, a reimport's per-asset
        // `errors[]`) answered honestly about work that landed in the old project, and a 503 over it would hide that.
        const stopped = stoppedBySwitch(ctx);
        if (stopped && (result.status ?? 200) >= 500) throw stopped;
        writeBackendResult(res, result, req.headers['if-none-match']);
      } catch (e) {
        // A request whose project was switched away under it (#1991) is the switch gate's 503, not a server fault —
        // also when a route caught the stop and then threw something else on the way out.
        const stop = e instanceof ProjectSwitchedError ? e : stoppedBySwitch(ctx);
        res.statusCode = stop ? 503 : 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(stop
          ? { ok: false, switching: true, reason: 'project-switching', error: stop.message }
          : { error: e instanceof Error ? e.message : String(e) }));
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
