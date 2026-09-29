/** #1679 — the Assets panel's undo/redo steps change a file only while it holds what the step's other half left there.
 *
 *  An asset file is global and an undo entry outlives edits made elsewhere, so each of these used to overwrite or trash
 *  a later save: restore a deleted file over one recreated at its path, re-trash a restored file the user had edited,
 *  trash a duplicate / pasted copy / imported file / imported prefab edited since, trash a New Folder that files were
 *  dropped into. Every step now states its expectation and the ROUTE checks it (`ifMatch`, `createOnly`, `ifEmpty`).
 *
 *  Driven through the real builders and client helpers against `fakeAssetRoute.ts`, a disk that holds the bytes each
 *  write sent — so every accepted precondition was compared with the bytes really written.
 *
 *  Mutations, each checked: red on the named case (plus older cases driving the same path), green again once restored:
 *  - delete undo restores without `createOnly`: "a file recreated at a deleted path survives".
 *  - delete redo trashes every deletePath again (the old set): "a file recreated … survives" (redo half).
 *  - delete redo sends no `ifMatch`: "an edit to a restored file refuses the redo".
 *  - delete undo restores the file before its sidecars: "the sidecar collides first".
 *  - delete undo drops the put-back of a half-restored asset: "a collision part-way puts back what the asset wrote".
 *  - `trashCopies` sends no `ifMatch`: "an edited duplicate refuses" and "an edited pasted copy refuses".
 *  - duplicate redo keeps the old hash: "a re-minted JSON copy".
 *  - model import undo sends no `ifMatch`: its edited case; its redo writes without `createOnly`: its occupied case.
 *  - a re-import's undo trashes instead of restoring (`replaced ? previousContent : null` → `null`): "undo RESTORES";
 *    ignores an unreadable prior (drop the `previousContent === null` branch): "could not be read"; its redo expects an
 *    empty path after a restore: "undo RESTORES".
 *  - file import hashes the base64 TEXT: "a binary import round-trips".
 *  - file import undo sends no `ifMatch`: "an edited import refuses".
 *  - file import undo trashes every imported path (not `onDisk`): "a redo that skipped a taken path".
 *  - no settled baseline for a scanner-stamped JSON (`settledHashes` returns nothing, or skips the rescan, or the
 *    undo ignores `sha256`): "an import the scanner re-stamps".
 *  - folder trash sends no `ifEmpty`: both folder cases.
 *  #1696 (the settings precondition on a binary's committed sidecar), each red on its named cases only:
 *  - `trashCopies` sends no `ifSettings`: "duplicate → edit the copy's import settings" and "a pasted copy whose …".
 *  - the delete redo sends no `ifSettings`: "delete → undo → edit the restored import settings".
 *  - `sameImportSettings` compares raw (no resolver): "a NEVER-BAKED texture" and "a bake rewrites the restored".
 *  - the duplicate redo keeps the first copy's sidecar: "the undo after a redo expects the redo's sidecar".
 *  - `settingsExpectations` keeps `.meta.local.json`: "a restored machine-local half rides unguarded".
 *  Close-out review cases, each red alone: an OS-refused file's sidecar not overwritten ("…the original GUID comes
 *  back"); a failed write not stopping the asset ("a FAILED sidecar write…"); hashes taken after the writes ("…BEFORE
 *  the first write"); no BOM strip in `sha256OfBytes` ("…UTF-8 BOM…"); the settled read hashing decoded text ("…hashes
 *  BYTES…"); `readPriorDocument` taking the SPA fallback's HTML; any 409 read as a conflict ("…format gate…"). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeAssetRoute, sha256, type FakeAssetRoute } from './fakeAssetRoute';
import {
  makeDeleteUndo, makeDuplicateUndo, makePasteUndo, makeModelImportUndo, makeFileImportUndo,
  makeNewFolderUndo, makeEmptyFolderDeleteUndo, settledHashes, snapshotFromBytes, type DeleteResult, type Snapshot,
} from '../../src/editor/panels/assetUndo';
import { duplicateAssetFileReport, readPriorDocument } from '../../src/editor/panels/assetOps';
import { writeAssetFileGuarded } from '../../src/editor/backend/editorBackend';
import { sha256OfWritten } from '../../src/editor/utils/contentHash';
import { UndoRefusedError } from '../../src/editor/undo/undoFailure';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { resolveTextureSettings, resolveTextureType } from '../../src/runtime/loaders/textureSettings';
import type { AssetEntry } from '../../src/editor/utils/assetPaths';

let route: FakeAssetRoute;
let spies: Array<{ mockRestore: () => void }> = [];
const quiet = () => { spies.push(vi.spyOn(console, 'error').mockImplementation(() => {})); spies.push(vi.spyOn(console, 'warn').mockImplementation(() => {})); };

beforeEach(() => {
  route = makeFakeAssetRoute();
  vi.stubGlobal('fetch', route.fetch);
  useEditorStore.setState({ toast: null });
  quiet();
});
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; vi.unstubAllGlobals(); });

const A = (path: string, type = 'texture'): AssetEntry => ({ path, name: path.split('/').pop()!, type });
const b64 = (s: string) => Buffer.from(s).toString('base64');
/** A binary asset and its sidecar, as `collectDeletion` snapshots them: sidecar text, file base64. */
function binaryAsset(path: string, bytes: string, meta: string): DeleteResult {
  const snapshots: Snapshot[] = [
    { path, content: b64(bytes), encoding: 'base64' },
    { path: `${path}.meta.json`, content: meta },
  ];
  return { asset: A(path), snapshots, deletePaths: [path, `${path}.meta.json`, `${path}.meta.local.json`] };
}
const bytesOf = (p: string) => route.disk.get(p)?.toString('utf8');
const writesTo = (p: string) => route.calls.filter((c) => c.url.endsWith('/api/write-file') && c.body?.path === p);

