/** #1879: the outside changes the editor has not applied, carried from the backend to every MCP answer.
 *  - the header is CAPPED (hub, 2026-09-30: a pull of hundreds of files must not make a giant header, or a 431);
 *  - a file-direct write is pending from its own answer, before the watcher's debounce raises it (fork A);
 *  - the MCP answer carries the list, in its JSON, scoped to the call that saw it.
 *  Mutations, measured: `slice(0, PENDING_OUTSIDE_CAP)` dropped → "caps"; the ASCII escape dropped → "ASCII"; the
 *  renderer's confirm (`noted.delete` in `fromRenderer`) dropped → "a note stands until"; `notePendingOutsideWrite` removed
 *  from the asset-write route → "a file-direct write"; the `!selfWrite` condition dropped → "the editor's own flush";
 *  the `scope.run` in `withPendingStamp` replaced by a shared store → "interleaved calls"; the atlas exclusion
 *  (`type !== 'atlas'`) dropped → "an atlas is not noted". */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  encodePendingOutside, decodePendingOutside, createPendingOutside, PENDING_OUTSIDE_CAP, PENDING_OUTSIDE_HEADER,
} from '../../tools/shared/pendingOutside';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { withPendingStamp, notePendingHeader, stampPending } from '../../tools/modoki-mcp/src/pendingStamp';
import { ERROR_DETAIL, type ToolResult } from '../../tools/shared/mcpResult';
import { relay } from './backendRelay';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

describe('the header', () => {
  it('caps the paths it carries and says how many there are', () => {
    const all = Array.from({ length: 300 }, (_, i) => `/assets/p/${i}.prefab.json`);
    const v = encodePendingOutside(all);
    expect(decodePendingOutside(v)).toEqual({ paths: all.slice(0, PENDING_OUTSIDE_CAP), count: 300 });
    expect(PENDING_OUTSIDE_CAP).toBe(50);
    expect(v.length, 'a header value, not a payload').toBeLessThan(4096);
  });

  it('is ASCII, whatever the paths hold', () => {
    const v = encodePendingOutside(['/assets/シーン.scene.json']);
    expect(/^[\x20-\x7e]*$/.test(v)).toBe(true);
    expect(decodePendingOutside(v)?.paths).toEqual(['/assets/シーン.scene.json']);
  });

  it('reads nothing from a missing or malformed header', () => {
    expect(decodePendingOutside(null)).toBeNull();
    expect(decodePendingOutside('{"paths":1}')).toBeNull();
  });
});

describe('createPendingOutside', () => {
  it('a note stands until the renderer confirms it or it expires; the renderer list is the rest', () => {
    let t = 0;
    const p = createPendingOutside(() => t, 3000);
    expect(decodePendingOutside(p.headers()[PENDING_OUTSIDE_HEADER]), 'stamped when empty too (review U2)').toEqual({ paths: [], count: 0 });
    p.noteWrite('/a.scene.json');
    expect(p.list()).toEqual(['/a.scene.json']);
    p.fromRenderer([]); // a push from before the watcher raised it: the note still stands
    expect(p.list()).toEqual(['/a.scene.json']);
    p.fromRenderer(['/a.scene.json']); // raised and held
    p.fromRenderer([]); // released: gone, not kept alive by the note
    expect(p.list()).toEqual([]);
    p.noteWrite('/b.json');
    t = 3001;
    expect(p.list(), 'a write the watcher never raised (identical bytes) does not stay pending').toEqual([]);
    p.fromRenderer(['/c.prefab.json']);
    expect(decodePendingOutside(p.headers()[PENDING_OUTSIDE_HEADER])).toEqual({ paths: ['/c.prefab.json'], count: 1 });
  });
});

