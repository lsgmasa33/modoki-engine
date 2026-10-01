/**
 * The cross-site request guard for the editor's two HTTP hosts — the Electron backend
 * (`electron/backendServer.ts`) and the Vite dev-server middleware (`vite-asset-scanner.ts`) (#1955).
 *
 * Both hosts listen on a known loopback port per clone and run privileged routes: file writes, deletes,
 * project settings a later deploy executes, and some GET routes with side effects (`/api/exit`, the SSE build
 * routes). CORS (`Access-Control-Allow-Origin`) only stops a page from READING a reply; a browser still DELIVERS
 * a "simple" cross-origin POST (text/plain body, no preflight) and any no-cors GET (`<img src>`), and the C6 token
 * does not help: it is validate-if-present, and a forged request simply sends none.
 *
 * Three checks, in `foreignRequestRefusal`:
 * 1. **Host** (the Electron backend only). The `Host` header must name a loopback host. This is what stops DNS
 *    rebinding there: a page at `http://evil.example:<port>` rebound to 127.0.0.1 makes SAME-origin requests,
 *    whose GETs carry no `Origin`, but its `Host` still says `evil.example`. The Vite host gets the same protection
 *    from Vite's own `hostValidationMiddleware`, which runs before this plugin's middleware.
 * 2. **Origin.** A request that carries one must come from an OWN origin: a loopback host NAME on one of the
 *    host's own ports, or an exact origin the host serves (the Electron renderer's Vite page; Vite's resolved
 *    URLs, LAN ones included). Browsers attach `Origin` to every cross-origin CORS request and to every POST,
 *    and a page cannot forge or remove it. An own Origin passes whatever else the request says.
 * 3. **Sec-Fetch-Site**, when there is NO Origin. A browser's no-cors GET (`<img>`, `<script>`, a navigation)
 *    carries no Origin but does carry `Sec-Fetch-Site`; `cross-site` is refused. The editor's own subresource
 *    loads are `same-origin` or `same-site` (an IP-literal site ignores the port), a typed URL is `none`, and
 *    curl, the MCP server and Node send no such header at all.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface OwnOrigins {
  /** Ports whose loopback origins are this host's own (the port the request arrived on, a sibling page's port). */
  ports: ReadonlyArray<number | null | undefined>;
  /** Exact origins this host serves, compared by `URL.origin`. Unparseable entries are ignored. */
  origins?: ReadonlyArray<string | null | undefined>;
}

type HeaderValue = string | string[] | undefined;
const first = (v: HeaderValue): string | undefined => (Array.isArray(v) ? v[0] : v);

function portOf(u: URL): number {
  return u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
}

/** True when the request's `Origin` header is present and is NOT one of `own`. An absent header is not foreign.
 *  `null` (an opaque origin: a sandboxed frame, a `data:` or `file:` page) and anything unparseable ARE foreign. */
export function isForeignOrigin(origin: HeaderValue, own: OwnOrigins): boolean {
  const raw = first(origin);
  if (raw == null || raw === '') return false;
  let u: URL;
  try { u = new URL(raw); } catch { return true; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  for (const o of own.origins ?? []) {
    if (!o) continue;
    try { if (new URL(o).origin === u.origin) return false; } catch { /* not an origin — ignore */ }
  }
  return !(LOOPBACK_HOSTS.has(u.hostname) && own.ports.includes(portOf(u)));
}

/** True when the `Host` header is present and does not name a loopback host (any port, any case). Absent is not
 *  foreign: every browser sends `Host`, so only a non-browser client can omit it. */
export function isForeignHost(host: HeaderValue): boolean {
  const raw = first(host);
  if (raw == null || raw === '') return false;
  let hostname: string;
  try { hostname = new URL(`http://${raw}`).hostname; } catch { return true; }
  return !LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export interface ForeignRequestRefusal {
  /** One line for the host's log, so a refusal of something legitimate is visible where it happens. */
  reason: string;
  body: { error: string; options: string[] };
}

/** The verdict both hosts act on: null to serve the request, or a 403 to send. `checkHost` is for a host with no
 *  Host validation of its own (the Electron backend); Vite validates Host itself, before this runs. */
export function foreignRequestRefusal(
  headers: { origin?: HeaderValue; host?: HeaderValue; 'sec-fetch-site'?: HeaderValue },
  own: OwnOrigins,
  opts: { checkHost?: boolean } = {},
): ForeignRequestRefusal | null {
  const options = [
    'call the API without a browser (curl, the modoki MCP server, a Node script)',
    'or from the editor window itself',
  ];
  if (opts.checkHost && isForeignHost(headers.host)) {
    const host = first(headers.host);
    return {
      reason: `Host ${host} is not a loopback name`,
      body: { error: `Refused: this request was addressed to ${host}, not to this editor's loopback address. The editor's HTTP API answers only to localhost / 127.0.0.1 / [::1]. Nothing was changed.`, options },
    };
  }
  const origin = first(headers.origin);
  if (origin != null && origin !== '') {
    if (!isForeignOrigin(origin, own)) return null;
    return {
      reason: `Origin ${origin} is not one of this editor's own`,
      body: { error: `Refused: this request came from a web page at ${origin}, not from this editor. The editor's HTTP API accepts browser requests only from its own pages. Nothing was changed.`, options },
    };
  }
  if (first(headers['sec-fetch-site']) === 'cross-site') {
    return {
      reason: 'a cross-site browser request with no Origin',
      body: { error: 'Refused: this request came from a browser page on another site (Sec-Fetch-Site: cross-site), not from this editor. Nothing was changed.', options },
    };
  }
  return null;
}
