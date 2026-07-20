/** Playable single-file inliner (Phase 4) — collapses a built `dist/` into ONE
 *  self-contained `index.html` for a "playable ad" (AppLovin etc.). See
 *  docs/playable-export.md.
 *
 *  WHY A SELF-EXTRACTING BLOB (not plain inline): the engine bundle is ~4.4 MB of JS.
 *  Inlined verbatim as `<script>` text + base64 assets it lands ~5.1 MB — just OVER the
 *  5 MB ceiling. So we gzip the whole payload (JS + CSS + assets) to a base64 blob and a
 *  tiny bootstrap inflates it at runtime via `DecompressionStream` (~2.7 MB on disk).
 *
 *  WHY BLOB URLs FOR ASSETS (not a fetch shim): the engine loads assets through THREE's
 *  loaders (`img.src`, XHR) as well as `fetch`, so a `fetch` monkeypatch would miss the
 *  image/model paths. Instead the bootstrap turns every inlined asset into a `blob:` URL
 *  and publishes `globalThis.__PLAYABLE_ASSETS__`; `assetUrl()` (runtime) resolves a
 *  root-absolute path to that blob URL, which fetch/XHR/img.src all load uniformly.
 *
 *  Trigger: `VITE_PLAYABLE=1` (see vite.config.ts, which also forces a single JS chunk via
 *  `inlineDynamicImports` and sets `MODOKI_PLAYABLE=1` so the asset profile shrinks assets).
 *  The pure builder `buildPlayableHtml` is unit-testable; the plugin does the FS + the
 *  hard ≤`playableMaxBytes` gate. */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

/** The fflate UMD source, read once at build time — inlined into the playable bootstrap as a
 *  DecompressionStream fallback (see buildPlayableHtml). Cached; resolved via node module
 *  resolution with a cwd/node_modules fallback. Returns '' if fflate can't be found (build still
 *  succeeds, DecompressionStream-only). */
let _fflateUmd: string | null = null;
function fflateUmd(): string {
  if (_fflateUmd == null) {
    try {
      const pkg = createRequire(import.meta.url).resolve('fflate/package.json');
      _fflateUmd = fs.readFileSync(path.join(path.dirname(pkg), 'umd', 'index.js'), 'utf8');
    } catch {
      try {
        _fflateUmd = fs.readFileSync(path.resolve(process.cwd(), 'node_modules/fflate/umd/index.js'), 'utf8');
      } catch {
        _fflateUmd = '';
      }
    }
  }
  return _fflateUmd;
}

const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr': 'image/vnd.radiance',
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.ktx2': 'image/ktx2',
  // Audio (mirror the scanner's AUDIO_EXTS). A correct MIME is load-bearing for a `stream`
  // clip: it becomes a `blob:` fed to `new Audio()` → a strict WKWebView (iOS ad slots) rejects
  // an `application/octet-stream` blob as MEDIA_ERR_SRC_NOT_SUPPORTED and the music won't play.
  // `buffer` clips (decodeAudioData) don't care, but keying them all correctly is free.
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};
const mimeFor = (p: string): string => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

/** An inlined asset: its serving MIME + base64 bytes. Keyed in the payload by its
 *  root-absolute URL path (e.g. `/assets/foo.webp`) — exactly what `assetUrl()` receives. */
export interface InlineAsset { m: string; d: string }

export interface PlayableInput {
  /** The built `index.html` (its head meta/#root are preserved; external script/style refs removed). */
  html: string;
  /** Concatenated entry JS (one chunk, `inlineDynamicImports`). */
  js: string;
  /** Concatenated CSS. */
  css: string;
  /** Reachable assets by root-absolute URL path. */
  assets: Record<string, InlineAsset>;
}

/** Strip `<script type=module src>`, `<link rel=stylesheet|modulepreload>`, and the favicon
 *  `<link rel=icon>` external refs from the built HTML — everything is inlined into the bootstrap
 *  instead. The favicon is inlined+deleted from disk by the caller, so its `<link href=/favicon.png>`
 *  would otherwise be a dangling 404 in a "fully offline" artifact (and a playable needs no favicon). */
