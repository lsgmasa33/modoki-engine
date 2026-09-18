/** The typed outcomes of an asset load, and the one status rule (#1371, #1397).
 *
 *  L0 on purpose: every loader that fetches an asset needs them — the L3 `loaders/` caches and the
 *  L2 subsystems that fetch for themselves (`rendering/` text atlases and textures, `audio/`,
 *  `video/`) — and an L2 folder may not import `loaders/` (docs/architecture-layers.md).
 *  `loaders/assetFetch.ts` re-exports them next to `parseAssetJson`, which is where most callers
 *  have always imported them from. */

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
  constructor(message: string, opts: { status?: number; absent: boolean; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.status = opts.status;
    this.absent = opts.absent;
  }
}

/** The request itself failed — no response at all (offline, DNS, connection reset, CORS), or the
 *  connection dropped while the BODY was being read. `fetch`/`res.text()` report both as a bare
 *  `TypeError` (Safari: "Load failed"), which is also what a bug in a parse step throws, so the
 *  fetch sites mark them at the source instead of guessing from the class afterwards: the fetch's
 *  own rejection via `fetch(url).catch(rethrowFetchFailure(url))` (`loadFailureMemo.ts`), the body
 *  read inside `parseAssetJson` (`loaders/assetFetch.ts`). Classified TRANSIENT by `loadFailureMemo` (#1371). */
