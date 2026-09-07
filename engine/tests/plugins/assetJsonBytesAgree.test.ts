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
import { handleBackendRequest, assetJsonBytes, sceneJsonBytes, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

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

  /** ⚠️ **A SCENE must NOT get the asset newline — the two writers have to agree (#831 close-out).**
   *
   *  This is the regression the first cut of #831 shipped and the review caught. `assetJsonBytes`
   *  was introduced for asset documents, but `writeJsonAtomic` is shared and its SCENE caller
   *  (`/api/scene-mutate`) went with it — while the editor's own save serialises client-side and
   *  still emits none. An agent's `mutate_scene` would add the newline, the human's next Cmd+S
   *  would strip it, forever, on the repo's most-committed documents. Every committed
   *  `.scene.json` ends `}` today, which is what makes this the correct direction, not an
   *  arbitrary one.
   *
   *  Driving `/api/scene-mutate` itself needs a live browser (it relays `apply-scene-ops`), so the
   *  agreement is pinned where it actually lives: the two serialisations, and the call site that
   *  chooses between them. When #835 fixes the client seam these flip together with
   *  `serialize.ts` — in one commit, not before. */
  it('sceneJsonBytes reproduces exactly what serialize.ts POSTs — no trailing newline', () => {
    const scene = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', version: 1, entities: [] };
    // `editor/scene/serialize.ts:905`: `const content = JSON.stringify(scene, null, 2);`
    const whatTheClientWrites = Buffer.from(JSON.stringify(scene, null, 2));
    expect(sceneJsonBytes(scene).equals(whatTheClientWrites)).toBe(true);
    expect(sceneJsonBytes(scene).at(-1)).toBe(0x7d);          // '}'
    expect(assetJsonBytes(scene).at(-1)).toBe(0x0a);          // '\n' — asset docs differ, on purpose
  });

  it('the scene, layout and settings writers use sceneJsonBytes; the asset writers use assetJsonBytes', () => {
    // A source check because the route needs a live browser. It is the half that actually
    // regressed: `writeJsonAtomic` used to take the DOCUMENT and serialise it itself, so the scene
    // caller silently inherited the asset newline. It now takes BYTES, and this pins that no
    // caller picks the wrong producer.
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
    const untyped = calls.filter((c) => !/assetJsonBytes\(|sceneJsonBytes\(/.test(c));
    expect(untyped, 'a writeJsonAtomic call passes neither assetJsonBytes nor sceneJsonBytes, so '
      + 'nothing states which serialisation it owns. That is how the scene writer silently '
      + 'inherited the asset trailing newline.\n\n' + untyped.join('\n')).toEqual([]);
    // And the scene caller specifically must be on the client-matching one.
    expect(calls.some((c) => /sceneJsonBytes\(scene\)/.test(c)),
      'the /api/scene-mutate writer no longer uses sceneJsonBytes — it will churn against Cmd+S')
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