export function stripExternalRefs(html: string): string {
  return html
    .replace(/<script\b[^>]*\bsrc=["'][^"']*["'][^>]*><\/script>/gi, '')
    .replace(/<link\b[^>]*\brel=["'](?:stylesheet|modulepreload)["'][^>]*>/gi, '')
    .replace(/<link\b[^>]*\brel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*>/gi, '');
}

/** Build the single self-contained `index.html` string. Pure (no FS): gzips the payload,
 *  base64s it, and injects the self-extract bootstrap before `</body>`.
 *
 *  `fflateUmdSrc` (the fflate UMD source, read by the plugin) is inlined as a DecompressionStream
 *  FALLBACK: `new DecompressionStream("gzip")` is iOS 16.4+ / Chrome 80+, and on an older ad
 *  webview it throws → the whole bootstrap rejected → a blank creative with no CTA. With fflate
 *  present the bootstrap decodes via `fflate.gunzipSync` instead, so the artifact runs everywhere.
 *  Omit it (tests) for a DecompressionStream-only build. */
export function buildPlayableHtml(input: PlayableInput, fflateUmdSrc = ''): string {
  const payload = JSON.stringify({ js: input.js, css: input.css, assets: input.assets });
  const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: 9 });
  const b64 = gz.toString('base64');

  // The self-extract bootstrap. Kept dependency-free and ES5-ish so it runs in any ad webview.
  // Feature-detects DecompressionStream and falls back to the inlined fflate.gunzipSync; the whole
  // thing is wrapped in try/catch so a decode failure surfaces (data-playable-error + console)
  // instead of a silent white screen.
  const bootstrap =
    '(async function(){try{' +
    'function B(s){var b=atob(s),n=b.length,u=new Uint8Array(n);for(var i=0;i<n;i++)u[i]=b.charCodeAt(i);return u;}' +
    'var gz=B(__P__);var bytes;' +
    'if(typeof DecompressionStream!=="undefined"){' +
    'bytes=new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());' +
    '}else if(self.fflate&&self.fflate.gunzipSync){bytes=self.fflate.gunzipSync(gz);' +
    '}else{throw new Error("no gzip decoder (DecompressionStream + fflate both unavailable)");}' +
    'var P=JSON.parse(new TextDecoder().decode(bytes));' +
    'var m={};for(var k in P.assets){var a=P.assets[k];m[k]=URL.createObjectURL(new Blob([B(a.d)],{type:a.m}));}' +
    'globalThis.__PLAYABLE_ASSETS__=m;' +
    'if(P.css){var s=document.createElement("style");s.textContent=P.css;document.head.appendChild(s);}' +
    'await import(URL.createObjectURL(new Blob([P.js],{type:"text/javascript"})));' +
    '}catch(e){(document.body||document.documentElement).setAttribute("data-playable-error",String((e&&e.message)||e));' +
    'if(typeof console!=="undefined")console.error("[playable] bootstrap failed:",e);}})();';
  // JSON.stringify the base64 so it's a safe JS string literal (base64 has no quotes/
  // backslashes/newlines, but this is future-proof and correct).
  // Function replacers throughout: the replacement STRINGS (base64 payload, and especially the
  // minified fflate UMD) contain `$` — a plain `String.replace(x, str)` would interpret `$&`/`$1`/…
  // as substitution patterns and CORRUPT them (→ "Invalid regular expression flags" at runtime,
  // fflate never defined). A function replacer returns its string verbatim.
  const script = '<script>' + bootstrap.replace('__P__', () => JSON.stringify(b64)) + '</script>';
  // fflate FIRST (defines self.fflate before the bootstrap runs). Verified it carries no
  // `B("<base64>")` literal that would shadow the payload extraction.
  const inject = (fflateUmdSrc ? '<script>' + fflateUmdSrc + '</script>' : '') + script;

  const stripped = stripExternalRefs(input.html);
  return stripped.includes('</body>')
    ? stripped.replace('</body>', () => inject + '</body>')
    : stripped + inject;
}

/** Vite plugin: after the asset scanner's `writeBundle`, collapse `dist/` into one
 *  `index.html` and enforce the byte cap. Runs only when `VITE_PLAYABLE=1`. */
