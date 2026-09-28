/** The prefab format gate as `/api/write-file` actually applies it (#1468 D4).
 *
 *  `prefabWriteGuard.test.ts` proves the classifier; this proves the WIRING, which is the half that
 *  was missing when a census found the obvious choke point (`writePrefabFile`) covers 4 of 17
 *  writers. Eight of those seventeen reach this route, so this is where the client half stops
 *  being bypassable — and a gate nothing drives through its real entry point is the
 *  `family/one-entry-point` defect wearing a test.
 *
 *  Both directions, per the sibling `assetWriteIfMatch.test.ts`: a guard tested only on its reject
 *  side is half a guard, and here the ACCEPT side is the one that matters most — every authored
 *  prefab in the repo is below the current version, so a gate that refused them would be caught
 *  only by this test. */

import { describe, it, expect, beforeEach } from 'vitest';
import { relay } from './backendRelay';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { PREFAB_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let projectRoot = '';

function makeCtx(): BackendContext {
  return {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: relay(),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

type Res = { status?: number; body: { ok?: boolean; conflict?: boolean; reason?: string; stored?: number; current?: number; error?: string } };

async function post(urlPath: string, body: unknown): Promise<Res> {
  const res = await handleBackendRequest(makeCtx(), { method: 'POST', urlPath, query: new URLSearchParams(), body });
  // `null` is "no route matched" — a silent miss would make every assertion below vacuous.
  expect(res, `no route handled ${urlPath}`).not.toBeNull();
  return res as unknown as Res;
}

/** Seed a document on disk and return the url path `/api/write-file` addresses it by. */
function seed(name: string, doc: unknown): string {
  const abs = path.join(projectRoot, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(doc, null, 2));
  return `/${name}`;
}

const prefabDoc = (version: number) => ({ version, name: 'thing', rootLocalId: 1, entities: [] });
const body = (p: string, doc: unknown) => ({ path: p, content: JSON.stringify(doc, null, 2) });

beforeEach(() => { projectRoot = makeScratchDir('modoki-prefabgate-route-'); });

describe('POST /api/write-file — the prefab format gate', () => {
  it('REFUSES 409 when the prefab on disk is newer than this build', async () => {
    const p = seed('assets/x.prefab.json', prefabDoc(PREFAB_FORMAT_VERSION + 1));
    const res = await post('/api/write-file', body(p, prefabDoc(PREFAB_FORMAT_VERSION)));
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('prefab-format-too-new');
    expect(res.body.stored).toBe(PREFAB_FORMAT_VERSION + 1);
    // …and the bytes are untouched, which is the whole point.
    const onDisk = JSON.parse(fs.readFileSync(path.join(projectRoot, 'assets/x.prefab.json'), 'utf8'));
    expect(onDisk.version).toBe(PREFAB_FORMAT_VERSION + 1);
  });

  it('⚠️ ACCEPTS an older prefab — the case every authored prefab in the repo is in', async () => {
    const p = seed('assets/old.prefab.json', prefabDoc(2));
    const res = await post('/api/write-file', body(p, prefabDoc(PREFAB_FORMAT_VERSION)));
    expect(res.body.ok, 'an older prefab must stay writable').toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(projectRoot, 'assets/old.prefab.json'), 'utf8'));
    expect(onDisk.version).toBe(PREFAB_FORMAT_VERSION);
  });

  it('accepts a first write, where nothing is on disk', async () => {
    const res = await post('/api/write-file', body('/assets/new.prefab.json', prefabDoc(PREFAB_FORMAT_VERSION)));
    expect(res.body.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'assets/new.prefab.json'))).toBe(true);
  });

  it('leaves a non-prefab document alone, whatever version it carries', async () => {
    const p = seed('assets/x.scene.json', { version: 9999 });
    const res = await post('/api/write-file', body(p, { version: 1 }));
    expect(res.body.ok).toBe(true);
  });

  it('runs BEFORE ifMatch — a too-new prefab reports the FORMAT reason, not a stale-baseline one', async () => {
    // Ordering matters for the diagnosis: "your baseline is stale" is a wrong answer to "your build
    // is old", and it sends the reader to re-read the file rather than to update.
    const p = seed('assets/x.prefab.json', prefabDoc(PREFAB_FORMAT_VERSION + 1));
    const res = await post('/api/write-file', { ...body(p, prefabDoc(PREFAB_FORMAT_VERSION)), ifMatch: 'a-baseline-that-cannot-match' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('prefab-format-too-new');
  });
});

/** The localId high-water mark (#1774): no write through this route lowers it. The editor's own writes keep it
 *  (`commitPrefabWrites`), so this is the line for a RAW write — an agent's eval, a game panel, a dropped file.
 *  Mutation: return null from `classifyPrefabMarkWrite` — every refusal goes through: red. */
describe('POST /api/write-file — the prefab localId high-water mark (#1774)', () => {
  const rows = (...lids: number[]) => lids.map((localId) => ({ localId, name: `n${localId}`, traits: {} }));
  const doc = (mark: number | undefined, ...lids: number[]) =>
    ({ version: PREFAB_FORMAT_VERSION, name: 'm', rootLocalId: 1, ...(mark === undefined ? {} : { nextLocalId: mark }), entities: rows(...lids) });
  const onDisk = (name: string) => JSON.parse(fs.readFileSync(path.join(projectRoot, name), 'utf8'));

  it('REFUSES a document whose mark is lower than the one on disk, and leaves the file alone', async () => {
    const p = seed('assets/m.prefab.json', doc(9, 1, 2, 3));
    const res = await post('/api/write-file', body(p, doc(4, 1, 2, 3)));
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('prefab-mark-lowered');
    expect(onDisk('assets/m.prefab.json').nextLocalId).toBe(9);
  });

  it('REFUSES a document with NO mark whose rows sit below the stored one — the shape an older writer produces', async () => {
    const p = seed('assets/m.prefab.json', doc(9, 1, 2, 3));
    expect((await post('/api/write-file', body(p, doc(undefined, 1, 2)))).body.reason).toBe('prefab-mark-lowered');
  });

  it('REFUSES the same through the base64 encoding', async () => {
    const p = seed('assets/m.prefab.json', doc(9, 1, 2, 3));
    const res = await post('/api/write-file', { path: p, content: Buffer.from(JSON.stringify(doc(4, 1))).toString('base64'), encoding: 'base64' });
    expect(res.body.reason).toBe('prefab-mark-lowered');
  });

  it('a CREATE-only write over an existing prefab is refused for its real reason, not as a lower mark', async () => {
    // Review sibling of finding 1. Mutation: run the mark check for `ifNoneMatch: '*'` too — the reason reads
    // `prefab-mark-lowered`, and Create Prefab's redo reports a generic failure instead of "changed on disk since".
    const p = seed('assets/m.prefab.json', doc(9, 1, 2, 3));
    const res = await post('/api/write-file', { ...body(p, doc(undefined, 1)), ifNoneMatch: '*' });
    expect(res.body.reason).toBe('if-none-match');
  });

  it('ACCEPTS a mark that holds or rises, a file with no mark whose rows derive it, and a first write', async () => {
    const p = seed('assets/m.prefab.json', doc(9, 1, 2, 3));
    expect((await post('/api/write-file', body(p, doc(9, 1)))).body.ok).toBe(true);
    expect((await post('/api/write-file', body(p, doc(12, 1, 11)))).body.ok).toBe(true);
    const q = seed('assets/old.prefab.json', doc(undefined, 1, 2, 3));
    expect((await post('/api/write-file', body(q, doc(undefined, 1, 2, 3)))).body.ok, 'before v8: the rows derive the same mark').toBe(true);
    expect((await post('/api/write-file', body('/assets/new.prefab.json', doc(undefined, 1)))).body.ok).toBe(true);
  });
});
