/** Which URL reaches the SAME module instance the running app imported (#1155).
 *
 *  The browser keys ES module instances by URL string. Vite's import analysis writes one URL per
 *  file into the app's imports, and any other spelling of that file is a SECOND evaluation of its
 *  body with its own module-level state:
 *  - `/@fs/<abs>` for a file under the Vite root (the app uses `/<rel>`);
 *  - any query — `?x=1`, and `?import`, which Vite's own `__vite__injectQuery` appends to a
 *    NON-literal `import(url)` in served code;
 *  - a bare URL after an HMR update, when the app's importers were rewritten to `?t=<ts>`.
 *
 *  Measured live 2026-09-13: `setTimelinePreviewActive(true)` through a `/@fs` import read `true`
 *  there and `false` in the app. The duplicate is SHALLOW — only the named module is evaluated
 *  twice; its own imports are Vite-rewritten to canonical URLs — so a symbol re-exported from a
 *  dependency looks shared while one defined in the module itself is not.
 *
 *  ⚠️ No PREFIX rule answers this on its own. A file OUTSIDE the Vite root (every `games/<id>/**`
 *  module, an external project) is canonical AT `/@fs/<abs>`, so "a `/@fs` import is wrong" is false.
 *
 *  What import analysis writes is split across two sources, and taking either whole is wrong
 *  (close-out review, all three observed live):
 *  - The PATH is derived from the file (`normalizeResolvedIdToUrl`: `/<rel>` under the root, else
 *    `/@fs/<abs>`) — NOT the graph node's `url`, which is whichever spelling requested the file
 *    FIRST. One stray `/@fs` fetch of a not-yet-loaded engine file made the node's url `/@fs/…`
 *    for the life of the server, while the app still imports `/packages/…`.
 *  - The QUERY comes from the graph: `?t=<lastHMRTimestamp>` after a hot update, and the
 *    optimizer's `?v=<browserHash>` on a pre-bundled dependency (`koota.js?v=20bc55de`). A node
 *    carrying `?v=` is the PLAIN module, not a `?raw`/`?worker` variant — treating every query as a
 *    variant sent koota to `inGraph:false` and a second copy of the ECS registry. The hash is the
 *    optimizer's CURRENT one, not the first node's: a re-optimize leaves the stale `?v=` node in
 *    place, ahead of the new one (reproduced on a real Vite 8.2 graph, close-out review 2).
 *
 *  ⚠️ Not covered: files import analysis adds `?import` to (`.json`, `.wasm`, `.svg` …) — a JS module
 *  is what an eval imports, and those fail loudly on a MIME type rather than duplicating silently.
 *
 *  Pure: the host supplies the graph lookup and the filesystem probes. */

import path from 'node:path';

/** One client-environment module node, as far as this needs it. */
export interface GraphModule {
  url: string;
  lastHMRTimestamp: number;
}

export interface ModuleUrlHost {
  /** Vite's `root` (the directory `/<rel>` URLs are relative to). */
  viteRoot: string;
  /** The repo root a repo-relative path (`engine/…`, `games/…`) is resolved against. */
  repoRoot: string;
  /** Client-environment modules for an absolute, symlink-resolved file (`moduleGraph.getModulesByFile`). */
  modulesByFile(absFile: string): Iterable<GraphModule> | undefined;
  /** The optimizer's CURRENT `browserHash` — the `?v=` import analysis writes today. Nodes are never
   *  removed, so after a re-optimize the graph holds the old `?v=` node too, added FIRST. */
  browserHash?(): string | undefined;
  exists(absFile: string): boolean;
  realpath(absFile: string): string;
}

/** Why no URL was produced. `status` carries a host's own HTTP status through a forward, so a
 *  Vite-side failure is not flattened into the caller's "no such file" (400). */
export interface ModuleUrlError {
  error: string;
  status?: number;
}

export interface ModuleUrlResolution {
  /** Import THIS to reach the app's instance. */
  url: string;
  /** The absolute file the spec named. */
  file: string;
  /** The app has loaded this file. `false` ⇒ no app instance exists, so `url` is only the
   *  spelling the app WOULD use. */
  inGraph: boolean;
  /** The HMR stamp baked into `url`, when the module has been hot-updated. */
  hmrTimestamp?: number;
}

const toPosix = (p: string) => p.replace(/\\/g, '/');

