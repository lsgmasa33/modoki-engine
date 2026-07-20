/** The clip NAMES an animator entity can switch to via `engine.playClip` — so an agent or
 *  UI can DISCOVER the switch targets without opening the underlying asset. Unifies the three
 *  animator flavours, whose clip lists live in different places:
 *    - `Animator`         — the inline JSON `clips` bank (keyframe `.anim.json` refs)
 *    - `SpriteAnimator`   — the `clipSet` `.spriteanim.json` asset's named clips
 *    - `SkeletalAnimator` — the rigged GLB's own clips ∪ its `animSet` ∪ `AnimationLibrary`
 *
 *  Best-effort + synchronous: asset-backed sources (sprite clipSet, skeletal GLB/animset)
 *  return [] until the asset has loaded into its cache (the same lazy-load the runtime uses).
 *  Returns [] for an entity that lacks the trait. Fed into `get_scene_state` (Percept). */

import { findEntity } from '../ecs/entityUtils';
import { Animator } from '../traits/Animator';
import { SpriteAnimator } from '../traits/SpriteAnimator';
import { SkeletalAnimator } from '../traits/SkeletalAnimator';
import { SkinnedModel } from '../traits/SkinnedModel';
import { AnimationLibrary } from '../traits/AnimationLibrary';
import { parseAnimClipBank } from './animClipBank';
import { getSpriteAnim } from '../loaders/spriteAnimCache';
import { getClipNames } from '../loaders/riggedModelCache';
import { getAnimSet } from '../loaders/animSetCache';

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

  if (traitName === 'SkeletalAnimator') {
    if (!entity.has(SkeletalAnimator)) return [];
    const skel = entity.get(SkeletalAnimator)!;
    const names = new Set<string>();
    const model = entity.get(SkinnedModel)?.model;   // GLB's own clips
    if (model) for (const n of getClipNames(model)) names.add(n);
    const addAnimSet = (ref?: string) => { if (ref) for (const c of getAnimSet(ref)?.clips ?? []) names.add(c.name); };
    addAnimSet(skel.animSet);                          // this animator's animset
    const lib = entity.get(AnimationLibrary);          // shared cross-model clip library
    if (lib && Array.isArray(lib.animSets)) for (const ref of lib.animSets) addAnimSet(ref);
    return [...names];
  }

  return [];
}
