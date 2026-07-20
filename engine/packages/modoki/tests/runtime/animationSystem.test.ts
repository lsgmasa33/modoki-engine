/** animationSystem — advances Animator.time and drives bound trait fields. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { Transform } from '../../src/runtime/traits/Transform';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Animator } from '../../src/runtime/traits/Animator';
import { Paused } from '../../src/runtime/traits/Paused';
import { Time } from '../../src/runtime/traits/Time';
import { registerTrait, getAllTraits } from '../../src/runtime/ecs/traitRegistry';
import { setAnimationClip } from '../../src/runtime/loaders/animationClipCache';
import { animationSystem } from '../../src/runtime/systems/animationSystem';
import type { AnimationClipDef } from '../../src/runtime/animation/types';

const CLIP: AnimationClipDef = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'move',
  duration: 1,
  frameRate: 60,
  loop: true,
  tracks: [
    { path: '', trait: 'Transform', field: 'x', type: 'number',
      keys: [{ t: 0, v: 0, inTangent: 100, outTangent: 100 }, { t: 1, v: 100, inTangent: 100, outTangent: 100 }] },
  ],
};

function ensureRegistered() {
  const names = new Set(getAllTraits().map((m) => m.name));
  if (!names.has('Transform'))
    registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' } } });
  if (!names.has('EntityAttributes'))
    registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' } } });
}

/** A named clip bank JSON string with one entry `move` → the seeded clip. */
const MOVE_BANK = JSON.stringify([{ name: 'move', clip: 'seed.anim.json' }]);

function spawnAnimated(world: ReturnType<typeof createWorld>) {
  // Animation reads the VISUAL delta (smoothedDelta = smoothed cadence × timeScale)
  // via getVisualDelta — represent a frame timeSystem already produced.
  world.spawn(Time({ smoothedDelta: 0.5, delta: 0.5, timeScale: 1 }));
  // The clip ref is a path here; seed the cache by that key so getAnimationClip resolves.
  setAnimationClip('seed.anim.json', CLIP);
  const e = world.spawn(
    Transform({ x: 0 }),
    EntityAttributes({ name: 'root', parentId: 0 }),
    // New shape: clips bank (name → GUID) + active clip NAME.
    Animator({ clips: MOVE_BANK, clip: 'move', time: 0, speed: 1, playing: true, loop: true }),
  );
  return e;
}

