/** Prefix a root-absolute asset path with Vite's BASE_URL so runtime fetches
 *  resolve when the app is hosted under a sub-path (e.g. "/demo/"). No-op when
 *  BASE_URL is "/" (dev + native Capacitor builds). Pass-through for relative,
 *  http, data, and blob URLs; idempotent for already-prefixed paths. */
export function assetUrl(path: string): string {
  if (!path) return path;
  // Playable single-file build: the self-extract bootstrap inlines every reachable
  // asset and publishes `globalThis.__PLAYABLE_ASSETS__ = { '/assets/x': 'blob:…' }`.
  // Resolve a root-absolute asset path to its blob: URL — that works uniformly for
  // fetch, XHR, AND `img.src` (a fetch monkeypatch would miss the image/loader paths).
  // Absent in a normal build, so this is a single cheap undefined-check that falls
  // through to BASE_URL prefixing. (See inlinePlayable.ts.)
  if (path.charCodeAt(0) === 47 /* '/' */) {
    const inlined = (globalThis as { __PLAYABLE_ASSETS__?: Record<string, string> }).__PLAYABLE_ASSETS__?.[path];
    if (inlined) return inlined;
  }
  const base = import.meta.env?.BASE_URL || '/';
  const resolved = (base === '/' || !path.startsWith('/') || path.startsWith(base)) ? path : base + path.slice(1);
  // iOS Capacitor serves the app from a CUSTOM scheme (capacitor://localhost). PixiJS's URL
  // resolver is written for http/https/file and mis-parses a root-absolute path under a custom
  // scheme — it drops the host, so "/assets/x" becomes "capacitor://assets/x" (host "assets") →
  // 404 (the file lives under localhost). Fully-qualify root-absolute paths against the real origin
  // on such schemes so no (buggy) resolution is needed. http(s) — web + Android's http://localhost —
  // resolve "/…" correctly and are left untouched, as are blob:/data: (handled above).
  if (typeof location !== 'undefined' && resolved.charCodeAt(0) === 47 /* '/' */) {
    const proto = location.protocol;
    if (proto !== 'http:' && proto !== 'https:' && proto !== 'file:' && location.host) {
      return proto + '//' + location.host + resolved;
    }
  }
  return resolved;
}

/** Append the content-hash cache-bust query `?v=<hash>` to a resolved URL, but
 *  ONLY in production builds and ONLY when a hash is known — a re-import mints a
 *  new hash → a new URL the browser/CDN hasn't cached. Dev + the packaged editor
 *  serve through the Vite dev server (no immutable caching, HMR), so it's a no-op
 *  there. Query-aware (`&` when the URL already has a `?`). Single source of truth
 *  for BOTH the model (`modelGlbUrl`) and texture (`resolveTextureVariantUrl`)
 *  appenders so the scheme can never drift between them. (B4) */
export function withCacheBust(url: string, hash?: string): string {
  // blob:/data: URLs are already unique (playable single-file build) — a `?v=hash`
  // suffix would break blob-URL lookup (matched by UUID, not query) and bloat data URLs.
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
  if (!(import.meta.env?.PROD && hash)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + hash;
}
