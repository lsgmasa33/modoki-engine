/**
 * The browser-side half of #1799's answer: the renderer and runtime do NOT need jsonFile.mjs.
 *
 * A fetch body's `text()` / `json()` run the spec's "UTF-8 decode", which drops a leading BOM, and a
 * `new TextDecoder()` does the same by default (`ignoreBOM: false`). Surveyed 2026-09-29: every
 * renderer path that turns bytes into JSON goes through one of those two — the asset loaders via
 * `parseAssetJson` (`res.text()`), `prefabCommit.ts`'s change probe and `rigBones.ts` via a default
 * `TextDecoder`. The two places that keep a BOM on purpose (`readPriorDocument`, `prefabCommit.ts`'s
 * `readState`: `ignoreBOM: true`, so a verbatim restore puts the exact bytes back) strip it before
 * they parse. This pins the premise all of that rests on, through the real `parseAssetJson`.
 * Runs on Node's fetch `Response`, which implements the same spec decode as the browser's.
 */
import { describe, it, expect } from 'vitest';
import { parseAssetJson } from '../../src/runtime/loaders/assetFetch';

const BOM = [0xef, 0xbb, 0xbf];
const bytes = (text: string, bom: boolean) => new Uint8Array([...(bom ? BOM : []), ...new TextEncoder().encode(text)]);
const DOC = '{\r\n  "id": "59dee356-b657-4bdf-a3b5-8274b975becc",\r\n  "name": "Crate"\r\n}\r\n';

describe('the renderer reads a BOM-prefixed JSON asset without a helper (#1799)', () => {
  it('parseAssetJson parses a BOM + CRLF body — Response.text() drops the BOM', async () => {
    const res = new Response(bytes(DOC, true), { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(parseAssetJson(res, '/assets/prefabs/Crate.prefab.json')).resolves.toEqual({
      id: '59dee356-b657-4bdf-a3b5-8274b975becc', name: 'Crate',
    });
  });

  it('a default TextDecoder drops it too; ignoreBOM: true keeps it, which is why those callers strip', () => {
    expect(new TextDecoder().decode(bytes('{}', true))).toBe('{}');
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes('{}', true))).toBe('\uFEFF{}');
    expect(() => JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes('{}', true)))).toThrow();
  });
});