describe('makeDeleteUndo', () => {
  it('a file recreated at a deleted path survives the undo AND the redo after it (the hub\'s sequence)', async () => {
    // Forward: both assets went to the trash. Then the user put a new b.png (and its own sidecar) at b's path.
    const a = binaryAsset('/assets/a.png', 'AAAA', '{"id":"ga"}');
    const b = binaryAsset('/assets/b.png', 'BBBB', '{"id":"gb"}');
    const action = makeDeleteUndo([a, b], vi.fn(), { missing: ['/assets/a.png.meta.local.json', '/assets/b.png.meta.local.json'] });
    route.put('/assets/b.png', 'USER');
    route.put('/assets/b.png.meta.json', '{"id":"user"}');

    await action.undo();
    // a came back, whole; b's path still holds the user's file and sidecar — nothing was written over either.
    expect(bytesOf('/assets/a.png')).toBe('AAAA');
    expect(bytesOf('/assets/a.png.meta.json')).toBe('{"id":"ga"}');
    expect(bytesOf('/assets/b.png')).toBe('USER');
    expect(bytesOf('/assets/b.png.meta.json')).toBe('{"id":"user"}');
    expect(useEditorStore.getState().toast?.kind).toBe('warn'); // the user can clear the path: told, not just logged

    await action.redo();
    // Only what the undo restored went back to the trash — b is not this entry's any more.
    expect(route.disk.has('/assets/a.png')).toBe(false);
    expect(route.disk.has('/assets/a.png.meta.json')).toBe(false);
    expect(bytesOf('/assets/b.png')).toBe('USER');
    expect(bytesOf('/assets/b.png.meta.json')).toBe('{"id":"user"}');

    // And the next undo does not go back for b at all.
    route.calls.length = 0;
    await action.undo();
    expect(bytesOf('/assets/a.png')).toBe('AAAA');
    expect(writesTo('/assets/b.png')).toHaveLength(0);
    expect(bytesOf('/assets/b.png')).toBe('USER');
  });

  it('an edit to a restored file refuses the redo, and nothing of the batch is trashed', async () => {
    const a = binaryAsset('/assets/a.png', 'AAAA', '{"id":"ga"}');
    const c = binaryAsset('/assets/c.png', 'CCCC', '{"id":"gc"}');
    const action = makeDeleteUndo([a, c], vi.fn());
    await action.undo();
    route.put('/assets/c.png', 'EDITED');

    await expect(action.redo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(bytesOf('/assets/a.png')).toBe('AAAA');
    expect(bytesOf('/assets/c.png')).toBe('EDITED');
    expect(bytesOf('/assets/c.png.meta.json')).toBe('{"id":"gc"}');
  });

  it('accept side: undo, redo, undo round-trips the exact bytes, binary included', async () => {
    const a = binaryAsset('/assets/a.png', '\u0000ÿ\u0010bin', '{"id":"ga"}');
    const action = makeDeleteUndo([a], vi.fn());
    await action.undo();
    expect(route.disk.get('/assets/a.png')).toEqual(Buffer.from('\u0000ÿ\u0010bin'));
    await action.redo();
    expect(route.disk.has('/assets/a.png')).toBe(false);
    await action.undo();
    expect(route.disk.get('/assets/a.png')).toEqual(Buffer.from('\u0000ÿ\u0010bin'));
    expect(useEditorStore.getState().toast).toBeNull();
  });

  it('the sidecar collides first, so a file whose sidecar path is taken is not written at all', async () => {
    const a = binaryAsset('/assets/a.png', 'AAAA', '{"id":"ga"}');
    route.put('/assets/a.png.meta.json', '{"id":"other"}');
    await makeDeleteUndo([a], vi.fn()).undo();
    expect(writesTo('/assets/a.png')).toHaveLength(0);
    expect(route.disk.has('/assets/a.png')).toBe(false); // never a file bound to somebody else's sidecar
    expect(bytesOf('/assets/a.png.meta.json')).toBe('{"id":"other"}');
  });

  it('a collision part-way puts back what the asset had already written — never half an asset', async () => {
    // A model: its sidecar and file are restored first, then the generated mesh's path turns out to be taken.
    const model: DeleteResult = {
      asset: A('/assets/m.glb', 'model'),
      snapshots: [
        { path: '/assets/m.glb', content: b64('GLB'), encoding: 'base64' },
        { path: '/assets/m.glb.meta.json', content: '{"id":"gm"}' },
        { path: '/assets/m.mesh.json', content: '{"id":"mesh"}' },
      ],
      deletePaths: ['/assets/m.glb', '/assets/m.glb.meta.json', '/assets/m.mesh.json'],
    };
    route.put('/assets/m.mesh.json', '{"id":"theirs"}');
    await makeDeleteUndo([model], vi.fn()).undo();
    expect(writesTo('/assets/m.glb')).toHaveLength(1); // it WAS written…
    expect(route.disk.has('/assets/m.glb')).toBe(false); // …and taken back
    expect(route.disk.has('/assets/m.glb.meta.json')).toBe(false);
    expect(bytesOf('/assets/m.mesh.json')).toBe('{"id":"theirs"}');
  });
});

describe('makeDeleteUndo — the close-out review\'s cases', () => {
  it('a sidecar whose file the OS REFUSED to trash is overwritten, so the original GUID comes back (not a collision)', async () => {
    // win32 #884: b.png was locked and stayed; its sidecar went, and the delete's inline rebuild minted a fresh one.
    const b = binaryAsset('/assets/b.png', 'BBBB', '{"id":"original"}');
    route.put('/assets/b.png', 'BBBB');
    route.put('/assets/b.png.meta.json', '{"id":"MINTED"}');
    const action = makeDeleteUndo([b], vi.fn(), { failed: ['/assets/b.png'], missing: ['/assets/b.png.meta.local.json'] });
    await action.undo();
    expect(bytesOf('/assets/b.png.meta.json')).toBe('{"id":"original"}');
    expect(useEditorStore.getState().toast).toBeNull(); // not reported as "another file is now at…"
    await action.redo(); // the retried file and its restored sidecar go together
    expect(route.disk.has('/assets/b.png')).toBe(false);
    expect(route.disk.has('/assets/b.png.meta.json')).toBe(false);
  });

  it('a FAILED sidecar write stops the asset — the file is never written bare — and the next undo restores it whole', async () => {
    const a = binaryAsset('/assets/a.png', 'AAAA', '{"id":"ga"}');
    const action = makeDeleteUndo([a], vi.fn());
    route.failWrites.add('/assets/a.png.meta.json');
    await action.undo();
    expect(route.disk.has('/assets/a.png')).toBe(false); // bare, the scanner would mint it a GUID of its own
    route.failWrites.clear();
    await action.undo(); // still this entry's to restore: a failure is not a collision
    expect(bytesOf('/assets/a.png')).toBe('AAAA');
    expect(bytesOf('/assets/a.png.meta.json')).toBe('{"id":"ga"}');
  });

  it('the hashes are taken BEFORE the first write, so a hash that cannot be computed refuses with nothing written', async () => {
    const a = binaryAsset('/assets/a.png', 'AAAA', '{"id":"ga"}');
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('insecure context'));
    try {
      await expect(makeDeleteUndo([a], vi.fn()).undo()).rejects.toBeInstanceOf(UndoRefusedError);
    } finally { digest.mockRestore(); }
    expect(writesTo('/assets/a.png')).toHaveLength(0);
    expect(writesTo('/assets/a.png.meta.json')).toHaveLength(0);
  });
});

