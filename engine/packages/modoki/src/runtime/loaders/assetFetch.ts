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

/** Thrown by `parseAssetJson` when the asset did not come back — the dev server's SPA fallback, or
 *  any non-ok response. Never thrown for a genuine parse failure — that keeps a plain `Error`, so
 *  the two stay distinguishable without matching message text. Modeled on `isPluginUnimplemented`
 *  in `engine/app/ota.ts`: a typed check survives a message reword; a string match doesn't.
 *
 *  ⚠️ **"Did not come back" is NOT the same as "is not there", and `absent` is the difference.**
 *  This class covers every non-ok status, so a 500/503/403 on a file that exists throws it too.
 *  That is right for a reader that just wants to show nothing — but catastrophic for a reader that
 *  SUBSTITUTES content for it, because substituting defaults for a file that is present and merely
 *  unreadable is how the file gets destroyed (#896: a transient 500 made an editor open a default
 *  clip, seed it as the saved baseline, and let the first edit replace the authored file with it —
 *  wearing a freshly-minted GUID). Ask `assetIsAbsent` for that question, never `isMissingAsset`. */
export class MissingAssetError extends Error {
  /** The HTTP status, or `undefined` for the SPA-fallback case (a 200 that was not the asset). */
  readonly status?: number;
  /** True only when the file is genuinely NOT THERE — a 404/410, or the SPA fallback, which the
   *  dev server serves precisely because nothing exists at that path. False for every other non-ok
   *  status, where the file may well exist and simply could not be served. */
  readonly absent: boolean;
  constructor(message: string, opts: { status?: number; absent: boolean }) {
    super(message);
    this.status = opts.status;
    this.absent = opts.absent;
  }
}

/** True when `e` is `parseAssetJson`'s did-not-come-back case (SPA fallback or ANY non-ok
 *  response) — never true for a real JSON parse failure or an unrelated error.
 *
 *  ⚠️ **This is the right question for a reader that shows nothing, and the WRONG one for a reader
 *  that substitutes content** — see `assetIsAbsent`, and `MissingAssetError`'s own header for the
 *  destruction the difference caused. */
export function isMissingAsset(e: unknown): boolean {
  return e instanceof MissingAssetError;
}

/** True when the asset is genuinely NOT THERE — the narrow half of `isMissingAsset`.
 *
 *  This is the predicate a caller must use before minting a GUID, writing a default document, or
 *  otherwise treating the path as free: those acts are correct for a file that does not exist and
 *  destructive for one that merely failed to load. Two callers ask it —
 *  `editor/panels/assetDocLoad.ts` and `editor/scene/modelImportPersist.ts` — and both used to ask
 *  `isMissingAsset` instead, so both substituted over a 5xx (#896). */
export function assetIsAbsent(e: unknown): boolean {
  return e instanceof MissingAssetError && e.absent;
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
  // A non-ok response is the same condition as the fallback case below as far as THIS read is
  // concerned — nothing usable came back — so it is a `MissingAssetError` too. ⚠️ But only a
  // 404/410 means the file is not there; a 500/503/403 says the server could not serve a file that
  // may well exist, and `absent: false` is what stops a caller substituting a document over it.
  if (!res.ok) {
    throw new MissingAssetError(`${res.status} ${res.statusText} for ${path}`, {
      status: res.status,
      absent: res.status === 404 || res.status === 410,
    });
  }
  const text = await res.text();
  if (isHtmlFallthrough(text)) {
    throw new MissingAssetError(
      `no asset at ${path} — the dev server answered with index.html (its SPA fallback), which `
      + `means the file does not exist. Check the ref/GUID, or create the asset.`,
      // The fallback is served BECAUSE nothing exists at that path — the one case where a 200 is
      // positive evidence of absence.
      { status: res.status, absent: true },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    // A REAL parse failure keeps its own message, plus the path — the original error said which
    // token but never which file, and these loaders fetch many. Deliberately a plain Error, not
    // MissingAssetError: a corrupt file must never be silently treated as an absent one.
    throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}
