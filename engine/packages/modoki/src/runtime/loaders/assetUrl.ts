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
  // Vite does NOT guarantee BASE_URL ends with "/" — it only normalizes a leading
  // slash (resolveBaseUrl in vite's config resolution), so a build invoked with
  // BASE_PATH=/demo (no trailing slash) yields BASE_URL "/demo". Joining that
  // directly against a root-absolute path ("/demo" + "assets.json" — path.slice(1)
  // drops the leading "/") glues the two segments with no separator, producing
  // "/demoassets.json": a silent 404 that fails EVERY GUID lookup at once (every
  // mesh drops, black screen) rather than an obvious per-asset error. Strip a
  // trailing slash before joining so the result is correct either way.
  const resolved = (base === '/' || !path.startsWith('/') || path.startsWith(base))
    ? path
    : (base.endsWith('/') ? base.slice(0, -1) : base) + path;
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

/** Append the content-hash cache-bust query `?v=<hash>` to a resolved URL whenever a
 *  hash is known — a re-import mints a new hash → a new URL. Query-aware (`&` when the
 *  URL already has a `?`). Single source of truth for BOTH the model (`modelGlbUrl`) and
 *  texture (`resolveTextureVariantUrl`) appenders so the scheme can never drift between
 *  them. (B4)
 *
 *  ⚠️ **This used to be gated on `import.meta.env.PROD`, and that gate was the whole of
 *  #1022** — it made the URL inert in DEV, which is precisely where re-import happens. The
 *  old docblock justified it by what the query is for in production (defeating immutable
 *  browser/CDN caching, which the Vite dev server does not need). That reasoning was sound
 *  and incomplete: the URL is not only a fetch key, it is the identity every downstream
 *  cache keys on. With it frozen in dev, a re-imported texture kept the SAME PixiJS
 *  `Assets` cache key and the same live `TextureSource`, so a live sprite went on drawing
 *  the pre-import bytes — and `Scene2D`'s retain-before-release bridge, which compares
 *  `resolved.url === displaySlot.textureUrl` to avoid a needless re-download, read the
 *  frozen URL as "nothing changed" and held the refcount off zero so nothing ever
 *  unloaded it.
 *
 *  ⚠️ **The hash is what distinguishes the two cases, and that is why the fix belongs
 *  HERE rather than in an eviction pass at the consumer.** A re-import moves the hash, so
 *  the URL moves and every layer re-fetches. A **re-slice** does NOT move it (same bytes,
 *  different frame rects), so the URL is unchanged, the bridge still fires, and the shared
 *  `TextureSource` is correctly kept. A consumer-side fix keyed on the sprite epoch cannot
 *  tell those apart — the epoch bumps for both — and would force a re-download on every
 *  re-slice. See `docs/textures.md` § "The dev URL carries the content hash". */
export function withCacheBust(url: string, hash?: string): string {
  // blob:/data: URLs are already unique (playable single-file build) — a `?v=hash`
  // suffix would break blob-URL lookup (matched by UUID, not query) and bloat data URLs.
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
  if (!hash) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + hash;
}