describe('animationSystem', () => {
  beforeEach(() => {
    ensureRegistered();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no fetch in test'))));
  });

  it('advances time and drives the bound field (linear ramp)', () => {
    const world = createWorld();
    const e = spawnAnimated(world);

    animationSystem(world); // dt 0.5 → time 0.5 → x ≈ 50 (linear tangents)
    expect(e.get(Animator)!.time).toBeCloseTo(0.5);
    expect(e.get(Transform)!.x).toBeCloseTo(50, 4);

    animationSystem(world); // time 1.0 → loops to 0 → x at end/clamped
    expect(e.get(Animator)!.time).toBeCloseTo(0, 5);
  });

  it('does nothing when Paused', () => {
    const world = createWorld();
    const e = spawnAnimated(world);
    e.add(Paused);
    animationSystem(world);
    expect(e.get(Animator)!.time).toBe(0);
    expect(e.get(Transform)!.x).toBe(0);
  });

  it('does not advance when playing=false but still poses at current time', () => {
    const world = createWorld();
    const e = spawnAnimated(world);
    e.set(Animator, { ...e.get(Animator)!, playing: false, time: 1 });
    animationSystem(world);
    expect(e.get(Animator)!.time).toBe(1);
    expect(e.get(Transform)!.x).toBeCloseTo(100, 4);
  });

  it('mirrors the resolved active name into activeClip (read-back)', () => {
    const world = createWorld();
    const e = spawnAnimated(world);
    expect(e.get(Animator)!.activeClip).toBe(''); // not resolved until the system runs
    animationSystem(world);
    expect(e.get(Animator)!.activeClip).toBe('move');
  });

  it('empty active name picks the first bank entry (no clobber of authored time)', () => {
    const world = createWorld();
    const e = spawnAnimated(world);
    // Author time=1, clear the active name → resolves to first entry ('move') without a reset.
    e.set(Animator, { ...e.get(Animator)!, clip: '', time: 1, playing: false });
    animationSystem(world);
    expect(e.get(Animator)!.time).toBe(1);            // initial bind must NOT reset
    expect(e.get(Animator)!.activeClip).toBe('move');
    expect(e.get(Transform)!.x).toBeCloseTo(100, 4);  // posed at t=1
  });

  it('switching the active clip name restarts the clip (time → 0)', () => {
    const world = createWorld();
    const e = spawnAnimated(world);
    // A two-clip bank: same underlying clip under two names, so we can prove the SWITCH resets.
    e.set(Animator, {
      ...e.get(Animator)!,
      clips: JSON.stringify([{ name: 'a', clip: 'seed.anim.json' }, { name: 'b', clip: 'seed.anim.json' }]),
      clip: 'a', time: 0,
    });
    animationSystem(world);                       // adopt 'a', advance to 0.5
    expect(e.get(Animator)!.time).toBeCloseTo(0.5);
    e.set(Animator, { ...e.get(Animator)!, clip: 'b' }); // switch WITHOUT resetting time by hand
    animationSystem(world);                       // detects a→b: time reset to 0, then advanced 0.5
    expect(e.get(Animator)!.activeClip).toBe('b');
    expect(e.get(Animator)!.time).toBeCloseTo(0.5); // 0 (reset) + 0.5 (this frame), NOT 1.0
  });

  it('honors a per-clip speed override over the trait speed', () => {
    const world = createWorld();
    const e = spawnAnimated(world);
    e.set(Animator, {
      ...e.get(Animator)!,
      clips: JSON.stringify([{ name: 'move', clip: 'seed.anim.json', speed: 2 }]),
      speed: 1, // trait fallback — the per-clip 2 must win
    });
    animationSystem(world); // dt 0.5 × speed 2 = 1.0 → loops to 0
    expect(e.get(Animator)!.time).toBeCloseTo(0, 5);
  });

  it('leaves the entity unposed when the clips bank is empty', () => {
    const world = createWorld();
    const e = spawnAnimated(world);
    e.set(Animator, { ...e.get(Animator)!, clips: '[]', clip: '' });
    animationSystem(world);
    expect(e.get(Transform)!.x).toBe(0);          // never posed
    expect(e.get(Animator)!.activeClip).toBe('');  // read-back cleared
  });

  it('leaves the entity unposed when the active clip resolves but its asset is not cached', () => {
    const world = createWorld();
    const e = spawnAnimated(world);
    // The active name resolves from the bank, but its .anim.json ref is NOT seeded in the
    // clip cache → getAnimationClip returns null (kicks off a fetch, which is stubbed to
    // reject). The entity stays unposed this frame (retried next frame), with no throw.
    e.set(Animator, {
      ...e.get(Animator)!,
      clips: JSON.stringify([{ name: 'move', clip: 'uncached.anim.json' }]),
      clip: 'move', time: 0,
    });
    expect(() => animationSystem(world)).not.toThrow();
    expect(e.get(Transform)!.x).toBe(0);              // never posed (clip not loaded)
    expect(e.get(Animator)!.activeClip).toBe('move'); // name resolved from the bank though
    expect(e.get(Animator)!.time).toBe(0);            // duration 0 → advanceClipTime stays at 0
  });
});

