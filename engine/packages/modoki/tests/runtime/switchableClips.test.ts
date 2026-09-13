/** switchableClipNames — the discoverable engine.playClip targets per animator trait. */

import { describe, it, expect, afterEach, vi } from 'vitest';
// Side-effect only: wires core provider slots (P7 C11+) so real-cache tests below resolve correctly.
import '../../src/runtime/loaders/registerProviders';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { Animator } from '../../src/runtime/traits/Animator';
import { SpriteAnimator } from '../../src/runtime/traits/SpriteAnimator';
import { SkeletalAnimator } from '../../src/runtime/traits/SkeletalAnimator';
import { SkinnedModel } from '../../src/runtime/traits/SkinnedModel';
import { AnimationLibrary } from '../../src/runtime/traits/AnimationLibrary';
import { setSpriteAnim, clearSpriteAnimCache } from '../../src/runtime/loaders/spriteAnimCache';
import { setAnimSet, clearAnimSetCache } from '../../src/runtime/loaders/animSetCache';
import { getClipNames, isRiggedModelLoaded } from '../../src/runtime/loaders/riggedModelCache';
import { switchableClipNames, skeletalClipRoster } from '../../src/runtime/animation/switchableClips';
import { registerEngineActions } from '../../src/runtime/actions/engineActions';
import { dispatchUIAction, isActionRefusal } from '../../src/runtime/core/actionRegistry';

// The GLB's own clips live in the rigged-model cache (loaded via a real GLTFLoader).
// Stub getClipNames so the SkeletalAnimator path has GLB clips without loading a GLB;
// the rest of riggedModelCache (disposeAllRiggedModels used at teardown) is preserved.
vi.mock('../../src/runtime/loaders/riggedModelCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/loaders/riggedModelCache')>();
  return { ...actual, getClipNames: vi.fn(() => [] as string[]), isRiggedModelLoaded: vi.fn(() => false) };
});

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { tw.dispose(); tw = undefined; } clearSpriteAnimCache(); clearAnimSetCache(); vi.mocked(getClipNames).mockReset(); vi.mocked(isRiggedModelLoaded).mockReset(); vi.restoreAllMocks(); });

