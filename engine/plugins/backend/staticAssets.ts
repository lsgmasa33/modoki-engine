/**
 * Shared static byte-serving for project assets + the packaged renderer shell
 * (ELECTRON_PLAN Phase 7). Mirrors the Phase-1 `editorBackendRouter` extraction:
 * the exact same logic the Vite dev middleware used inline is now a transport-
 * agnostic function so the Electron main HTTP backend serves project assets
 * byte-for-byte the same way — full dev/prod parity, one origin.
 *
 *   - `serveProjectAsset` — a GET for a project asset URL (`/games/x/foo.webp`,
 *     the Basis transcoder, a cached model-LOD GLB, a cached texture variant).
 *     Returns a BackendResult, or null to fall through (Vite module / 404).
 *   - `serveAppShell` — the built editor renderer (`dist/index.html` + `assets/*`),
 *     served ONLY by the Electron backend in a packaged/prod build (in dev the
 *     Vite server owns the shell). SPA hash routing ⇒ unknown paths fall back to
 *     `index.html`.
 *
 * Node-only (fs): consumed by `plugins/vite-asset-scanner.ts` and
 * `electron/backendServer.ts`, never the browser.
 */

import fs from 'fs';
import path from 'path';
import { readMetaSidecar } from '../meta-sidecar';
import { getCacheDir, cachePathFor } from '../texture-cache';
import { getAudioCacheDir, audioCachePathFor } from '../audio-cache';
import { getEnvCacheDir, envCachePathFor } from '../env-cache';
import { getFontCacheDir, atlasCachePath, metricsCachePath } from '../font-cache';
import { getModelCacheDir, lodCachePath } from '../model-cache';
import { atlasPageUrlPath } from '../atlas-cache';
import { getReimportHandler, type ReimportContext, type ReimportAsset } from '../reimport-registry';
import type { TextureVariant } from '../../packages/modoki/src/runtime/loaders/textureSettings';
import type { AtlasCacheBlock } from '../../packages/modoki/src/runtime/loaders/spriteAtlas';
import type { BackendContext, BackendResult } from './editorBackendRouter';

/** Content types for both project asset bytes and the built renderer shell.
 *  Includes the script/wasm/html types the packaged shell needs (the dev server
 *  got those from Vite). */
export const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.hdr': 'application/octet-stream',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.css': 'text/css',
  '.wgsl': 'text/plain', '.glsl': 'text/plain',
  // Convertible model sources + their companions (served to the in-browser
  // OBJ/FBX/DAE loaders during conversion). .obj/.mtl are text; .fbx/.dae/.bin
  // are binary but parsed from the raw bytes regardless of content-type.
  '.obj': 'text/plain', '.mtl': 'text/plain', '.fbx': 'application/octet-stream',
  '.dae': 'model/vnd.collada+xml', '.bin': 'application/octet-stream',
  // Renderer shell (packaged build): module scripts, wasm, html.
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.wasm': 'application/wasm', '.html': 'text/html', '.map': 'application/json',
  '.ico': 'image/x-icon', '.txt': 'text/plain',
};

const raw = (contentType: string, body: Buffer, status?: number): BackendResult =>
  ({ kind: 'raw', contentType, body, ...(status != null ? { status } : {}) });

/** Stream a file from disk (not buffered) — for asset bytes which can be large. */
const file = (contentType: string, absPath: string, headers?: Record<string, string>): BackendResult =>
  ({ kind: 'file', contentType, path: absPath, ...(headers ? { headers } : {}) });

/** Genuinely content-addressed URLs (the hash IS in the path) — cache forever.
 *  Only the Basis transcoder qualifies here; its bytes never change. */
const IMMUTABLE = { 'Cache-Control': 'public, max-age=31536000, immutable' } as const;

