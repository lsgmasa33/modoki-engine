/** spriteAnimationSystem — drives Renderable2D.sprite through a frame list
 *  (flipbook), honoring loop / once / pingpong play modes and `cycles`. The clips
 *  live in a `.spriteanim` asset (SpriteAnimator.clipSet); tests seed the cache by
 *  path so resolution is synchronous in the headless harness. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld, type World } from 'koota';
import { Renderable2D } from '../../src/runtime/traits/Renderable2D';
import { Paused } from '../../src/runtime/traits/Paused';
import { Time } from '../../src/runtime/traits/Time';
import { SpriteAnimator, type SpriteClip } from '../../src/runtime/traits/SpriteAnimator';
import { setSpriteAnim, clearSpriteAnimCache } from '../../src/runtime/loaders/spriteAnimCache';
import { spriteAnimationSystem } from '../../src/runtime/systems/spriteAnimationSystem';
import { spriteIndexFromStep, spriteFrameIndex } from '../../src/runtime/particles/types';

afterEach(() => clearSpriteAnimCache());

const FRAMES = ['fa', 'fb', 'fc', 'fd']; // 4 frames
let setSeq = 0; // unique asset key per setup so seeds never bleed across tests

// smoothedDelta 0.5 × fps 2 = +1 step per tick — one frame advance per call.
// `clipOverrides` tune the single clip (frames/fps/mode/cycles); time/playing sit on the trait.
function setup(opts: { time?: number; playing?: boolean } & Partial<SpriteClip> = {}) {
  const { time, playing, ...clipOverrides } = opts;
  const set = `single-${++setSeq}.spriteanim.json`;
  setSpriteAnim(set, { clips: { main: { frames: [...FRAMES], fps: 2, mode: 'loop', cycles: 0, ...clipOverrides } } });
  const world = createWorld();
  world.spawn(Time({ smoothedDelta: 0.5, delta: 0.5, timeScale: 1 }));
  const e = world.spawn(
    Renderable2D({ sprite: '' }),
    SpriteAnimator({ clipSet: set, clip: 'main', time: time ?? 0, playing: playing ?? true }),
  );
  return { world, e };
}

function spriteAfterTicks(world: World, e: ReturnType<World['spawn']>, ticks: number): string[] {
  const seen: string[] = [];
  for (let i = 0; i < ticks; i++) {
    spriteAnimationSystem(world);
    seen.push(e.get(Renderable2D)!.sprite);
  }
  return seen;
}

describe('spriteAnimationSystem', () => {
  it('loops forward and wraps', () => {
    const { world, e } = setup({ mode: 'loop' });
    // Frame applied before advancing → fa at t=0, then fb, fc, fd, wrap to fa, fb.
    expect(spriteAfterTicks(world, e, 6)).toEqual(['fa', 'fb', 'fc', 'fd', 'fa', 'fb']);
  });

  it('pingpong bounces forward then backward', () => {
    const { world, e } = setup({ mode: 'pingpong' });
    // period = 2*4-2 = 6 → fa,fb,fc,fd,fc,fb then repeats fa,fb...
    expect(spriteAfterTicks(world, e, 8)).toEqual(['fa', 'fb', 'fc', 'fd', 'fc', 'fb', 'fa', 'fb']);
  });

  it('once plays through then holds the last frame and stops', () => {
    const { world, e } = setup({ mode: 'once' });
    expect(spriteAfterTicks(world, e, 6)).toEqual(['fa', 'fb', 'fc', 'fd', 'fd', 'fd']);
    expect(e.get(SpriteAnimator)!.playing).toBe(false);
  });

  it('honors cycles for loop (N passes then holds, playing cleared)', () => {
    const { world, e } = setup({ mode: 'loop', cycles: 1 }); // 1 pass = 4 frames, hold frame 0
    expect(spriteAfterTicks(world, e, 6)).toEqual(['fa', 'fb', 'fc', 'fd', 'fa', 'fa']);
    expect(e.get(SpriteAnimator)!.playing).toBe(false);
  });

  it('does not advance when Paused', () => {
    const { world, e } = setup();
    e.add(Paused);
    spriteAnimationSystem(world);
    expect(e.get(SpriteAnimator)!.time).toBe(0);
    expect(e.get(Renderable2D)!.sprite).toBe(''); // never touched
  });

  it('resolves the frame for an externally-set time even when not playing (scrub)', () => {
    const { world, e } = setup({ playing: false, time: 1.0 }); // floor(1.0*2)=step 2 → fc
    spriteAnimationSystem(world);
    expect(e.get(SpriteAnimator)!.time).toBe(1.0); // not advanced
    expect(e.get(Renderable2D)!.sprite).toBe('fc');
  });

  it('is a no-op with no frames', () => {
    const { world, e } = setup({ frames: [] });
    spriteAnimationSystem(world);
    expect(e.get(Renderable2D)!.sprite).toBe('');
  });

  it('spriteIndexFromStep stays in lockstep with the particle spriteFrameIndex', () => {
    // The phase-based particle entry and the step-based flipbook entry must agree.
    const tiles = 4;
    for (const mode of ['once', 'loop', 'pingpong'] as const) {
      for (let step = 0; step < 12; step++) {
        // spriteFrameIndex with cycles=1 derives the same `step` from a phase
        // sampled at the frame midpoint, so the two must produce identical indices.
        const t = (step + 0.5) / (mode === 'pingpong' ? 2 * tiles - 2 : tiles);
        expect(spriteFrameIndex(t, tiles, mode, 1)).toBe(spriteIndexFromStep(step, tiles, mode));
      }
    }
  });
});

describe('spriteAnimationSystem — named tracks', () => {
  // smoothedDelta 0.5 × fps 2 = +1 step/tick (same cadence as the single-track setup).
  function setupClips(activeClip: string, clips?: Record<string, SpriteClip>) {
    const set = `tracks-${++setSeq}.spriteanim.json`;
    setSpriteAnim(set, {
      clips: clips ?? {
        idle: { frames: ['i0', 'i1'], fps: 2, mode: 'loop', cycles: 0 },
        walk: { frames: ['w0', 'w1', 'w2'], fps: 2, mode: 'loop', cycles: 0 },
      },
    });
    const world = createWorld();
    world.spawn(Time({ smoothedDelta: 0.5, delta: 0.5, timeScale: 1 }));
    const e = world.spawn(
      Renderable2D({ sprite: '' }),
      SpriteAnimator({ clipSet: set, clip: activeClip, time: 0, playing: true }),
    );
    return { world, e };
  }

  it('plays the active named track', () => {
    const { world, e } = setupClips('walk');
    expect(spriteAfterTicks(world, e, 4)).toEqual(['w0', 'w1', 'w2', 'w0']);
  });

  it('an empty active clip name falls back to the first track', () => {
    const { world, e } = setupClips(''); // → first key "idle"
    expect(spriteAfterTicks(world, e, 3)).toEqual(['i0', 'i1', 'i0']);
  });

  it('switching the active track plays the other clip from the reset playhead', () => {
    const { world, e } = setupClips('idle');
    spriteAnimationSystem(world);
    expect(e.get(Renderable2D)!.sprite).toBe('i0');
    // Simulate a "play track" intent: set active clip + reset time.
    e.set(SpriteAnimator, { ...e.get(SpriteAnimator)!, clip: 'walk', time: 0 });
    expect(spriteAfterTicks(world, e, 3)).toEqual(['w0', 'w1', 'w2']);
  });

  it('is a no-op when the active track has no frames', () => {
    const { world, e } = setupClips('empty', { empty: { frames: [], fps: 2, mode: 'loop', cycles: 0 } });
    spriteAnimationSystem(world);
    expect(e.get(Renderable2D)!.sprite).toBe('');
  });
});
