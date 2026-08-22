/** Texture tier-variant emit policy (#212). Landed in `0deb2c5b`/`f6b8da81`, per-tier texture
 *  LOD variants ship every size INSIDE the package — measured on `demos/postfx-demo`: dist grew
 *  32,428 → 38,736 KB (+19%) to buy a device that fetches only its own variant −76% texture
 *  bytes and −268 ms median boot. For a web/OTA delivery that cost is paid by nobody (the device
 *  downloads only what it picks); for a plain APK/IPA install it is pure install-size growth for
 *  a device that already has every size on disk. Owner decision: emit only when the payload is
 *  delivered OVER THE WIRE, with an explicit per-project override in both directions.
 *
 *  Pure — reads only env vars + the project's `build.textureTierVariants` setting, so this is
 *  unit-testable without a real build. The scanner (`vite-asset-scanner.ts`) must call this
 *  ONCE and gate the tier-cap collection on it, not re-derive the condition inline. */

import { isPlayableBuild } from './playable-profile';
import type { TEXTURE_TIER_VARIANTS_MODES } from '../project-config';

export type TextureTierVariantsMode = (typeof TEXTURE_TIER_VARIANTS_MODES)[number];

/** True when this build should emit per-tier texture LOD variants.
 *
 *  - `'always'` / `'never'` are unconditional overrides — the explicit per-project opt in/out.
 *  - `'auto'` emits when the payload travels over the wire: a web build
 *    (`MODOKI_BUILD_TARGET === 'web'`, set by `build-web.mjs --target web`) OR a native build
 *    that is actually an OTA publish (`MODOKI_OTA_PUBLISH === '1'`, set by the `/api/ota/publish`
 *    route around its `--target native` build step — see `otaPublishBuildStepEnv` in
 *    `vite-asset-scanner.ts`). A PLAIN `--target native` build (a package built for install) is
 *    neither, so `'auto'` emits nothing for it.
 *  - A playable build is excluded FIRST, unconditionally, regardless of mode: it already clamps
 *    every texture to ≤512px (`playableTextureSettings`), so a second size axis on top is waste,
 *    not a feature — 'always' does not override this. */
export function shouldEmitTextureTierVariants(mode: TextureTierVariantsMode): boolean {
  if (isPlayableBuild()) return false;
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  // 'auto'
  return process.env.MODOKI_BUILD_TARGET === 'web' || process.env.MODOKI_OTA_PUBLISH === '1';
}
