/** uiResizeMath — pure resize/anchor arithmetic extracted from UIResizeOverlay
 *  (editor-gizmos missing-test #3). DOM-free: drag deltas + start values → trait patch. */

import { describe, it, expect } from 'vitest';
import {
  anchorRefPoint, anchorDragAxes, usesRightOffset, usesBottomOffset,
  computeMoveOffsets, computeResize, frameToLogicalRect,
  type MoveAnchorStart, type ResizeStartValues,
} from '../../src/editor/scene/uiResizeMath';

describe('frameToLogicalRect (selection-overlay screen→logical — regression guard)', () => {
  // A device whose logical width is W, shown in a preview frame scaled to `scale`
  // on screen at origin (fx, fy). An element with logical rect (lx,ly,lw,lh) appears
  // on screen at (fx+lx*scale, fy+ly*scale, lw*scale, lh*scale).
  const onScreen = (lx: number, ly: number, lw: number, lh: number, fx: number, fy: number, scale: number) =>
    ({ left: fx + lx * scale, top: fy + ly * scale, width: lw * scale, height: lh * scale });

  it('recovers the full device for a stretch element (er == frame) across devices/scales', () => {
    for (const [W, H] of [[834, 1194], [375, 667], [402, 874], [656, 728]]) {
      for (const scale of [0.25, 0.4436, 0.7947, 1, 1.5]) {
        const frame = { left: 130, top: 40, width: W * scale, height: H * scale };
        const r = frameToLogicalRect({ ...frame }, frame, W); // stretch: el === frame
        expect(r.left).toBeCloseTo(0, 4);
        expect(r.top).toBeCloseTo(0, 4);
        expect(r.width).toBeCloseTo(W, 3);
        expect(r.height).toBeCloseTo(H, 3);
      }
    }
  });

  it('is scale-invariant: the SAME logical rect regardless of the frame on-screen scale', () => {
    const W = 834;
    const small = frameToLogicalRect(onScreen(100, 200, 300, 400, 10, 20, 0.3), { left: 10, top: 20, width: 834 * 0.3, height: 1194 * 0.3 }, W);
    const big = frameToLogicalRect(onScreen(100, 200, 300, 400, 50, 60, 1.2), { left: 50, top: 60, width: 834 * 1.2, height: 1194 * 1.2 }, W);
    for (const k of ['left', 'top', 'width', 'height'] as const) expect(big[k]).toBeCloseTo(small[k], 3);
    expect(small).toMatchObject({ left: 100, top: 200, width: 300, height: 400 });
  });

  it('uses the CURRENT device width — same on-screen pixels, different device → different logical (the device-switch bug)', () => {
    // Identical on-screen frame/element, but measured against two device widths.
    const frame = { left: 0, top: 0, width: 370, height: 530 };
    const el = { left: 0, top: 0, width: 370, height: 530 }; // full (stretch)
    expect(frameToLogicalRect(el, frame, 834).width).toBeCloseTo(834, 3);  // iPad logical
    expect(frameToLogicalRect(el, frame, 375).width).toBeCloseTo(375, 3);  // iPhone SE logical
    // A stale device width (the bug) would have produced the wrong logical size here.
  });

  it('degenerate frame/device width → identity scale (no divide-by-zero)', () => {
    const r = frameToLogicalRect({ left: 5, top: 6, width: 10, height: 20 }, { left: 0, top: 0, width: 0, height: 0 }, 834);
    expect(r).toEqual({ left: 5, top: 6, width: 10, height: 20 });
  });
});

describe('anchorRefPoint', () => {
  it('maps corner/edge/center anchors to parent-rect fractions', () => {
    expect(anchorRefPoint('top-left')).toEqual({ fx: 0, fy: 0 });
    expect(anchorRefPoint('center')).toEqual({ fx: 0.5, fy: 0.5 });
    expect(anchorRefPoint('bottom-right')).toEqual({ fx: 1, fy: 1 });
    expect(anchorRefPoint('right')).toEqual({ fx: 1, fy: 0.5 });
  });
  it('stretch variants reference their pinned edge; unknown → top-left', () => {
    expect(anchorRefPoint('top-stretch')).toEqual({ fx: 0.5, fy: 0 });
    expect(anchorRefPoint('left-stretch')).toEqual({ fx: 0, fy: 0.5 });
    expect(anchorRefPoint('stretch')).toEqual({ fx: 0, fy: 0 });
    expect(anchorRefPoint('whatever')).toEqual({ fx: 0, fy: 0 });
  });
});

describe('anchorDragAxes', () => {
  it('full stretch is locked on both axes; corner anchors free on both', () => {
    expect(anchorDragAxes('stretch')).toEqual({ h: false, v: false });
    expect(anchorDragAxes('center')).toEqual({ h: true, v: true });
  });
  it('a stretched axis is locked, the other free', () => {
    expect(anchorDragAxes('top-stretch')).toEqual({ h: false, v: true });  // pinned L+R
    expect(anchorDragAxes('left-stretch')).toEqual({ h: true, v: false }); // pinned T+B
    expect(anchorDragAxes('h-stretch')).toEqual({ h: false, v: true });
    expect(anchorDragAxes('v-stretch')).toEqual({ h: true, v: false });
  });
});

