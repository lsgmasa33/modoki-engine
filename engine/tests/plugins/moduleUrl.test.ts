/** `resolveModuleUrl` (#1155): which URL reaches the app's OWN instance of a module.
 *
 *  Every case pins one way a spelling can differ from the one the app imported. The graph is a
 *  plain Map, so these assert the RULE (path derived from the file; `?t=`/`?v=` and `inGraph` from
 *  the graph); the live identity check — a state write through the resolved URL seen by the app —
 *  is the editor probe recorded on #1155, which vitest cannot stand in for. */

import { describe, it, expect } from 'vitest';
import { resolveModuleUrl, derivedUrl, forwardModuleUrl, type GraphModule, type ModuleUrlHost } from '../../plugins/backend/moduleUrl';

const REPO = '/repo';
const ROOT = '/repo/engine';
const ENGINE_FILE = '/repo/engine/packages/modoki/src/runtime/core/timelinePreview.ts';
const GAME_FILE = '/repo/games/court/runtime/systems.ts';
const UNLOADED = '/repo/engine/packages/modoki/src/runtime/core/unloaded.ts';
const LINKED = '/repo/node_modules/@modoki/engine/src/runtime/core/timelinePreview.ts';
const DEP = '/repo/node_modules/.vite/deps/koota.js';

function host(graph: Record<string, GraphModule[]>, over: Partial<ModuleUrlHost> = {}): ModuleUrlHost {
  const files = new Set([ENGINE_FILE, GAME_FILE, UNLOADED, LINKED, DEP]);
  return {
    viteRoot: ROOT,
    repoRoot: REPO,
    modulesByFile: (f) => graph[f],
    exists: (f) => files.has(f),
    realpath: (f) => (f === LINKED ? ENGINE_FILE : f),
    ...over,
  };
}

const ENGINE_GRAPH = { [ENGINE_FILE]: [{ url: '/packages/modoki/src/runtime/core/timelinePreview.ts', lastHMRTimestamp: 0 }] };

