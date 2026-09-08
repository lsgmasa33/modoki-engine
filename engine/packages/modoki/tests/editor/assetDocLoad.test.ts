/** The shared asset-document load verdict (#886/#896).
 *
 *  The property under test is a DISTINCTION, not a boolean: "absent" and "unreadable" arrive at the
 *  same `.catch` and must come out different, because the callers do opposite things with them —
 *  substitute defaults vs refuse to hold a document at all. A guard proved only on its refuse side
 *  would pass while making every brand-new asset unauthorable, so both sides are asserted here. */

import { describe, it, expect } from 'vitest';
import { classifyAssetDocFetchFailure } from '../../src/editor/panels/assetDocLoad';
import { MissingAssetError, assetIsAbsent, isMissingAsset, parseAssetJson } from '../../src/runtime/loaders/assetFetch';
import { classifyParticleFetchFailure } from '../../src/editor/panels/particleLoadPersist';

/** A `Response` stand-in for `parseAssetJson`, which only reads `.ok`/`.status`/`.text()`. */
function res(body: string, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: 'x',
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('classifyAssetDocFetchFailure', () => {
  it('reports an ABSENT MissingAssetError as missing — the caller may substitute defaults', () => {
    expect(classifyAssetDocFetchFailure(new MissingAssetError('404 for /a.anim.json', { status: 404, absent: true })))
      .toEqual({ kind: 'missing' });
  });

  it('reports a JSON parse failure as refused, carrying the message', () => {
    const v = classifyAssetDocFetchFailure(new SyntaxError('Unexpected token < in JSON at position 0'));
    expect(v.kind).toBe('refused');
    expect(v.kind === 'refused' && v.message).toContain('Unexpected token');
  });

  it('reports a network rejection as refused', () => {
    expect(classifyAssetDocFetchFailure(new TypeError('Failed to fetch')))
      .toEqual({ kind: 'refused', message: 'Failed to fetch' });
  });

  it('stringifies a non-Error rejection rather than dropping the reason', () => {
    expect(classifyAssetDocFetchFailure('boom')).toEqual({ kind: 'refused', message: 'boom' });
  });

  it('reports an ABORT as refused — the documented contract, and why callers must filter it first', () => {
    // Not an oversight and not a third verdict kind: this cannot tell an abort from a real failure,
    // so `assetDocLoad.ts` requires the caller to filter it BEFORE asking. Every current caller does
    // (a `cancelled` flag checked at the top of its `.catch`). Pinned so that contract is a decision
    // on the record rather than an accident a future AbortController-using caller trips over.
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    expect(classifyAssetDocFetchFailure(abort).kind).toBe('refused');
  });

  it('is exactly what particleLoadPersist re-exports — one definition, not two copies', () => {
    // The whole point of #896's extraction. If these ever become separate functions, the two halves
    // of the class drift and `.particle.json` gets a different answer from `.anim.json`.
    expect(classifyParticleFetchFailure).toBe(classifyAssetDocFetchFailure);
  });
});

describe('the missing/unreadable distinction, driven through parseAssetJson', () => {
  // This is the pairing that matters: the verdict is only as good as the error it classifies, and
  // `MaterialBatchView` proved a caller can be structurally incapable of producing the `missing`
  // one (a raw `r.json()` rejects with a bare SyntaxError for BOTH cases). These assert that the
  // real producer separates them.

  it("Vite's SPA fallback (200 index.html) classifies as MISSING, not corrupt", async () => {
    const e = await parseAssetJson(res('<!doctype html><html></html>'), '/a.anim.json').catch((x) => x);
    expect(classifyAssetDocFetchFailure(e)).toEqual({ kind: 'missing' });
  });

  it('a 404 / 410 classifies as MISSING — the file really is not there', async () => {
    for (const status of [404, 410]) {
      const e = await parseAssetJson(res('', { ok: false, status }), '/a.anim.json').catch((x) => x);
      expect(classifyAssetDocFetchFailure(e), `status ${status}`).toEqual({ kind: 'missing' });
    }
  });

  it('⚠️ a 5xx / 401 / 403 classifies as REFUSED, NOT missing — the file may well exist', async () => {
    // The finding that reopened this whole defect after it was "fixed". `MissingAssetError` is
    // thrown for EVERY non-ok status, so the obvious `isMissingAsset(e)` made a transient 500 mean
    // "absent" — and `AnimationEditor` then opened `defaultAnimationClip(newGuid())` and marked it
    // equal-to-disk, which is verbatim the pre-fix destruction on a file that was merely
    // unreadable. There is a real producer: `plugins/backend/writeResult.ts` answers 500 when
    // `createReadStream` errors on a file `existsSync` just confirmed (EMFILE under a scene-load
    // fan-out, EACCES, EBUSY on Windows). `assetIsAbsent` is what narrows it.
    for (const status of [500, 502, 503, 401, 403]) {
      const e = await parseAssetJson(res('', { ok: false, status }), '/a.anim.json').catch((x) => x);
      expect(classifyAssetDocFetchFailure(e).kind, `status ${status}`).toBe('refused');
    }
  });

  it('the wide predicate still answers "did not come back" for every non-ok status', async () => {
    // `isMissingAsset` is NOT wrong — it is a different question, and the eight readers that show
    // nothing on a failed read still want it. Pinned so a future "simplification" cannot collapse
    // the two predicates back into one and silently re-widen the substitution decision.
    for (const status of [404, 500, 403]) {
      const e = await parseAssetJson(res('', { ok: false, status }), '/a.anim.json').catch((x) => x);
      expect(isMissingAsset(e), `status ${status}`).toBe(true);
      expect(assetIsAbsent(e), `status ${status}`).toBe(status === 404);
    }
  });

  it('a CORRUPT body classifies as REFUSED — this is the half that must not get defaults', async () => {
    // A conflict-markered file is the concrete case: it is present, it is authored content, and
    // substituting defaults over it destroys whatever was still recoverable.
    const e = await parseAssetJson(res('<<<<<<< HEAD\n{"id":"a"}\n'), '/a.anim.json').catch((x) => x);
    expect(classifyAssetDocFetchFailure(e).kind).toBe('refused');
  });

  it('a VALID document does not reject at all — the accept side', async () => {
    await expect(parseAssetJson(res('{"id":"a","tracks":[]}'), '/a.anim.json'))
      .resolves.toEqual({ id: 'a', tracks: [] });
  });
});
