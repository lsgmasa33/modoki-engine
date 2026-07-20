/** Engine built-in UIActions — lifecycle (reload / quit) + engine.toggleAnimator.
 *  Scene navigation moved to NavigationManager (covered in navigationManager.test.ts). */

import { describe, it, expect, vi } from 'vitest';

async function setup() {
  vi.resetModules();
  const { registerEngineActions } = await import('../../src/runtime/ui/engineActions');
  const reg = await import('../../src/runtime/ui/actionRegistry');
  registerEngineActions();
  return reg;
}

describe('engineActions', () => {
  it('registers lifecycle actions: engine.reload + engine.quit', async () => {
    const { getUIActionNames } = await setup();
    expect(getUIActionNames()).toEqual(expect.arrayContaining(['engine.reload', 'engine.quit']));
  });

  it('does not register scene navigation (owned by NavigationManager)', async () => {
    const { getUIActionNames } = await setup();
    expect(getUIActionNames()).not.toContain('engine.loadScene');
  });

  it('registers engine.toggleAnimator', async () => {
    const { getUIActionNames } = await setup();
    expect(getUIActionNames()).toContain('engine.toggleAnimator');
  });

  it('engine.toggleAnimator flips playing on the target SkeletalAnimator instance', async () => {
    const { dispatchUIAction } = await setup();
    const { getCurrentWorld } = await import('../../src/runtime/ecs/world');
    const { EntityAttributes } = await import('../../src/runtime/traits/EntityAttributes');
    const { SkeletalAnimator } = await import('../../src/runtime/traits/SkeletalAnimator');

    const e = getCurrentWorld().spawn(EntityAttributes({ guid: 'skel-guid' }), SkeletalAnimator({ playing: true }));

    dispatchUIAction('engine.toggleAnimator', { targetGuid: 'skel-guid' });
    expect(e.get(SkeletalAnimator)!.playing).toBe(false);

    dispatchUIAction('engine.toggleAnimator', { targetGuid: 'skel-guid' });
    expect(e.get(SkeletalAnimator)!.playing).toBe(true);
  });

  it('engine.toggleAnimator flips playing on the target Animator instance', async () => {
    const { dispatchUIAction } = await setup();
    const { getCurrentWorld } = await import('../../src/runtime/ecs/world');
    const { EntityAttributes } = await import('../../src/runtime/traits/EntityAttributes');
    const { Animator } = await import('../../src/runtime/traits/Animator');

    const e = getCurrentWorld().spawn(EntityAttributes({ guid: 'anim-guid' }), Animator({ playing: false }));

    dispatchUIAction('engine.toggleAnimator', { targetGuid: 'anim-guid' });
    expect(e.get(Animator)!.playing).toBe(true);
  });

  it('engine.toggleAnimator only affects the targeted instance, not sibling animators', async () => {
    const { dispatchUIAction } = await setup();
    const { getCurrentWorld } = await import('../../src/runtime/ecs/world');
    const { EntityAttributes } = await import('../../src/runtime/traits/EntityAttributes');
    const { SkeletalAnimator } = await import('../../src/runtime/traits/SkeletalAnimator');

    const world = getCurrentWorld();
    const a = world.spawn(EntityAttributes({ guid: 'rig-a' }), SkeletalAnimator({ playing: true }));
    const b = world.spawn(EntityAttributes({ guid: 'rig-b' }), SkeletalAnimator({ playing: true }));

    dispatchUIAction('engine.toggleAnimator', { targetGuid: 'rig-a' });

    expect(a.get(SkeletalAnimator)!.playing).toBe(false);
    expect(b.get(SkeletalAnimator)!.playing).toBe(true);
  });

  it('engine.toggleAnimator warns and no-ops when target has no animator trait', async () => {
    const { dispatchUIAction } = await setup();
    const { getCurrentWorld } = await import('../../src/runtime/ecs/world');
    const { EntityAttributes } = await import('../../src/runtime/traits/EntityAttributes');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    getCurrentWorld().spawn(EntityAttributes({ guid: 'bare-guid' }));
    expect(() => dispatchUIAction('engine.toggleAnimator', { targetGuid: 'bare-guid' })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no SkeletalAnimator or Animator'));

    warn.mockRestore();
  });

  it('engine.playClip switches a keyframe Animator by name (resets time, plays)', async () => {
    const { dispatchUIAction } = await setup();
    const { getCurrentWorld } = await import('../../src/runtime/ecs/world');
    const { EntityAttributes } = await import('../../src/runtime/traits/EntityAttributes');
    const { Animator } = await import('../../src/runtime/traits/Animator');

    const clips = JSON.stringify([{ name: 'idle', clip: 'g-idle' }, { name: 'walk', clip: 'g-walk' }]);
    const e = getCurrentWorld().spawn(
      EntityAttributes({ guid: 'a1' }),
      Animator({ clips, clip: 'idle', time: 3, playing: false }),
    );

    dispatchUIAction('engine.playClip', { targetGuid: 'a1', params: { clip: 'walk' } });

    const a = e.get(Animator)!;
    expect(a.clip).toBe('walk');
    expect(a.time).toBe(0);
    expect(a.playing).toBe(true);
  });

  it('engine.playClip switches a SkeletalAnimator by name (no synchronous guard — mixer validates)', async () => {
    const { dispatchUIAction } = await setup();
    const { getCurrentWorld } = await import('../../src/runtime/ecs/world');
    const { EntityAttributes } = await import('../../src/runtime/traits/EntityAttributes');
    const { SkeletalAnimator } = await import('../../src/runtime/traits/SkeletalAnimator');

    const e = getCurrentWorld().spawn(EntityAttributes({ guid: 's1' }), SkeletalAnimator({ clip: 'Idle', playing: false }));
    dispatchUIAction('engine.playClip', { targetGuid: 's1', params: { clip: 'Walk' } });
    const s = e.get(SkeletalAnimator)!;
    expect(s.clip).toBe('Walk');
    expect(s.playing).toBe(true);
  });

  it('engine.playClip warns + no-ops for a name not in a keyframe/sprite bank', async () => {
    const { dispatchUIAction } = await setup();
    const { getCurrentWorld } = await import('../../src/runtime/ecs/world');
    const { EntityAttributes } = await import('../../src/runtime/traits/EntityAttributes');
    const { Animator } = await import('../../src/runtime/traits/Animator');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const clips = JSON.stringify([{ name: 'idle', clip: 'g-idle' }]);
    const e = getCurrentWorld().spawn(EntityAttributes({ guid: 'a2' }), Animator({ clips, clip: 'idle' }));

    dispatchUIAction('engine.playClip', { targetGuid: 'a2', params: { clip: 'nope' } });
    expect(e.get(Animator)!.clip).toBe('idle'); // unchanged
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no clip named "nope"'));

    warn.mockRestore();
  });

  it('engine.playClip warns when the target has no animator trait at all', async () => {
    const { dispatchUIAction } = await setup();
    const { getCurrentWorld } = await import('../../src/runtime/ecs/world');
    const { EntityAttributes } = await import('../../src/runtime/traits/EntityAttributes');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    getCurrentWorld().spawn(EntityAttributes({ guid: 'bare2' }));
    dispatchUIAction('engine.playClip', { targetGuid: 'bare2', params: { clip: 'x' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no Animator / SpriteAnimator / SkeletalAnimator'));

    warn.mockRestore();
  });

});
