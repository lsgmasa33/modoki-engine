/** Three.js atlas-texture cache for SDF fonts. Builds one THREE.Texture per
 *  `${fontId}:${atlasVersion}` from the provider's atlas image URL, and ties its
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
    }
    if (uploadedVersion.get(tex) !== provider.atlasVersion) {
      tex.needsUpdate = true;
      uploadedVersion.set(tex, provider.atlasVersion);
    }
    return tex;
  }

  if (page !== 0 || !provider.atlasImageUrl) return null; // baked is single-page
  const key = `${provider.id}:${provider.atlasVersion}`;
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
