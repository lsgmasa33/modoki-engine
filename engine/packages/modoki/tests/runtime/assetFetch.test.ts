/** assetFetch — dev-only no-store cache policy for asset-content fetches.
 *
 *  Guards the "editor loads a stale level" bug: in the editor (dev) a scene/prefab/
 *  asset re-fetched after a file change MUST read fresh, not a browser-cached copy.
 *  In a production build the default HTTP cache is kept (immutable assets). */

import { describe, it, expect } from 'vitest';
import { assetFetchInit, parseAssetJson, isMissingAsset } from '../../src/runtime/loaders/assetFetch';

describe('assetFetchInit', () => {
  it('bypasses the HTTP cache in dev (editor) — no-store', () => {
    expect(assetFetchInit(true)).toEqual({ cache: 'no-store' });
  });

  it('keeps the default cache in a production build', () => {
    expect(assetFetchInit(false)).toEqual({});
  });

  it('returns a value spreadable into fetch() options without clobbering others', () => {
    const signal = new AbortController().signal;
    const dev = { signal, ...assetFetchInit(true) };
    expect(dev).toEqual({ signal, cache: 'no-store' });
    const prod = { signal, ...assetFetchInit(false) };
    expect(prod).toEqual({ signal });
  });
});

/** `parseAssetJson` — a MISSING asset must not report itself as a corrupt one.
 *
 *  Vite answers an unknown path with `200 index.html`, so `res.ok` is true and `res.json()` throws
 *  `SyntaxError: Unexpected token '<', "<!doctype "…`. Six asset caches logged that verbatim, which
 *  made the most common authoring mistake on this engine (a ref pointing at a path that does not
 *  exist) indistinguishable from a genuinely broken file — and named the wrong one of the two. */
describe('parseAssetJson', () => {
  const res = (body: string, init?: { ok?: boolean; status?: number; statusText?: string }) => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    text: async () => body,
  }) as Response;

  it('parses a normal asset body', async () => {
    expect(await parseAssetJson(res('{"id":"x","maxParticles":10}'), '/a.particle.json'))
      .toEqual({ id: 'x', maxParticles: 10 });
  });

  it('turns the SPA fallback into a MISSING-asset error naming the path', async () => {
    await expect(parseAssetJson(res('<!doctype html><html><body>app</body></html>'), '/assets/particles/probe.particle.json'))
      .rejects.toThrow(/no asset at \/assets\/particles\/probe\.particle\.json/);
    // And it must NOT read as a parse failure — that was the whole defect.
    await expect(parseAssetJson(res('<!doctype html>'), '/p.json')).rejects.not.toThrow(/Unexpected token/);
  });

  it('recognises the fallback with leading whitespace and a bare <html>', async () => {
    await expect(parseAssetJson(res('\n  <!DOCTYPE HTML>\n<html>'), '/p.json')).rejects.toThrow(/does not exist/);
    await expect(parseAssetJson(res('<html lang="en">'), '/p.json')).rejects.toThrow(/does not exist/);
  });

  it('a REAL parse failure still says so — and now names the file', async () => {
    // The other half: this must not swallow genuine corruption into "missing".
    await expect(parseAssetJson(res('{"id": '), '/broken.particle.json'))
      .rejects.toThrow(/\/broken\.particle\.json is not valid JSON/);
  });

  it('a non-ok response reports status AND path', async () => {
    await expect(parseAssetJson(res('nope', { ok: false, status: 500, statusText: 'Server Error' }), '/p.json'))
      .rejects.toThrow(/500 Server Error for \/p\.json/);
  });
});

/** `isMissingAsset` — the machine-readable tag callers use to distinguish "no such asset" from a
 *  genuinely corrupt one, without matching message text (modeled on `isPluginUnimplemented` in
 *  `engine/app/ota.ts`). */
describe('isMissingAsset', () => {
  const res = (body: string, init?: { ok?: boolean; status?: number; statusText?: string }) => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    text: async () => body,
  }) as Response;

  it('is true for the SPA-fallback case', async () => {
    try {
      await parseAssetJson(res('<!doctype html><html></html>'), '/p.json');
      expect.unreachable();
    } catch (e) {
      expect(isMissingAsset(e)).toBe(true);
    }
  });

  it('is true for a non-ok response', async () => {
    try {
      await parseAssetJson(res('nope', { ok: false, status: 404, statusText: 'Not Found' }), '/p.json');
      expect.unreachable();
    } catch (e) {
      expect(isMissingAsset(e)).toBe(true);
    }
  });

  it('is false for a real JSON parse failure — a corrupt file must never read as absent', async () => {
    try {
      await parseAssetJson(res('{"id": '), '/broken.json');
      expect.unreachable();
    } catch (e) {
      expect(isMissingAsset(e)).toBe(false);
    }
  });

  it('is false for an unrelated error', () => {
    expect(isMissingAsset(new Error('some other failure'))).toBe(false);
    expect(isMissingAsset(null)).toBe(false);
    expect(isMissingAsset('not an error')).toBe(false);
  });
});