export function inlinePlayablePlugin(maxBytes: number): Plugin {
  return {
    name: 'modoki-inline-playable',
    // `closeBundle` runs AFTER every `writeBundle` (incl. the asset scanner that
    // converts + copies the reachable assets), so dist/ is fully populated here.
    closeBundle() {
      if (process.env.VITE_PLAYABLE !== '1') return;
      const distDir = process.env.MODOKI_DIST_DIR || '';
      const indexPath = path.join(distDir, 'index.html');
      if (!distDir || !fs.existsSync(indexPath)) {
        this.warn(`[playable] no dist/index.html at ${distDir || '(unset MODOKI_DIST_DIR)'} — skipping inline.`);
        return;
      }
      const html = fs.readFileSync(indexPath, 'utf8');

      // Collect the external JS/CSS the HTML references (inlineDynamicImports ⇒ one JS
      // chunk, but be defensive about multiple + a CSS link).
      const inlinedFiles = new Set<string>();
      const readRef = (url: string): string => {
        const rel = url.replace(/^\//, '').split('?')[0];
        const abs = path.join(distDir, rel);
        inlinedFiles.add(path.resolve(abs));
        return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      };
      const js = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi)]
        .map((m) => readRef(m[1])).join('\n');
      const css = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi)]
        .map((m) => readRef(m[1])).join('\n');

      // Every OTHER file under dist/ becomes an inlined asset, keyed by its root-absolute
      // URL path. Skip index.html + the JS/CSS already inlined above.
      const assets: Record<string, InlineAsset> = {};
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) { walk(abs); continue; }
          if (abs === indexPath || inlinedFiles.has(path.resolve(abs))) continue;
          const urlPath = '/' + path.relative(distDir, abs).split(path.sep).join('/');
          assets[urlPath] = { m: mimeFor(abs), d: fs.readFileSync(abs).toString('base64') };
        }
      };
      walk(distDir);

      // GUARD (single-chunk invariant): a JS file that ISN'T the inlined entry is an
      // un-inlined dynamic-import chunk. React.lazy would `import()` it by its real
      // `/assets/*.js` URL — which does NOT route through `assetUrl`/the blob map — so it
      // would 404 at runtime and the lazy component (e.g. a renderer) would never mount:
      // a silently-blank playable. The build MUST collapse to one JS chunk
      // (`rollupOptions.output.codeSplitting:false`); fail loudly if it didn't rather than
      // ship a broken single file.
      const strayJs = Object.keys(assets).filter((p) => p.endsWith('.js'));
      if (strayJs.length) {
        this.error(
          `[playable] ${strayJs.length} un-inlined JS chunk(s) remain — the build did not collapse to a single ` +
          `bundle, so these would 404 at runtime (React.lazy imports them by URL):\n  ${strayJs.join('\n  ')}\n` +
          `Ensure VITE_PLAYABLE forces one chunk (rollupOptions.output.codeSplitting:false).`,
        );
      }

      const out = buildPlayableHtml({ html, js, css, assets }, fflateUmd());
      const bytes = Buffer.byteLength(out, 'utf8');

      // Leave ONLY index.html: delete the now-inlined external files so the artifact is
      // truly a single self-contained file (and `dist/` size reflects the real payload).
      for (const abs of inlinedFiles) if (fs.existsSync(abs)) fs.rmSync(abs);
      for (const p of Object.keys(assets)) {
        const abs = path.join(distDir, p.replace(/^\//, ''));
        if (fs.existsSync(abs)) fs.rmSync(abs);
      }
      // Prune now-empty asset dirs (best-effort).
      const assetsDir = path.join(distDir, 'assets');
      const pruneEmpty = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmpty(path.join(dir, e.name));
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      };
      pruneEmpty(assetsDir);

      fs.writeFileSync(indexPath, out);

      const mb = (n: number) => (n / 1048576).toFixed(2);
      // eslint-disable-next-line no-console
      console.log(`[playable] single-file index.html: ${mb(bytes)} MB (${Object.keys(assets).length} assets inlined, cap ${mb(maxBytes)} MB).`);
      if (bytes > maxBytes) {
        this.error(`[playable] index.html is ${mb(bytes)} MB — exceeds the ${mb(maxBytes)} MB cap (build.playableMaxBytes). Shrink assets (playable profile) or trim the engine module set.`);
      }
    },
  };
}