export class AssetNetworkError extends Error {
  constructor(cause: unknown) {
    super(`network error: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'AssetNetworkError';
  }
}

/** True for the statuses that mean the file is NOT THERE (404/410). Every other non-ok status says
 *  the server could not serve a file that may exist. The one copy of that rule — `parseAssetJson`,
 *  {@link checkAssetResponse} and `loadFailureMemo`'s three.js branch all ask it. */
export function statusIsAbsent(status: number): boolean {
  return status === 404 || status === 410;
}

export function checkAssetStatus(res: Response, path: string): void {
  // A non-ok response is the same condition as the SPA fallback as far as a read is concerned —
  // nothing usable came back — so it is a `MissingAssetError` too. ⚠️ But only a 404/410 means the
  // file is not there; a 500/503/403 says the server could not serve a file that may well exist,
  // and `absent: false` is what stops a caller substituting a document over it.
  if (!res.ok) {
    throw new MissingAssetError(`${res.status} ${res.statusText} for ${path}`, {
      status: res.status,
      absent: statusIsAbsent(res.status),
    });
  }
}

/** The status half of `parseAssetJson` (`loaders/assetFetch.ts`), for a BINARY asset fetched with plain `fetch` (a font,
 *  an atlas image, an audio clip, a video) — throws `MissingAssetError` for a non-ok response, and
 *  for a `text/html` response, which for a binary asset can only be the dev server's SPA fallback
 *  (#1397). Content-type rather than a body sniff: the body is binary, and reading it here would
 *  consume it. Pair it with `fetch(url).catch(rethrowFetchFailure(url))` so all three outcomes are
 *  typed for `loadFailureMemo`. */
export function checkAssetResponse(res: Response, path: string): Response {
  checkAssetStatus(res, path);
  if (/^\s*text\/html\b/i.test(res.headers.get('content-type') ?? '')) {
    throw new MissingAssetError(
      `no asset at ${path} — the server answered with an HTML page (the dev server's SPA fallback), `
      + `which means the file does not exist. Check the ref/GUID, or create the asset.`,
      { status: res.status, absent: true },
    );
  }
  return res;
}

/** Read a BINARY asset's body, marking a connection that drops mid-body as {@link AssetNetworkError}
 *  — the `arrayBuffer()` twin of `parseAssetJson` (`loaders/assetFetch.ts`)'s body read, with the same `AbortError`
 *  pass-through (a caller's cancel is not a failure). */
export async function readAssetBytes(res: Response): Promise<ArrayBuffer> {
  return res.arrayBuffer().catch((e: unknown) => {
    if ((e as { name?: unknown } | null)?.name === 'AbortError') throw e;
    throw new AssetNetworkError(e);
  });
}

/** True when `url` is served by the native app ITSELF: a Capacitor build (iOS or Android), and the
 *  URL on the page's own scheme + host. That covers the embedded bundle, an OTA snapshot (the
 *  `serverBasePath` swap keeps the origin) and a sub-game's `_capacitor_file_` URL. Always false
 *  on the web, where the page's own server is as remote as any CDN (#1402).
 *
 *  Scheme + host rather than `URL.origin`: iOS serves the page from `capacitor://localhost`, and
 *  the URL standard gives a non-special scheme the opaque origin `"null"`. WebKit reports
 *  `capacitor://localhost` instead (measured, iPhone 8 / iOS 16.7.16), but scheme + host holds
 *  whichever way an engine answers. Capacitor is read from
 *  the global, as `formFactor.readPlatform` does, so this L0 module imports no native plugin. */
export function isAppBundleUrl(url: string): boolean {
  const cap = (globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  let native: boolean;
  try { native = cap?.isNativePlatform?.() === true; } catch { native = false; }
  if (!native) return false;
  const loc = (globalThis as unknown as { location?: { href: string; protocol: string; host: string } }).location;
  if (!loc) return false;
  try {
    const u = new URL(url, loc.href);
    return u.protocol === loc.protocol && u.host === loc.host;
  } catch {
    return false;
  }
}

/** Pixi's `Loader` wraps every parser failure as `[Loader.load] Failed to load <url>.\n${inner}`
 *  (`pixi.js/lib/assets/loader/Loader.mjs`), so the inner error survives only as text. A failed
 *  REQUEST reads `TypeError…` (the fetch rejected) or `[object Event]` (the `<img>` fired `error`);
 *  a decode failure, a `createImageBitmap` refusal or a status reads otherwise. */
const PIXI_REQUEST_FAILED = /^\[Loader\.load\] Failed to load [^\n]*\n(?:TypeError\b|\[object (?:\w*)Event\])/;

/** Did the REQUEST fail, as opposed to something after it? A rejected `fetch` and three's
 *  `FileLoader` give a `TypeError`, an `<img>` or XHR `error` gives an `Event`, a
 *  `rethrowFetchFailure` site gives an `AssetNetworkError`, and Pixi gives its wrapper around one
 *  of those. Anything else — a KTX2 transcoder not initialised yet, a `createImageBitmap` refusal, a
 *  parser's plain `Error` — says nothing about whether the file is there (#1402 review). By SHAPE,
 *  not cause: an `<img>` decode failure and a `TypeError` thrown inside a loader's own chain still
 *  match, which is tolerable because the same bytes reproduce them. So pass only the rejection of
 *  the url's OWN load, never a promise that awaited something else first. */
function isRequestFailure(e: unknown): boolean {
  if (e instanceof AssetNetworkError || e instanceof TypeError) return true;
  if (typeof Event !== 'undefined' && e instanceof Event) return true;
  return e instanceof Error && PIXI_REQUEST_FAILED.test(e.message);
}

/** A REQUEST for `url` failed with NO status to go on (a rejected `fetch`, an XHR `onerror`, an
 *  `<img>` `error`, three's bare `TypeError`): if the app serves `url` itself, it is not an outage, because
 *  there is no network between the app and its own files. iOS's `WebViewAssetHandler` answers a
 *  file missing from the bundle by failing the request instead of with a 404, so this is how a
 *  missing bundled file looks there (#1402; `otaClient`'s embedded-manifest read made the same
 *  call first, #1132). Returns `e` untouched when it already carries a verdict (a
 *  `MissingAssetError`, three's `HttpError` with a status), for an `AbortError` (a caller's cancel
 *  is not a failure), and for any URL {@link isAppBundleUrl} does not claim. */
export function absentIfBundled(url: string, e: unknown): unknown {
  if (e instanceof MissingAssetError) return e;
  // `rethrowFetchFailure` hands this the fetch's rejection already wrapped, so look inside it.
  const cause = e instanceof AssetNetworkError ? e.cause : e;
  if ((cause as { name?: unknown } | null)?.name === 'AbortError') return e;
  if (typeof (e as { response?: { status?: unknown } } | null)?.response?.status === 'number') return e;
  if (!isRequestFailure(e)) return e;
  if (!isAppBundleUrl(url)) return e;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new MissingAssetError(
    `could not load ${url} from the app bundle (${detail}). The app serves this file itself, so this `
    + `is not an outage: the file is missing from the build, or unreadable.`,
    { absent: true, cause },
  );
}
