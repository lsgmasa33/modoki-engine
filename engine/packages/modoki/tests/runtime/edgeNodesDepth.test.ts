/** sobelDepth projection branch — perspective vs orthographic linearize (npr-F10).
 *
 *  The depth Sobel reconstructs view-space Z from the raw depth buffer before
 *  thresholding. That linearization is projection-dependent: perspective depth is
 *  hyperbolic (1/z), orthographic depth is already linear. Using the perspective
 *  reconstructor under an ortho camera (the editor SceneView can use one) warps
 *  view-Z and misfires the silhouette threshold. These tests pin that `sobelDepth`
 *  selects the matching `*DepthToViewZ` node from its `isOrthographic` flag.
 *
 *  `three/tsl` is mocked so we can observe which reconstructor the kernel calls;
 *  no GPU. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const perspectiveSpy = vi.fn((..._a: unknown[]) => makeNode());
const orthographicSpy = vi.fn((..._a: unknown[]) => makeNode());

// Chainable no-op TSL node — every op returns another node.
function makeNode(): Record<string, unknown> {
  const n: Record<string, unknown> = {};
  const ret = () => n;
  for (const k of ['add', 'sub', 'mul', 'div']) n[k] = ret;
  n.x = n; n.y = n; n.z = n; n.xyz = n;
  n.sample = ret;
  return n;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('three/tsl', () => ({
    vec2: vi.fn(() => makeNode()),
    abs: vi.fn((v: unknown) => v),
    max: vi.fn((a: unknown) => a),
    sqrt: vi.fn((v: unknown) => v),
    luminance: vi.fn(() => makeNode()),
    screenUV: makeNode(),
    cameraNear: makeNode(),
    cameraFar: makeNode(),
    perspectiveDepthToViewZ: perspectiveSpy,
    orthographicDepthToViewZ: orthographicSpy,
  }));
});

afterEach(() => { vi.restoreAllMocks(); });

async function runSobelDepth(isOrthographic?: boolean) {
  const { sobelDepth } = await import('../../src/runtime/rendering/npr/edgeNodes');
  const depthTex = { ...makeNode(), uvNode: makeNode() };
  return sobelDepth(depthTex, makeNode(), isOrthographic);
}

describe('sobelDepth projection branch (F10)', () => {
  it('uses perspectiveDepthToViewZ by default (perspective camera)', async () => {
    await runSobelDepth();
    expect(perspectiveSpy).toHaveBeenCalled();
    expect(orthographicSpy).not.toHaveBeenCalled();
  });

  it('uses perspectiveDepthToViewZ when isOrthographic is explicitly false', async () => {
    await runSobelDepth(false);
    expect(perspectiveSpy).toHaveBeenCalled();
    expect(orthographicSpy).not.toHaveBeenCalled();
  });

  it('uses orthographicDepthToViewZ when isOrthographic is true', async () => {
    await runSobelDepth(true);
    expect(orthographicSpy).toHaveBeenCalled();
    expect(perspectiveSpy).not.toHaveBeenCalled();
  });

  it('linearizes every Sobel tap with the chosen reconstructor', async () => {
    await runSobelDepth(true);
    // The 3x3 Sobel kernel samples the 8 surrounding offsets (the center tap has
    // weight 0 in both Gx and Gy, so it's omitted) → 8 linearize calls.
    expect(orthographicSpy).toHaveBeenCalledTimes(8);
  });
});
