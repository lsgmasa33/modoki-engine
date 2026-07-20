/** Router tests for the in-browser code editor's source-file endpoints:
 *  GET /api/scripts/tree (project working copy [writable] + engine source
 *  [read-only]) and GET /api/read-file (raw UTF-8, 403-on-escape). Also covers
 *  the engine-path write guard on /api/write-file. No live renderer needed —
 *  these are pure filesystem handlers over real temp dirs. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

let projectRoot = '';
let editorRoot = '';

function makeCtx(over: Partial<BackendContext> = {}): BackendContext {
  const base = {
    projectRoot,
    editorRoot,
    resolveAssetPath: (p: string) => p,
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async () => ({}),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  };
  return { ...base, ...over } as unknown as BackendContext;
}

const get = (url: string, ctx: BackendContext) => {
  const [urlPath, qs] = url.split('?');
  return handleBackendRequest(ctx, { method: 'GET', urlPath, query: new URLSearchParams(qs ?? ''), body: undefined });
};
const post = (urlPath: string, body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body });

beforeEach(() => {
  // A flat project working copy with scripts + dirs the walker must prune.
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-proj-'));
  fs.writeFileSync(path.join(projectRoot, 'game.ts'), 'export const game = 1;\n');
  fs.mkdirSync(path.join(projectRoot, 'runtime', 'systems'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'runtime', 'setup.ts'), 'export function setup() {}\n');
  fs.writeFileSync(path.join(projectRoot, 'runtime', 'systems', 'move.ts'), 'export const move = 2;\n');
  // Non-script + ignored content that must NOT appear.
  fs.writeFileSync(path.join(projectRoot, 'project.config.json'), '{}\n');
  fs.mkdirSync(path.join(projectRoot, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'node_modules', 'pkg', 'index.ts'), 'export {};\n');
  fs.mkdirSync(path.join(projectRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'dist', 'bundle.js'), '//built\n');

  // A separate editor root with the engine source layout (read-only reference).
  editorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-editor-'));
  const engSrc = path.join(editorRoot, 'engine', 'packages', 'modoki', 'src');
  fs.mkdirSync(path.join(engSrc, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(engSrc, 'runtime', 'core.ts'), 'export const core = true;\n');
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(editorRoot, { recursive: true, force: true });
});

describe('/api/scripts/tree', () => {
  it('returns project scripts (writable) + engine source (read-only)', async () => {
    const r = (await get('/api/scripts/tree', makeCtx())) as { body: { roots: { label: string; writable: boolean; files: { rel: string; path: string }[] }[] } };
    const roots = r.body.roots;
    const scripts = roots.find((x) => x.label === 'Scripts')!;
    const engine = roots.find((x) => x.label === 'Engine')!;

    expect(scripts.writable).toBe(true);
    expect(engine.writable).toBe(false);

    const rels = scripts.files.map((f) => f.rel).sort();
    expect(rels).toEqual(['game.ts', 'runtime/setup.ts', 'runtime/systems/move.ts']);
    // node_modules, dist, and non-scripts pruned.
    expect(rels.some((p) => p.includes('node_modules'))).toBe(false);
    expect(rels.some((p) => p.includes('dist'))).toBe(false);
    expect(rels.some((p) => p.endsWith('.json'))).toBe(false);

    expect(engine.files.map((f) => f.rel)).toEqual(['runtime/core.ts']);
    // I/O paths are the /@fs/<abs> form.
    expect(scripts.files[0].path.startsWith('/@fs/')).toBe(true);
  });

  it('omits the Engine root when editorRoot is unset', async () => {
    const r = (await get('/api/scripts/tree', makeCtx({ editorRoot: undefined }))) as { body: { roots: { label: string }[] } };
    expect(r.body.roots.map((x) => x.label)).toEqual(['Scripts']);
  });
});

describe('/api/read-file', () => {
  it('reads a project script as raw UTF-8, X-Writable=true', async () => {
    const abs = '/@fs/' + path.join(projectRoot, 'game.ts');
    const r = (await get('/api/read-file?path=' + encodeURIComponent(abs), makeCtx())) as { kind: string; body: string; headers: Record<string, string> };
    expect(r.kind).toBe('raw');
    expect(r.body).toBe('export const game = 1;\n');
    expect(r.headers['X-Writable']).toBe('true');
  });

  it('reads an engine source file as read-only, X-Writable=false', async () => {
    const abs = '/@fs/' + path.join(editorRoot, 'engine', 'packages', 'modoki', 'src', 'runtime', 'core.ts');
    const r = (await get('/api/read-file?path=' + encodeURIComponent(abs), makeCtx())) as { headers: Record<string, string>; body: string };
    expect(r.body).toBe('export const core = true;\n');
    expect(r.headers['X-Writable']).toBe('false');
  });

  it('accepts a path relative to the project root', async () => {
    const r = (await get('/api/read-file?path=' + encodeURIComponent('runtime/setup.ts'), makeCtx())) as { body: string };
    expect(r.body).toBe('export function setup() {}\n');
  });

  it('403s on a path that escapes every root', async () => {
    const escape = '/@fs/' + path.join(os.tmpdir(), 'definitely-outside.ts');
    const r = (await get('/api/read-file?path=' + encodeURIComponent(escape), makeCtx())) as { status?: number };
    expect(r.status).toBe(403);
  });

  it('404s on a missing file inside an allowed root', async () => {
    const r = (await get('/api/read-file?path=' + encodeURIComponent('runtime/nope.ts'), makeCtx())) as { status?: number };
    expect(r.status).toBe(404);
  });
});

describe('/api/write-file engine-path guard', () => {
  it('rejects writes to engine source (outside the project working copy)', async () => {
    const abs = '/@fs/' + path.join(editorRoot, 'engine', 'packages', 'modoki', 'src', 'runtime', 'core.ts');
    const r = (await post('/api/write-file', { path: abs, content: 'hacked' }, makeCtx())) as { status?: number };
    expect(r.status).toBe(403);
    // The engine file is untouched.
    expect(fs.readFileSync(path.join(editorRoot, 'engine', 'packages', 'modoki', 'src', 'runtime', 'core.ts'), 'utf-8')).toBe('export const core = true;\n');
  });

  it('allows writes to a project script', async () => {
    const abs = '/@fs/' + path.join(projectRoot, 'runtime', 'setup.ts');
    const r = (await post('/api/write-file', { path: abs, content: 'export function setup() { return 42; }\n' }, makeCtx())) as { body: { ok?: boolean } };
    expect(r.body.ok).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, 'runtime', 'setup.ts'), 'utf-8')).toContain('return 42');
  });
});
