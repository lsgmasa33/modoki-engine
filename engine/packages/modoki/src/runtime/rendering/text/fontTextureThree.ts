/** Three.js atlas-texture cache for SDF fonts. Builds one THREE.Texture per
 *  `${fontId}:image` from the provider's atlas image URL (immutable), and ties its
 *  disposal to the font's scene-scoped lifetime via provider.addDisposable — so the
 *  GPU texture is freed exactly when the font is released (no leak, no double-free),
 *  without the renderer-agnostic provider importing THREE.
 *
 *  MTSDF atlases are DATA (distance fields), not color: the texture uses linear
 *  colorspace (no sRGB decode — that would distort the distances), no mipmaps, and
 *  linear filtering. flipY=false matches the `-yorigin top` bake (top-origin UVs). */

import * as THREE from 'three';
import type { FontProvider } from './fontProvider';
import { markTextDirty } from './textDirty';
import { createLoadFailureMemo } from '../../core/loadFailureMemo';
import { absentIfBundled } from '../../core/assetLoadErrors';

const cache = new Map<string, THREE.Texture>();
const loader = new THREE.TextureLoader();
/** What a FAILED atlas load left behind (#1397). Before it, the placeholder Texture that
 *  `TextureLoader.load` returns stayed cached with no image for as long as the provider lived, so a
 *  network blip left that font's 3D text invisible until the scene changed. A failure now evicts
 *  the placeholder and is remembered here; `TextureLoader` goes through an `<img>`, which reports
 *  a 404 and a dropped connection as the same bare `Event`, so every failure is `transient` and
 *  backs off (1 s doubling to 10 min) — a missing file costs one request per step, a blip
 *  recovers. `onRetryDue` repaints the font's text so render-on-demand surfaces ask again. Keyed
 *  like the Pixi twin: `fontId + '\n' + url`. */
const failures = createLoadFailureMemo({
  label: 'fontTextureThree',
  unknownIs: 'transient',
  onRetryDue: (key) => markTextDirty(key.slice(0, key.indexOf('\n'))),
});
/** Providers whose page-0 image disposer is registered — ONE per provider, not one per load: a
 *  retry is a new load, and registering per load grew the provider's disposer list by one per
 *  backoff step for as long as an outage lasted. */
const imageDisposerRegistered = new WeakSet<FontProvider>();
/** Providers that have been disposed — an atlas load that fails after its provider was superseded
 *  (`invalidateFont`) must not record a failure under the key its successor is about to use. */
const disposedProviders = new WeakSet<FontProvider>();
/** Last atlasVersion uploaded into each dynamic CanvasTexture (so a grow re-uploads). */
const uploadedVersion = new WeakMap<THREE.Texture, number>();

function styleFontTexture(tex: THREE.Texture): void {
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace; // distance-field data — never sRGB-decode
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.premultiplyAlpha = false;
}

/** Get (or build) the atlas texture for a font provider's `page` (default 0). Returns
 *  null for a page that has no image yet (out-of-range dynamic page, or a dynamic
 *  provider before its first). Baked fonts are single-page (page 0 → the image URL). */
export function getFontTexture(provider: FontProvider, page = 0): THREE.Texture | null {
  // Dynamic (path B): each page is a growing canvas. Build ONE CanvasTexture per page
  // and re-upload it whenever atlasVersion bumps (a new glyph batch was blitted in).
  const canvas = provider.atlasCanvasAt?.(page);
  if (canvas) {
    const key = `${provider.id}:canvas:${page}`;
    let tex = cache.get(key);
    if (!tex) {
      tex = new THREE.CanvasTexture(canvas);
      styleFontTexture(tex);
      cache.set(key, tex);
      provider.addDisposable(() => {
        const t = cache.get(key);
        if (t) { t.dispose(); cache.delete(key); }
      });
      // ⚠️ NO destroyed-check here, and that is deliberate — do NOT port the Pixi twin's
      // `if (created.destroyed) return null` from `fontTexturePixi.ts` (#481). This has the same
      // SHAPE (cache, register a disposer that can run synchronously on an already-disposed
      // provider, return the texture) and none of the hazard: THREE exposes no `.destroyed` /
      // `.disposed` flag at all, and `dispose()` only emits the event that makes WebGLRenderer
      // drop its cached WebGLTexture — `.image` survives, so the next bind RE-UPLOADS. Adding a
      // null-return here would blank text that renders correctly today.
    }
    if (uploadedVersion.get(tex) !== provider.atlasVersion) {
      tex.needsUpdate = true;
      uploadedVersion.set(tex, provider.atlasVersion);
    }
    return tex;
  }

  if (page !== 0 || !provider.atlasImageUrl) return null; // baked is single-page
  /** Page 0's IMAGE is IMMUTABLE, so its key must NOT carry atlasVersion.
   *
   *  ⚠️ A baked-seeded dynamic font bumps `atlasVersion` on EVERY generated glyph batch, and
   *  its page 0 is the baked atlas image. Keyed by version, each batch minted a fresh key:
   *  the cache missed, `getFontTexture*` returned null while a redundant load of the SAME url
   *  started, and every baked glyph vanished for those frames — so typing CJK made the Latin
   *  text flicker. The superseded Texture also stayed in the map under its old key until the
   *  font was released. Harmless before this existed, because a provider was either all-image
   *  (version pinned 0) or all-canvas (this path unreachable); the hybrid made both live. */
  const key = `${provider.id}:image`;
  const existing = cache.get(key);
  if (existing) return existing;

  const url = provider.atlasImageUrl;
  const failureKey = `${provider.id}\n${url}`;
  if (failures.blocked(failureKey)) return null;
  const tex = loader.load(
    url,
    () => {
      failures.forget(failureKey);
      // Repaint once the image is actually here. The retry's own wake (`onRetryDue`) fires BEFORE
      // this load starts, and the idle 3D surfaces render only ~1 s after a wake — an atlas slower
      // than that would land into a frame nobody draws (#1397 review).
      markTextDirty(provider.id);
    },
    undefined,
    (err) => {
      // Evict the image-less placeholder, so the next ask after the backoff loads again instead
      // of finding it cached. Identity-checked: a disposed-and-reacquired font may own the key now.
      if (cache.get(key) === tex) cache.delete(key);
      tex.dispose();
      failures.record(failureKey, absentIfBundled(url, err), !disposedProviders.has(provider));
    },
  );
  styleFontTexture(tex);
  cache.set(key, tex);
  if (!imageDisposerRegistered.has(provider)) {
    imageDisposerRegistered.add(provider);
    provider.addDisposable(() => {
      disposedProviders.add(provider);
      const t = cache.get(key);
      if (t) { t.dispose(); cache.delete(key); }
      failures.forget(failureKey);
    });
  }
  return tex;
}
