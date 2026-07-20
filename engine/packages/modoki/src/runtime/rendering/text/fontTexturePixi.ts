/** PixiJS atlas-texture cache for SDF fonts — the 2D twin of {@link getFontTexture}
 *  (the Three version). One Pixi Texture per `${fontId}:${atlasVersion}`, loaded via
 *  Assets from the provider's atlas image URL and freed when the font is released
 *  (provider.addDisposable) — so the GPU texture tracks the font's scene-scoped life
 *  without the renderer-agnostic provider importing Pixi.
 *
 *  MTSDF atlases are DATA (distance fields), not colour: NO premultiply (that would
 *  corrupt the RGB median where alpha is low), linear filtering, no mipmaps. The
 *  `-yorigin top` bake gives top-origin UVs, which is Pixi-native (no flip).
 */

import { Assets, Texture, CanvasSource } from 'pixi.js';
import { loadPixiTexture } from '../pixiTextureLoad';
import type { FontProvider } from './fontProvider';

const cache = new Map<string, Texture>();
const loading = new Set<string>();
/** Last atlasVersion uploaded into each dynamic canvas-backed Texture. */
const uploadedVersion = new WeakMap<Texture, number>();

/** Dynamic (path B): build ONE Texture from a page's growing canvas and call
 *  `source.update()` whenever atlasVersion bumps (a new glyph batch was blitted). */
function getDynamicFontTexturePixi(provider: FontProvider, page: number): Texture | null {
  const canvas = provider.atlasCanvasAt?.(page);
  if (!canvas) return null;
  const key = `${provider.id}:canvas:${page}`;
  let tex = cache.get(key);
  if (!tex) {
    const source = new CanvasSource({ resource: canvas, scaleMode: 'linear', alphaMode: 'no-premultiply-alpha' });
    tex = new Texture({ source });
    cache.set(key, tex);
    provider.addDisposable(() => {
      cache.delete(key);
      tex!.destroy(true);
    });
  }
  if (uploadedVersion.get(tex) !== provider.atlasVersion) {
    tex.source.update();
    uploadedVersion.set(tex, provider.atlasVersion);
  }
  return tex;
}

/** Get (or kick off loading of) the atlas texture for a font provider's `page`
 *  (default 0). Returns the cached Texture, or null while it loads / for a page with
 *  no image yet; `onReady` fires once a load completes so the caller can re-render.
 *  Baked fonts are single-page (page 0 → the image URL). */
export function getFontTexturePixi(provider: FontProvider, page = 0, onReady?: () => void): Texture | null {
  if (provider.atlasCanvasAt) return getDynamicFontTexturePixi(provider, page);
  if (page !== 0 || !provider.atlasImageUrl) return null; // baked is single-page
  const key = `${provider.id}:${provider.atlasVersion}`;
  const existing = cache.get(key);
  if (existing) return existing;
  if (loading.has(key)) return null;

  loading.add(key);
  const url = provider.atlasImageUrl;
  loadPixiTexture(url)
    .then((tex: Texture) => {
      loading.delete(key);
      // Distance-field data: linear filter, NO premultiply (RGB median must stay
      // intact under low alpha). Set before first GPU upload (lazy on first render).
      tex.source.scaleMode = 'linear';
      tex.source.alphaMode = 'no-premultiply-alpha';
      tex.source.update();
      cache.set(key, tex);
      provider.addDisposable(() => {
        cache.delete(key);
        Assets.unload(url).catch(() => { /* already gone */ });
      });
      onReady?.();
    })
    .catch((e: unknown) => {
      loading.delete(key);
      console.warn(`[fontTexturePixi] atlas load failed: ${url}`, e);
    });
  return null;
}
