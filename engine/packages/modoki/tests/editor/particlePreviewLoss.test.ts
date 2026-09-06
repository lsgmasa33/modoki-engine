/** ParticleEditor's loss-teardown state, extracted into `particlePreviewLoss.ts` so it is
 *  testable without mounting the `.tsx` panel (finding 1, adversarial review of #795): a
 *  GPU-context-loss teardown that fires MID-MOUNT must clear the state the "apply def to the
 *  live preview" effect gates on, or the panel stays a zombie that recreates a particle handle on
 *  whatever renderer now owns the active-renderer slot. */
import { describe, it, expect, vi } from 'vitest';
import { canApplyParticleDef, handleParticleLossTeardown } from '../../src/editor/panels/particle/particlePreviewLoss';

describe('canApplyParticleDef', () => {
  it('allows the apply effect to run when the scene is ready and live', () => {
    expect(canApplyParticleDef({ sceneReady: true, scene: {} }, true, true)).toBe(true);
  });

  it('blocks the apply effect once a loss teardown has cleared sceneReady + scene (finding 1)', () => {
    // This is exactly the post-teardown state `handleParticleLossTeardown` below produces.
    expect(canApplyParticleDef({ sceneReady: false, scene: null }, true, true)).toBe(false);
  });

  it('blocks even if only ONE of the two was cleared — both must gate independently', () => {
    expect(canApplyParticleDef({ sceneReady: true, scene: null }, true, true)).toBe(false);
    expect(canApplyParticleDef({ sceneReady: false, scene: {} }, true, true)).toBe(false);
  });

  it('still requires a def and an open asset, independent of scene state', () => {
    expect(canApplyParticleDef({ sceneReady: true, scene: {} }, false, true)).toBe(false);
    expect(canApplyParticleDef({ sceneReady: true, scene: {} }, true, false)).toBe(false);
  });
});

describe('handleParticleLossTeardown', () => {
  it('clears sceneReady and the scene ref, and disposes the renderer, on every call', () => {
    const setSceneReady = vi.fn();
    let scene: object | null = {};
    const disposeRenderer = vi.fn();

    handleParticleLossTeardown({ setSceneReady, clearScene: () => { scene = null; } }, disposeRenderer);

    expect(setSceneReady).toHaveBeenCalledWith(false);
    expect(scene).toBeNull();
    expect(disposeRenderer).toHaveBeenCalledTimes(1);
  });

  it('feeds canApplyParticleDef a gate that blocks the apply effect afterward', () => {
    let sceneReady = true;
    let scene: object | null = {};
    handleParticleLossTeardown(
      { setSceneReady: (v) => { sceneReady = v; }, clearScene: () => { scene = null; } },
      () => {},
    );
    expect(canApplyParticleDef({ sceneReady, scene }, true, true)).toBe(false);
  });
});
