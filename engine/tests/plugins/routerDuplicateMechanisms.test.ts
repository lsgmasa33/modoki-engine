/** #1965: the router's duplicated mechanisms, each folded to one copy. Every case here is the symptom the
 *  duplicate produced: a copy that had drifted from its siblings, or a cost the copies multiplied.
 *  - item 2 `refusalReply`: `/api/creatable-assets` skipped the refusal check, so a coded NO_RENDERER was a 409.
 *  - item 4 `writeFileAtomic`: two of the three tmp+rename copies left `<file>.tmp` behind when the rename failed.
 *  - item 6 `relEscapes`: `startsWith('..')` refused a legitimate `..art` folder as an escape.
 *  - item 10: delete-asset ran the GLOBAL held-editor probe once per target. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  // The OS trash, stubbed: a real one shells out to Finder/trash-put.
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));

import { handleBackendRequest, toFsUrl, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { relEscapes } from '../../plugins/backend/projectPaths';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let projectRoot = '';
let asked: Array<{ op: string; params: unknown }> = [];
/** What the stub renderer reports as held in the `openAssetEditor` registry. */
let editorHolds: string[] = [];
/** What the stub renderer answers for any other op. */
let otherReply: unknown = { ok: true };

function makeCtx(): BackendContext {
  return {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: (abs: string) => `/${path.relative(projectRoot, abs).split(path.sep).join('/')}`,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async (op: string, params: unknown) => {
      asked.push({ op, params });
      if (op === 'resolve-unsaved') {
        const registries = (params as { registries?: string[] }).registries ?? [];
        const holds = registries.includes('openAssetEditor')
          ? editorHolds.map((p) => ({ path: p, registry: 'openAssetEditor', detail: 'unsaved edits' }))
          : [];
        return { ok: true, holds, discarded: [], covers: registries };
      }
      return otherReply;
    },
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

type Reply = { status?: number; body: Record<string, unknown> };
const call = async (method: 'GET' | 'POST', urlPath: string, body?: unknown) =>
  await handleBackendRequest(makeCtx(), { method, urlPath, query: new URLSearchParams(), body }) as Reply;
const write = (rel: string, text: string) => {
  const abs = path.join(projectRoot, rel.replace(/^\//, ''));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

beforeEach(() => {
  projectRoot = makeScratchDir('modoki-router-dup-');
  asked = [];
  editorHolds = [];
  otherReply = { ok: true };
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('item 2: a coded refusal travels on its code\'s status at /api/creatable-assets', () => {
  it('a coded NO_RENDERER is a 503 (it was a 409, the uncoded branch)', async () => {
    otherReply = { ok: false, code: 'NO_RENDERER', error: 'no renderer' };
    expect((await call('GET', '/api/creatable-assets')).status).toBe(503);
  });

  it('an UNCODED {ok:false} keeps its 409', async () => {
    otherReply = { ok: false, error: 'something' };
    expect((await call('GET', '/api/creatable-assets')).status).toBe(409);
  });
});

describe('item 4: a failed atomic write leaves no .tmp behind', () => {
  it('/api/write-file whose rename fails answers 500 and leaves neither the file nor <file>.tmp', async () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); });
    const r = await call('POST', '/api/write-file', { path: '/fx/a.particle.json', content: '{}' });
    expect(r.status).toBe(500);
    const dir = path.join(projectRoot, 'fx');
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('the same write, with the rename working, lands (the accept side)', async () => {
    const r = await call('POST', '/api/write-file', { path: '/fx/a.particle.json', content: '{}' });
    expect(r.body.ok).toBe(true);
    expect(fs.readdirSync(path.join(projectRoot, 'fx'))).toEqual(['a.particle.json']);
  });
});

// The /@fs urls go through `toFsUrl`, never `'/@fs' + abs` — that is `/@fsC:/…` on Windows, which the route does not
// read as a /@fs path at all, so the accept test went red there (public CI) and the refuse test passed for the wrong reason.
describe('item 6: only a `..` SEGMENT escapes', () => {
  it('relEscapes', () => {
    expect(relEscapes('..')).toBe(true);
    expect(relEscapes(`..${path.sep}x`)).toBe(true);
    expect(relEscapes(path.resolve('/elsewhere'))).toBe(true);
    expect(relEscapes(`..art${path.sep}icon.png`)).toBe(false);
    expect(relEscapes('..art')).toBe(false);
    expect(relEscapes('')).toBe(false);
  });

  it('/api/write-file accepts a /@fs path inside a `..art` folder (it was refused as an escape)', async () => {
    const abs = path.join(projectRoot, '..art', 'x.json');
    const r = await call('POST', '/api/write-file', { path: toFsUrl(abs), content: '{}' });
    expect(r.status ?? 200).toBe(200);
    expect(fs.existsSync(abs)).toBe(true);
  });

  it('…and still refuses a real escape', async () => {
    const abs = path.join(path.dirname(projectRoot), 'outside.json');
    const r = await call('POST', '/api/write-file', { path: toFsUrl(abs), content: '{}' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(abs)).toBe(false);
  });
});

describe('item 10: delete-asset probes the held-editor registry ONCE, whatever the target count', () => {
  const editorProbes = () => asked.filter((a) => a.op === 'resolve-unsaved'
    && ((a.params as { registries?: string[] }).registries ?? []).includes('openAssetEditor')).length;

  it('three targets, nothing held: one probe, and the delete goes through', async () => {
    for (const n of ['a', 'b', 'c']) write(`/fx/${n}.particle.json`, '{}');
    const r = await call('POST', '/api/delete-asset', { paths: ['/fx/a.particle.json', '/fx/b.particle.json', '/fx/c.particle.json'] });
    expect(r.body.ok).toBe(true);
    expect(editorProbes()).toBe(1);
  });

  it('a hold on the LAST target still refuses, naming it (one probe covers every target)', async () => {
    for (const n of ['a', 'b', 'c']) write(`/fx/${n}.particle.json`, '{}');
    editorHolds = ['/fx/c.particle.json'];
    const r = await call('POST', '/api/delete-asset', { paths: ['/fx/a.particle.json', '/fx/b.particle.json', '/fx/c.particle.json'] });
    expect(r.status).toBe(423);
    expect(r.body.code).toBe('HELD_BY_ASSET_EDITOR');
    expect(r.body.held).toEqual([{ path: '/fx/c.particle.json', detail: 'unsaved edits' }]);
    expect(editorProbes()).toBe(1);
    expect(fs.existsSync(path.join(projectRoot, 'fx', 'a.particle.json'))).toBe(true);
  });
});
