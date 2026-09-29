/** The prefab fuzzer's backend (#1789): the REAL editor backend router over a scratch directory.
 *
 *  Every `fetch` the editor makes lands here. `/api/*` goes to `handleBackendRequest`, the router the Vite and Electron
 *  hosts serve, so a write's preconditions, the member-path repair, the move and the trash are the routes' own code.
 *  Any other GET serves the file under the scratch directory. A relay to the renderer (`requestBrowser`) runs the real
 *  renderer op through `runAgentOp`, in this same process.
 *
 *  What the host would add and this does not (the harness-blind list in `prefabFuzz.test.ts` names these):
 *  - no file watcher. A write the route marks as the editor's own is recorded in `marked`; any other change to the
 *    directory is found by the harness's `flushWatcher` and reaches the editor only through the harness's hot-reload step.
 *  - the manifest is rebuilt from the directory on every read (the host keeps a watcher-fed cache), so it is never
 *    stale here. */

import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

/** Asset URLs the fuzzer's project serves: `/fuzz/...` maps onto the scratch directory. */
export const ROOT_URL = '/fuzz';

export interface FuzzBackend {
  dir: string;
  /** The asset urls (`/fuzz/...`) the router marked as the editor's own write, since the watcher last ran. Keyed by url, as
   *  the watcher finds changes, not by the absolute path the route passes: on Windows that path has `\` separators no
   *  url-built string matches, so every editor write was raised as an outside edit and tainted its segment (#1840). */
  marked: Set<string>;
  fetch: (url: string | URL, init?: { method?: string; body?: string }) => Promise<Response>;
  write(url: string, text: string): void;
  read(url: string): string | undefined;
  remove(url: string): void;
  /** Every file under the root, url → bytes (as text). */
  snapshot(): Map<string, string>;
  /** How many times each `/api/*` route was called: the hunt reports it as coverage. */
  routeCounts: Map<string, number>;
  /** The renderer relay. Set by the harness once the agent ops are registered. */
  relay: (op: string, params: unknown) => Promise<unknown>;
  reset(): void;
}


export function makeFuzzBackend(): FuzzBackend {
  const dir = makeScratchDir('modoki-prefab-fuzz-');
  const abs = (url: string) => path.join(dir, url.slice(ROOT_URL.length));
  const toUrl = (p: string) => {
    const rel = path.relative(dir, p);
    return rel.startsWith('..') ? null : `${ROOT_URL}/${rel.split(path.sep).join('/')}`;
  };
  /** Every file under `d`: the scratch directory, not the repo corpus, so `repoFiles()` does not apply. */
  const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true, encoding: 'utf8' }) : [])
    .map((rel) => path.join(d, rel))
    .filter((p) => fs.statSync(p).isFile());
  const manifest = (): Manifest => {
    const assets: Manifest['assets'] = [];
    for (const p of walk(dir)) {
      const url = toUrl(p)!;
      if (!url.endsWith('.json') || url.endsWith('.meta.json')) continue;
      let guid: string | undefined;
      try { guid = (JSON.parse(fs.readFileSync(p, 'utf8')) as { id?: string }).id; } catch { /* unreadable: no guid */ }
      assets.push({ path: url, type: url.endsWith('.prefab.json') ? 'prefab' : 'scene', guid });
    }
    return { version: 2, assets, folders: [] };
  };

  const backend: FuzzBackend = {
    dir,
    marked: new Set(),
    routeCounts: new Map(),
    relay: async () => { throw new Error('fuzz backend: no renderer relay installed'); },
    write(url, text) { fs.mkdirSync(path.dirname(abs(url)), { recursive: true }); fs.writeFileSync(abs(url), text); },
    read(url) { try { return fs.readFileSync(abs(url), 'utf8'); } catch { return undefined; } },
    remove(url) { fs.rmSync(abs(url), { force: true }); },
    snapshot() {
      const out = new Map<string, string>();
      for (const p of walk(dir).sort()) out.set(toUrl(p)!, fs.readFileSync(p, 'utf8'));
      return out;
    },
    reset() {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      backend.marked.clear();
    },
    async fetch(input, init) {
      const u = new URL(String(input), 'http://fuzz.local');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (u.pathname.startsWith('/api/')) {
        backend.routeCounts.set(u.pathname, (backend.routeCounts.get(u.pathname) ?? 0) + 1);
        const body = init?.body ? JSON.parse(init.body) as unknown : undefined;
        const r = await handleBackendRequest(ctx, { method, urlPath: u.pathname, query: u.searchParams, body });
        if (!r) return new Response(JSON.stringify({ error: `fuzz backend: no route ${u.pathname}` }), { status: 404 });
        if (r.kind === 'json') return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json', ...r.headers } });
        if (r.kind === 'raw') return new Response(typeof r.body === 'string' ? r.body : new Uint8Array(r.body), { status: r.status ?? 200, headers: { 'Content-Type': r.contentType } });
        return new Response(new Uint8Array(fs.readFileSync(r.path)), { status: r.status ?? 200, headers: { 'Content-Type': r.contentType } });
      }
      const p = u.pathname.startsWith(ROOT_URL) ? abs(decodeURIComponent(u.pathname)) : null;
      if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return new Response('', { status: 404 });
      return new Response(new Uint8Array(fs.readFileSync(p)), { status: 200 });
    },
  };

  const ctx = {
    projectRoot: dir,
    resolveAssetPath: (url: string) => (url === ROOT_URL || url.startsWith(`${ROOT_URL}/`) ? abs(url) : null),
    absToAssetUrl: (p: string) => toUrl(p),
    firstRootDir: () => dir,
    getManifest: manifest,
    rebuildManifest: manifest,
    requestBrowser: (op: string, params: unknown) => backend.relay(op, params),
    getSchema: () => undefined,
    markEditorWrite: (p: string, hash?: string | null) => {
      const url = toUrl(p);
      if (url) backend.marked.add(url);
      void hash;
    },
    ssrLoadModule: async () => { throw new Error('fuzz backend: no SSR'); },
    invalidateProjectConfig: () => {},
    computeUnused: () => { throw new Error('fuzz backend: no tree-shaker'); },
    computeRefEdges: () => { throw new Error('fuzz backend: no tree-shaker'); },
  } as unknown as BackendContext;

  return backend;
}