describe('usesRightOffset / usesBottomOffset', () => {
  it('right-edge anchors store a right offset', () => {
    for (const a of ['right', 'top-right', 'bottom-right', 'right-stretch']) expect(usesRightOffset(a)).toBe(true);
    for (const a of ['left', 'top-left', 'center', 'top']) expect(usesRightOffset(a)).toBe(false);
  });
  it('bottom-edge anchors store a bottom offset', () => {
    for (const a of ['bottom', 'bottom-left', 'bottom-right', 'bottom-stretch']) expect(usesBottomOffset(a)).toBe(true);
    for (const a of ['top', 'left', 'center']) expect(usesBottomOffset(a)).toBe(false);
  });
});

const px = (over: Partial<MoveAnchorStart> = {}): MoveAnchorStart => ({
  anchor: 'top-left',
  top: 0, topUnit: 'px', left: 0, leftUnit: 'px',
  right: 0, rightUnit: 'px', bottom: 0, bottomUnit: 'px', ...over,
});
const PARENT = { width: 200, height: 100 };

describe('computeMoveOffsets', () => {
  it('move-free with a top-left anchor adds dx to left, dy to top (px)', () => {
    const out = computeMoveOffsets('move-free', px({ left: 10, top: 5 }), 8, 3, PARENT);
    expect(out).toEqual({ left: 18, top: 8 });
  });

  it('move-x only touches the horizontal offset; move-y only vertical', () => {
    expect(computeMoveOffsets('move-x', px({ left: 10, top: 5 }), 8, 3, PARENT)).toEqual({ left: 18 });
    expect(computeMoveOffsets('move-y', px({ left: 10, top: 5 }), 8, 3, PARENT)).toEqual({ top: 8 });
  });

  it('a right-edge anchor SUBTRACTS dx from the right offset (drag right → smaller right)', () => {
    const out = computeMoveOffsets('move-x', px({ anchor: 'top-right', right: 20 }), 8, 0, PARENT);
    expect(out).toEqual({ right: 12 });
  });

  it('a bottom-edge anchor subtracts dy from the bottom offset', () => {
    const out = computeMoveOffsets('move-y', px({ anchor: 'bottom-left', bottom: 30 }), 0, 5, PARENT);
    expect(out).toEqual({ bottom: 25 });
  });

  it('% units convert the pixel delta to a percentage of the parent and round to 0.1', () => {
    // dx=10 of 200px parent = +5% on left.
    const out = computeMoveOffsets('move-x', px({ leftUnit: '%', left: 12 }), 10, 0, PARENT);
    expect(out).toEqual({ left: 17 }); // 12 + 5
  });

  it('% with a zero-size parent contributes no delta (no divide-by-zero)', () => {
    const out = computeMoveOffsets('move-x', px({ leftUnit: '%', left: 12 }), 10, 0, { width: 0, height: 0 });
    expect(out).toEqual({ left: 12 });
  });
});

const rv = (over: Partial<ResizeStartValues> = {}): ResizeStartValues => ({
  width: 100, height: 50, widthUnit: 'px', heightUnit: 'px', ...over,
});

describe('computeResize', () => {
  const computed = { width: 100, height: 50 };

  it('a bottom-right corner grows width by dx, height by dy (px)', () => {
    expect(computeResize('resize-br', rv(), computed, PARENT, 10, 6)).toEqual({ width: 110, height: 56 });
  });

  it('a top-left corner inverts the sign (drag right/down shrinks)', () => {
    expect(computeResize('resize-tl', rv(), computed, PARENT, 10, 6)).toEqual({ width: 90, height: 44 });
  });

  it('an edge handle affects only one dimension', () => {
    expect(computeResize('resize-r', rv(), computed, PARENT, 10, 6)).toEqual({ width: 110 });
    expect(computeResize('resize-t', rv(), computed, PARENT, 10, 6)).toEqual({ height: 44 });
  });

  it('clamps width/height at 0 (no negative sizes)', () => {
    expect(computeResize('resize-l', rv({ width: 20 }), computed, PARENT, 1000, 0)).toEqual({ width: 0 });
  });

  it('% width: delta is a percentage of the parent; rounds to 0.1', () => {
    // width 50%, dx=10 of 200px = +5% → 55%.
    expect(computeResize('resize-r', rv({ width: 50, widthUnit: '%' }), computed, PARENT, 10, 0)).toEqual({ width: 55 });
  });

  it('auto-sized (0 width) px element bases the new size on the measured size', () => {
    // width:0 (auto) + px unit → base = computed.width (100); grow by 10.
    expect(computeResize('resize-r', rv({ width: 0 }), computed, PARENT, 10, 0)).toEqual({ width: 110 });
  });

  it('auto-sized 0-width % element derives the base from computed/parent', () => {
    // width:0 % → base = computed.width(100)/parent.width(200) = 50%; +5% (dx 10/200).
    expect(computeResize('resize-r', rv({ width: 0, widthUnit: '%' }), computed, PARENT, 10, 0)).toEqual({ width: 55 });
  });
});