describe('resolveModuleUrl', () => {
  it('a /@fs spelling of an engine file resolves to the Vite-root URL the app imported', () => {
    expect(resolveModuleUrl(`/@fs${ENGINE_FILE}`, host(ENGINE_GRAPH))).toEqual({
      url: '/packages/modoki/src/runtime/core/timelinePreview.ts', file: ENGINE_FILE, inGraph: true,
    });
  });

  it('a query variant resolves to the plain URL — the query is what made it a second instance', () => {
    expect(resolveModuleUrl('/packages/modoki/src/runtime/core/timelinePreview.ts?x=1', host(ENGINE_GRAPH)))
      .toMatchObject({ url: '/packages/modoki/src/runtime/core/timelinePreview.ts', inGraph: true });
  });

  it('a hot-updated module resolves WITH the ?t= stamp its importers were rewritten to', () => {
    const g = { [ENGINE_FILE]: [{ url: '/packages/modoki/src/runtime/core/timelinePreview.ts', lastHMRTimestamp: 1234 }] };
    expect(resolveModuleUrl('/packages/modoki/src/runtime/core/timelinePreview.ts', host(g))).toEqual({
      url: '/packages/modoki/src/runtime/core/timelinePreview.ts?t=1234', file: ENGINE_FILE, inGraph: true, hmrTimestamp: 1234,
    });
  });

  it('a game file outside the Vite root is canonical AT /@fs — the URL the graph holds, not a prefix rule', () => {
    const g = { [GAME_FILE]: [{ url: `/@fs${GAME_FILE}`, lastHMRTimestamp: 0 }] };
    expect(resolveModuleUrl('games/court/runtime/systems.ts', host(g))).toMatchObject({ url: `/@fs${GAME_FILE}`, inGraph: true });
  });

  it('the PATH is derived from the file, not the node url — which is whichever spelling asked first', () => {
    // Observed live (close-out review): one stray `/@fs` fetch of a not-yet-loaded engine file made
    // the node's url `/@fs/…` for the life of the server, while import analysis still writes
    // `/packages/…` into every importer. Returning the node url would name the stray copy.
    const g = { [ENGINE_FILE]: [{ url: `/@fs${ENGINE_FILE}`, lastHMRTimestamp: 0 }] };
    expect(resolveModuleUrl(ENGINE_FILE, host(g))).toMatchObject({ url: '/packages/modoki/src/runtime/core/timelinePreview.ts', inGraph: true });
  });

  it('a pre-bundled dependency is the PLAIN module, and keeps the optimizer ?v= the app imported', () => {
    // Observed live: the app imports `…/.vite/deps/koota.js?v=20bc55de`; treating every query as a
    // variant reported inGraph:false and named a second koota — a second ECS registry.
    const g = { [DEP]: [{ url: `/@fs${DEP}?v=20bc55de`, lastHMRTimestamp: 0 }] };
    expect(resolveModuleUrl(`/@fs${DEP}?v=20bc55de`, host(g))).toEqual({ url: `/@fs${DEP}?v=20bc55de`, file: DEP, inGraph: true });
  });

  it('a stamp goes ahead of an existing ?v=, as Vite\'s injectQuery orders them', () => {
    const g = { [DEP]: [{ url: `/@fs${DEP}?v=abc`, lastHMRTimestamp: 7 }] };
    expect(resolveModuleUrl(DEP, host(g))).toMatchObject({ url: `/@fs${DEP}?t=7&v=abc`, hmrTimestamp: 7 });
  });

  it('after a re-optimize, the CURRENT ?v= wins over the stale node added first', () => {
    // Reproduced on a real Vite 8.2 graph: nodes are never removed, so the old `?v=` node precedes
    // the new one. Without the host's hash, the newest node (insertion order) is the answer.
    const g = { [DEP]: [{ url: `/@fs${DEP}?v=old`, lastHMRTimestamp: 0 }, { url: `/@fs${DEP}?v=new`, lastHMRTimestamp: 0 }] };
    expect(resolveModuleUrl(DEP, host(g))).toMatchObject({ url: `/@fs${DEP}?v=new` });
    expect(resolveModuleUrl(DEP, host(g, { browserHash: () => 'current' }))).toMatchObject({ url: `/@fs${DEP}?v=current` });
  });

  it('a ?worker_file node is a variant too — the main thread holds no instance of it', () => {
    const g = { [ENGINE_FILE]: [{ url: '/packages/modoki/src/runtime/core/timelinePreview.ts?worker_file&type=module', lastHMRTimestamp: 0 }] };
    expect(resolveModuleUrl(ENGINE_FILE, host(g))).toMatchObject({ inGraph: false });
  });

  it('ignores a ?raw / ?worker node of the same file — a different module', () => {
    const g = { [ENGINE_FILE]: [
      { url: '/packages/modoki/src/runtime/core/timelinePreview.ts?raw', lastHMRTimestamp: 0 },
      { url: '/packages/modoki/src/runtime/core/timelinePreview.ts', lastHMRTimestamp: 0 },
    ] };
    expect(resolveModuleUrl(ENGINE_FILE, host(g))).toMatchObject({ url: '/packages/modoki/src/runtime/core/timelinePreview.ts' });
  });

  it('a file the app never loaded derives the spelling and says inGraph:false', () => {
    expect(resolveModuleUrl(`/@fs${UNLOADED}`, host({}))).toEqual({
      url: '/packages/modoki/src/runtime/core/unloaded.ts', file: UNLOADED, inGraph: false,
    });
  });

  it('accepts a full http URL and a symlinked path, resolving both to the real file', () => {
    expect(resolveModuleUrl('http://127.0.0.1:5177/packages/modoki/src/runtime/core/timelinePreview.ts?t=1', host(ENGINE_GRAPH)))
      .toMatchObject({ file: ENGINE_FILE, inGraph: true });
    expect(resolveModuleUrl(LINKED, host(ENGINE_GRAPH))).toMatchObject({ file: ENGINE_FILE, inGraph: true });
  });

  it('refuses a spec that names no file, and an empty one', () => {
    expect(resolveModuleUrl('/packages/nope.ts', host(ENGINE_GRAPH))).toEqual({ error: expect.stringMatching(/no such file/) });
    expect(resolveModuleUrl('  ', host(ENGINE_GRAPH))).toEqual({ error: 'path is empty' });
  });
});

describe('forwardModuleUrl (Electron main → child Vite)', () => {
  const res = (status: number, body: unknown) => (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;

  it('passes a resolution through', async () => {
    const answer = { url: '/packages/a.ts', file: '/repo/engine/packages/a.ts', inGraph: true };
    expect(await forwardModuleUrl('http://vite', '/a.ts', res(200, answer))).toEqual(answer);
  });

  it('KEEPS Vite\'s status — a 502 there must not reach the router as a 400 "no such file"', async () => {
    expect(await forwardModuleUrl('http://vite', '/a.ts', res(502, { error: 'module graph unreachable: boom' })))
      .toEqual({ error: 'module graph unreachable: boom', status: 502 });
    expect(await forwardModuleUrl('http://vite', '/a.ts', res(400, { error: 'no such file: /a.ts' })))
      .toEqual({ error: 'no such file: /a.ts', status: 400 });
  });

  it('a 200 without a url is a failure of the host, not a resolution', async () => {
    expect(await forwardModuleUrl('http://vite', '/a.ts', res(200, { nope: 1 }))).toEqual({ error: 'dev server answered 200', status: 502 });
  });
});

describe('derivedUrl', () => {
  it('root-relative under the Vite root, /@fs outside it', () => {
    expect(derivedUrl(ENGINE_FILE, ROOT)).toBe('/packages/modoki/src/runtime/core/timelinePreview.ts');
    expect(derivedUrl(GAME_FILE, ROOT)).toBe(`/@fs${GAME_FILE}`);
  });

  it('a sibling whose name merely STARTS with the root is outside it', () => {
    expect(derivedUrl('/repo/engine-old/x.ts', ROOT)).toBe('/@fs/repo/engine-old/x.ts');
  });
});
