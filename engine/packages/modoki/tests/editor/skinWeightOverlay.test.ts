/** Which parts the SceneView weight overlay draws (#180). The overlay pairs each part's
 *  DEFORMED positions (Skin2DBuffer) with that part's OWN weights (ParsedRig2D.parts); this
 *  is the pairing rule, extracted so it can be tested without mounting SceneView. Pure — no DOM. */

import { describe, it, expect } from 'vitest';
import { overlayPartIndices, type OverlayRigPart, type OverlayBufferPart } from '../../src/editor/panels/skinWeightOverlay';

const rigPart = (vertCount: number, visible = true): OverlayRigPart => ({ vertCount, visible });
const bufPart = (vertCount: number): OverlayBufferPart => ({ positions: { length: vertCount * 2 } });

describe('overlayPartIndices', () => {
  it('draws EVERY part of a multi-part rig, not just parts[0]', () => {
    // The defect: the overlay read the rig's top-level (parts[0]-alias) weights and drew
    // buffer.parts[0], so parts 1..N were left blank under a whole-rig wireframe.
    const rig = [rigPart(4), rigPart(6), rigPart(3)];
    const buf = [bufPart(4), bufPart(6), bufPart(3)];
    expect(overlayPartIndices(rig, buf)).toEqual([0, 1, 2]);
  });

  it('draws the single part of a v1 rig', () => {
    expect(overlayPartIndices([rigPart(4)], [bufPart(4)])).toEqual([0]);
  });

  it('skips a hidden part — the renderer honours part.visible, so shading it would paint influence onto nothing on screen', () => {
    const rig = [rigPart(4), rigPart(6, false), rigPart(3)];
    const buf = [bufPart(4), bufPart(6), bufPart(3)];
    expect(overlayPartIndices(rig, buf)).toEqual([0, 2]);
  });

  it('skips a part whose vertex counts DISAGREE — a mid-rebuild buffer would index one part\'s weights into another part\'s positions', () => {
    const rig = [rigPart(4), rigPart(6), rigPart(3)];
    const buf = [bufPart(4), bufPart(5), bufPart(3)]; // part 1 stale
    expect(overlayPartIndices(rig, buf)).toEqual([0, 2]);
  });

  it('skips empty parts (no geometry to shade)', () => {
    expect(overlayPartIndices([rigPart(0), rigPart(4)], [bufPart(0), bufPart(4)])).toEqual([1]);
  });

  it('tolerates a length mismatch between rig and buffer rather than indexing past the end', () => {
    // skin2DSystem rebuilds the buffer on a part-count change, but a frame can land between
    // the rig edit and the reskin.
    expect(overlayPartIndices([rigPart(4), rigPart(6)], [bufPart(4)])).toEqual([0]);
    expect(overlayPartIndices([rigPart(4)], [bufPart(4), bufPart(6)])).toEqual([0]);
  });

  it('returns nothing for an absent or empty rig/buffer', () => {
    expect(overlayPartIndices(undefined, [bufPart(4)])).toEqual([]);
    expect(overlayPartIndices([rigPart(4)], undefined)).toEqual([]);
    expect(overlayPartIndices([], [])).toEqual([]);
  });
});