/** Revalidating cache policy for the converted model + texture *variant* URLs.
 *  These are NOT content-addressed in the URL: the editor/dev backend serves them
 *  query-agnostic (`<model>.glb.processed.glb`, `<src>~uastc.ktx2`) — the hash
 *  lives only in the meta sidecar + cache *disk* path, and `modelGlbUrl` /
 *  `resolveTextureVariantUrl` append `?v=<hash>` ONLY in the GCS prod build, never
 *  here. So `immutable` was a LIE: after a re-bake (e.g. a `recipeVersion` bump
 *  that adds the island's planar UVs) the bytes at the same URL change but the
 *  browser keeps serving its year-cached copy → grass renders untextured until you
 *  manually "Disable cache". `no-cache` makes the browser revalidate every load;
 *  the content hash as `ETag` lets `writeBackendResult` answer a cheap 304 when the
 *  bake is unchanged, and a 200 with fresh bytes the moment it changes. */
const revalidate = (hash: string) =>
  ({ 'Cache-Control': 'no-cache', ETag: `"${hash}"` }) as const;

/** Extra capabilities the host can grant `serveProjectAsset` so a variant
 *  cache-miss SELF-HEALS instead of 404ing — the editor auto-imports a model/
 *  texture whose optimized variant was never baked on this machine/worktree
 *  (the `.cache/` dir is gitignored, so a fresh checkout has the committed meta
 *  hash but no local bytes). Off by default: a packaged Electron build ships
 *  pre-baked variants in `dist/` and has neither `toktx` nor an SSR loader, so it
 *  keeps the loud 404. The Vite dev/editor server turns it on. */
export interface AutoConvertCaps {
  /** Enable on-demand baking on a variant cache-miss. */
  autoConvert?: boolean;
  /** SSR module loader (Vite) — needed for a static model's postprocessor Stage-A
   *  bake. Absent ⇒ the model converter falls back to a passthrough copy. */
  ssrLoadModule?: (url: string) => Promise<Record<string, unknown>>;
  /** Project asset snapshot — the atlas auto-bake resolves member sprites through it. */
  listAssets?: () => ReimportAsset[];
}

/** De-dupe concurrent bakes of the SAME source: a model produces `processed.glb`
 *  + every `lod<N>.glb` in one run, and the loader fetches several of those URLs
 *  back-to-back, so without this each would kick its own (expensive) re-encode.
 *  Keyed by absolute source path — a source is either a model or a texture. */
const inFlightBakes = new Map<string, Promise<void>>();

function dedupeBake(absSource: string, run: () => Promise<void>): Promise<void> {
  let p = inFlightBakes.get(absSource);
  if (!p) {
    p = run().finally(() => inFlightBakes.delete(absSource));
    inFlightBakes.set(absSource, p);
  }
  return p;
}

/** On a variant cache-miss, run the asset type's reimport handler (which
 *  regenerates the cache + rewrites the meta hash), then re-resolve via the
 *  caller's `resolveCached` against the FRESH meta. Returns the served result, or
 *  null to fall through to the existing loud 404. Never throws — a bake failure
 *  (e.g. `toktx` missing) degrades to the 404 so the missing variant stays
 *  visible rather than masking the source. */
async function autoBakeThenServe(
  ctx: Pick<BackendContext, 'projectRoot' | 'resolveAssetPath'> & AutoConvertCaps,
  assetType: 'model' | 'texture' | 'atlas' | 'audio' | 'font' | 'environment',
  sourceUrl: string,
  absSource: string,
  resolveCached: () => BackendResult | null,
): Promise<BackendResult | null> {
  if (!ctx.autoConvert || !fs.existsSync(absSource)) return null;
  const handler = getReimportHandler(assetType);
  if (!handler) return null;
  const reimportCtx: ReimportContext = {
    projectRoot: ctx.projectRoot,
    resolveAssetPath: ctx.resolveAssetPath,
    ssrLoadModule: ctx.ssrLoadModule,
    listAssets: ctx.listAssets,
  };
  try {
    await dedupeBake(absSource, () => handler(sourceUrl, absSource, reimportCtx));
  } catch (e) {
    console.error(`[asset-scanner] on-demand ${assetType} bake failed for ${sourceUrl}:`, e);
    return null;
  }
  return resolveCached();
}

