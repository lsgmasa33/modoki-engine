/** The one seam between an asset PATH and an asset URL (#1979).
 *
 *  An **asset path** is an identity — `/assets/textures/50%.png`, spelled exactly as the file is
 *  named on disk. It is what the manifest keys, what a JSON body or an MCP argument carries, what a
 *  query value is once `URLSearchParams` has parsed it, and what `resolveAssetPath` resolves. It is
 *  **never percent-encoded**, so nothing that holds one may decode it.
 *
 *  In L0 core so `runtime/ui` (L2) and `core/config.ts` may use it too.
 *
 *  An **asset URL** is that path on the wire. The crossings (docs/engine-concepts.md § "Asset path vs asset URL"):
 *  - path → URL: `assetUrl()` (runtime), via `encodeAssetUrlPath`;
 *  - URL → path: `serveProjectAsset` (the dev/editor server), via `decodeAssetUrlPath`;
 *  - URL → path: `bootScenePath(config)`, for the Vite `?url` value `config.scenePath` holds.
 *
 *  ⚠️ **Decoding an identity is the bug this module exists to stop.** It made `100%.png` throw
 *  `URIError` (a 500 on every route that touched it, and a failed production build), and made a
 *  file literally named `my%20tex.png` resolve to a DIFFERENT file, `my tex.png` — so a delete or a
 *  move acted on the wrong asset. */

/** Encode the three characters a URL path cannot carry literally: `%` (the escape introducer — so
 *  first), `?` (would start a query) and `#` (would start a fragment). Everything else — a space,
 *  non-ASCII — is left for the browser to percent-encode itself, as it always has, so an ordinary
 *  name's URL is unchanged by this. Not idempotent by design: it takes a PATH, never a URL. */
export function encodeAssetUrlPath(assetPath: string): string {
  return assetPath.replace(/[%?#]/g, (c) => (c === '%' ? '%25' : c === '?' ? '%3F' : '%23'));
}

/** URL bases of the OTA sub-game bundles whose manifest fragments were merged (`loadManifestJson`'s
 *  `pathPrefix`), each without a trailing slash. */
const subgameBases = new Set<string>();

/** Declare `base` (a sub-game's staged bundle root as a URL, e.g. `Capacitor.convertFileSrc()` of it)
 *  as the prefix of asset paths: `base + '/assets/50%.png'` is an asset PATH whose part after `base`
 *  `assetUrl` encodes (#2051). Called by `loadManifestJson` for a `pathPrefix`, the one place such
 *  paths are made. */
export function registerSubgameAssetBase(base: string): void {
  subgameBases.add(base.replace(/\/$/, ''));
}

/** Forget every sub-game base — with the manifest entries that carried them (`clearManifest`). */
export function clearSubgameAssetBases(): void {
  subgameBases.clear();
}

/** The registered sub-game base `path` starts with, on a `/` boundary, or undefined.
 *
 *  ⚠️ The registry lives HERE, in the seam module, not in `loaders/assetUrl.ts`: nineteen tests mock that module with
 *  an explicit export list, and `clearManifest` reaching a name the mock lacks throws in every one of them. */
export function subgameAssetBaseOf(path: string): string | undefined {
  for (const base of subgameBases) {
    if (path.startsWith(base) && path.charCodeAt(base.length) === 47 /* '/' */) return base;
  }
  return undefined;
}

/** Decode a request's URL pathname back to the asset path it names — once. `null` for a malformed
 *  escape (a stray `%`): no asset URL this engine builds can produce one, so the caller treats it
 *  as "not an asset" and falls through, rather than throwing a 500. */
export function decodeAssetUrlPath(urlPath: string): string | null {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return null;
  }
}

/** A URL as a CSS `url()` value — QUOTED, with `"` and `\` escaped. An unquoted `url(…)` is
 *  invalid CSS once the name holds a space, a quote or a parenthesis, and the browser drops the
 *  whole declaration silently: no image, no error (#1979's CSS layer; `fontLoader.ts` hit it first
 *  with "Geologica-Bold Dynamic.ttf"). */
export function cssUrl(url: string): string {
  return `url("${url.replace(/(["\\])/g, '\\$1')}")`;
}
