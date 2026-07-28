/** Provider slot for the animation-asset lookup seam (P7 C11): clip/sprite-anim/anim-set/
 *  rigged-model caches, all L3 (`loaders/`), consumed by several `animation/` systems and
 *  `timeline/timelineSystem.ts` (via the declared timeline→animation L2_ALLOWED edge).
 *  Installed by `loaders/{animationClipCache,spriteAnimCache,animSetCache,
 *  riggedModelCache}.ts` at composition time (composed in `registerProviders.ts`, same
 *  reasoning as the other multi-loader slots — see its header).
 *
 *  Input/output shapes are typed minimally against what these callers actually touch
 *  (a clipSet/clip pair, a named-clips array) rather than importing the loaders' full
 *  cache-entry types — those stay loader-owned, only their USE shape crosses the seam. */

import { createProviderSlot } from '../core/providerSlot';
import type { AnimationClipDef } from './types';
import type { SpriteClip } from '../traits/SpriteAnimator';

/** The subset of a SpriteAnimator instance the sprite-anim resolvers read. */
export interface SpriteAnimSource {
  clipSet?: string;
  clip?: string;
}

export interface AnimationAssetProvider {
  getAnimationClip(ref: string): AnimationClipDef | null;
  getSpriteAnim(ref: string): { clips: Record<string, SpriteClip> } | null;
  resolveSpriteClip(ref: string, clipName: string): SpriteClip | undefined;
  activeSpriteClip(anim: SpriteAnimSource): SpriteClip | undefined;
  spriteAnimHasClip(anim: SpriteAnimSource, name: string): boolean;
  getAnimSet(ref: string): { clips: { name: string }[] } | null;
  getClipNames(modelRef: string): string[];
}

export const animationAssetProvider = createProviderSlot<AnimationAssetProvider>('animationAssetProvider');
