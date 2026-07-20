/** switchableClipNames — the discoverable engine.playClip targets per animator trait. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { Animator } from '../../src/runtime/traits/Animator';
import { SpriteAnimator } from '../../src/runtime/traits/SpriteAnimator';
import { SkeletalAnimator } from '../../src/runtime/traits/SkeletalAnimator';
import { SkinnedModel } from '../../src/runtime/traits/SkinnedModel';
import { AnimationLibrary } from '../../src/runtime/traits/AnimationLibrary';
import { setSpriteAnim, clearSpriteAnimCache } from '../../src/runtime/loaders/spriteAnimCache';
import { setAnimSet, clearAnimSetCache } from '../../src/runtime/loaders/animSetCache';
import { getClipNames } from '../../src/runtime/loaders/riggedModelCache';
import { switchableClipNames } from '../../src/runtime/animation/switchableClips';

// The GLB's own clips live in the rigged-model cache (loaded via a real GLTFLoader).
// Stub getClipNames so the SkeletalAnimator path has GLB clips without loading a GLB;
// the rest of riggedModelCache (disposeAllRiggedModels used at teardown) is preserved.
vi.mock('../../src/runtime/loaders/riggedModelCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/loaders/riggedModelCache')>();
  return { ...actual, getClipNames: vi.fn(() => [] as string[]) };
});

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { tw.dispose(); tw = undefined; } clearSpriteAnimCache(); clearAnimSetCache(); vi.mocked(getClipNames).mockReset(); });

describe('switchableClipNames', () => {
  it('lists a keyframe Animator bank by name', () => {
    tw = createTestWorld({});
    const clips = JSON.stringify([{ name: 'idle', clip: 'g-idle' }, { name: 'walk', clip: 'g-walk' }]);
    const e = tw.spawn(Animator({ clips, clip: 'idle' }));
    expect(switchableClipNames(e.id(), 'Animator')).toEqual(['idle', 'walk']);
  });

  it('lists a SpriteAnimator clipSet by name (once the asset is cached)', () => {
    setSpriteAnim('chars/hero.spriteanim.json', {
      clips: { idle: { frames: ['i0'], fps: 6, mode: 'loop', cycles: 0 }, run: { frames: ['r0', 'r1'], fps: 10, mode: 'loop', cycles: 0 } },
    });
    tw = createTestWorld({});
    const e = tw.spawn(SpriteAnimator({ clipSet: 'chars/hero.spriteanim.json', clip: 'idle' }));
    expect(switchableClipNames(e.id(), 'SpriteAnimator').sort()).toEqual(['idle', 'run']);
  });

  it('returns [] for an unloaded/absent clipSet and for a non-animator trait', () => {
    tw = createTestWorld({});
    const e = tw.spawn(SpriteAnimator({ clipSet: '', clip: '' }));
    expect(switchableClipNames(e.id(), 'SpriteAnimator')).toEqual([]);
    expect(switchableClipNames(e.id(), 'Transform')).toEqual([]);
  });

  it('returns [] for an empty Animator bank', () => {
    tw = createTestWorld({});
    const e = tw.spawn(Animator({ clips: '[]', clip: '' }));
    expect(switchableClipNames(e.id(), 'Animator')).toEqual([]);
  });

  it('unions a SkeletalAnimator GLB clips ∪ animSet ∪ AnimationLibrary, de-duplicated', () => {
    // GLB's own clips (from the rigged-model cache).
    vi.mocked(getClipNames).mockImplementation((ref) => (ref === 'model-guid' ? ['idle', 'walk'] : []));
    // This animator's own animSet — 'idle' collides with a GLB clip (must de-dupe).
    setAnimSet('set-a', { clips: [{ name: 'run' }, { name: 'idle' }] });
    // A shared cross-model library animSet referenced by AnimationLibrary.animSets.
    setAnimSet('set-lib', { clips: [{ name: 'jump' }] });

    tw = createTestWorld({});
    const e = tw.spawn(
      SkinnedModel({ model: 'model-guid' }),
      SkeletalAnimator({ animSet: 'set-a', clip: 'idle' }),
      AnimationLibrary({ animSets: ['set-lib'] }),
    );
    // idle+walk (GLB) ∪ run+idle (animSet) ∪ jump (library) → {idle, walk, run, jump}.
    expect(switchableClipNames(e.id(), 'SkeletalAnimator').sort()).toEqual(['idle', 'jump', 'run', 'walk']);
  });

  it('SkeletalAnimator with no GLB/animSet/library sources lists nothing', () => {
    tw = createTestWorld({});
    const e = tw.spawn(SkeletalAnimator({ animSet: '', clip: '' }));
    expect(switchableClipNames(e.id(), 'SkeletalAnimator')).toEqual([]);
  });
});
