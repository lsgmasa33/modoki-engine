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
import { relay } from './backendRelay';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readScannedSource } from '@modoki/engine/testing';
import {
  calleeName, declarationOf, findNodes, flatText, lineOf, parseSource, statementOf, ts, unwrapValue,
} from '@modoki/engine/testing/sourceAst';
import { handleBackendRequest, assetJsonBytes, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

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
    requestBrowser: relay(),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  };
  return { ...base, ...over } as unknown as BackendContext;
}

const post = (urlPath: string, body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body });

/** Every `writeJsonAtomic` call in a file, and whether each one's OWN bytes argument is an
 *  `assetJsonBytes(…)` call — inline, or a `const` that the argument RESOLVES to (#1179).
 *
 *  This was a line scan: a line holding `writeJsonAtomic(` passed if `assetJsonBytes(` appeared
 *  anywhere on it, or if its argument's NAME was declared from one anywhere in the file — so a
 *  producer beside the call on the same line, or a same-named const in another function, vouched for
 *  a write it has nothing to do with. `producedFrom` lists what each inline/bound producer serialises
 *  (its first argument's text). A reference to `writeJsonAtomic` that is not a call's callee (passed as
 *  a value) cannot be classified and is reported. */
export function jsonWrites(code: string, label: string): { calls: number; untyped: string[]; producedFrom: string[] } {
  const sf = parseSource(code, label);
  const producer = (e: ts.Expression | undefined): ts.CallExpression | undefined => {
    if (!e) return undefined;
    const u = unwrapValue(e);
    if (ts.isCallExpression(u)) return calleeName(u) === 'assetJsonBytes' && ts.isIdentifier(u.expression) ? u : undefined;
    if (!ts.isIdentifier(u)) return undefined;
    const decl = declarationOf(u);
    return decl && ts.isVariableDeclaration(decl) && (decl.parent.flags & ts.NodeFlags.Const) !== 0
      ? producer(decl.initializer) : undefined;
  };
  let calls = 0;
  const untyped: string[] = [];
  const producedFrom: string[] = [];
  for (const id of findNodes(sf, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === 'writeJsonAtomic')) {
    if (ts.isFunctionDeclaration(id.parent) && id.parent.name === id) continue;
    const call = ts.isCallExpression(id.parent) && id.parent.expression === id ? id.parent : undefined;
    if (!call) { untyped.push(`${label}:${lineOf(id)}: <not a call> ${flatText(statementOf(id))}`.replace(/;$/, '')); continue; }
    calls += 1;
    const made = call.arguments.length === 2 ? producer(call.arguments[1]) : undefined;
    if (made) producedFrom.push(made.arguments[0] ? flatText(made.arguments[0]) : '');
    else untyped.push(`${label}:${lineOf(call)}: ${flatText(call)}`);
  }
  return { calls, untyped, producedFrom };
}

beforeEach(() => { projectRoot = makeScratchDir('modoki-bytes-'); });
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
    const w = jsonWrites(readScannedSource(
      path.resolve(__dirname, '../../plugins/backend/editorBackendRouter.ts')).code, 'editorBackendRouter.ts');
    expect(w.calls, 'the writeJsonAtomic call scan found nothing — it has broken').toBeGreaterThanOrEqual(5);
    expect(w.untyped, 'a writeJsonAtomic call does not pass assetJsonBytes — not inline, and not '
      + 'through a const its own scope binds to one — so nothing states which serialisation it '
      + 'owns.\n\n' + w.untyped.join('\n')).toEqual([]);
    // And the scene caller specifically must be on the (now single) producer — this is the line
    // that used to read `sceneJsonBytes(scene)`.
    expect(w.producedFrom, 'the /api/scene-mutate writer no longer serialises `scene` through assetJsonBytes')
      .toContain('scene');
  });

  it('jsonWrites reads each call\'s OWN bytes argument (#1179)', () => {
    const scan = (body: string) => jsonWrites(`function writeJsonAtomic(absPath: string, bytes: Buffer): void {}\n${body}`, 'fixture.ts');
    // Inline, wrapped, and through a const of the call's own scope.
    expect(scan(`function a() { writeJsonAtomic(abs,
      assetJsonBytes(scene)); }
    function b() { const outBytes = assetJsonBytes(out); writeJsonAtomic(abs, outBytes); }
    function c() { const held = (assetJsonBytes(doc) as Buffer); writeJsonAtomic(abs, held!); }`))
      .toEqual({ calls: 3, untyped: [], producedFrom: ['scene', 'out', 'doc'] });
    // The line reader passed each of these: a producer elsewhere on the LINE, a same-named const in
    // ANOTHER function, a `let` reassigned after, the producer's name inside a string.
    expect(scan(`function c() { writeJsonAtomic(abs, JSON.stringify(x)); const y = assetJsonBytes(x); }
    function d() { const bytes = assetJsonBytes(out); }
    function e(bytes: Buffer) { writeJsonAtomic(abs, bytes); }
    function f() { let raw = assetJsonBytes(out); raw = Buffer.from('x'); writeJsonAtomic(abs, raw); }
    function g() { writeJsonAtomic(abs, Buffer.from('assetJsonBytes(scene)')); }
    function i() { writeJsonAtomic(abs, legacy.assetJsonBytes(scene)); }
    function j() { writeJsonAtomic(abs, sceneJsonBytes(scene)); }`).untyped.map((u) => u.replace(/^fixture\.ts:\d+: /, '')))
      .toEqual(['writeJsonAtomic(abs, JSON.stringify(x))', 'writeJsonAtomic(abs, bytes)', 'writeJsonAtomic(abs, raw)',
        "writeJsonAtomic(abs, Buffer.from('assetJsonBytes(scene)'))", 'writeJsonAtomic(abs, legacy.assetJsonBytes(scene))',
        'writeJsonAtomic(abs, sceneJsonBytes(scene))']);
    // A reference that is not the callee writes through a path nothing here reads.
    expect(scan(`function h() { save(writeJsonAtomic); }`).untyped.map((u) => u.replace(/^fixture\.ts:\d+: /, '')))
      .toEqual(['<not a call> save(writeJsonAtomic)']);
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
