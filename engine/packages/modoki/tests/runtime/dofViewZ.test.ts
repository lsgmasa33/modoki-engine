/** buildViewZNode projection branch (see docs/rendering.md "Vignette & Depth
 *  of Field"; mirrors npr-F10 / edgeNodesDepth.test.ts). `three/tsl` is mocked
 *  so we can observe which reconstructor gets called; no GPU. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const perspectiveSpy = vi.fn((..._a: unknown[]) => ({ __viewZ: 'perspective' }));
const orthographicSpy = vi.fn((..._a: unknown[]) => ({ __viewZ: 'orthographic' }));

/** Caller-owned uniforms carrying the SCENE camera's near/far. */
const NEAR = { __uniform: 'sceneNear' };
const FAR = { __uniform: 'sceneFar' };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('three/tsl', () => ({
    // Deliberately still exported so the regression test below can prove we do NOT use them.
    cameraNear: { __uniform: 'GLOBAL_cameraNear' },
    cameraFar: { __uniform: 'GLOBAL_cameraFar' },
    perspectiveDepthToViewZ: perspectiveSpy,
    orthographicDepthToViewZ: orthographicSpy,
  }));
});

afterEach(() => { vi.restoreAllMocks(); });

async function run(isOrthographic: boolean) {
  const { buildViewZNode } = await import('../../src/runtime/rendering/postfx/dofViewZ');
  const depthTextureNode = { __texture: 'depth' };
  return buildViewZNode(depthTextureNode, isOrthographic, NEAR, FAR);
}

describe('buildViewZNode projection branch', () => {
  it('uses perspectiveDepthToViewZ for a perspective camera', async () => {
    await run(false);
    expect(perspectiveSpy).toHaveBeenCalledTimes(1);
    expect(orthographicSpy).not.toHaveBeenCalled();
  });

  it('uses orthographicDepthToViewZ for an orthographic camera', async () => {
    await run(true);
    expect(orthographicSpy).toHaveBeenCalledTimes(1);
    expect(perspectiveSpy).not.toHaveBeenCalled();
  });

  it('passes the depth texture node + the CALLER-SUPPLIED near/far through unchanged', async () => {
    await run(false);
    expect(perspectiveSpy).toHaveBeenCalledWith({ __texture: 'depth' }, NEAR, FAR);
  });

  /** REGRESSION — the bug this file previously failed to catch.
   *
   *  buildViewZNode used to close over TSL's GLOBAL `cameraNear`/`cameraFar`. Those resolve
   *  from whatever camera renders the CURRENT pass, and DOF's circle-of-confusion pass is a
   *  full-screen quad with its own camera — so the reconstructed viewZ was effectively a
   *  constant across the frame. Symptom: near and far objects blurred by the same amount and
   *  moved together as focusDistance changed, and the effect ignored the scene camera's
   *  `near` entirely. The old test asserted the globals were passed through, so it PASSED on
   *  the broken behaviour — it pinned the projection branch but never the near/far SOURCE. */
  it('does NOT use the global cameraNear/cameraFar (they belong to the quad pass, not the scene camera)', async () => {
    await run(false);
    const [, nearArg, farArg] = perspectiveSpy.mock.calls[0] as unknown[];
    expect(nearArg).not.toEqual({ __uniform: 'GLOBAL_cameraNear' });
    expect(farArg).not.toEqual({ __uniform: 'GLOBAL_cameraFar' });
    expect(nearArg).toBe(NEAR);
    expect(farArg).toBe(FAR);
  });
});
