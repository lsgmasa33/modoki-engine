/** The clip NAMES an animator entity can switch to via `engine.playClip` — so an agent or
 *  UI can DISCOVER the switch targets without opening the underlying asset. Unifies the three
 *  animator flavours, whose clip lists live in different places:
 *    - `Animator`         — the inline JSON `clips` bank (keyframe `.anim.json` refs)
 *    - `SpriteAnimator`   — the `clipSet` `.spriteanim.json` asset's named clips
 *    - `SkeletalAnimator` — the rigged GLB's own clips ∪ every clip of each animset's `source` GLB
 *                           (its `animSet` and the `AnimationLibrary`'s)
 *
 *  Best-effort + synchronous: asset-backed sources (sprite clipSet, skeletal GLB/animset)
 *  return [] until the asset has loaded into its cache (the same lazy-load the runtime uses).
 *  Returns [] for an entity that lacks the trait. Fed into `get_scene_state` (Percept). */

import { findEntity } from '../core/ecs/entityUtils';
import { Animator } from '../traits/Animator';
import { SpriteAnimator } from '../traits/SpriteAnimator';
import { SkeletalAnimator } from '../traits/SkeletalAnimator';
import { SkinnedModel } from '../traits/SkinnedModel';
import { AnimationLibrary } from '../traits/AnimationLibrary';
import { parseAnimClipBank } from './animClipBank';
import { animationAssetProvider } from './assetProviders';
function getSpriteAnim(ref: string) { return animationAssetProvider.get()?.getSpriteAnim(ref) ?? null; }
function getClipNames(modelRef: string) { return animationAssetProvider.get()?.getClipNames(modelRef) ?? []; }
function getAnimSet(ref: string) { return animationAssetProvider.get()?.getAnimSet(ref) ?? null; }
function isRiggedModelLoaded(ref: string) { return animationAssetProvider.get()?.isRiggedModelLoaded(ref) ?? false; }

/** A SkeletalAnimator's playable clip names, and whether that list is COMPLETE.
 *
 *  The roster mirrors what the render layer's mixer can actually play (`scene3DSync.ts`'s library
 *  merge): the rig's own GLB clips plus EVERY clip of each animset's `source` GLB. An animset's declared
 *  `clips` entries are NOT counted: they are optional per-clip parameters, never turned into actions —
 *  counting only them refused a clip the mixer played, and counting them as well advertised a name the
 *  mixer cannot play (`driveAnimator` warns and falls back to the first clip) (#1129 reviews). A source-
 *  less animset contributes nothing, as in the merge.
 *
 *  ⚠️ KEEP IN SYNC with `mergeAnimationLibrary` + `effectiveLibrary` in `rendering/scene3DSync.ts` — this is
 *  a second derivation of the same source set, and no test ties the two (a merge that gains per-clip
 *  sources or a filter would leave this list stale, and the first symptom is a false refusal).
 *
 *  `complete` is false while any source has not loaded (the model GLB, an animset, an animset's source
 *  GLB) — the mixer retries those every frame, so a name missing from a partial list may still play.
 *  A caller that REFUSES an unknown name must require `complete`; one that only lists names need not. */
export function skeletalClipRoster(entityId: number): { names: string[]; complete: boolean } {
  const entity = findEntity(entityId);
  if (!entity || !entity.has(SkeletalAnimator)) return { names: [], complete: true };
  const skel = entity.get(SkeletalAnimator)!;
  const names = new Set<string>();
  let complete = true;
  const addModel = (ref: string) => {
    if (!isRiggedModelLoaded(ref)) { complete = false; return; }
    for (const n of getClipNames(ref)) names.add(n);
  };
  const model = entity.get(SkinnedModel)?.model;   // GLB's own clips
  if (model) addModel(model);
  const addAnimSet = (ref?: string) => {
    if (!ref) return;
    const set = getAnimSet(ref);
    if (!set) { complete = false; return; }
    if (set.source) addModel(set.source);
  };
  addAnimSet(skel.animSet);                          // this animator's animset
  const lib = entity.get(AnimationLibrary);          // shared cross-model clip library
  if (lib && Array.isArray(lib.animSets)) for (const ref of lib.animSets) addAnimSet(ref);
  return { names: [...names], complete };
}

/** Trait names that carry a switchable named-clip pointer (the `engine.playClip` targets). */
export const ANIMATOR_CLIP_TRAITS = new Set(['Animator', 'SpriteAnimator', 'SkeletalAnimator']);

/** Names playable on `traitName` of the entity `entityId`, or [] if none / not loaded yet. */
export function switchableClipNames(entityId: number, traitName: string): string[] {
  const entity = findEntity(entityId);
  if (!entity) return [];

  if (traitName === 'Animator') {
    const a = entity.get(Animator);
    return a ? parseAnimClipBank(a.clips).map((c) => c.name) : [];
  }

  if (traitName === 'SpriteAnimator') {
    const s = entity.get(SpriteAnimator);
    const set = s?.clipSet ? getSpriteAnim(s.clipSet) : null;
    return set ? Object.keys(set.clips) : [];
  }

  if (traitName === 'SkeletalAnimator') return skeletalClipRoster(entityId).names;

  return [];
}