describe('animationSystem — crossfade (Phase 2)', () => {
  beforeEach(() => {
    ensureRegistered();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no fetch in test'))));
  });

  // Two clips: 'a' ramps x 0→100 over 1s (CLIP); 'b' holds x at 200.
  const CLIP_B: AnimationClipDef = {
    id: '22222222-2222-2222-2222-222222222222', name: 'hold', duration: 1, frameRate: 60, loop: true,
    tracks: [{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [{ t: 0, v: 200, inTangent: 0, outTangent: 0 }] }],
  };
  const AB_BANK = JSON.stringify([{ name: 'a', clip: 'seed.anim.json' }, { name: 'b', clip: 'seed2.anim.json' }]);

  function spawnFadeable(world: ReturnType<typeof createWorld>, fadeDuration: number) {
    world.spawn(Time({ smoothedDelta: 0.5, delta: 0.5, timeScale: 1 }));
    setAnimationClip('seed.anim.json', CLIP);
    setAnimationClip('seed2.anim.json', CLIP_B);
    return world.spawn(
      Transform({ x: 0 }),
      EntityAttributes({ name: 'root', parentId: 0 }),
      Animator({ clips: AB_BANK, clip: 'a', time: 0, speed: 1, playing: true, loop: true, fadeDuration }),
    );
  }

  it('fadeDuration:0 is an instant cut (no fade state, time reset)', () => {
    const world = createWorld();
    const e = spawnFadeable(world, 0);
    animationSystem(world);                                  // adopt 'a', x→50
    e.set(Animator, { ...e.get(Animator)!, clip: 'b' });     // switch, no fade
    animationSystem(world);
    const a = e.get(Animator)!;
    expect(a.fadeFrom).toBe('');                             // no crossfade
    expect(a.activeClip).toBe('b');
    expect(e.get(Transform)!.x).toBeCloseTo(200);            // pure 'b' immediately
  });

  it('a switch with fadeDuration begins a crossfade and blends the two poses', () => {
    const world = createWorld();
    const e = spawnFadeable(world, 1);                       // 1s fade = 2 frames @ dt 0.5
    animationSystem(world);                                  // 'a' at t0.5 → x≈50
    expect(e.get(Transform)!.x).toBeCloseTo(50);
    e.set(Animator, { ...e.get(Animator)!, clip: 'b' });     // switch a→b

    animationSystem(world);                                  // frame into the fade
    const a = e.get(Animator)!;
    expect(a.activeClip).toBe('b');
    expect(a.fadeFrom).toBe('a');                            // outgoing captured
    expect(a.fadeElapsed).toBeCloseTo(0.5);
    // from 'a'@0 (x=0, wrapped) blended with 'b'@0.5 (x=200) at w=0.5 → 100
    expect(e.get(Transform)!.x).toBeCloseTo(100);
  });

  it('the fade completes and clears fade state → pure incoming clip', () => {
    const world = createWorld();
    const e = spawnFadeable(world, 1);
    animationSystem(world);
    e.set(Animator, { ...e.get(Animator)!, clip: 'b' });
    animationSystem(world);                                  // fadeElapsed 0.5
    animationSystem(world);                                  // fadeElapsed 1.0 → complete
    const a = e.get(Animator)!;
    expect(a.fadeFrom).toBe('');                             // fade done
    expect(e.get(Transform)!.x).toBeCloseTo(200);           // pure 'b'
  });

  it('interrupting a fade restarts it from the current active clip', () => {
    const world = createWorld();
    const e = spawnFadeable(world, 1);
    animationSystem(world);
    e.set(Animator, { ...e.get(Animator)!, clip: 'b' });
    animationSystem(world);                                  // mid-fade a→b (fadeFrom 'a')
    expect(e.get(Animator)!.fadeFrom).toBe('a');
    e.set(Animator, { ...e.get(Animator)!, clip: 'a' });     // switch back BEFORE the fade finishes
    animationSystem(world);
    const a = e.get(Animator)!;
    expect(a.activeClip).toBe('a');
    expect(a.fadeFrom).toBe('b');                            // now fading FROM the interrupted 'b'
    expect(a.fadeElapsed).toBeCloseTo(0.5);                  // fade timer restarted
  });

  it('does not advance the fade while paused (blend freezes in place)', () => {
    const world = createWorld();
    const e = spawnFadeable(world, 1);
    animationSystem(world);
    e.set(Animator, { ...e.get(Animator)!, clip: 'b' });
    animationSystem(world);                                  // fadeElapsed 0.5
    e.set(Animator, { ...e.get(Animator)!, playing: false });
    animationSystem(world);
    expect(e.get(Animator)!.fadeElapsed).toBeCloseTo(0.5);  // frozen, not advanced
    expect(e.get(Animator)!.fadeFrom).toBe('a');            // still mid-fade
  });
});
