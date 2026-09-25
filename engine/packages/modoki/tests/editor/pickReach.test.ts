// @vitest-environment jsdom
/** #1576 — the SceneView's 3D pick answers only for a press its own canvas receives.
 *
 *  The live defect: in 'ui' mode a Canvas2D host's pick overlay sits over the Three.js canvas. A
 *  press it misses DESELECTS and never reaches the 3D viewport, but the overlay's provider says
 *  `null` for it, `pickAt` read that as "ask the next one", and the 3D provider named the mesh
 *  underneath — so `modoki_tap` reported ok for an entity no click can reach.
 *
 *  The composition is tested through the REAL `pickAt` with the overlay's provider ranked above,
 *  as the SceneView registers them, because the defect was in how the two answers combine: the
 *  predicate alone returning false proves nothing if `pickAt` would still fall through past it.
 *  The 3D provider here is a stand-in with the predicate as its first line, which is the shape
 *  `pickEntityAtViewportPoint` has (a wrapper is forbidden by `pickProviderSharedPath.test.ts`). */

import { describe, it, expect, afterEach } from 'vitest';
import { pickAt, registerPickProvider, __resetPickProvidersForTest } from '../../src/runtime/core/screenPick';
import { pressReachesCanvas } from '../../src/editor/scene/pickReach';

const CUBE = 21;

afterEach(() => { __resetPickProvidersForTest(); document.body.innerHTML = ''; });

/** The SceneView's stack at one point: the 3D canvas, and optionally something on top of it. */
function scene(top: 'own' | 'foreign-canvas' | 'div' | 'nothing') {
  const own = document.createElement('canvas');
  const foreign = document.createElement('canvas');
  foreign.setAttribute('data-2d-pick', '');
  const toolbar = document.createElement('div');
  document.body.append(own, foreign, toolbar);
  const at = { own, 'foreign-canvas': foreign, div: toolbar, nothing: null }[top];
  // The overlay's own provider: a 2D MISS with no UI node under it — absorbed, selects nothing.
  registerPickProvider(() => null, 'scene-view', 10);
  registerPickProvider((x, y) => (pressReachesCanvas(own, x, y, () => at) ? CUBE : null), 'scene-view');
}

describe('pressReachesCanvas, as the 3D pick consults it', () => {
  it('a canvas ON TOP of the 3D one withholds the 3D answer — the press never reaches it', () => {
    scene('foreign-canvas');
    expect(pickAt('scene-view', 5, 5)).toBeNull();
  });

  it('accept side: the 3D canvas itself on top answers as before', () => {
    scene('own');
    expect(pickAt('scene-view', 5, 5)).toBe(CUBE);
  });

  it('a NON-canvas cover still answers — that is the DOM check\'s flag, not a refusal', () => {
    // Withholding here would turn `entityResolve`'s documented "covered, flagged" result into an
    // OCCLUDED refusal that says the press "selects nothing", which is wrong about what covers it.
    scene('div');
    expect(pickAt('scene-view', 5, 5)).toBe(CUBE);
  });

  it('nothing at the point (off-window) answers as before — the window check is the caller\'s', () => {
    scene('nothing');
    expect(pickAt('scene-view', 5, 5)).toBe(CUBE);
  });
});
