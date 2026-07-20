/** characterAnimationSystem — drives a 2D platformer character's flipbook from its
 *  controller state (Phase 4.6). For every entity carrying CharacterAnimator2D +
 *  CharacterController2D + SpriteAnimator it:
 *    - picks the active SpriteAnimator clip from motion state (jump / walk / idle) and
 *      restarts the track from frame 0 when the clip changes, and
 *    - mirrors the sprite by facing via Renderable2D.flipX (when `flip` is on).
 *
 *  Facing uses `Renderable2D.flipX` (a render-only mirror), NOT a negative Transform
 *  scale: that keeps the transform untouched, never mirrors child entities, and stays
 *  invisible to the physics collider.
 *
 *  Runs at GAME priority (with the input bridge), BEFORE spriteAnimationSystem
 *  (ANIMATION) reads the chosen clip that same frame. `grounded`/`velY` are the previous
 *  frame's physics readback (physics runs later, at PHYSICS priority) — a one-frame lag
 *  that's imperceptible for animation. Reads only trait fields, so it's deterministic and
 *  safe under the headless harness (it just no-ops without the sibling traits). */

import type { World } from 'koota';
import { CharacterAnimator2D } from '../traits/CharacterAnimator2D';
import { CharacterController2D } from '../traits/CharacterController2D';
import { SpriteAnimator } from '../traits/SpriteAnimator';
import { spriteAnimHasClip, type SpriteAnimSource } from '../loaders/spriteAnimCache';
import { Renderable2D } from '../traits/Renderable2D';
import { Paused } from '../traits/Paused';

interface AnimCfg { idleClip: string; walkClip: string; jumpClip: string; moveThreshold: number; flip: boolean }
interface CharState { moveX: number; grounded: boolean; readbackReady: boolean }
interface SprState { clipSet?: string; clips?: Record<string, unknown>; clip: string; time: number; playing: boolean }
interface R2dState { flipX: boolean }

export function characterAnimationSystem(world: World): void {
  world.query(CharacterAnimator2D, CharacterController2D, SpriteAnimator, Renderable2D).updateEach(
    ([cfg, cc, spr, r2d]: [AnimCfg, CharState, SprState, R2dState], entity) => {
      if (entity.has(Paused)) return;

      const moving = Math.abs(cc.moveX) > cfg.moveThreshold;
      // Physics runs AFTER this system (PHYSICS priority), so on the first frame(s)
      // after spawn `grounded` is still its default `false` — treat the character as
      // grounded until physics has reported at least once, else it flashes the jump
      // clip on start before settling.
      const grounded = cc.readbackReady ? cc.grounded : true;
      const desired = !grounded ? cfg.jumpClip : moving ? cfg.walkClip : cfg.idleClip;

      // Switch tracks only to a clip that actually exists (in the clipSet asset or
      // the legacy inline map); restart it from the top.
      if (desired && spr.clip !== desired && spriteAnimHasClip(spr as SpriteAnimSource, desired)) {
        spr.clip = desired;
        spr.time = 0;
        spr.playing = true;
      }

      // Facing: the sheet faces right, so moving left mirrors horizontally. Leave the
      // facing unchanged while (near-)still so the character keeps its last direction.
      if (cfg.flip && moving) {
        r2d.flipX = cc.moveX < 0;
      }
    },
  );
}
