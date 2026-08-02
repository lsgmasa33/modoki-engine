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

/** True when a response body is the dev server's SPA fallback (`index.html`) rather than the JSON
 *  asset that was asked for. */
function isHtmlFallthrough(text: string): boolean {
  return /^\s*(<!doctype html|<html\b)/i.test(text);
}

/** Parse an asset-JSON response, turning the dev server's SPA fallback into a MISSING-ASSET error.
 *
 *  WHY. Vite answers an unknown path with `200 index.html`, so `r.ok` is true and `r.json()` throws
 *  `SyntaxError: Unexpected token '<', "<!doctype "... is not valid JSON`. Every asset cache
 *  (particle, animation clip, animset, timeline, rig2d, sprite-anim) logged that verbatim, so the
 *  single most common authoring mistake on this engine — a ref pointing at a path that does not
 *  exist — reported itself as a corrupt file. Two different causes, one indistinguishable message,
 *  and the one it named was the wrong one.
 *
 *  Observed 2026-07-30: the MCP live sweep reads a deliberately-absent probe path, and the editor
 *  console filled with `[particleCache] failed to load /assets/particles/probe.particle.json:
 *  SyntaxError: Unexpected token '<'` — which reads as a broken asset, not an absent one.
 *
 *  This is the same fallthrough the MCP transport already special-cases (`htmlFallthrough` in
 *  `engine/tools/modoki-mcp/src/context.ts`, which turns it into "no such API route"). Same trap,
 *  same shape of fix; the two cannot share code because one runs in the browser and one in the MCP
 *  server process. */
export async function parseAssetJson(res: Response, path: string): Promise<unknown> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  const text = await res.text();
  if (isHtmlFallthrough(text)) {
    throw new Error(
      `no asset at ${path} — the dev server answered with index.html (its SPA fallback), which `
      + `means the file does not exist. Check the ref/GUID, or create the asset.`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    // A REAL parse failure keeps its own message, plus the path — the original error said which
    // token but never which file, and these loaders fetch many.
    throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}
