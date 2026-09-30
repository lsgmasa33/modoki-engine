/** The client helpers a precondition rests on: what a path holds before a write replaces it (`readPriorDocument`), the
 *  hash a written body is compared by (`sha256OfWritten`), and which 409s are a precondition's conflict
 *  (`writeAssetFileGuarded`). Create Prefab, model import and the prefab commit all rest on them. Kept from
 *  `undoFilePreconditions.test.ts` when the Assets panel's file operations left undo (#1868, D2) — the builders those
 *  cases drove went, the helpers did not. Driven against `fakeAssetRoute.ts`, a disk that holds the bytes each write sent. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeAssetRoute, sha256, type FakeAssetRoute } from './fakeAssetRoute';
import { readPriorDocument } from '../../src/editor/panels/assetOps';
import { writeAssetFileGuarded } from '../../src/editor/backend/editorBackend';
import { sha256OfWritten } from '../../src/editor/utils/contentHash';
import { parkPrefab, clearDirtyAssets } from '../../src/editor/scene/dirtyAssets';
import { jsonFileBody } from '../../src/editor/backend/editorBackend';

let route: FakeAssetRoute;
let spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  route = makeFakeAssetRoute();
  vi.stubGlobal('fetch', route.fetch);
  spies.push(vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}));
});
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; vi.unstubAllGlobals(); });

describe('the prior-bytes read and the hash', () => {
  it('readPriorDocument: a JSON document is its bytes; a 404 and the SPA fallback\'s HTML are nothing; a 500 is unreadable', async () => {
    route.put('/assets/p.prefab.json', '{"id":"p"}\n');
    route.put('/assets/spa.prefab.json', '<!doctype html><html></html>');
    expect(await readPriorDocument('/assets/p.prefab.json')).toBe('{"id":"p"}\n');
    expect(await readPriorDocument('/assets/none.prefab.json')).toBeUndefined();
    expect(await readPriorDocument('/assets/spa.prefab.json')).toBeUndefined();
    route.put('/assets/corrupt.prefab.json', '{"id": "p", broken');
    expect(await readPriorDocument('/assets/corrupt.prefab.json')).toBeNull(); // corrupt is there, never "absent"
    route.fail.add('/assets/p.prefab.json');
    expect(await readPriorDocument('/assets/p.prefab.json')).toBeNull();
  });

  it('readPriorDocument: a PARKED prefab reads as the park, not the file (#1868, #1872)', async () => {
    // Every prefab writer replaces what the editor shows: the agent's `prefab create`, the model re-import and the rigged
    // regenerate read the file here and wrote over it without the parked edits. Mutation: drop the park read from
    // `readPriorDocument` — red.
    const onDisk = { id: 'p', name: 'P', rootLocalId: 1, entities: [] };
    const park = { ...onDisk, entities: [{ localId: 1, name: 'Parked', traits: {} }] };
    route.put('/assets/p.prefab.json', `${JSON.stringify(onDisk)}\n`);
    parkPrefab('/assets/p.prefab.json', park, onDisk);
    try {
      expect(await readPriorDocument('/assets/p.prefab.json')).toBe(jsonFileBody(park as never));
      expect(await readPriorDocument('/assets/other.prefab.json'), 'an unparked path still reads the file').toBeUndefined();
    } finally { clearDirtyAssets(); }
  });

  it('a file that starts with a UTF-8 BOM hashes the way the route does', async () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('newmtl x\n')]);
    expect(await sha256OfWritten(bom.toString('base64'), 'base64')).toBe(sha256(bom));
  });

  it('writeAssetFileGuarded: only the precondition\'s own 409s are a conflict — the prefab format gate is a failure', async () => {
    const answer = (body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status: 409 }));
    vi.stubGlobal('fetch', answer({ ok: false, conflict: true, reason: 'prefab-format-too-new', error: 'written by a newer build' }));
    expect(await writeAssetFileGuarded('/assets/p.prefab.json', '{}', { ifMatch: 'h' })).toEqual({ result: 'failed', error: 'written by a newer build' });
    vi.stubGlobal('fetch', answer({ ok: false, conflict: true, reason: 'if-match' }));
    expect((await writeAssetFileGuarded('/assets/p.prefab.json', '{}', { ifMatch: 'h' })).result).toBe('conflict');
    vi.stubGlobal('fetch', answer({ ok: false, conflict: true, reason: 'if-none-match' }));
    expect((await writeAssetFileGuarded('/assets/p.prefab.json', '{}', { createOnly: true })).result).toBe('conflict');
  });
});
