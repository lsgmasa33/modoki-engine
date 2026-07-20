/** characterAnimationSystem (Phase 4.6) — maps CharacterController2D motion state onto the
 *  sibling SpriteAnimator's active clip + flips facing via Transform.sx. Pure trait logic,
 *  so it verifies headlessly. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { Renderable2D } from '../../src/runtime/traits/Renderable2D';
import { SpriteAnimator } from '../../src/runtime/traits/SpriteAnimator';
import { setSpriteAnim, clearSpriteAnimCache } from '../../src/runtime/loaders/spriteAnimCache';
import { CharacterController2D } from '../../src/runtime/traits/CharacterController2D';
import { CharacterAnimator2D } from '../../src/runtime/traits/CharacterAnimator2D';
import { characterAnimationSystem } from '../../src/runtime/systems/characterAnimationSystem';

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { tw.dispose(); tw = undefined; } clearSpriteAnimCache(); });

const CLIPS = {
  idle: { frames: ['i0'], fps: 6, mode: 'loop' as const, cycles: 0 },
  walk: { frames: ['w0', 'w1'], fps: 10, mode: 'loop' as const, cycles: 0 },
  jump: { frames: ['j0', 'j1'], fps: 10, mode: 'once' as const, cycles: 0 },
};
// The clips live in a .spriteanim asset now; seed the cache by path so the character
// system's spriteAnimHasClip resolves it synchronously (no fetch in the harness).
const SET = 'chars/hero.spriteanim.json';

function setup() {
  setSpriteAnim(SET, { clips: CLIPS });
  tw = createTestWorld({ systems: [{ name: 'charAnim', fn: characterAnimationSystem, priority: SYSTEM_PRIORITY.GAME }] });
  return tw;
}
function character(cc: Record<string, unknown>, r2d: Record<string, unknown> = {}) {
  return tw!.spawn(
    Transform({ x: 0, y: 0 }),
    Renderable2D({ sprite: 'i0', flipX: false, ...r2d }),
    SpriteAnimator({ clipSet: SET, clip: 'idle', time: 1.23, playing: false }),
    CharacterController2D(cc),
    CharacterAnimator2D({}),
  );
}
const spr = (e: unknown) => tw!.trait<{ clip: string; time: number; playing: boolean }>(SpriteAnimator, e);
const flipOf = (e: unknown) => tw!.trait<{ flipX: boolean }>(Renderable2D, e).flipX;

describe('characterAnimationSystem — clip selection', () => {
  it('grounded + still → idle', () => {
    setup(); const c = character({ grounded: true, moveX: 0 });
    tw!.step(1);
    expect(spr(c).clip).toBe('idle');
  });
  it('grounded + moving → walk (and restarts the track)', () => {
    setup(); const c = character({ grounded: true, moveX: 1 });
    tw!.step(1);
    expect(spr(c).clip).toBe('walk');
    expect(spr(c).time).toBe(0);        // restarted on clip change
    expect(spr(c).playing).toBe(true);
  });
  it('airborne → jump regardless of moveX', () => {
    // readbackReady:true = physics has reported this frame's grounded (a REAL airborne).
    setup(); const c = character({ grounded: false, moveX: 1, readbackReady: true });
    tw!.step(1);
    expect(spr(c).clip).toBe('jump');
  });
  it('default-false grounded before physics reports → idle, NOT jump (spawn-flash fix)', () => {
    // Fresh spawn: grounded still defaults to false because physics (PHYSICS priority)
    // hasn't run yet this frame. readbackReady:false must be treated as grounded so the
    // character doesn't flash the jump clip on the first frame(s) after Play.
    setup(); const c = character({ grounded: false, moveX: 0, readbackReady: false });
    tw!.step(1);
    expect(spr(c).clip).toBe('idle');
  });
  it('below moveThreshold counts as still → idle', () => {
    setup(); const c = character({ grounded: true, moveX: 0.02 });
    tw!.step(1);
    expect(spr(c).clip).toBe('idle');
  });
});

describe('characterAnimationSystem — facing (Renderable2D.flipX, not Transform)', () => {
  it('moving left sets flipX; right clears it', () => {
    setup(); const c = character({ grounded: true, moveX: -1 });
    tw!.step(1);
    expect(flipOf(c)).toBe(true);
    c.set(CharacterController2D, { moveX: 1 });   // now move right
    tw!.step(1);
    expect(flipOf(c)).toBe(false);
  });
  it('never touches Transform.sx (physics/child transform untouched)', () => {
    setup(); const c = character({ grounded: true, moveX: -1 });
    tw!.step(1);
    expect(tw!.trait<{ sx: number }>(Transform, c).sx).toBe(1);
  });
  it('does not change facing while still', () => {
    setup(); const c = character({ grounded: true, moveX: 0 }, { flipX: true });
    tw!.step(1);
    expect(flipOf(c)).toBe(true);   // kept last direction
  });
  it('leaves facing unchanged with flip disabled', () => {
    setup();
    const c = tw!.spawn(
      Transform({ x: 0, y: 0 }),
      Renderable2D({ sprite: 'i0', flipX: false }),
      SpriteAnimator({ clipSet: SET, clip: 'idle', time: 0, playing: true }),
      CharacterController2D({ grounded: true, moveX: -1 }),
      CharacterAnimator2D({ flip: false }),
    );
    tw!.step(1);
    expect(flipOf(c)).toBe(false);
    expect(spr(c).clip).toBe('walk');   // clip still switches
  });
});