describe('/api/asset-write, file-direct', () => {
  let projectRoot = '';
  const PATH = '/assets/particles/spark.particle.json';
  beforeEach(() => {
    projectRoot = makeScratchDir('modoki-pending-outside-');
    const abs = path.join(projectRoot, PATH.replace(/^\//, ''));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify({ id: 'p-guid', version: 1, rate: 10 }, null, 2)}\n`);
  });
  afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });
  const write = (selfWrite: boolean) => {
    const pendingOutside = createPendingOutside();
    const ctx = {
      projectRoot, editorRoot: projectRoot,
      resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
      absToAssetUrl: (p: string) => `/${path.relative(projectRoot, p).split(path.sep).join('/')}`,
      firstRootDir: () => null,
      getManifest: () => ({ version: 2, assets: [] }) as Manifest,
      rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
      requestBrowser: relay(), getSchema: () => undefined, markEditorWrite: () => {},
      ssrLoadModule: async () => ({}), invalidateProjectConfig: () => {},
      pendingOutside,
    } as unknown as BackendContext;
    return handleBackendRequest(ctx, {
      method: 'POST', urlPath: '/api/asset-write', query: new URLSearchParams(),
      body: { path: PATH, type: 'particle', data: { id: 'p-guid', version: 1, rate: 99 }, ...(selfWrite ? { selfWrite: true } : {}) },
    }).then((r) => ({ r: r as { body: { ok?: boolean; hint?: string } }, pending: pendingOutside.list() }));
  };

  it('a file-direct write is pending from its own answer, which says to refresh', async () => {
    const { r, pending } = await write(false);
    expect(r.body.ok).toBe(true);
    expect(pending).toEqual([PATH]);
    expect(r.body.hint).toMatch(/modoki_refresh/);
  });

  it('an atlas is not noted: no watcher broadcast raises one, so nothing could apply it (review U1)', async () => {
    const ATLAS = '/assets/sheets/a.atlas.json';
    const abs = path.join(projectRoot, ATLAS.replace(/^\//, ''));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify({ id: 'a-guid', version: 1, members: [] }, null, 2)}\n`);
    const pendingOutside = createPendingOutside();
    const ctx = {
      projectRoot, editorRoot: projectRoot,
      resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
      absToAssetUrl: (p: string) => `/${path.relative(projectRoot, p).split(path.sep).join('/')}`,
      firstRootDir: () => null,
      getManifest: () => ({ version: 2, assets: [] }) as Manifest,
      rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
      requestBrowser: relay(), getSchema: () => undefined, markEditorWrite: () => {},
      ssrLoadModule: async () => ({}), invalidateProjectConfig: () => {},
      pendingOutside,
    } as unknown as BackendContext;
    const r = await handleBackendRequest(ctx, {
      method: 'POST', urlPath: '/api/asset-write', query: new URLSearchParams(),
      body: { path: ATLAS, type: 'atlas', data: { id: 'a-guid', version: 1, members: [] } },
    }) as { body: { ok?: boolean; hint?: string; error?: string } };
    expect(r.body.ok, r.body.error).toBe(true);
    expect(pendingOutside.list()).toEqual([]);
    expect(r.body.hint).toBeUndefined();
  });

  it('the editor\'s own flush is not an outside change', async () => {
    const { r, pending } = await write(true);
    expect(r.body.ok).toBe(true);
    expect(pending).toEqual([]);
    expect(r.body.hint).toBeUndefined();
  });
});

describe('the MCP answer', () => {
  const ok = (data: unknown, banner = ''): ToolResult => ({ content: [{ type: 'text', text: `${banner}${JSON.stringify(data)}` }] });
  const header = (paths: string[]) => encodePendingOutside(paths);

  it('adds the list to the answer\'s JSON, behind a banner too, and a plain-text answer gets a block', async () => {
    const r = await withPendingStamp(async () => { notePendingHeader(header(['/s.scene.json'])); return ok({ a: 1 }); });
    expect(JSON.parse(r.content[0].text)).toMatchObject({ a: 1, pendingOutsideChanges: ['/s.scene.json'], pendingOutsideCount: 1 });
    const b = stampPending(ok({ a: 1 }, 'WARNING: other clone\n\n'), { paths: ['/x'], count: 1 });
    expect(b.content[0].text.startsWith('WARNING: other clone\n\n{')).toBe(true);
    expect(JSON.parse(b.content[0].text.slice('WARNING: other clone\n\n'.length)).pendingOutsideCount).toBe(1);
    const t = stampPending({ content: [{ type: 'text', text: 'plain' }] }, { paths: ['/x'], count: 1 });
    expect(t.content).toHaveLength(2);
    expect(JSON.parse(t.content[1].text).pendingOutsideChanges).toEqual(['/x']);
  });

  it('nothing pending: the answer is untouched; a failure keeps its detail', async () => {
    const plain = ok({ a: 1 });
    expect(await withPendingStamp(async () => { notePendingHeader(null); return plain; })).toBe(plain);
    const fail = { ...ok({ error: { code: 'NOT_FOUND' } }), isError: true, [ERROR_DETAIL]: { code: 'NOT_FOUND' } } as unknown as ToolResult;
    const stamped = stampPending(fail, { paths: ['/x'], count: 1 }) as unknown as Record<symbol, unknown>;
    expect(stamped[ERROR_DETAIL]).toEqual({ code: 'NOT_FOUND' });
  });

  it('a response with no header (an error path) keeps what an earlier call saw (review U2)', async () => {
    const r = await withPendingStamp(async () => {
      notePendingHeader(header(['/s.scene.json'])); // /api/editor-state, stamped
      notePendingHeader(null); // a 500 that bypassed the stamp
      return ok({ a: 1 });
    });
    expect(JSON.parse(r.content[0].text).pendingOutsideChanges).toEqual(['/s.scene.json']);
  });

  it('interleaved calls each get the list their own backend calls saw', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = withPendingStamp(async () => { notePendingHeader(header(['/slow'])); await gate; return ok({ which: 'slow' }); });
    const fast = withPendingStamp(async () => { notePendingHeader(null); return ok({ which: 'fast' }); });
    const f = await fast;
    release();
    const s = await slow;
    expect(JSON.parse(f.content[0].text).pendingOutsideChanges).toBeUndefined();
    expect(JSON.parse(s.content[0].text).pendingOutsideChanges).toEqual(['/slow']);
  });
});
