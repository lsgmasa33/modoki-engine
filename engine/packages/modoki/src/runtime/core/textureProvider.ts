/** Provider slot for the "GUID/path → texture" resolution seam (P7 C9) — the single biggest
 *  shared cross-L2 reach in the runtime. Installed by `loaders/textureResolver.ts` +
 *  `loaders/assetManifest.ts` at module-eval time. Consumed by `particles/{cpuTslBackend,
 *  gpuComputeBackend,pixiParticleBackend}.ts`, `ui/UINode.tsx`, `skinning/skin2DSystem.ts`, and
 *  `core/textureRefs.ts` (the pure ref-classification helpers built on top of this).
 *
 *  `ResolvedSprite` lives here (not `loaders/textureResolver.ts`) since it's the shape flowing
 *  through this seam — `textureResolver.ts` re-exports it for its existing callers. */

import type * as THREE from 'three';
import { createProviderSlot } from './providerSlot';

/** A resolved sprite: the served URL of the texture (or, post-packing, atlas page)
 *  that backs it, the source-pixel frame rect, and the slice's pivot. A whole-texture
 *  ref resolves with `frame: null` (use the entire image). */
export interface ResolvedSprite {
  url: string;
  /** Source-pixel rect within the authored sheet, or null for the whole image.
   *  The render path scales this to the actually-loaded variant via {@link ResolvedSprite.sheetW}. */
  frame: { x: number; y: number; w: number; h: number } | null;
  pivot: { x: number; y: number } | null;
  /** Source-sheet dims the frame was authored against. When the loaded variant is
   *  downscaled, multiply frame coords by `loadedTexW / sheetW`. Null ⇒ no scaling. */
  sheetW: number | null;
  sheetH: number | null;
  /** 9-slice border insets (source px), for UI `border-image`. Absent ⇒ plain image.
   *  `scale` = CSS px drawn per source px of border (Unity PPU-style); absent ⇒ 1. */
  border?: { l: number; r: number; t: number; b: number; scale?: number };
}

export interface TextureProvider {
  resolveSprite(ref: string): ResolvedSprite | undefined;
  resolveTextureVariantUrl(ref: string, usage: '2d' | '3d'): string | undefined;
  resolveBrowserImageUrl(ref: string, warnKtx?: boolean): string | undefined;
  loadTexture3D(ref: string, opts?: { flipY?: boolean }): Promise<THREE.Texture>;
  releaseTexture3D(tex: THREE.Texture | null | undefined): void;
  getSpriteEpoch(ref: string): number;
  /** Loosely typed (not `AssetType`, which lives in loaders/assetManifest.ts, L3) — callers
   *  only ever compare the result against a couple of literal strings. */
  getAssetType(guid: string): string | undefined;
  ensurePixiKtxTranscoder(): void;
}

export const textureProvider = createProviderSlot<TextureProvider>('textureProvider');
