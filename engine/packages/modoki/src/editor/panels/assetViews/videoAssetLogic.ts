/** Pure decision logic behind VideoAssetView — which URL the preview element should
 *  point at, what the current delivery settings will actually DO at play time, and
 *  which settings combinations are quietly broken.
 *
 *  Split out of the .tsx on purpose (docs/editor.md § Panels): a panel component holds
 *  JSX and wiring, its decisions live in a plain module beside it where a unit test can
 *  reach them without mounting anything. */

import {
  resolveDeliveryPolicy, videoVariantSuffix,
  type VideoImportSettings, type VideoCacheInfo,
} from '../../../runtime/loaders/videoSettings';

/** Where the inspector's `<video>` element should point.
 *
 *  The CONVERTED variant whenever one exists, not the source — and that is a
 *  correctness choice, not a preference. Sources are accepted as `.mov`/`.mkv`/`.webm`
 *  as well as `.mp4`, and the editor's Chromium plays neither `.mkv` nor most `.mov`
 *  codecs; previewing the source would show a broken element for a clip that is
 *  perfectly fine. The variant is H.264/mp4 by construction. Dev serves it at
 *  `<source>~video.mp4` (staticAssets.ts § 3c-bis), which also auto-heals a checkout
 *  whose cached bytes are missing.
 *
 *  Before the first convert there is no variant, so the source is all there is. */
export function videoPreviewUrl(path: string, converted: boolean): string {
  return converted ? `${path}${videoVariantSuffix()}` : path;
}

/** One line describing what happens at play time, with `policy: 'auto'` already
 *  resolved against the measured size — the field says "auto", and this says which way
 *  auto actually went for THIS clip. */
export function describeVideoDelivery(
  settings: VideoImportSettings, cache: VideoCacheInfo | undefined,
): string {
  if (settings.delivery === 'bundled') return 'Ships inside the build; played from its local URL.';
  const resolved = resolveDeliveryPolicy(settings, cache?.bytes);
  const size = cache?.bytes != null ? ` (${(cache.bytes / (1024 * 1024)).toFixed(2)} MB)` : '';
  const how = resolved === 'download'
    ? 'downloaded to the local cache first, then played from disk'
    : 'streamed from its URL; nothing stored locally';
  // Only say "auto →" when auto is what made the decision; a pinned policy reads as a
  // restatement of the field otherwise.
  const via = settings.policy === 'auto' ? 'auto → ' : '';
  return `Fetched at runtime — ${via}${how}${size}.`;
}

/** Settings combinations that produce a clip which loads in dev and fails in
 *  production (or fails only on a texture surface). Each string is shown verbatim.
 *  Empty array = nothing to say. */
export function videoSettingsWarnings(
  settings: VideoImportSettings, cache: VideoCacheInfo | undefined,
): string[] {
  const out: string[] = [];
  if (settings.delivery === 'remote') {
    const url = settings.remoteUrl?.trim();
    if (!url) {
      // resolveVideoSource falls back to the local path — which the production build
      // drops in favour of the variant, so this 404s only once shipped.
      out.push('No Remote URL — playback falls back to the local path, which the production build does not ship.');
    } else if (!/^https?:\/\//i.test(url)) {
      out.push('Remote URL must be an absolute http(s) URL.');
    } else if (/^http:\/\//i.test(url)) {
      out.push('Plain http:// — blocked as mixed content on an https page and by ATS on iOS.');
    } else if (/^https:\/\/github\.com\/.+\/releases\/download\//i.test(url)) {
      // Measured, docs/video.md § Remote delivery: Releases serves range requests but
      // sends no Access-Control-Allow-Origin, and a clip bound as a GPU texture is
      // loaded crossOrigin='anonymous' — so it fails the load outright.
      out.push('GitHub Releases sends no CORS header — a clip used as a texture will fail to load. Use jsDelivr.');
    } else if (/^https:\/\/([A-Za-z0-9-]+\.)*archive\.org\//i.test(url)) {
      // Measured 2026-08-11 (docs/video.md § Remote delivery): archive.org answers the /download/
      // request with a 302 carrying `ACAO: *`, then redirects to an `ia<n>`/`dn<n>.us.archive.org`
      // storage node whose 200 carries NO CORS header at all. The redirect is what makes this a
      // trap — a `curl -I` follows it and prints the header the real response does not have.
      //
      // ⚠️ SUBDOMAINS MUST MATCH, and this is the whole reason the pattern is not `(www\.)?`:
      // the storage node is where a user's URL usually comes FROM. They paste the /download/ link,
      // preview it in a browser, and the address bar now reads
      // `https://ia801409.us.archive.org/0/items/…` — so the URL a human actually copies is the
      // one a domain-anchored pattern misses, leaving the Inspector silent on the exact input the
      // check exists for. (`ia801409…` 301s to `dn801201…`; both are archive.org subdomains, so
      // one subdomain-permitting pattern covers the family. `archive.org.evil.com` and
      // `notarchive.org` still correctly do not match — see the test.)
      //
      // NOT measured: `web.archive.org` (Wayback) playback URLs. They match this pattern and get
      // warned, which is the safe direction — the hint names what was measured and points at a
      // host known to work, rather than asserting Wayback's behaviour.
      out.push('archive.org does not send CORS on the response that serves the bytes — its /download/ redirect carries the header and the ia*/dn* storage node behind it does not, so a clip used as a texture will fail to load. Use jsDelivr.');
    }
  }
  if (settings.audio === 'strip' && cache?.hasAudio) {
    out.push('Audio is stripped — re-import to drop the track from the converted file.');
  }
  return out;
}

/** True when two settings snapshots would encode to DIFFERENT bytes.
 *
 *  Used against the baseline captured at the last load/apply, to tell the user their
 *  edit is waiting on a re-encode. It cannot be compared against the variant on disk:
 *  the sidecar's `video` block is rewritten on every keystroke, so it always describes
 *  the CURRENT settings, never the ones that produced the existing `videoCache.hash`.
 *  So this answers "changed since you last applied", not "stale on disk" — a clip
 *  edited and left unapplied in an earlier session reads as up to date.
 *
 *  `delivery`/`policy`/`remoteUrl` are deliberately EXCLUDED: they fork the delivery
 *  path only and are not in the conversion cache key (videoSettings.ts), so flipping
 *  one must not demand a re-encode. */
export function conversionSettingsDiffer(
  a: VideoImportSettings, b: VideoImportSettings,
): boolean {
  const keys: (keyof VideoImportSettings)[] = [
    'quality', 'preset', 'resizeMode', 'maxFps', 'keyframeIntervalSec', 'audio', 'audioBitrate',
  ];
  // Only the ACTIVE half of the resize mode counts — an edit to the bounds while in
  // percentage mode changes nothing about the output, so it must not claim a re-encode
  // is owed. Mirrors what the cache key hashes (video-cache.ts § stableSettings).
  const sizeKeys: (keyof VideoImportSettings)[] = a.resizeMode === 'percent'
    ? ['scalePercent']
    : ['maxWidth', 'maxHeight'];
  return [...keys, ...sizeKeys].some((k) => a[k] !== b[k]);
}
