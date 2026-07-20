/** Shared marquee keysInBox geometry (Missing-Tests #4 / F8 consolidation).
 *  A box selects exactly the diamonds/dots whose centers fall inside, across multiple
 *  tracks, and the row-band/value-band filtering excludes off-band keys. */
import { describe, it, expect } from 'vitest';
import { keysInBox } from '../../src/editor/panels/animation/marqueeGeom';
import type { AnimationTrack } from '../../src/runtime/animation/types';

// Two tracks, two keys each. Centers are supplied by the `center` callback below.
const tracks = [
  { keys: [{ t: 0 }, { t: 1 }] },
  { keys: [{ t: 0 }, { t: 1 }] },
] as unknown as AnimationTrack[];

// Lay keys on a grid: cx = ki*100, cy = ti*100. So:
//   (ti0,ki0)=(0,0) (ti0,ki1)=(100,0) (ti1,ki0)=(0,100) (ti1,ki1)=(100,100)
const grid = (ti: number, ki: number) => ({ cx: ki * 100, cy: ti * 100 });

describe('keysInBox geometry', () => {
  it('selects exactly the centers inside the box, across tracks', () => {
    const ids = keysInBox(tracks, [0, 1], { x0: -10, y0: -10, x1: 10, y1: 110 }, grid);
    // x in [-10,10] → only ki=0; y in [-10,110] → both rows.
    expect(ids.sort()).toEqual(['0:0', '1:0']);
  });

  it('normalizes an inverted (dragged-up-left) box', () => {
    const ids = keysInBox(tracks, [0, 1], { x0: 110, y0: 110, x1: 90, y1: 90 }, grid);
    expect(ids).toEqual(['1:1']); // box around (100,100)
  });

  it('row-band filtering: a center returned as null is skipped', () => {
    // Emulate the dopesheet skipping an off-band row by returning null for ti=1.
    const center = (ti: number, ki: number) => (ti === 1 ? null : { cx: ki * 100, cy: 0 });
    const ids = keysInBox(tracks, [0, 1], { x0: -10, y0: -10, x1: 210, y1: 10 }, center);
    expect(ids.sort()).toEqual(['0:0', '0:1']); // ti=1 entirely excluded
  });

  it('only considers the `visible` subset of tracks', () => {
    const ids = keysInBox(tracks, [0], { x0: -10, y0: -10, x1: 210, y1: 210 }, grid);
    expect(ids.sort()).toEqual(['0:0', '0:1']); // track 1 not visible
  });

  it('returns empty when nothing is inside', () => {
    expect(keysInBox(tracks, [0, 1], { x0: 500, y0: 500, x1: 600, y1: 600 }, grid)).toEqual([]);
  });
});
