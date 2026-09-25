/** mixerAdvanceDelta — the per-frame skeletal-mixer advance policy.
 *
 *  Regression guard for the "skeleton animates while the game is stopped" bug:
 *  when the Animation editor previews a clip in the Scene window, the global
 *  skeletal mixers must STAY FROZEN. They advance only while really Playing — the
 *  editor flag that once also advanced them (`skeletalPreview`) was deleted as dead
 *  in #1552 — so this pins every play state: a future change can't silently start
 *  driving every rig's baked clip out of Play mode again. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { mixerAdvanceDelta } from '../../src/runtime/rendering/scene3DSync';
import { setPlayState } from '../../src/runtime/core/playState';
import { Time } from '../../src/runtime/traits';

let world: ReturnType<typeof createWorld>;

beforeEach(() => {
  world = createWorld();
  setPlayState('stopped');
});
afterEach(() => {
  world.destroy();
  setPlayState('stopped');
});

describe('mixerAdvanceDelta (skeletal mixer freeze policy)', () => {
  it('STOPPED → 0 (every rig frozen out of Play mode), even with a live Time delta', () => {
    world.spawn(Time({ smoothedDelta: 0.016, timeScale: 1 }));
    expect(mixerAdvanceDelta(world)).toBe(0);
  });

  it('PAUSED → 0', () => {
    setPlayState('paused');
    world.spawn(Time({ smoothedDelta: 0.016, timeScale: 1 }));
    expect(mixerAdvanceDelta(world)).toBe(0);
  });

  it('PLAYING → the engine visual delta (smoothed × timeScale)', () => {
    setPlayState('playing');
    world.spawn(Time({ smoothedDelta: 0.016, timeScale: 1 }));
    expect(mixerAdvanceDelta(world)).toBeCloseTo(0.016);
  });
});
