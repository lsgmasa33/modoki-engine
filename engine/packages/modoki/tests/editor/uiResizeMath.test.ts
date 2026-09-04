/** uiResizeMath — pure resize/anchor arithmetic extracted from UIResizeOverlay
 *  (editor-gizmos missing-test #3). DOM-free: drag deltas + start values → trait patch. */

import { describe, it, expect } from 'vitest';
import {
  anchorRefPoint, anchorDragAxes, decomposeScale, accumulateAncestorScale, usesRightOffset, usesBottomOffset,
  computeMoveOffsets, computeResize, containingBlockSize, frameToLogicalRect, paddingBoxRect,
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

describe('computeResize / computeMoveOffsets with an ancestor scale (#651 B2 second follow-up)', () => {
  // `dx`/`dy` arrive frame-logical — inflated by any SECOND transform an ancestor carries on
  // top of the preview frame's own (accumulateAncestorScale). Every unit except `%` must divide
  // that back out; `%` must NOT (its denominator is built in the same inflated space and already
  // cancels it — see uiResizeMath.ts's deltaToUnit doc comment).
  const computed = { width: 100, height: 50 };
  const NO_VP = { width: 0, height: 0 };

  it('a px resize under ancestor scale 2 writes HALF what the raw (frame-logical) delta suggests', () => {
    // dx=20 frame-logical px; a further 2x ancestor transform means only 10 authored px of
    // growth actually tracks the cursor on screen. The pre-fix code (no ancestorScaleX) wrote
    // 100+20=120 here — this is the exact overshoot the brief calls out at uiResizeMath.ts:256.
    expect(computeResize('resize-r', rv(), computed, PARENT, 20, 0, NO_VP, 2, 1)).toEqual({ width: 110 });
  });

  it('an AUTO-SIZED (0-width) px element under ancestor scale divides the measured base too, not just dx (#651 B2 — the auto-sized px base)', () => {
    // `computed` arrives in the SAME ancestor-inflated space as dx/dy (UIResizeOverlay measures
    // it that way deliberately) — a layout width of 100 under ancestorScaleX=2 is reported here
    // as 200. The pre-fix code fed that straight into `baseW` unmodified, then added the
    // already-un-inflated layoutDx (20) on top: 200+20=220. The fix divides the computed-size
    // fallback by ancestorScaleX too: 200/2=100, +20=120 — matching a plain (non-auto-sized)
    // px element's math one test above, as it must (auto-size is only about WHERE the base
    // number comes from, not a different unit-conversion rule).
    const inflatedComputed = { width: 200, height: 50 };
    expect(computeResize('resize-r', rv({ width: 0 }), inflatedComputed, PARENT, 40, 0, NO_VP, 2, 1))
      .toEqual({ width: 120 });
  });

  it('the same fix applies on the HEIGHT axis, via ancestorScaleY independently of ancestorScaleX', () => {
    const inflatedComputed = { width: 100, height: 200 }; // layout height 50 under ancestorScaleY=4
    expect(computeResize('resize-b', rv({ height: 0 }), inflatedComputed, PARENT, 0, 40, NO_VP, 1, 4))
      .toEqual({ height: 60 }); // base 200/4=50; layoutDy 40/4=10; 50+10=60.
  });

  it('an ancestor scale of 1 is BYTE-IDENTICAL to omitting it — the regression guard for every existing case', () => {
    const withDefaults = computeResize('resize-br', rv(), computed, PARENT, 10, 6);
    const withExplicit1 = computeResize('resize-br', rv(), computed, PARENT, 10, 6, NO_VP, 1, 1);
    expect(withExplicit1).toEqual(withDefaults);
    expect(withExplicit1).toEqual({ width: 110, height: 56 });
  });

  it('a viewport-unit (vw) resize divides the delta by the ancestor scale before taking % of the viewport', () => {
    const viewport = { width: 400, height: 300 };
    // dx=20 frame-logical, ancestorScaleX=2 → layout dx=10 → 10/400*100=2.5%; base 30% → 32.5%.
    expect(computeResize('resize-r', rv({ width: 30, widthUnit: 'vw' }), computed, PARENT, 20, 0, viewport, 2, 1))
      .toEqual({ width: 32.5 });
  });

  it('height/dy uses ancestorScaleY, independent of ancestorScaleX — the axis pairing must not cross', () => {
    // dy=20, ancestorScaleY=4 → layout dy=5 → 50+5=55. ancestorScaleX=1 (irrelevant to height)
    // is deliberately different from ancestorScaleY to prove the axes aren't swapped.
    expect(computeResize('resize-b', rv(), computed, PARENT, 0, 20, NO_VP, 1, 4)).toEqual({ height: 55 });
  });

  it('the % path is UNCHANGED by ancestorScale — its denominator already cancels the same factor', () => {
    const unscaled = computeResize('resize-r', rv({ width: 50, widthUnit: '%' }), computed, PARENT, 10, 0);
    const scaled = computeResize('resize-r', rv({ width: 50, widthUnit: '%' }), computed, PARENT, 10, 0, NO_VP, 2, 2);
    expect(scaled).toEqual(unscaled);
    expect(scaled).toEqual({ width: 55 });
  });

  it('computeMoveOffsets: a px move divides dx by ancestorScaleX and dy by ancestorScaleY', () => {
    const out = computeMoveOffsets('move-free', px({ left: 10, top: 5 }), 20, 12, PARENT, NO_VP, 2, 4);
    // left: 10 + 20/2 = 20; top: 5 + 12/4 = 8.
    expect(out).toEqual({ left: 20, top: 8 });
  });

  it('computeMoveOffsets: a right/bottom-anchored px move also divides before SUBTRACTING', () => {
    const out = computeMoveOffsets('move-free', px({ anchor: 'bottom-right', right: 20, bottom: 30 }), 20, 12, PARENT, NO_VP, 2, 4);
    // right: 20 - 20/2 = 10; bottom: 30 - 12/4 = 27.
    expect(out).toEqual({ right: 10, bottom: 27 });
  });

  it('computeMoveOffsets: an ancestor scale of 1 is byte-identical to omitting it', () => {
    const withDefaults = computeMoveOffsets('move-free', px({ left: 10, top: 5 }), 8, 3, PARENT);
    const withExplicit1 = computeMoveOffsets('move-free', px({ left: 10, top: 5 }), 8, 3, PARENT, NO_VP, 1, 1);
    expect(withExplicit1).toEqual(withDefaults);
  });
});

describe('containingBlockSize (#651 — the %-denominator box)', () => {
  const computed = { width: 100, height: 50 };
  // The parent's PADDING box — border already excluded (e.g. `clientWidth`/`clientHeight`).
  // A 400x300 border box with 5px L/R/T/B borders yields a 390x290 padding box.
  const NO_BORDER_PADDING_BOX = { width: 400, height: 300 }; // same border box, 0px border
  const PADDING_BOX = { width: 390, height: 290 };
  const PADDING = { left: 40, right: 40, top: 20, bottom: 20 };

  it('in-flow (content box): subtracts padding — CSS 10.2', () => {
    expect(containingBlockSize(NO_BORDER_PADDING_BOX, PADDING, 'content')).toEqual({ width: 320, height: 260 });
    expect(containingBlockSize(PADDING_BOX, PADDING, 'content')).toEqual({ width: 310, height: 250 });
  });

  it('anchored (padding box): returns the padding box as-is, padding does not shrink it — CSS 10.3.7', () => {
    expect(containingBlockSize(NO_BORDER_PADDING_BOX, PADDING, 'padding')).toEqual({ width: 400, height: 300 });
    expect(containingBlockSize(PADDING_BOX, PADDING, 'padding')).toEqual({ width: 390, height: 290 });
  });

  it('never returns negative — a parent smaller than its own padding clamps at 0', () => {
    expect(containingBlockSize({ width: 10, height: 10 }, PADDING, 'content')).toEqual({ width: 0, height: 0 });
  });

  it('regression: a %-resize on an in-flow child must use the SHRUNK denominator, not the raw padding box', () => {
    // The bug (#651): computeResize was fed the parent's raw padding-box width (400) for an
    // in-flow child, so an 80px drag wrote +20% instead of the correct +25% (80/320).
    const cb = containingBlockSize(NO_BORDER_PADDING_BOX, PADDING, 'content');
    expect(computeResize('resize-r', rv({ width: 50, widthUnit: '%' }), computed, cb, 80, 0))
      .toEqual({ width: 75 }); // 50 + (80/320)*100 = 75, not 50 + (80/400)*100 = 70.
  });

  it('regression: a %-resize on an ANCHORED child uses the padding box, not the content box', () => {
    // Same parent, but the resized entity itself is anchored — CSS resolves against the
    // padding box (400, since border is 0 here), not the content box (320).
    const cb = containingBlockSize(NO_BORDER_PADDING_BOX, PADDING, 'padding');
    expect(computeResize('resize-r', rv({ width: 50, widthUnit: '%' }), computed, cb, 80, 0))
      .toEqual({ width: 70 }); // 50 + (80/400)*100 = 70.
  });
});

describe('decomposeScale (#651 B2 — the rotation/AABB regression — ancestorScaleRatio\'s replacement, exact under rotation)', () => {
  it("'none', empty, and anything unparseable are the identity", () => {
    expect(decomposeScale('none')).toEqual({ x: 1, y: 1 });
    expect(decomposeScale('')).toEqual({ x: 1, y: 1 });
    expect(decomposeScale('not-a-transform')).toEqual({ x: 1, y: 1 });
  });

  it('matrix(): a pure scale (no rotation) recovers exactly that scale per axis', () => {
    // scale(2, 3) → matrix(2, 0, 0, 3, 0, 0).
    expect(decomposeScale('matrix(2, 0, 0, 3, 0, 0)')).toEqual({ x: 2, y: 3 });
  });

  it('matrix(): a pure rotation (no scale) recovers exactly 1 on both axes, at every angle', () => {
    // This is the exact case ancestorScaleRatio got wrong (#651 B2 — the rotation/AABB regression's regression): a rotated
    // element's getBoundingClientRect() is its inflated axis-aligned bounding box, not its true
    // size, so a rect-ratio approach reads a rotation as a scale. Reading the matrix directly
    // does not have this problem — rotation only redirects a column, hypot recovers its length.
    for (const deg of [15, 45, 90, 180]) {
      const rad = (deg * Math.PI) / 180;
      const t = `matrix(${Math.cos(rad)}, ${Math.sin(rad)}, ${-Math.sin(rad)}, ${Math.cos(rad)}, 0, 0)`;
      const { x, y } = decomposeScale(t);
      expect(x).toBeCloseTo(1, 9);
      expect(y).toBeCloseTo(1, 9);
    }
  });

  it('matrix(): scale AND rotation together — recovers the scale unchanged by the angle, non-uniform axes too', () => {
    for (const deg of [15, 45, 90, 180]) {
      const rad = (deg * Math.PI) / 180;
      // rotate(deg) scale(2, 3): a=2cos, b=2sin, c=-3sin, d=3cos. Translation (e,f) must not matter.
      const t = `matrix(${2 * Math.cos(rad)}, ${2 * Math.sin(rad)}, ${-3 * Math.sin(rad)}, ${3 * Math.cos(rad)}, 5, -7)`;
      const { x, y } = decomposeScale(t);
      expect(x).toBeCloseTo(2, 9);
      expect(y).toBeCloseTo(3, 9);
    }
  });

  it('matrix3d(): recovers scale from the first three entries of each of its first two columns', () => {
    const m = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; // pure scale(2, 3, 1), column-major
    expect(decomposeScale(`matrix3d(${m.join(', ')})`)).toEqual({ x: 2, y: 3 });
  });

  it('a malformed matrix()/matrix3d() (wrong arity or a non-finite entry) falls back to the identity', () => {
    expect(decomposeScale('matrix(1, 2, 3)')).toEqual({ x: 1, y: 1 });
    expect(decomposeScale('matrix(1, NaN, 3, 4, 5, 6)')).toEqual({ x: 1, y: 1 });
    expect(decomposeScale('matrix3d(1, 2, 3)')).toEqual({ x: 1, y: 1 });
  });
});

describe('accumulateAncestorScale (#651 B2 — the rotation/AABB regression — replaces ancestorScaleRatio; #651 B2 — the scale:0 guard — the scale:0 guard)', () => {
  it('is 1 when the chain is empty or every link is none — the byte-identical invariant', () => {
    expect(accumulateAncestorScale([])).toEqual({ x: 1, y: 1 });
    expect(accumulateAncestorScale(['none', 'none'])).toEqual({ x: 1, y: 1 });
  });

  it('is 1 for a PURE-ROTATION ancestor at every angle — the regression this fixes', () => {
    // Measured before this fix (parent 200×150, scale:1, frame 0.5): ancestorScaleRatio came out
    // 1.160/1.311 at rotation:15 where the true answer is 1/1, and 0.750/1.333 at rotation:90 on
    // the same non-square parent.
    for (const deg of [15, 45, 90, 180]) {
      const rad = (deg * Math.PI) / 180;
      const t = `matrix(${Math.cos(rad)}, ${Math.sin(rad)}, ${-Math.sin(rad)}, ${Math.cos(rad)}, 0, 0)`;
      const { x, y } = accumulateAncestorScale([t]);
      expect(x).toBeCloseTo(1, 9);
      expect(y).toBeCloseTo(1, 9);
    }
  });

  it('recovers a scale composed WITH rotation, exactly, independent of the angle', () => {
    for (const deg of [15, 45, 90, 180]) {
      const rad = (deg * Math.PI) / 180;
      const t = `matrix(${2 * Math.cos(rad)}, ${2 * Math.sin(rad)}, ${-3 * Math.sin(rad)}, ${3 * Math.cos(rad)}, 0, 0)`;
      const { x, y } = accumulateAncestorScale([t]);
      expect(x).toBeCloseTo(2, 9);
      expect(y).toBeCloseTo(3, 9);
    }
  });

  it('compounds NESTED ancestors by multiplying their per-axis scales together', () => {
    const outer = 'matrix(2, 0, 0, 2, 0, 0)';   // scale(2)
    const inner = 'matrix(1.5, 0, 0, 1.5, 0, 0)'; // scale(1.5), between outer and the element
    expect(accumulateAncestorScale([outer, inner])).toEqual({ x: 3, y: 3 });
  });

  it('a degenerate scale:0 ancestor falls back to 1, not 0 (#651 B2 — the scale:0 guard — scale:0 is a legitimate authored value)', () => {
    // scale(0) → matrix(0, 0, 0, 0, 0, 0). Propagating 0 would zero computeResize's `%`
    // denominator and turn a drag into a silent no-op, where the pre-ancestor-scale code worked.
    expect(accumulateAncestorScale(['matrix(0, 0, 0, 0, 0, 0)'])).toEqual({ x: 1, y: 1 });
    // Also when it's one link in a longer chain — the WHOLE product collapses to 0 first.
    expect(accumulateAncestorScale(['matrix(2, 0, 0, 2, 0, 0)', 'matrix(0, 0, 0, 0, 0, 0)'])).toEqual({ x: 1, y: 1 });
  });
});

describe('paddingBoxRect (#651 follow-up — the anchor-reference diamond box)', () => {
  const BORDER_RECT = { left: 100, top: 50, width: 400, height: 300 };

  it('with no border, the padding box equals the border box (origin unchanged)', () => {
    const NO_BORDER = { left: 0, right: 0, top: 0, bottom: 0 };
    expect(paddingBoxRect(BORDER_RECT, NO_BORDER, { width: 400, height: 300 }))
      .toEqual({ left: 100, top: 50, width: 400, height: 300 });
  });

  it('insets the origin by the L/T border width and takes the given padding-box size', () => {
    // A 5px border on every edge: origin shifts in by (5,5); size is whatever the
    // caller measured as the padding box (e.g. clientWidth/clientHeight) — 390x290,
    // NOT borderRect.width/height - border (400-10=390 coincides here, but the
    // function must use the passed-in size, not derive it from the border rect).
    const BORDER = { left: 5, right: 5, top: 5, bottom: 5 };
    expect(paddingBoxRect(BORDER_RECT, BORDER, { width: 390, height: 290 }))
      .toEqual({ left: 105, top: 55, width: 390, height: 290 });
  });

  it('asymmetric borders: origin shifts by LEFT/TOP only, never right/bottom', () => {
    const BORDER = { left: 10, right: 2, top: 3, bottom: 20 };
    expect(paddingBoxRect(BORDER_RECT, BORDER, { width: 388, height: 277 }))
      .toEqual({ left: 110, top: 53, width: 388, height: 277 });
  });

  it('matches the box containingBlockSize resolves an ANCHORED entity against — same padding-box size, offset by the parent border', () => {
    // This is the invariant the diamond fix depends on: for an anchored child,
    // containingBlockSize(paddingBoxSize, padding, 'padding') returns paddingBoxSize
    // UNCHANGED (CSS 10.3.7 — padding does not shrink the anchored containing block).
    // paddingBoxRect must place that SAME size at the parent's padding-box origin.
    const paddingBoxSize = { width: 390, height: 290 };
    const padding = { left: 40, right: 40, top: 20, bottom: 20 };
    const cb = containingBlockSize(paddingBoxSize, padding, 'padding');
    const border = { left: 5, right: 5, top: 5, bottom: 5 };
    const rect = paddingBoxRect(BORDER_RECT, border, paddingBoxSize);
    expect({ width: rect.width, height: rect.height }).toEqual(cb);
    expect({ left: rect.left, top: rect.top }).toEqual({ left: 105, top: 55 });
  });
});
