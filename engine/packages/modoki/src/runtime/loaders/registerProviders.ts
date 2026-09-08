/** Side-effect import that wires every `core/providerSlot.ts` seam, so importing THIS module
 *  once (from `runtime/index.ts`) is enough for any consumer that goes through the barrel.
 *  Slots owned by a SINGLE loader self-register at that loader's own module-evaluation time
 *  (see the `<slot>.provide(...)` call at the bottom of the file — `particleCache.ts` does
 *  this). Slots spanning MULTIPLE loaders (`textureProvider`, `assetPlumbing`,
 *  `animationAssetProvider`) are composed and provided HERE instead — deliberately NOT by
 *  adding new cross-file imports to a widely-mocked loader file (`textureResolver.ts`,
 *  `assetManifest.ts`); doing that once broke tests unrelated to the seam being wired
 *  (measured: `riggedModelCache.test.ts` when `textureResolver.ts` gained new imports from
 *  `assetManifest.ts`). */

import './particleCache';
import './gpuMemoryReport';

import { textureProvider } from '../core/textureProvider';
import {
  resolveSprite, resolveTextureVariantUrl, resolveBrowserImageUrl, loadTexture3D, releaseTexture3D,
} from './textureResolver';
import { getSpriteEpoch, getAssetType } from './assetManifest';
import { ensurePixiKtxTranscoder } from './pixiKtxTranscoder';

import { assetPlumbing } from '../core/assetPlumbing';
import { assetUrl } from './assetUrl';
import { ASSET_FETCH_INIT } from './assetFetch';
import { fetchShaderManifest } from './shaderSchema';

import { animationAssetProvider } from '../animation/assetProviders';
import { getAnimationClip } from './animationClipCache';
import { getSpriteAnim, resolveSpriteClip, activeSpriteClip, spriteAnimHasClip } from './spriteAnimCache';
import { getAnimSet } from './animSetCache';
import { getClipNames } from './riggedModelCache';

import { audioAssetProvider } from '../audio/audioAssetProvider';
import { getCachedAudioBuffer, resolveAudioUrl, retryFailedAudioDecodes } from './audioBufferCache';
import { getAudioLoadType } from './assetManifest';

import { domFontProvider } from '../core/domFontProvider';
import { familyForFontRef } from './fontLoader';

import { rig2dProvider } from '../skinning/rig2dProvider';
import { getRig2D } from './rig2dCache';

import { materialProvider } from '../rendering/materialProvider';
import { resolveMaterial } from './meshTemplateCache';

import { meshColliderProvider } from '../physics/meshColliderProvider';
import { resolveMeshTemplate } from './meshTemplateCache';

import { timelineAssetProvider } from '../timeline/assetProvider';
import { getTimeline } from './timelineCache';
import { getCachedPrefab } from './meshTemplateCache';
import { spawnPrefabInstance } from './loadSceneFile';

textureProvider.provide({
  resolveSprite, resolveTextureVariantUrl, resolveBrowserImageUrl, loadTexture3D, releaseTexture3D,
  getSpriteEpoch, getAssetType, ensurePixiKtxTranscoder,
});

assetPlumbing.provide({ assetUrl, fetchInit: ASSET_FETCH_INIT, fetchShaderManifest });

animationAssetProvider.provide({
  getAnimationClip, getSpriteAnim, resolveSpriteClip, activeSpriteClip, spriteAnimHasClip,
  getAnimSet, getClipNames,
});

audioAssetProvider.provide({ getCachedAudioBuffer, resolveAudioUrl, retryFailedAudioDecodes, getAudioLoadType });

domFontProvider.provide({ familyForGuid: familyForFontRef });

rig2dProvider.provide({ getRig2D });

materialProvider.provide({ resolveMaterial });

meshColliderProvider.provide({ resolveMeshGeometry: (ref) => resolveMeshTemplate(ref)?.geometry });

timelineAssetProvider.provide({
  getTimeline, getCachedPrefab,
  spawnPrefabInstance: (world, prefab, opts) => spawnPrefabInstance(world, prefab as never, opts),
});
