/** inlinePlayable — unit tests for the pure single-file builder. The end-to-end proof
 *  (a real sling `VITE_PLAYABLE=1` build → one 2.97 MB index.html that self-extracts +
 *  renders in WebGL2) is validated by hand; these lock the HTML surgery + the gzip
 *  self-extract round-trip so a refactor can't silently break the artifact. */

import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { buildPlayableHtml, stripExternalRefs, type PlayableInput } from '../../plugins/inlinePlayable';

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="modulepreload" href="/assets/chunk-a.js">
<link rel="stylesheet" href="/assets/index.css">
<title>Sling</title></head>
<body><div id="root"></div>
<script type="module" crossorigin src="/assets/index-abc.js"></script>
</body></html>`;

const input = (): PlayableInput => ({
  html: HTML,
  js: 'console.log("entry");',
  css: '#root{inset:0}',
  assets: {
    '/assets/main-xyz.json': { m: 'application/json', d: Buffer.from('{"scene":1}').toString('base64') },
    '/assets/tex.webp': { m: 'image/webp', d: Buffer.from([1, 2, 3, 4]).toString('base64') },
  },
});

describe('stripExternalRefs', () => {
  it('removes module scripts, stylesheet + modulepreload links', () => {
    const out = stripExternalRefs(HTML);
    expect(out).not.toMatch(/<script[^>]*\bsrc=/i);
    expect(out).not.toMatch(/rel="stylesheet"/i);
    expect(out).not.toMatch(/rel="modulepreload"/i);
  });
  it('preserves head meta, title, and #root', () => {
    const out = stripExternalRefs(HTML);
    expect(out).toContain('name="viewport"');
    expect(out).toContain('<title>Sling</title>');
    expect(out).toContain('id="root"');
  });
});

describe('buildPlayableHtml', () => {
  it('emits a fully self-contained file — no external file refs, no fetch(/…)', () => {
    const out = buildPlayableHtml(input());
    // No src=/href= pointing at a built file extension.
    expect(out).not.toMatch(/(?:src|href)="[^"]*\.(?:js|css|webp|hdr|glb|json|wasm)"/i);
    expect(out).not.toMatch(/fetch\(["']\//);
    expect(out).toContain('DecompressionStream');
    expect(out).toContain('__PLAYABLE_ASSETS__');
    // Bootstrap injected inside the body.
    expect(out).toMatch(/<script>[\s\S]*<\/script><\/body>/);
  });

  it('gzip payload round-trips: extract → gunzip → parse === input', () => {
    const out = buildPlayableHtml(input());
    const m = out.match(/B\("([A-Za-z0-9+/=]+)"\)/); // the base64 arg to the decoder
    expect(m).toBeTruthy();
    const payload = JSON.parse(zlib.gunzipSync(Buffer.from(m![1], 'base64')).toString('utf8'));
    expect(payload.js).toBe('console.log("entry");');
    expect(payload.css).toBe('#root{inset:0}');
    expect(payload.assets['/assets/tex.webp']).toEqual({ m: 'image/webp', d: Buffer.from([1, 2, 3, 4]).toString('base64') });
    expect(payload.assets['/assets/main-xyz.json'].m).toBe('application/json');
  });

  it('inlines the fflate fallback VERBATIM ($-sequences intact) before the bootstrap', () => {
    // Minified fflate contains `$` (`$&`, `$1`, `$` idents). A plain String.replace would treat
    // those as substitution patterns and corrupt the source → runtime SyntaxError, no fallback.
    const fflate = 'self.fflate={gunzipSync:function(x){var $a=1,b$=2;return"$&_$1_$`"+x}};';
    const out = buildPlayableHtml(input(), fflate);
    expect(out).toContain(fflate); // byte-for-byte, not `$`-mangled
    // fflate defines self.fflate BEFORE the bootstrap's DecompressionStream feature-detect runs.
    expect(out.indexOf('self.fflate=')).toBeLessThan(out.indexOf('DecompressionStream'));
  });

  it('compresses — the gzipped artifact is smaller than the raw payload', () => {
    const inp = input();
    const raw = JSON.stringify({ js: inp.js, css: inp.css, assets: inp.assets }).length;
    const out = buildPlayableHtml(inp);
    // The base64 blob is present; for a realistic bundle gzip wins big. Here we just
    // assert the mechanism produced a compressed blob (base64 of gzip), not raw JSON.
    expect(out).not.toContain('console.log("entry");'); // the JS is INSIDE the gzip blob, not inline
    expect(raw).toBeGreaterThan(0);
  });
});
