/** Cache policy for asset-content fetches (scene / prefab / mesh / material /
 *  manifest / clip / particle / shader JSON).
 *
 *  In the EDITOR (dev) the same URL is re-fetched after the file changes on disk
 *  — a scene revert, a prefab edit, an asset re-import. The dev server sends
 *  `Cache-Control: no-cache` with a weak ETag, which still lets the browser serve
 *  a stale `304` after a revert (and the editor's "reload scene" / force-reload go
 *  through these fetches). The result: the editor loads a STALE level. `no-store`
 *  bypasses the HTTP cache entirely so every editor load reads the current file.
 *
 *  In a PRODUCTION build assets are immutable and cross-session HTTP caching is
 *  valuable (a returning player doesn't re-download a shared mesh/texture), so the
 *  default cache is kept. Note: the in-memory resource caches (meshAssetCache,
 *  prefabCache, …) still dedupe within a session in both modes — this only governs
 *  the FIRST network read of each asset. */
export function assetFetchInit(isDev: boolean): RequestInit {
  return isDev ? { cache: 'no-store' } : {};
}

/** Resolved once for the current build. Spread into fetch() options:
 *    fetch(url, ASSET_FETCH_INIT)
 *    fetch(url, { signal, ...ASSET_FETCH_INIT })
 *
 *  `import.meta.env` is provided by Vite (an object in dev, statically replaced in
 *  a build); undefined in a bare Node/test context → treated as non-dev. */
export const ASSET_FETCH_INIT: RequestInit = assetFetchInit(Boolean(import.meta.env?.DEV));
