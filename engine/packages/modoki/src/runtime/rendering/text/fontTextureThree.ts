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

const cache = new Map<string, THREE.Texture>();
const loader = new THREE.TextureLoader();
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

  const tex = loader.load(provider.atlasImageUrl);
  styleFontTexture(tex);
  cache.set(key, tex);
  provider.addDisposable(() => {
    const t = cache.get(key);
    if (t) { t.dispose(); cache.delete(key); }
  });
  return tex;
}