describe('makeDeleteUndo — the close-out RE-review\'s cases', () => {
  /** A model whose .glb the OS refused to trash: its sidecar went, the heal minted `healed` for the bare file, and
   *  its generated mesh went too. */
  function refusedModel(healed: string) {
    const model: DeleteResult = {
      asset: A('/assets/m.glb', 'model'),
      snapshots: [
        { path: '/assets/m.glb', content: b64('GLB'), encoding: 'base64' },
        { path: '/assets/m.glb.meta.json', content: '{"id":"G1"}' },
        { path: '/assets/m.mesh.json', content: '{"id":"mesh"}' },
      ],
      deletePaths: ['/assets/m.glb', '/assets/m.glb.meta.json', '/assets/m.mesh.json'],
    };
    route.put('/assets/m.glb', 'GLB');
    route.put('/assets/m.glb.meta.json', healed);
    return makeDeleteUndo([model], vi.fn(), { failed: ['/assets/m.glb'] });
  }

  it('a collision part-way never trashes the refused file\'s sidecar — the overwrite goes LAST, so it never ran', async () => {
    const action = refusedModel('{"id":"G2"}');
    route.put('/assets/m.mesh.json', '{"id":"theirs"}');
    await action.undo();
    expect(bytesOf('/assets/m.glb.meta.json')).toBe('{"id":"G2"}'); // not trashed, not half-restored: left as it was
    expect(bytesOf('/assets/m.glb')).toBe('GLB');
  });

  it('an asset dropped on a collision is dropped WHOLE: the next redo does not retry trashing its refused file', async () => {
    const action = refusedModel('{"id":"G2"}');
    route.put('/assets/m.mesh.json', '{"id":"theirs"}');
    await action.undo();
    await action.redo();
    expect(bytesOf('/assets/m.glb')).toBe('GLB');
  });

  it('a failed write whose put-back also fails is reported, naming what is left on disk', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    spies.push(error);
    const a = binaryAsset('/assets/a.png', 'AAAA', '{"id":"ga"}');
    route.failWrites.add('/assets/a.png');
    route.fail.add('/api/delete-asset');
    await makeDeleteUndo([a], vi.fn()).undo();
    expect(error.mock.calls.some((c) => String(c[0]).includes('could not be taken back') && String(c[0]).includes('/assets/a.png.meta.json'))).toBe(true);
  });

  it('every asset\'s hashes are taken before the FIRST write of the undo, not per asset', async () => {
    const a = binaryAsset('/assets/a.png', 'AAAA', '{"id":"ga"}');
    const c = binaryAsset('/assets/c.png', 'CCCC', '{"id":"gc"}');
    const real = crypto.subtle.digest.bind(crypto.subtle);
    let n = 0;
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (alg, data) => {
      if (++n > 2) throw new Error('insecure context'); // a's two hash; c's fail
      return real(alg, data);
    });
    try {
      await expect(makeDeleteUndo([a, c], vi.fn()).undo()).rejects.toBeInstanceOf(UndoRefusedError);
    } finally { digest.mockRestore(); }
    expect(route.calls.filter((x) => x.url.endsWith('/api/write-file'))).toHaveLength(0);
  });

  it.each([['texture first', true], ['model first', false]])('a folder delete that lists a model AND its generated texture restores both (%s), with no false collision', async (_n, texFirst) => {
    // `handleDeleteFolder` builds one result for the model (its deletePaths include the generated files) and one for
    // each generated file as an asset of its own — so two results share paths.
    const tex = binaryAsset('/assets/f/textures/t.png', 'TEX', '{"id":"gt"}');
    const model: DeleteResult = {
      asset: A('/assets/f/z.glb', 'model'),
      snapshots: [
        { path: '/assets/f/z.glb', content: b64('GLB'), encoding: 'base64' },
        { path: '/assets/f/z.glb.meta.json', content: '{"id":"gz"}' },
        ...tex.snapshots,
      ],
      deletePaths: ['/assets/f/z.glb', '/assets/f/z.glb.meta.json', ...tex.deletePaths],
    };
    await makeDeleteUndo(texFirst ? [tex, model] : [model, tex], vi.fn(), { missing: ['/assets/f/z.glb.meta.local.json', '/assets/f/textures/t.png.meta.local.json'] }).undo();
    expect(bytesOf('/assets/f/z.glb')).toBe('GLB');
    expect(bytesOf('/assets/f/z.glb.meta.json')).toBe('{"id":"gz"}');
    expect(bytesOf('/assets/f/textures/t.png')).toBe('TEX');
    expect(bytesOf('/assets/f/textures/t.png.meta.json')).toBe('{"id":"gt"}');
    expect(useEditorStore.getState().toast).toBeNull();
  });

  it('a redo that retries a refused file takes the heal\'s sidecar with it, so the next undo restores the asset whole', async () => {
    const action = refusedModel('{"id":"G2"}');
    route.failWrites.add('/assets/m.glb.meta.json'); // the own-sidecar overwrite fails this time
    await action.undo();
    route.failWrites.clear();
    await action.redo(); // the retry now succeeds: m.glb — and the healed G2 beside it — go
    expect(route.disk.has('/assets/m.glb')).toBe(false);
    expect(route.disk.has('/assets/m.glb.meta.json')).toBe(false);
    await action.undo();
    expect(bytesOf('/assets/m.glb')).toBe('GLB');
    expect(bytesOf('/assets/m.glb.meta.json')).toBe('{"id":"G1"}');
    expect(bytesOf('/assets/m.mesh.json')).toBe('{"id":"mesh"}');
  });

  it('snapshotFromBytes: UTF-8 text stays text; non-UTF-8 text and binaries go byte-exact as base64', () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    expect(snapshotFromBytes('/assets/n.txt', latin1)).toEqual({ path: '/assets/n.txt', content: Buffer.from(latin1).toString('base64'), encoding: 'base64' });
    expect(snapshotFromBytes('/assets/p.json', new TextEncoder().encode('{"é":1}'))).toEqual({ path: '/assets/p.json', content: '{"é":1}' });
    expect(snapshotFromBytes('/assets/t.png', new Uint8Array([1, 2]))).toEqual({ path: '/assets/t.png', content: 'AQI=', encoding: 'base64' });
  });
});

