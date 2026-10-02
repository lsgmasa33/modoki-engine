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
import { handleBackendRequest, makePrefabResolver, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { admitPrefabDocument } from '../../packages/modoki/src/runtime/loaders/documentIdentity';
import { PREFAB_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { reserveLocalId, clearReservedLocalIds } from '../../packages/modoki/src/runtime/core/localIdCounter';

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

  // #1933 S5: a renderer that loaded a scene holds an in-memory reservation for the prefab, and the fuzz backend runs this
  // route in that process. The route compares what the two FILES state, as it does in node, where no reservation exists.
  // Mutation: compare `localIdCounter` (counts the reservation) — both sides read 21 and the lowering write goes through.
  it('compares what the files state, not a reservation the process holds for the prefab', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000193305';
    const p = seed('assets/m.prefab.json', { ...doc(9, 1, 2, 3), id });
    reserveLocalId(id, 20);
    try {
      expect((await post('/api/write-file', body(p, { ...doc(4, 1, 2, 3), id }))).body.reason).toBe('prefab-mark-lowered');
    } finally { clearReservedLocalIds(); }
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

/** #1937 C-A step 6, T11 (owner ruling F-D): a prefab declaring an identifier twice is never written by the raw routes —
 *  every seat refuses such a document, so each instance of it would become a Damaged Prefab placeholder. */
describe('the raw routes refuse a prefab that declares an identifier twice (#1937 T11)', () => {
  const row = (localId: number, nodeGuid: string, extra: object = {}) => ({ localId, name: `R${localId}`, nodeGuid, traits: {}, ...extra });
  const node = (key?: string) => ({ parentLocalId: 1, name: 'N', ...(key ? { key } : {}), traits: {}, children: [] });
  const clean = () => ({ version: PREFAB_FORMAT_VERSION, name: 'd', rootLocalId: 1, nextLocalId: 3, entities: [row(1, 'g-1'), row(2, 'g-2')] });
  const repeatedLocalId = () => ({ ...clean(), entities: [row(1, 'g-1'), row(1, 'g-3')] });
  const repeatedKey = () => ({ ...clean(), entities: [row(1, 'g-1', { added: [node('k1'), node('k1')] }), row(2, 'g-2')] });
  const keyless = () => ({ ...clean(), entities: [row(1, 'g-1', { added: [node()] }), row(2, 'g-2')] });

  // Mutation: drop the gate in `/api/write-file` — both are written.
  it('/api/write-file: a repeated localId and a repeated key are refused 422 with the reason; nothing reaches disk', async () => {
    for (const [what, doc] of [['localId', repeatedLocalId()], ['template key', repeatedKey()]] as const) {
      const res = await post('/api/write-file', body('/assets/d.prefab.json', doc));
      expect(res.status, what).toBe(422);
      expect(res.body.reason).toBe('prefab-identifier-repeated');
      expect(res.body.error).toContain(what);
      expect(fs.existsSync(path.join(projectRoot, 'assets/d.prefab.json'))).toBe(false);
    }
  });

  // The accept side. Mutation: refuse every prefab write — these are refused.
  it('/api/write-file: a clean document and one with keyless template nodes (the seats mint them) are written', async () => {
    expect((await post('/api/write-file', body('/assets/c.prefab.json', clean()))).body.ok).toBe(true);
    expect((await post('/api/write-file', body('/assets/k.prefab.json', keyless()))).body.ok).toBe(true);
  });

  // #1948 F3. Mutation: drop admission's `malformedOwnerRefusal` — written; report the identity reason — the reason fails.
  it('/api/write-file: a nested row stating a channel in a shape no reader takes is refused 422, prefab-channel-malformed', async () => {
    const malformed = () => ({ ...clean(), entities: [row(1, 'g-1'), row(2, 'g-2', { prefab: 'cccccccc-0000-4000-8000-000000019481', removed: 3 })] });
    const res = await post('/api/write-file', body('/assets/m.prefab.json', malformed()));
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('prefab-channel-malformed');
    expect(res.body.error).toMatch(/nested row R2 \(localId 2\) states removed in a shape no reader takes/);
    expect(fs.existsSync(path.join(projectRoot, 'assets/m.prefab.json'))).toBe(false);
    // The accept side: the same row well-formed is written.
    const ok = () => ({ ...clean(), entities: [row(1, 'g-1'), row(2, 'g-2', { prefab: 'cccccccc-0000-4000-8000-000000019481', removed: [3] })] });
    expect((await post('/api/write-file', body('/assets/w.prefab.json', ok()))).body.ok).toBe(true);
  });

  // A scene is not gated (its gate is C-A step 5, parked): its damaged embedded copy is written back as the file held it.
  it('/api/write-file: a scene holding a damaged embedded prefab copy is written', async () => {
    const scene = { version: 19, name: 'S', entities: [], embeddedPrefabs: { 'cccccccc-0000-4000-8000-000000019311': repeatedKey() } };
    expect((await post('/api/write-file', body('/assets/s.scene.json', scene))).body.ok).toBe(true);
  });
});

/** #1937 C-A step 7 (I7): a Node reader that predicts derived guids reads a prefab as every seat does — admitted — so a
 *  keyless template node carries the key the editor mints, and a guid predicted here is the one the load derives. */
describe('the Node prefab readers admit what they read (#1937 C-A step 7)', () => {
  const P = 'cccccccc-0000-4000-8000-000000019701';
  const PN = 'cccccccc-0000-4000-8000-000000019702';
  const O = 'cccccccc-0000-4000-8000-000000019703';
  const row = (localId: number, nodeGuid: string, extra: object = {}) => ({ localId, name: `R${localId}`, nodeGuid, traits: { EntityAttributes: { name: `R${localId}`, parentId: localId === 1 ? 0 : 1, guid: '' } }, ...extra });
  const loose = { parentLocalId: 2, guid: '', name: 'Loose', traits: { EntityAttributes: { name: 'Loose', parentId: 0 } }, children: [] };
  const pDoc = { id: P, version: PREFAB_FORMAT_VERSION, name: 'P', rootLocalId: 1, entities: [row(1, 'eeeeeeee-0000-4000-8000-000000019711'), row(2, 'eeeeeeee-0000-4000-8000-000000019712')] };
  /** PN: R1 → R2, a P row adding Loose (KEYLESS) under P's R2. */
  const pnDoc = { id: PN, version: PREFAB_FORMAT_VERSION, name: 'PN', rootLocalId: 1, entities: [row(1, 'eeeeeeee-0000-4000-8000-000000019721'), row(2, 'eeeeeeee-0000-4000-8000-000000019722', { prefab: P, added: [loose] })] };
  const minted = () => ((admitPrefabDocument(structuredClone(pnDoc)) as { doc: typeof pnDoc }).doc.entities[1] as unknown as { added: Array<{ key?: string }> }).added[0]!.key!;
  const ctxWith = (assets: Array<{ guid: string; path: string }>) => ({ ...makeCtx(), getManifest: () => ({ version: 2, assets: assets.map((a) => ({ ...a, type: 'prefab' })) }) as unknown as Manifest });
  const install = () => {
    seed('assets/P.prefab.json', pDoc);
    seed('assets/PN.prefab.json', pnDoc);
    return [{ guid: P, path: '/assets/P.prefab.json' }, { guid: PN, path: '/assets/PN.prefab.json' }];
  };

  // Mutation: `makePrefabResolver` returns the raw parse (no `admittedPrefab`) — Loose has no key.
  it('makePrefabResolver: the keyless node carries the key the seats mint', () => {
    const read = makePrefabResolver(ctxWith(install()) as never);
    const doc = read(PN) as typeof pnDoc;
    expect((doc.entities[1] as unknown as { added: Array<{ key?: string }> }).added[0]!.key).toBe(minted());
  });

  // Mutation: `/api/validate-prefab`'s nested reader returns the raw parse — O's node keyed with the MINTED key meets no
  // keyed node in PN, and the repeat goes unreported.
  it('/api/validate-prefab reads the nested documents admitted: a key O repeats from a minted one is reported', async () => {
    const assets = install();
    const oDoc = { id: O, version: PREFAB_FORMAT_VERSION, name: 'O', rootLocalId: 1, entities: [
      row(1, 'eeeeeeee-0000-4000-8000-000000019731'),
      row(2, 'eeeeeeee-0000-4000-8000-000000019732', { prefab: PN, added: [{ ...loose, name: 'Copied', key: minted() }] }),
    ] };
    const p = seed('assets/O.prefab.json', oDoc);
    const res = await handleBackendRequest(ctxWith([...assets, { guid: O, path: p }]) as never, { method: 'GET', urlPath: '/api/validate-prefab', query: new URLSearchParams({ path: p }), body: undefined });
    const warnings = ((res as unknown as { body: { warnings?: string[] } }).body.warnings ?? []);
    expect(warnings.filter((w) => w.startsWith('ERROR:')).join('\n')).toContain(minted());
  });

  // Close-out review #6 (F-D): a repeat only the derive walk sees — two of O's lists anchored at members of ONE frame of P
  // (admission groups keys by anchor), and a key O copies from one PN's own node gives — is refused by /api/write-file,
  // which reads the nested documents through the router's admitted resolver. Mutation: drop `frameRepeatRefusal` from
  // `classifyPrefabIdentityWrite` — both are written.
  it('/api/write-file refuses a repeat the derive walk sees: one file across two anchors, and a key copied from a nested file', async () => {
    const assets = install();
    const ctx = ctxWith(assets) as never;
    const write = async (name: string, doc: unknown) => (await handleBackendRequest(ctx, { method: 'POST', urlPath: '/api/write-file', query: new URLSearchParams(), body: { path: name, content: JSON.stringify(doc) } })) as unknown as { status?: number; body: { reason?: string; error?: string } };
    const kd = (parentLocalId: number) => ({ ...loose, parentLocalId, name: `K${parentLocalId}`, key: 'k-dup' });
    const oneFile = { id: O, version: PREFAB_FORMAT_VERSION, name: 'O', rootLocalId: 1, entities: [
      row(1, 'eeeeeeee-0000-4000-8000-000000019741'), row(2, 'eeeeeeee-0000-4000-8000-000000019742', { prefab: P, added: [kd(1), kd(2)] }),
    ] };
    const twoFiles = { id: O, version: PREFAB_FORMAT_VERSION, name: 'O', rootLocalId: 1, entities: [
      row(1, 'eeeeeeee-0000-4000-8000-000000019743'), row(2, 'eeeeeeee-0000-4000-8000-000000019744', { prefab: PN, added: [{ ...loose, name: 'Copied', key: minted() }] }),
    ] };
    for (const [what, doc] of [['one file', oneFile], ['two files', twoFiles]] as const) {
      const res = await write('/assets/O.prefab.json', doc);
      expect(res.status, what).toBe(422);
      expect(res.body.reason).toBe('prefab-identifier-repeated');
      expect(res.body.error).toMatch(/to two nodes in one frame/);
      expect(fs.existsSync(path.join(projectRoot, 'assets/O.prefab.json')), what).toBe(false);
    }
    // The accept side: the same O with its own key on the second node is written.
    expect((await write('/assets/O.prefab.json', { ...oneFile, entities: [oneFile.entities[0], { ...oneFile.entities[1], added: [kd(1), { ...kd(2), key: 'k-own' }] }] })).body).toMatchObject({ ok: true });
  });
});
