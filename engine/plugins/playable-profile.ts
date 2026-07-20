/** Playable asset profile — the build-wide asset-shrink overrides for a single-file
 *  "playable ad" web build (AppLovin etc., ≤5 MB). See docs/playable-export.md.
 *
 *  The engine's per-asset conversion is normally driven ENTIRELY by each asset's
 *  `.meta.json` sidecar (there is no build-wide override). A playable build can't rely on
 *  every game author having authored small textures / a downscaled HDR, so this profile
 *  layers aggressive overrides ON TOP of the resolved per-asset settings, applied inside
 *  the asset-scanner's existing `computeKeptAssets().kept` loops — so it's automatically
 *  scoped to the REACHABLE set (nothing off-scene is touched).
 *
 *  Trigger: `MODOKI_PLAYABLE=1` (set by the Phase-4 `playable` build target). Kept as a
 *  pure env read + pure setting transforms so the whole profile is unit-testable without
 *  a real build.
 *
 *  What it forces (measured on sling: ~12 MB of assets → ~1 MB):
 *   - Textures → WebP @ ≤512px. Both build-emit (`variantsToEmit`) and runtime resolve
 *     (`selectVariant`) key off `format`, and they AGREE on 'webp' for 2d AND 3d usage, so
 *     Three's ImageLoader / PixiJS load the WebP variant natively — no KTX2, no transcoder.
 *   - HDR env → downscaled Radiance @ 256px (forced even when the source has no
 *     `environmentCache` block, which would otherwise ship the multi-MB source verbatim).
 *   - KTX2 transcoders (basis + pixi-ktx, ~1.2 MB of wasm) SKIPPED: a WebP-only texture set
 *     emits zero KTX2 variants, so nothing decodes them at runtime. */

import type { TextureImportSettings, TextureMaxSize } from '../packages/modoki/src/runtime/loaders/textureSettings';
import type { EnvImportSettings, EnvMaxSize } from '../packages/modoki/src/runtime/loaders/environmentSettings';

/** Longest-edge caps for the playable profile. Deliberately small — a playable is a
 *  low-fidelity ad, not the shipped game. */
export const PLAYABLE_TEXTURE_MAX: TextureMaxSize = 512;
export const PLAYABLE_ENV_MAX: EnvMaxSize = 256;
export const PLAYABLE_WEBP_QUALITY = 70;

/** True when this build should apply the playable asset profile. */
export function isPlayableBuild(): boolean {
  return process.env.MODOKI_PLAYABLE === '1';
}

/** Override a texture's resolved settings for a playable build: force WebP (browser-decoded,
 *  no KTX2 transcoder) and cap the longest edge at {@link PLAYABLE_TEXTURE_MAX} (only
 *  shrinks — a texture already ≤512 keeps its size). */
export function playableTextureSettings(s: TextureImportSettings): TextureImportSettings {
  return {
    ...s,
    format: 'webp',
    maxSize: Math.min(s.maxSize, PLAYABLE_TEXTURE_MAX) as TextureMaxSize,
    webpQuality: PLAYABLE_WEBP_QUALITY,
  };
}

/** Override an HDR environment's resolved settings for a playable build: plain downscaled
 *  Radiance (NOT 'ultrahdr' — that needs a committed browser-encoded variant a playable
 *  source won't have) capped at {@link PLAYABLE_ENV_MAX}. */
export function playableEnvSettings(s: EnvImportSettings): EnvImportSettings {
  return {
    ...s,
    format: 'hdr',
    maxSize: Math.min(s.maxSize, PLAYABLE_ENV_MAX) as EnvMaxSize,
  };
}