/** Pretend these GLBs have loaded, with these clips. Anything else is still loading. */
function loadedGlbs(glbs: Readonly<Record<string, readonly string[]>>) {
  vi.mocked(getClipNames).mockImplementation((ref) => [...(glbs[ref] ?? [])]);
  vi.mocked(isRiggedModelLoaded).mockImplementation((ref) => ref in glbs);
}

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

  it('unions a SkeletalAnimator GLB clips ∪ animSet source ∪ AnimationLibrary sources, de-duplicated', () => {
    // The GLB's own clips, plus each animset's SOURCE GLB — 'idle' is in two of them (must de-dupe).
    loadedGlbs({ 'model-guid': ['idle', 'walk'], 'a.glb': ['run', 'idle'], 'lib.glb': ['jump'] });
    // `Sprint` is DECLARED but in no GLB: the mixer never gets an action for it, so it is not listed.
    setAnimSet('set-a', { source: 'a.glb', clips: [{ name: 'run' }, { name: 'Sprint' }] });
    // A shared cross-model library animSet referenced by AnimationLibrary.animSets.
    setAnimSet('set-lib', { source: 'lib.glb', clips: [] });
    // A source-less animset contributes nothing — the merge skips it.
    setAnimSet('set-bare', { clips: [{ name: 'Wave' }] });

    tw = createTestWorld({});
    const e = tw.spawn(
      SkinnedModel({ model: 'model-guid' }),
      SkeletalAnimator({ animSet: 'set-a', clip: 'idle' }),
      AnimationLibrary({ animSets: ['set-lib', 'set-bare'], retarget: false, boneMaps: {} }),
    );
    expect(switchableClipNames(e.id(), 'SkeletalAnimator').sort()).toEqual(['idle', 'jump', 'run', 'walk']);
    expect(skeletalClipRoster(e.id()).complete).toBe(true);
  });

  it('SkeletalAnimator with no GLB/animSet/library sources lists nothing', () => {
    tw = createTestWorld({});
    const e = tw.spawn(SkeletalAnimator({ animSet: '', clip: '' }));
    expect(switchableClipNames(e.id(), 'SkeletalAnimator')).toEqual([]);
  });

  /** #1129 review: an animset's `clips` entries are optional per-clip PARAMETERS — the mixer plays every
   *  clip of its `source` GLB (scene3DSync.ts's library merge). Counting only the declared names made
   *  engine.playClip refuse a clip that plays. */
  it('SkeletalAnimator lists every clip of an animset\'s SOURCE GLB, not only the declared ones', () => {
    loadedGlbs({ 'rig.glb': ['Idle'], 'pack.glb': ['Run', 'Jump'] });
    setAnimSet('lib', { source: 'pack.glb', clips: [{ name: 'Run' }] });
    tw = createTestWorld({});
    const e = tw.spawn(
      SkinnedModel({ model: 'rig.glb' }),
      SkeletalAnimator({ animSet: '', clip: 'Idle' }),
      AnimationLibrary({ animSets: ['lib'], retarget: false, boneMaps: {} }),
    );
    expect(skeletalClipRoster(e.id())).toEqual({ names: expect.arrayContaining(['Idle', 'Run', 'Jump']), complete: true });
    expect(switchableClipNames(e.id(), 'SkeletalAnimator').sort()).toEqual(['Idle', 'Jump', 'Run']);
  });

  it.each([
    ['the model GLB', { 'pack.glb': ['Run'] }, true],
    ['the animset source GLB', { 'rig.glb': ['Idle'] }, true],
    ['the animset itself', { 'rig.glb': ['Idle'], 'pack.glb': ['Run'] }, false],
  ] as const)('the roster is INCOMPLETE while %s has not loaded', (_what, glbs, animsetCached) => {
    loadedGlbs(glbs);
    if (animsetCached) setAnimSet('lib', { source: 'pack.glb', clips: [] });
    tw = createTestWorld({});
    const e = tw.spawn(SkinnedModel({ model: 'rig.glb' }), SkeletalAnimator({ animSet: 'lib', clip: '' }));
    expect(skeletalClipRoster(e.id()).complete).toBe(false);
  });
});

describe('engine.playClip on a SkeletalAnimator refuses only against a COMPLETE roster (#1129)', () => {
  function rig() {
    registerEngineActions();
    setAnimSet('lib', { source: 'pack.glb', clips: [{ name: 'Run' }] });
    tw = createTestWorld({});
    return tw.spawn(
      SkinnedModel({ model: 'rig.glb' }),
      SkeletalAnimator({ animSet: '', clip: 'Idle' }),
      AnimationLibrary({ animSets: ['lib'], retarget: false, boneMaps: {} }),
    );
  }

  it('plays a source-GLB clip the animset does not declare (the review\'s repro)', () => {
    loadedGlbs({ 'rig.glb': ['Idle'], 'pack.glb': ['Run', 'Jump'] });
    const e = rig();
    expect(dispatchUIAction('engine.playClip', { target: e, params: { clip: 'Jump' } })).toBeUndefined();
    expect(e.get(SkeletalAnimator)!.clip).toBe('Jump');
  });

  it('refuses a name no loaded source has, naming every playable clip, and writes nothing', () => {
    loadedGlbs({ 'rig.glb': ['Idle'], 'pack.glb': ['Run', 'Jump'] });
    const e = rig();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = dispatchUIAction('engine.playClip', { target: e, params: { clip: 'Fly' } });
    expect(isActionRefusal(r) && [...(r.detail?.known as string[])].sort()).toEqual(['Idle', 'Jump', 'Run']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(e.get(SkeletalAnimator)!.clip).toBe('Idle');
  });

  it('writes ANY name while a source is still loading — the mixer retries it', () => {
    loadedGlbs({ 'rig.glb': ['Idle'] }); // pack.glb not loaded: the declared [Run] alone is a partial list
    const e = rig();
    expect(dispatchUIAction('engine.playClip', { target: e, params: { clip: 'Jump' } })).toBeUndefined();
    expect(e.get(SkeletalAnimator)!.clip).toBe('Jump');
  });
});
