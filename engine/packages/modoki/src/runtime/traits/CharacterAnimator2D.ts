import { trait } from 'koota';

/** CharacterAnimator2D — the connective "attribute" that turns a 2D platformer character
 *  into an animated one: it maps a sibling `CharacterController2D`'s motion state onto a
 *  sibling `SpriteAnimator`'s active clip, and mirrors the sprite by facing.
 *
 *  Put it on the SAME entity as the `Renderable2D` + `SpriteAnimator` + `CharacterController2D`.
 *  Each frame `characterAnimationSystem` picks the clip:
 *    - airborne (`!grounded`)            → `jumpClip`
 *    - grounded & |moveX| > threshold    → `walkClip`
 *    - grounded & (near-)still           → `idleClip`
 *  and, when `flip` is on, sets `Transform.sx`'s sign from the move direction (the base sheet
 *  faces right; moving left flips it). Switching clips restarts the new track from frame 0.
 *
 *  Determinism: reads only trait fields (no DOM / wall-clock), so it's safe under the harness
 *  and the determinism guard. Facing writes `Transform.sx`, which the 2D renderer multiplies
 *  into the sprite's scale while the physics collider ignores it (unscaled world units). */
export const CharacterAnimator2D = trait({
  /** Clip (SpriteAnimator track) name played when grounded and still. */
  idleClip: 'idle' as string,
  /** Clip played when grounded and moving horizontally. */
  walkClip: 'walk' as string,
  /** Clip played while airborne. */
  jumpClip: 'jump' as string,
  /** |moveX| above this counts as "moving" (moveX is the -1..1 input axis). */
  moveThreshold: 0.05 as number,
  /** Mirror the sprite by move direction via `Transform.sx` sign (sheet faces right). */
  flip: true as boolean,
});