/** Drop an origin, a query and a hash, leaving the path the spec names. */
function pathPart(spec: string): string {
  let s = spec.trim();
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).pathname; } catch { /* not a URL after all — keep it */ }
  }
  return s.replace(/[?#].*$/, '');
}

/** The absolute file a spec names, or an error saying why it names none.
 *  Accepted: `/@fs/<abs>`, an absolute path, a Vite-root URL (`/packages/…`), a repo-relative path
 *  (`engine/…`, `games/…`), and any of those as a full `http(s)://` URL or with a query. */
export function fileForSpec(spec: string, host: ModuleUrlHost): { file: string } | ModuleUrlError {
  const p = pathPart(spec);
  if (!p) return { error: 'path is empty' };
  let abs: string;
  if (p.startsWith('/@fs/')) {
    abs = decodeURIComponent(p.slice('/@fs'.length));
    // `/@fs/C:/x` on Windows: the leading slash belongs to the URL, not the path.
    if (/^\/[A-Za-z]:\//.test(abs)) abs = abs.slice(1);
  } else if (/^[A-Za-z]:[\\/]/.test(p)) {
    abs = p;
  } else if (p.startsWith('/')) {
    // An absolute path and a Vite-root URL share a leading slash. The file on disk decides:
    // `/Users/…/x.ts` exists as written, `/packages/…` does not (it is under the Vite root).
    const decoded = decodeURIComponent(p);
    abs = host.exists(decoded) ? decoded : path.join(host.viteRoot, decoded);
  } else {
    abs = path.join(host.repoRoot, decodeURIComponent(p));
  }
  abs = path.normalize(abs);
  if (!host.exists(abs)) return { error: `no such file: ${abs}` };
  return { file: host.realpath(abs) };
}

/** The URL Vite would write for `file` into an import — for a file the app has not loaded. */
export function derivedUrl(file: string, viteRoot: string): string {
  const rel = path.relative(viteRoot, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return '/' + toPosix(rel);
  const p = toPosix(file);
  return '/@fs' + (p.startsWith('/') ? p : '/' + p);
}

/** Queries that make a DIFFERENT module of the same file (Vite's asset/worker suffixes). A query
 *  outside this set — `?v=` above all — does not. */
const VARIANT_QUERY = /[?&](raw|url|worker|worker_file|sharedworker|inline|no-inline|direct|html-proxy)(&|=|$)/;

export function resolveModuleUrl(spec: string, host: ModuleUrlHost): ModuleUrlResolution | ModuleUrlError {
  const r = fileForSpec(spec, host);
  if ('error' in r) return r;
  const path = derivedUrl(r.file, host.viteRoot);
  const plains = [...(host.modulesByFile(r.file) ?? [])].filter((m) => !VARIANT_QUERY.test(m.url));
  if (!plains.length) return { url: path, file: r.file, inGraph: false };
  const ts = Math.max(...plains.map((m) => m.lastHMRTimestamp));
  const versions = plains.map((m) => /[?&]v=([^&#]+)/.exec(m.url)?.[1]).filter((x): x is string => !!x);
  // The optimizer's current hash when the host can say; otherwise the NEWEST node's (insertion order).
  const v = versions.length ? (host.browserHash?.() ?? versions[versions.length - 1]) : undefined;
  // Vite's `injectQuery` puts the stamp FIRST, ahead of the url's existing query.
  const query = [ts > 0 ? `t=${ts}` : '', v ? `v=${v}` : ''].filter(Boolean).join('&');
  return {
    url: query ? `${path}?${query}` : path,
    file: r.file,
    inGraph: true,
    ...(ts > 0 ? { hmrTimestamp: ts } : {}),
  };
}

/** Electron main's forward to the child Vite, which holds the only graph that wrote the renderer's
 *  URLs. Keeps Vite's status — a 502/503 there must not reach the router as a bare `{error}`, which
 *  it answers 400 and `modoki_eval` reads as "the spec names no file", silencing every check — and
 *  bounds the fetch, so a hung Vite does not leave a request pending in main. */
export async function forwardModuleUrl(
  devUrl: string, spec: string,
  // Strictly under modoki_eval's own 5s lookup deadline (context.ts), so THIS message is the one
  // that reaches the agent rather than the outer client's generic abort.
  fetchImpl: typeof fetch = fetch, timeoutMs = 3000,
): Promise<ModuleUrlResolution | ModuleUrlError> {
  const res = await fetchImpl(`${devUrl}/api/module-url?path=${encodeURIComponent(spec)}`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null) as (ModuleUrlResolution & { error?: string }) | null;
  if (res.ok && body && typeof body.url === 'string') return body;
  return { error: body?.error ?? `dev server answered ${res.status}`, status: res.ok ? 502 : res.status };
}
