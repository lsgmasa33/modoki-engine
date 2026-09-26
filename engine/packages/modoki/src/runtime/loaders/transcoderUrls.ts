/** Versioned URLs for the two KTX2 transcoder pairs (#1586).
 *
 *  Both pairs ship under FIXED file names (`/basis/basis_transcoder.{js,wasm}`,
 *  `/pixi-ktx/libktx.{js,wasm}`), and the CDN in front of a published web game caches those for a
 *  day — so after a three/pixi bump a returning visitor could pair a stale `.js` with a fresh `.wasm`
 *  and fail every KTX2 texture. The build bakes each pair's content hash into
 *  `__MODOKI_TRANSCODER_VERSIONS__` (`engine/plugins/transcoders.ts`), and these helpers append it as
 *  `?v=<hash>` — the engine's cache-bust convention. A blank version (editor, dev, playable) leaves
 *  the URL bare. */
import { assetUrl, withCacheBust } from './assetUrl';

/** The baked versions, or blanks when the host's Vite config supplies no define. A host that omits
 *  it gets bare URLs (the pre-#1586 behaviour), not a ReferenceError that fails every KTX2 load. */
function bakedVersions(): { readonly basis: string; readonly pixiKtx: string } {
  return typeof __MODOKI_TRANSCODER_VERSIONS__ === 'undefined'
    ? { basis: '', pixiKtx: '' }
    : __MODOKI_TRANSCODER_VERSIONS__;
}

/** PixiJS's `setKTXTranscoderPath` takes the two full URLs, so the query rides on each directly. */
export function pixiKtxTranscoderUrls(
  version: string = bakedVersions().pixiKtx,
): { jsUrl: string; wasmUrl: string } {
  return {
    jsUrl: withCacheBust(assetUrl('/pixi-ktx/libktx.js'), version),
    wasmUrl: withCacheBust(assetUrl('/pixi-ktx/libktx.wasm'), version),
  };
}

const BASIS_FILE = /\/basis_transcoder\.(?:js|wasm)$/;

/** three's `KTX2Loader` joins `setTranscoderPath(dir)` with the FIXED names `basis_transcoder.js` /
 *  `.wasm`, so a query cannot ride on the path. It loads both through `new FileLoader(this.manager)`,
 *  and `FileLoader` passes the joined URL through `manager.resolveURL` — so `getKTX2Loader` builds the
 *  loader on a `LoadingManager` carrying this URL modifier, which appends the version to exactly
 *  those two names. Every other URL the manager sees (the `.ktx2` textures, which carry their own
 *  `?v=`) passes through untouched. `undefined` for a blank version: the loader keeps three's default
 *  manager, as before. Three-free on purpose — this module is on the 2D path too (#254). */
export function basisTranscoderUrlModifier(
  version: string = bakedVersions().basis,
): ((url: string) => string) | undefined {
  if (!version) return undefined;
  return (url) => (BASIS_FILE.test(url) ? withCacheBust(url, version) : url);
}
