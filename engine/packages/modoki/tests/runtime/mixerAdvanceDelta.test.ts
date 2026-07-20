/** mixerAdvanceDelta — the per-frame skeletal-mixer advance policy.
 *
 *  Regression guard for the "skeleton animates while the game is stopped" bug:
 *  when the Animation editor previews a clip in the Scene window, the global
 *  skeletal mixers must STAY FROZEN. They advance only while really Playing, or
 *  while something explicitly turns on `skeletalPreview`. The keyframe preview no
 *  longer flips that flag (see SceneView), so a stopped editor reads 0 here — this
 *  pins all three branches so a future change can't silently start driving every
 *  rig's baked clip out of Play mode again. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { mixerAdvanceDelta } from '../../src/runtime/rendering/scene3DSync';
import { setPlayState } from '../../src/runtime/systems/playState';
import { setSkeletalPreview } from '../../src/runtime/systems/skeletalPreview';
import { Time } from '../../src/runtime/traits';

let world: ReturnType<typeof createWorld>;

beforeEach(() => {
  world = createWorld();
  setPlayState('stopped');
  setSkeletalPreview(false, 0);
});
afterEach(() => {
  world.destroy();
  setPlayState('stopped');
  setSkeletalPreview(false, 0);
});

describe('mixerAdvanceDelta (skeletal mixer freeze policy)', () => {
  it('STOPPED + not previewing → 0 (every rig frozen out of Play mode)', () => {
    expect(mixerAdvanceDelta(world)).toBe(0);
  });

  it('STOPPED + skeletal preview active → the editor preview delta', () => {
    setSkeletalPreview(true, 0.02);
    expect(mixerAdvanceDelta(world)).toBeCloseTo(0.02);
  });

  it('PLAYING → the engine visual delta (smoothed × timeScale)', () => {
    setPlayState('playing');
    world.spawn(Time({ smoothedDelta: 0.016, timeScale: 1 }));
    expect(mixerAdvanceDelta(world)).toBeCloseTo(0.016);
  });

  it('PLAYING ignores a stale preview flag — real Play always wins', () => {
    setPlayState('playing');
    setSkeletalPreview(true, 0.5); // irrelevant in Play
    world.spawn(Time({ smoothedDelta: 0.016, timeScale: 1 }));
    expect(mixerAdvanceDelta(world)).toBeCloseTo(0.016);
  });
});