describe('the prior-bytes read and the hash (close-out review)', () => {
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

  it('a file that starts with a UTF-8 BOM hashes the way the route does, for written bytes and for a settled read', async () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('newmtl x\n')]);
    expect(await sha256OfWritten(bom.toString('base64'), 'base64')).toBe(sha256(bom));
    route.put('/assets/m.mtl.txt', bom);
    expect((await settledHashes(['/assets/m.mtl.txt'])).get('/assets/m.mtl.txt')).toBe(sha256(bom));
  });

  it('a settled baseline hashes BYTES, so a non-UTF-8 text import still undoes', async () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1, invalid as UTF-8
    route.put('/assets/notes.txt', latin1);
    const settled = await settledHashes(['/assets/notes.txt']);
    const action = makeFileImportUndo({ imported: [{ path: '/assets/notes.txt', content: latin1.toString('base64'), sha256: settled.get('/assets/notes.txt') }], refresh: vi.fn() });
    await action.undo();
    expect(route.disk.has('/assets/notes.txt')).toBe(false);
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

describe('makeDuplicateUndo / makePasteUndo (copy)', () => {
  async function duplicate(from: string, to: string) {
    const r = await duplicateAssetFileReport(from, to);
    if (!r.ok) throw new Error(`premise: the duplicate landed — ${r.error}`);
    expect(r.ok).toBe(true);
    return { asset: A(from), toPath: to, sha256: r.sha256, sidecar: r.sidecar };
  }

  it('accept side: undo trashes the copy with its sidecars', async () => {
    route.put('/assets/t.png', 'PNG'); route.put('/assets/t.png.meta.json', '{"id":"t"}');
    const action = makeDuplicateUndo([await duplicate('/assets/t.png', '/assets/t copy.png')], vi.fn());
    await action.undo();
    expect(route.disk.has('/assets/t copy.png')).toBe(false);
    expect(route.disk.has('/assets/t copy.png.meta.json')).toBe(false);
  });

  it('an edited duplicate refuses the undo, and it and its sidecar stay', async () => {
    route.put('/assets/t.png', 'PNG'); route.put('/assets/t.png.meta.json', '{"id":"t"}');
    const action = makeDuplicateUndo([await duplicate('/assets/t.png', '/assets/t copy.png')], vi.fn());
    route.put('/assets/t copy.png', 'PAINTED');
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(bytesOf('/assets/t copy.png')).toBe('PAINTED');
    expect(route.disk.has('/assets/t copy.png.meta.json')).toBe(true);
  });

  it('a re-minted JSON copy: the undo after a redo expects the redo\'s bytes, not the first copy\'s', async () => {
    route.put('/assets/p.prefab.json', '{"id":"p","name":"P"}\n');
    const action = makeDuplicateUndo([await duplicate('/assets/p.prefab.json', '/assets/p copy.prefab.json')], vi.fn());
    await action.undo();
    await action.redo();
    const second = bytesOf('/assets/p copy.prefab.json');
    await action.undo(); // must not refuse: the copy holds exactly what the redo wrote
    expect(route.disk.has('/assets/p copy.prefab.json')).toBe(false);
    expect(second).toContain('dup-'); // it really was a different, re-minted document
  });

  it('an edited pasted copy refuses the undo', async () => {
    route.put('/assets/t.png', 'PNG');
    const r = await duplicateAssetFileReport('/assets/t.png', '/b/t.png');
    if (!r.ok) throw new Error(`premise: the duplicate landed — ${r.error}`);
    const action = makePasteUndo({ op: 'copy', done: [{ from: '/assets/t.png', to: '/b/t.png', sha256: r.sha256 }], refresh: vi.fn() });
    route.put('/b/t.png', 'PAINTED');
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(bytesOf('/b/t.png')).toBe('PAINTED');
  });

  it('a copy whose hash was never reported is refused, not trashed unguarded', async () => {
    route.put('/assets/t copy.png', 'PNG');
    await expect(makeDuplicateUndo([{ asset: A('/assets/t.png'), toPath: '/assets/t copy.png' }], vi.fn()).undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(route.disk.has('/assets/t copy.png')).toBe(true);
  });
});

describe('a binary\'s committed sidecar carries its IMPORT SETTINGS as a precondition (#1696)', () => {
  const PNG = '/assets/t.png';
  const COPY = '/assets/t copy.png';
  /** What a bake leaves in a sidecar with no user action: the resolved settings + type, a cache block, the stamp. */
  const baked = (meta: Record<string, unknown>) => ({
    ...meta, version: 2, type: resolveTextureType(meta), texture: resolveTextureSettings(meta),
    textureCache: { hash: 'h', variants: [] },
  });
  const sidecarOf = (p: string) => JSON.parse(bytesOf(`${p}.meta.json`)!) as Record<string, unknown>;
  async function duplicated() {
    route.put(PNG, 'PNG'); route.put(`${PNG}.meta.json`, '{"id":"t","texture":{"maxSize":512}}'); // never baked
    const r = await duplicateAssetFileReport(PNG, COPY);
    if (!r.ok) throw new Error(`premise: the duplicate landed — ${r.error}`);
    return makeDuplicateUndo([{ asset: A(PNG), toPath: COPY, sha256: r.sha256, sidecar: r.sidecar }], vi.fn());
  }

  it('duplicate → edit the copy\'s import settings → save → undo: refused, and the copy and its sidecar survive', async () => {
    const action = await duplicated();
    route.put(`${COPY}.meta.json`, JSON.stringify({ ...sidecarOf(COPY), texture: { maxSize: 256 } }));
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(route.disk.has(COPY)).toBe(true);
    expect(sidecarOf(COPY).texture).toEqual({ maxSize: 256 });
  });

  it('duplicate a NEVER-BAKED texture → view it (the bake fills in defaults) → undo: trashed, no refusal', async () => {
    const action = await duplicated();
    route.put(`${COPY}.meta.json`, JSON.stringify(baked(sidecarOf(COPY))));
    await action.undo();
    expect(route.disk.has(COPY)).toBe(false);
    expect(route.disk.has(`${COPY}.meta.json`)).toBe(false);
  });

  it('the undo after a redo expects the REDO\'s sidecar, which copies the source as it is then', async () => {
    const action = await duplicated();
    await action.undo();
    route.put(`${PNG}.meta.json`, '{"id":"t","texture":{"maxSize":64}}'); // the source's settings changed meanwhile
    await action.redo();
    expect(sidecarOf(COPY).texture).toEqual({ maxSize: 64 });
    await action.undo();
    expect(route.disk.has(`${COPY}.meta.json`)).toBe(false);
  });

  it('a pasted copy whose import settings were edited refuses the undo', async () => {
    route.put(PNG, 'PNG'); route.put(`${PNG}.meta.json`, '{"id":"t"}');
    const r = await duplicateAssetFileReport(PNG, '/b/t.png');
    if (!r.ok) throw new Error(`premise: the duplicate landed — ${r.error}`);
    const action = makePasteUndo({ op: 'copy', done: [{ from: PNG, to: '/b/t.png', sha256: r.sha256, sidecar: r.sidecar }], refresh: vi.fn() });
    route.put('/b/t.png.meta.json', JSON.stringify({ ...sidecarOf('/b/t.png'), texture: { srgb: false } }));
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(route.disk.has('/b/t.png.meta.json')).toBe(true);
  });

  it('delete → undo → edit the restored import settings → save → redo: refused, nothing trashed', async () => {
    const a = binaryAsset('/assets/a.png', 'AAAA', '{"id":"ga","texture":{"maxSize":512}}');
    const action = makeDeleteUndo([a], vi.fn());
    await action.undo();
    route.put('/assets/a.png.meta.json', '{"id":"ga","texture":{"maxSize":128}}');
    await expect(action.redo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(bytesOf('/assets/a.png')).toBe('AAAA');
    expect(bytesOf('/assets/a.png.meta.json')).toBe('{"id":"ga","texture":{"maxSize":128}}');
  });

  it('delete → undo → a bake rewrites the restored sidecar → redo: trashed, no refusal', async () => {
    const a = binaryAsset('/assets/a.png', 'AAAA', '{"id":"ga","texture":{"maxSize":512}}');
    const action = makeDeleteUndo([a], vi.fn());
    await action.undo();
    route.put('/assets/a.png.meta.json', JSON.stringify(baked(sidecarOf('/assets/a.png'))));
    await action.redo();
    expect(route.disk.has('/assets/a.png')).toBe(false);
    expect(route.disk.has('/assets/a.png.meta.json')).toBe(false);
  });

  it('a restored machine-local half rides unguarded: the redo still trashes the whole asset', async () => {
    const a = binaryAsset('/assets/a.png', 'AAAA', '{"id":"ga"}');
    a.snapshots.push({ path: '/assets/a.png.meta.local.json', content: '{"textureCache":{"bytes":4}}' });
    const action = makeDeleteUndo([a], vi.fn());
    await action.undo();
    expect(route.disk.has('/assets/a.png.meta.local.json')).toBe(true);
    await action.redo();
    expect(route.disk.has('/assets/a.png')).toBe(false);
    expect(route.disk.has('/assets/a.png.meta.local.json')).toBe(false);
  });

  it('the request names the committed sidecar in ifSettings, and never the machine-local half', async () => {
    const action = await duplicated();
    await action.undo();
    const del = route.calls.filter((c) => c.url.endsWith('/api/delete-asset')).at(-1)!;
    expect(Object.keys(del.body!.ifSettings as object)).toEqual([`${COPY}.meta.json`]);
  });
});

describe('makeModelImportUndo', () => {
  // A real prefab document: the undo is a `commitPrefabWrite` now (#1692), which parses what it restores.
  const content = '{"id":"rig","name":"Rig","entities":[]}\n';
  const setup = () => { route.put('/assets/rig.prefab.json', content); return makeModelImportUndo({ assetName: 'rig.glb', prefabPath: '/assets/rig.prefab.json', content }); };

  it('accept side: undo trashes the prefab, redo writes it back', async () => {
    const action = setup();
    await action.undo();
    expect(route.disk.has('/assets/rig.prefab.json')).toBe(false);
    await action.redo();
    expect(bytesOf('/assets/rig.prefab.json')).toBe(content);
  });

  it('an edited prefab refuses the undo and is kept', async () => {
    const action = setup();
    route.put('/assets/rig.prefab.json', '{"id":"rig","name":"Edited"}\n');
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(bytesOf('/assets/rig.prefab.json')).toContain('Edited');
  });

  it('a prefab made at the path since refuses the redo and is kept', async () => {
    const action = setup();
    await action.undo();
    route.put('/assets/rig.prefab.json', '{"id":"another"}\n');
    await expect(action.redo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(bytesOf('/assets/rig.prefab.json')).toBe('{"id":"another"}\n');
  });
});

describe('makeModelImportUndo — a RE-import over an existing prefab (close-out sweep, #1264 shape)', () => {
  const before = '{"id":"rig","name":"Before","entities":[]}\n';
  const after = '{"id":"rig","name":"After","entities":[]}\n';
  const setup = (previousContent: string) => {
    route.put('/assets/rig.prefab.json', after);
    return makeModelImportUndo({ assetName: 'rig.glb', prefabPath: '/assets/rig.prefab.json', content: after, previousContent });
  };

  it('undo RESTORES the prefab the import replaced — never trashes it — and redo re-applies the import', async () => {
    const action = setup(before);
    await action.undo();
    expect(bytesOf('/assets/rig.prefab.json')).toBe(before);
    await action.redo();
    expect(bytesOf('/assets/rig.prefab.json')).toBe(after);
    await action.undo();
    expect(bytesOf('/assets/rig.prefab.json')).toBe(before);
  });

  // (A replaced prefab that could not be read no longer reaches this undo: the import itself refuses to overwrite it
  // blind (#1692, Assets.tsx), so there is no third `previousContent` case to restore.)

  it('an edit to the re-imported prefab refuses the restore', async () => {
    const action = setup(before);
    route.put('/assets/rig.prefab.json', '{"id":"rig","name":"Edited"}\n');
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(bytesOf('/assets/rig.prefab.json')).toContain('Edited');
  });
});

describe('makeFileImportUndo', () => {
  it('a binary import round-trips: the baseline is the DECODED bytes the route stored', async () => {
    const png = b64('\u0089PNG\u0000\u0001');
    route.put('/assets/i.png', Buffer.from(png, 'base64'));
    const action = makeFileImportUndo({ imported: [{ path: '/assets/i.png', content: png }], refresh: vi.fn() });
    await action.undo();
    expect(route.disk.has('/assets/i.png')).toBe(false);
    await action.redo();
    expect(route.disk.get('/assets/i.png')).toEqual(Buffer.from(png, 'base64'));
  });

  it('an edited import refuses the undo, and nothing in the batch is trashed', async () => {
    route.put('/assets/i.png', Buffer.from(b64('ONE'), 'base64'));
    route.put('/assets/j.png', Buffer.from(b64('TWO'), 'base64'));
    const action = makeFileImportUndo({ imported: [{ path: '/assets/i.png', content: b64('ONE') }, { path: '/assets/j.png', content: b64('TWO') }], refresh: vi.fn() });
    route.put('/assets/j.png', 'PAINTED');
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(bytesOf('/assets/i.png')).toBe('ONE');
    expect(bytesOf('/assets/j.png')).toBe('PAINTED');
  });

  it('a redo that skipped a taken path leaves it out of the next undo', async () => {
    route.put('/assets/i.png', 'ONE'); route.put('/assets/j.png', 'TWO');
    const action = makeFileImportUndo({ imported: [{ path: '/assets/i.png', content: b64('ONE') }, { path: '/assets/j.png', content: b64('TWO') }], refresh: vi.fn() });
    await action.undo();
    route.put('/assets/j.png', 'THEIRS');
    await action.redo();
    expect(bytesOf('/assets/i.png')).toBe('ONE');
    expect(bytesOf('/assets/j.png')).toBe('THEIRS');
    expect(useEditorStore.getState().toast?.kind).toBe('warn');
    await action.undo(); // not refused: j is not in it
    expect(route.disk.has('/assets/i.png')).toBe(false);
    expect(bytesOf('/assets/j.png')).toBe('THEIRS');
  });

  it('an import the scanner re-stamps is not mistaken for an edit: the baseline is the settled file', async () => {
    const dropped = '{"name":"no id yet"}\n';
    route.put('/assets/fx.particle.json', dropped);
    // The scanner's GUID heal: an id-less JSON asset is rewritten with a minted id on the next scan.
    route.onRescan = () => { const cur = bytesOf('/assets/fx.particle.json'); if (cur && !cur.includes('"id"')) route.put('/assets/fx.particle.json', '{\n  "id": "minted",\n  "name": "no id yet"\n}\n'); };
    const settled = await settledHashes(['/assets/fx.particle.json']);
    expect(bytesOf('/assets/fx.particle.json')).toContain('minted'); // the heal ran BEFORE the read-back…
    expect(settled.get('/assets/fx.particle.json')).toBe(sha256(route.disk.get('/assets/fx.particle.json')!)); // …which hashed it
    const action = makeFileImportUndo({ imported: [{ path: '/assets/fx.particle.json', content: b64(dropped), sha256: settled.get('/assets/fx.particle.json') }], refresh: vi.fn() });
    await action.undo();
    expect(route.disk.has('/assets/fx.particle.json')).toBe(false);
  });
});

describe('folders', () => {
  const setters = { setPendingFolders: vi.fn(), setExpanded: vi.fn() };

  it('New Folder undo refuses a folder something was put in, and trashes one holding only OS litter', async () => {
    route.folders.add('/assets/F');
    route.put('/assets/F/dropped.png', 'X');
    await expect(makeNewFolderUndo({ path: '/assets/F', refresh: vi.fn(), ...setters }).undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(route.folders.has('/assets/F')).toBe(true);
    expect(bytesOf('/assets/F/dropped.png')).toBe('X');

    route.folders.add('/assets/G');
    route.put('/assets/G/.DS_Store', 'finder');
    await makeNewFolderUndo({ path: '/assets/G', refresh: vi.fn(), ...setters }).undo();
    expect(route.folders.has('/assets/G')).toBe(false);
  });

  it('Delete Folder redo refuses a recreated folder that is no longer empty', async () => {
    const action = makeEmptyFolderDeleteUndo({ folderPath: '/assets/E', folderName: 'E', refresh: vi.fn() });
    await action.undo(); // the fake's create-folder answers ok; the shell is back
    route.folders.add('/assets/E');
    route.put('/assets/E/new.png', 'X');
    await expect(action.redo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(bytesOf('/assets/E/new.png')).toBe('X');
  });
});