/** Static byte-serving for project assets. The Electron backend and the Vite dev
 *  middleware both call this for a non-`/api` GET before falling through. Returns
 *  null when the URL matches no asset shape (caller serves the app shell / 404 /
 *  hands off to Vite). Only needs projectRoot + resolveAssetPath from the ctx;
 *  `AutoConvertCaps` opt the dev/editor server into on-demand variant baking. */
export async function serveProjectAsset(
  ctx: Pick<BackendContext, 'projectRoot' | 'resolveAssetPath' | 'editorRoot'> & AutoConvertCaps,
  urlPath: string,
): Promise<BackendResult | null> {
  // 1. A real file under any discovered assets/ directory (streamed — GLB/HDR can
  //    be tens of MB). Project assets are user-editable, so no long cache.
  const absPath = ctx.resolveAssetPath(urlPath);
  if (absPath && fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
    const ext = path.extname(absPath).toLowerCase();
    return file(MIME_TYPES[ext] || 'application/octet-stream', absPath);
  }

  // 2. The Basis transcoder (KTX2Loader fetches it via setTranscoderPath). Look in
  //    the project's node_modules first, then fall back to the EDITOR's own three —
  //    a FLAT project has no node_modules, so without the fallback this 404s, the
  //    KTX2 worker blob ends up being the SPA index.html ("Unexpected identifier
  //    'html'"), and every KTX2 texture silently fails to transcode (missing
  //    textures). The transcoder bytes are identical across three copies.
  if (urlPath === '/basis/basis_transcoder.js' || urlPath === '/basis/basis_transcoder.wasm') {
    const rel = path.join('node_modules/three/examples/jsm/libs/basis', path.basename(urlPath));
    const roots = [ctx.projectRoot, ctx.editorRoot].filter((r): r is string => !!r);
    for (const root of roots) {
      const transcoder = path.join(root, rel);
      if (fs.existsSync(transcoder)) {
        return file(urlPath.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', transcoder, { ...IMMUTABLE });
      }
    }
    return null;
  }

  // 2b. The PixiJS KTX2 transcoder (libktx). PixiJS's `loadKTX2` fetches it via
  //     `setKTXTranscoderPath`; we point that at `/pixi-ktx/*` so KTX2 sprites
  //     decode offline (default is a jsdelivr CDN). Bundled under pixi.js's
  //     `transcoders/` dir — same project-then-editor fallback as Basis above.
  if (urlPath === '/pixi-ktx/libktx.js' || urlPath === '/pixi-ktx/libktx.wasm') {
    const rel = path.join('node_modules/pixi.js/transcoders/ktx', path.basename(urlPath));
    const roots = [ctx.projectRoot, ctx.editorRoot].filter((r): r is string => !!r);
    for (const root of roots) {
      const transcoder = path.join(root, rel);
      if (fs.existsSync(transcoder)) {
        return file(urlPath.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', transcoder, { ...IMMUTABLE });
      }
    }
    return null;
  }

  // 3. A converted model-LOD GLB from the local cache. URL form:
  //    <sourceUrl>.processed.glb or <sourceUrl>.lod<N>.glb — the source's meta
  //    carries the cache hash; the suffix maps to a LOD level index. The source
  //    may be named .glb OR .gltf — both go through the LOD/convert pipeline and
  //    produce the same `<src>.processed.glb`/`.lod<N>.glb` variant URLs (e.g. a
  //    GLB-binary export named `foo.gltf` by Tripo/3D AI Studio). Match both, else
  //    the variant URL falls through to the app-shell and GLTFLoader chokes on the
  //    returned index.html ("Unexpected token '<' … is not valid JSON").
  const mm = urlPath.match(/^(.+\.(?:glb|gltf))\.(processed|lod(\d+))\.glb$/);
  if (mm) {
    // Decode percent-encoding so a non-ASCII-named GLB's LOD resolves to the same
    // cache path the texture branch (below) already decodes for (P2-7).
    const sourceUrl = decodeURIComponent(mm[1]);
    const level = mm[2] === 'processed' ? 0 : parseInt(mm[3], 10);
    const absSource = ctx.resolveAssetPath(sourceUrl);
    if (absSource) {
      const meta = readMetaSidecar(absSource);
      const hash = (meta.modelCache as { hash?: string } | undefined)?.hash;
      if (hash) {
        const cached = lodCachePath(getModelCacheDir(ctx.projectRoot), sourceUrl, hash, level);
        if (fs.existsSync(cached)) return file('model/gltf-binary', cached, revalidate(hash));
      }
      // Cache miss — try to auto-import (dev/editor only). Re-bakes the optimized
      // variant from the source + meta settings (regenerating the modelCache hash)
      // and serves it. Self-heals a fresh checkout/worktree whose committed meta
      // hash has no local cache bytes — the original reason rigged models fell back
      // to the raw GLB with a `[RiggedCache] … falling back to raw` warning.
      const auto = await autoBakeThenServe(ctx, 'model', sourceUrl, absSource, () => {
        const m = readMetaSidecar(absSource);
        const h = (m.modelCache as { hash?: string } | undefined)?.hash;
        if (!h) return null;
        const c = lodCachePath(getModelCacheDir(ctx.projectRoot), sourceUrl, h, level);
        if (!fs.existsSync(c)) return null;
        console.log(`[asset-scanner] auto-baked ${mm[2]} variant for ${sourceUrl} (hash ${h})`);
        return file('model/gltf-binary', c, revalidate(h));
      });
      if (auto) return auto;
      // Cache miss AND re-bake unavailable — the sidecar's hash has no local variant
      // (stale/cross-toolchain committed hash, or the cache was never generated here)
      // and autoBake couldn't regenerate it (e.g. a packaged editor without the model
      // toolchain, or auto-import isn't granted). If the SOURCE GLB itself is present,
      // degrade gracefully by serving it — rather than 404, which leaves the viewport
      // EMPTY and looks like a broken app. This is a deliberate trade-off: the
      // passthrough skips filterMesh + the postprocessor's geometry fixups, so a
      // postprocessor-dependent model (e.g. the island's baked planar UVs) may render
      // untextured until re-imported/rebuilt. We WARN loudly (never silently) so the
      // missing bake is still obvious. `no-cache` so that once the proper variant IS
      // baked, the next load picks it up (the baked branch above returns a different
      // ETag → 200 with the optimized bytes).
      if (fs.existsSync(absSource)) {
        console.warn(`[asset-scanner] no cached ${mm[2]} variant for ${sourceUrl} (hash ${hash ?? 'none'}) — serving the unprocessed source GLB as a fallback so the base mesh still renders (it may be untextured for postprocessor-dependent models). Re-import the model or run a build to regenerate the optimized variant.`);
        return file('model/gltf-binary', absSource, { 'Cache-Control': 'no-cache', ETag: '"raw-source-fallback"' });
      }
      // Source genuinely absent too — nothing to serve.
      console.error(`[asset-scanner] no cached ${mm[2]} variant for ${sourceUrl} (hash ${hash ?? 'none'}) and no source GLB on disk — cannot serve the model. Re-import it or run a build.`);
      return raw('application/json', Buffer.from(JSON.stringify({ error: 'model-variant-not-baked', source: sourceUrl, hash: hash ?? null })), 404);
    }
    return raw('application/json', Buffer.from('not found'), 404);
  }

  // 3b. A packed atlas PAGE variant. URL form: <atlasUrl>~page<N>~<variant>.<ext>.
  //     Must run BEFORE the generic texture-variant branch below — that regex's `.+`
  //     would otherwise greedily match `<atlasUrl>~page<N>` as a (nonexistent) source.
  //     The atlas's `.meta.json` sidecar carries each page's content hash; page bytes
  //     live in the shared texture cache keyed on the synthetic page url path.
  const am = urlPath.match(/^(.+\.atlas\.json)~page(\d+)~(uastc|etc1s|astc|webp|png)\.(?:ktx2|webp|png)$/);
  if (am) {
    const atlasUrl = decodeURIComponent(am[1]);
    const pageIndex = parseInt(am[2], 10);
    const variant = am[3] as TextureVariant;
    const ctFor = (v: TextureVariant) => v === 'webp' ? 'image/webp' : v === 'png' ? 'image/png' : 'application/octet-stream';
    const absAtlas = ctx.resolveAssetPath(atlasUrl);
    const pageHash = (block: AtlasCacheBlock | undefined) => block?.pages?.[pageIndex]?.hash;
    if (absAtlas) {
      const hash = pageHash(readMetaSidecar(absAtlas).atlasCache as AtlasCacheBlock | undefined);
      if (hash) {
        const cached = cachePathFor(getCacheDir(ctx.projectRoot), atlasPageUrlPath(atlasUrl, pageIndex), hash, variant);
        if (fs.existsSync(cached)) return file(ctFor(variant), cached, revalidate(hash));
      }
      // Cache miss — re-pack the atlas (dev/editor only) then re-resolve the page.
      const auto = await autoBakeThenServe(ctx, 'atlas', atlasUrl, absAtlas, () => {
        const h = pageHash(readMetaSidecar(absAtlas).atlasCache as AtlasCacheBlock | undefined);
        if (!h) return null;
        const c = cachePathFor(getCacheDir(ctx.projectRoot), atlasPageUrlPath(atlasUrl, pageIndex), h, variant);
        if (!fs.existsSync(c)) return null;
        console.log(`[asset-scanner] auto-packed atlas page ${pageIndex} (${variant}) for ${atlasUrl} (hash ${h})`);
        return file(ctFor(variant), c, revalidate(h));
      });
      if (auto) return auto;
      return raw('application/json', Buffer.from(JSON.stringify({ error: 'atlas-page-not-baked', source: atlasUrl, page: pageIndex })), 404);
    }
    return raw('application/json', Buffer.from('not found'), 404);
  }

  // 3c. A converted audio variant from the local cache. URL form:
  //     <sourceUrl>~audio.<ext> — the source's meta carries the cache hash. Must
  //     run BEFORE the texture-variant branch (its `.+` would swallow the suffix).
  const aud = urlPath.match(/^(.+)~audio\.(mp3|m4a|opus|wav|flac)$/);
  if (aud) {
    const sourceUrl = decodeURIComponent(aud[1]);
    const ext = aud[2];
    const ctFor: Record<string, string> = {
      mp3: 'audio/mpeg', m4a: 'audio/mp4', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
    };
    const absSource = ctx.resolveAssetPath(sourceUrl);
    if (absSource) {
      const hash = (readMetaSidecar(absSource).audioCache as { hash?: string } | undefined)?.hash;
      if (hash) {
        const cached = audioCachePathFor(getAudioCacheDir(ctx.projectRoot), sourceUrl, hash, ext);
        if (fs.existsSync(cached)) return file(ctFor[ext] || 'application/octet-stream', cached, revalidate(hash));
      }
      // Cache miss — auto-import (dev/editor only): re-convert from the meta
      // settings and serve, healing a checkout that has the committed audioCache
      // hash but no local converted bytes.
      const auto = await autoBakeThenServe(ctx, 'audio', sourceUrl, absSource, () => {
        const h = (readMetaSidecar(absSource).audioCache as { hash?: string } | undefined)?.hash;
        if (!h) return null;
        const c = audioCachePathFor(getAudioCacheDir(ctx.projectRoot), sourceUrl, h, ext);
        if (!fs.existsSync(c)) return null;
        console.log(`[asset-scanner] auto-converted audio variant for ${sourceUrl} (hash ${h})`);
        return file(ctFor[ext] || 'application/octet-stream', c, revalidate(h));
      });
      if (auto) return auto;
    }
    return raw('application/json', Buffer.from('not found'), 404);
  }

  // 3d. A converted font variant (mtsdf atlas PNG or Chlumsky metrics JSON) from
  //     the local cache. URL forms: <sourceUrl>~atlas.png / <sourceUrl>~metrics.json —
  //     the source font's meta carries the cache hash. Must run BEFORE the generic
  //     texture-variant branch below — that regex's `.+` would otherwise greedily
  //     match `<font>.ttf~atlas` as a (nonexistent) `png`-variant source.
  const fm = urlPath.match(/^(.+\.(?:ttf|otf|woff|woff2))~(atlas\.png|metrics\.json)$/i);
  if (fm) {
    const sourceUrl = decodeURIComponent(fm[1]);
    const which = fm[2].toLowerCase();
    const isAtlas = which === 'atlas.png';
    const ctFor = isAtlas ? 'image/png' : 'application/json';
    const cachePathFn = (h: string) => isAtlas
      ? atlasCachePath(getFontCacheDir(ctx.projectRoot), sourceUrl, h)
      : metricsCachePath(getFontCacheDir(ctx.projectRoot), sourceUrl, h);
    const absSource = ctx.resolveAssetPath(sourceUrl);
    if (absSource) {
      const hash = (readMetaSidecar(absSource).fontCache as { hash?: string } | undefined)?.hash;
      if (hash) {
        const cached = cachePathFn(hash);
        if (fs.existsSync(cached)) return file(ctFor, cached, revalidate(hash));
      }
      // Cache miss — auto-import (dev/editor only): re-bake the mtsdf atlas from the
      // meta settings and serve, healing a checkout that has the committed fontCache
      // hash but no local atlas/metrics bytes.
      const auto = await autoBakeThenServe(ctx, 'font', sourceUrl, absSource, () => {
        const h = (readMetaSidecar(absSource).fontCache as { hash?: string } | undefined)?.hash;
        if (!h) return null;
        const c = cachePathFn(h);
        if (!fs.existsSync(c)) return null;
        console.log(`[asset-scanner] auto-baked font ${which} for ${sourceUrl} (hash ${h})`);
        return file(ctFor, c, revalidate(h));
      });
      if (auto) return auto;
    }
    return raw('application/json', Buffer.from('not found'), 404);
  }

  // 3e. A converted (downscaled) environment HDR from the local cache. URL form:
  //     <sourceUrl>~env.hdr — the source's meta carries the cache hash. Must run
  //     BEFORE the texture-variant branch (whose `.+` would swallow the suffix; and
  //     `.hdr` isn't in that branch's ext list anyway, but keep the ordering explicit).
  const env = urlPath.match(/^(.+\.hdr)~env\.hdr$/);
  if (env) {
    const sourceUrl = decodeURIComponent(env[1]);
    const absSource = ctx.resolveAssetPath(sourceUrl);
    if (absSource) {
      const hash = (readMetaSidecar(absSource).environmentCache as { hash?: string } | undefined)?.hash;
      if (hash) {
        const cached = envCachePathFor(getEnvCacheDir(ctx.projectRoot), sourceUrl, hash);
        if (fs.existsSync(cached)) return file('application/octet-stream', cached, revalidate(hash));
      }
      // Cache miss — auto-import (dev/editor only): re-downscale from the meta
      // settings and serve, healing a checkout that has the committed
      // environmentCache hash but no local converted bytes.
      const auto = await autoBakeThenServe(ctx, 'environment', sourceUrl, absSource, () => {
        const h = (readMetaSidecar(absSource).environmentCache as { hash?: string } | undefined)?.hash;
        if (!h) return null;
        const c = envCachePathFor(getEnvCacheDir(ctx.projectRoot), sourceUrl, h);
        if (!fs.existsSync(c)) return null;
        console.log(`[asset-scanner] auto-converted environment variant for ${sourceUrl} (hash ${h})`);
        return file('application/octet-stream', c, revalidate(h));
      });
      if (auto) return auto;
    }
    return raw('application/json', Buffer.from('not found'), 404);
  }

  // 4. A converted texture variant from the local cache. URL form:
  //    <sourceUrl>~<variant>.<ext> — the source's meta carries the cache hash.
  const vm = urlPath.match(/^(.+)~(uastc|etc1s|astc|webp|png)\.(?:ktx2|webp|png)$/);
  if (vm) {
    // Decode percent-encoding: cachePathFor stitches sourceUrl onto the cache
    // dir as a filesystem path laid out by decoded path (UTF-8 bytes), so a
    // non-ASCII filename misses the lookup if passed encoded.
    const sourceUrl = decodeURIComponent(vm[1]);
    const variant = vm[2] as TextureVariant;
    const absSource = ctx.resolveAssetPath(sourceUrl);
    const ctFor = (v: TextureVariant) => v === 'webp' ? 'image/webp' : v === 'png' ? 'image/png' : 'application/octet-stream';
    if (absSource) {
      const meta = readMetaSidecar(absSource);
      const hash = (meta.textureCache as { hash?: string } | undefined)?.hash;
      if (hash) {
        const cached = cachePathFor(getCacheDir(ctx.projectRoot), sourceUrl, hash, variant);
        if (fs.existsSync(cached)) return file(ctFor(variant), cached, revalidate(hash));
      }
      // Cache miss — auto-import (dev/editor only): re-convert the source into its
      // variants from the meta settings and serve, healing a checkout that has the
      // committed textureCache hash but no local KTX2/WebP bytes.
      const auto = await autoBakeThenServe(ctx, 'texture', sourceUrl, absSource, () => {
        const m = readMetaSidecar(absSource);
        const h = (m.textureCache as { hash?: string } | undefined)?.hash;
        if (!h) return null;
        const c = cachePathFor(getCacheDir(ctx.projectRoot), sourceUrl, h, variant);
        if (!fs.existsSync(c)) return null;
        console.log(`[asset-scanner] auto-baked ${variant} texture variant for ${sourceUrl} (hash ${h})`);
        return file(ctFor(variant), c, revalidate(h));
      });
      if (auto) return auto;
    }
    return raw('application/json', Buffer.from('not found'), 404);
  }

  return null;
}

/** A URL path that looks like a static asset (has a file extension) rather than a
 *  client-side SPA route — so a miss should 404, not fall back to index.html. */
function looksLikeAsset(urlPath: string): boolean {
  return path.extname(urlPath) !== '' && !urlPath.endsWith('.html');
}

/** Serve the built editor renderer shell from a `dist` directory (Electron
 *  packaged/prod build only). Maps the URL path to a file under distDir; an
 *  unknown path (a SPA hash route, e.g. the editor) falls back to index.html.
 *  Path traversal is rejected. Returns null only if index.html itself is absent
 *  (a broken build). */
export function serveAppShell(distDir: string, urlPath: string): BackendResult | null {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const candidate = path.normalize(path.join(distDir, rel));
  // Confine to distDir with a boundary check (NOT a prefix `startsWith` — that
  // would let a sibling dir like `<distDir>-secrets` through). Mirrors the
  // resolveAssetPath guard.
  const relToDist = path.relative(distDir, candidate);
  const escaped = relToDist === '..' || relToDist.startsWith('..' + path.sep) || path.isAbsolute(relToDist);
  if (!escaped && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    const ext = path.extname(candidate).toLowerCase();
    return file(MIME_TYPES[ext] || 'application/octet-stream', candidate);
  }
  // A miss on something that looks like a static asset (has an extension) is a real
  // 404 — don't hand back index.html (a 200) for a missing `.webp`/`.glb`, or the
  // texture/model loader would try to parse HTML as image/binary (P2-2).
  if (escaped || looksLikeAsset(urlPath)) return raw('application/json', Buffer.from('{"error":"not found"}'), 404);
  // SPA hash/deep routes (no extension) fall back to index.html.
  const index = path.join(distDir, 'index.html');
  if (fs.existsSync(index)) return file('text/html', index);
  return null;
}
