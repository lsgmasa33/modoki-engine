/** ⚠️ **The bytes a JSON asset write puts on disk are fingerprinted in two other places, and a
 *  mismatch FAILS OPEN — silently, in the authoring path (#831).**
 *
 *  `markEditorWrite(abs, sha1(bytes))` is how the watcher skips the editor's own save. If the
 *  fingerprint is not the hash of what actually landed, the change event comes back ~150ms later,
 *  is read as an EXTERNAL edit, and `dropParkedWriteFor` discards whatever the human had parked —
 *  an edit made in the second after Cmd+S, gone, with no error anywhere. The router's own comments
 *  say so at both sites.
 *
 *  Until #831 those sites each spelled out `JSON.stringify(x, null, 2)` by hand, next to a writer
 *  that did the same — three transcriptions of one rule, kept in step by nothing. Adding the
 *  trailing newline the committed corpus expects meant touching all three, and getting two of
 *  three right would have been WORSE than leaving the bug: the newline would be correct and the
 *  self-write guard would be broken.
 *
 *  So `assetJsonBytes` is now the one definition and this asserts the agreement it exists to make
 *  checkable — against the FILE, not against a re-derivation of the same expression, which is the
 *  only version of this test that can fail when it should. `createAssetSelfWrite.test.ts` already
 *  covers `/api/create-asset` this way; the `/api/asset-write` self-write path — the one the asset
 *  views' parked edits flush through — had no such cover at all. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readScannedSource } from '@modoki/engine/testing';
import { handleBackendRequest, assetJsonBytes, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

let projectRoot = '';

function makeCtx(over: Partial<BackendContext> = {}): BackendContext {
  const base = {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  };
  return { ...base, ...over } as unknown as BackendContext;
}

const post = (urlPath: string, body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body });

beforeEach(() => { projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-bytes-')); });
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('assetJsonBytes is the one definition of what lands on disk (#831)', () => {
  it('ends every document with a trailing newline — asserted on the BYTES', () => {
    // Not a parsed round-trip: a parse-and-compare passes with or without the newline, which is
    // exactly how this defect survived in the corpus for so long.
    const bytes = assetJsonBytes({ a: 1 });
    expect(bytes[bytes.length - 1]).toBe(0x0a);
    expect(bytes.toString()).toBe('{\n  "a": 1\n}\n');
  });

  it('/api/asset-write fingerprints the bytes that actually landed on disk', async () => {
    // The gap this file was written for. `persistenceRouter` and `assetWriteFormatRefusal` both
    // stub markEditorWrite as a no-op, so nothing checked this route's hash against the file.
    const markEditorWrite = vi.fn();
    const ctx = makeCtx({ markEditorWrite });
    const res = (await post('/api/asset-write', {
      path: '/assets/probe.mat.json',
      type: 'material',
      data: { version: 1, type: 'pbr', color: 16777215, roughness: 0.5 },
      selfWrite: true,
    }, ctx)) as { body: { ok?: boolean } };

    expect(res.body.ok, 'the write itself must succeed, or this proves nothing').toBe(true);
    expect(markEditorWrite).toHaveBeenCalledOnce();
    const [abs, hash] = markEditorWrite.mock.calls[0] as [string, string];
    const onDisk = fs.readFileSync(abs);
    expect(onDisk[onDisk.length - 1], 'the flushed asset lost its trailing newline').toBe(0x0a);
    expect(hash, 'the self-write fingerprint does not match the file — the guard fails OPEN and a '
      + 'parked edit made just after this write would be silently discarded')
      .toBe(crypto.createHash('sha1').update(onDisk).digest('hex'));
  });

  /** ⚠️ **A SCENE now gets the SAME bytes as every other document — the two writers converged
   *  in #835.** Until then `assetJsonBytes` was asset-only and a separate `sceneJsonBytes` (no
   *  trailing newline) covered scenes/prefabs/layouts/AI-settings to agree with the editor's
   *  client-side save (`editor/scene/serialize.ts`), which emitted none. #835 moved that client
   *  writer onto `jsonFileBody` (`editor/backend/editorBackend.ts`) — the client mirror of THIS
   *  function, newline included — so `sceneJsonBytes` had nothing left to agree with and is gone.
   *
   *  Driving `/api/scene-mutate` itself needs a live browser (it relays `apply-scene-ops`), so the
   *  agreement is pinned where it actually lives: this function's bytes against what the client
   *  writer now produces. */
  it('assetJsonBytes reproduces exactly what serialize.ts now POSTs — WITH a trailing newline', () => {
    const scene = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', version: 1, entities: [] };
    // `editor/backend/editorBackend.ts`'s `jsonFileBody`: `` `${JSON.stringify(data, null, 2)}\n` ``
    // — the client mirror `editor/scene/serialize.ts` now composes scene bodies through.
    const whatTheClientWrites = Buffer.from(`${JSON.stringify(scene, null, 2)}\n`);
    expect(assetJsonBytes(scene).equals(whatTheClientWrites)).toBe(true);
    expect(assetJsonBytes(scene).at(-1)).toBe(0x0a); // '\n'
  });

  it('every writeJsonAtomic call — scene, layout, settings, asset — uses assetJsonBytes', () => {
    // A source check because the route needs a live browser. It is the half that actually
    // regressed once (#831 close-out): `writeJsonAtomic` used to take the DOCUMENT and serialise
    // it itself, so the scene caller silently inherited the asset newline. It now takes BYTES, and
    // this pins that every caller composes them with the one producer.
    // Through the shared reader (#812), not fs.readFileSync: the router's own PROSE mentions
    // `writeJsonAtomic` several times, and a comment that happens to contain a call-shaped string
    // would be counted as a call here — a guard satisfied by a comment is the defect that reader
    // exists to stop.
    const src = readScannedSource(
      path.resolve(__dirname, '../../plugins/backend/editorBackendRouter.ts')).code;
    // Line-based, and the DECLARATION is excluded explicitly: a span-matching regex ran from
    // `function writeJsonAtomic(` into the body and reported the signature as an offending call.
    const calls = src.split('\n')
      .filter((l) => l.includes('writeJsonAtomic(') && !l.includes('function writeJsonAtomic('));
    expect(calls.length, 'the writeJsonAtomic call scan found nothing — it has broken')
      .toBeGreaterThanOrEqual(5);
    // A call may name its producer INLINE (`writeJsonAtomic(abs, assetJsonBytes(out))`) or through
    // a local the same file assigns from one (`const outBytes = assetJsonBytes(out)` — which
    // /api/asset-write needs, because it also hashes those exact bytes into the reply and must not
    // serialise them twice). Either DECLARES which serialisation the call owns, which is the
    // claim; a bare identifier that traces to no producer does not, and still fails.
    const declaredFrom = (id: string) =>
      new RegExp(`(?:const|let)\\s+${id}\\s*(?::[^=]+)?=\\s*assetJsonBytes\\(`).test(src);
    const untyped = calls.filter((c) => {
      if (/assetJsonBytes\(/.test(c)) return false;
      const arg = /writeJsonAtomic\([^,]+,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(c);
      return !(arg && declaredFrom(arg[1]));
    });
    expect(untyped, 'a writeJsonAtomic call does not pass assetJsonBytes — not inline, and not '
      + 'through a local this file assigns from one — so nothing states which serialisation it '
      + 'owns.\n\n' + untyped.join('\n')).toEqual([]);
    // And the scene caller specifically must be on the (now single) producer — this is the line
    // that used to read `sceneJsonBytes(scene)`.
    expect(calls.some((c) => /assetJsonBytes\(scene\)/.test(c)),
      'the /api/scene-mutate writer no longer serialises `scene` through assetJsonBytes')
      .toBe(true);
  });

  it('the writer and `assetJsonBytes` produce identical bytes for the same document', async () => {
    // Ties the two together directly, so a future edit to either one alone is a red test rather
    // than a silent divergence between "what we hash" and "what we write".
    const doc = { version: 1, type: 'pbr', color: 255, nested: { a: [1, 2] } };
    const ctx = makeCtx();
    await post('/api/asset-write', { path: '/assets/x.mat.json', type: 'material', data: doc }, ctx);
    const onDisk = fs.readFileSync(path.join(projectRoot, 'assets/x.mat.json'));
    expect(onDisk.equals(assetJsonBytes(doc))).toBe(true);
  });
});
