/**
 * A handle on the far edge of its own canvas must stay INSIDE it.
 *
 * A canvas editor sizes its element with a rounded pixel count and computes handle positions
 * from the unrounded product, so a handle on the image's last row/column lands a sub-pixel
 * outside its owner — and Enact refuses to drag a handle that is not inside the thing that owns
 * it. Measured on `games/space-invader`'s 1008x392 `catvader.png` (bug `XVkE46RE8ZQMm3cOwC8q`,
 * QA-ASSET-0025): canvas height `round(279.222) = 279`, handles published at `top + 279.222`,
 * `se`/`s`/`sw` all `onScreen:false` and undraggable — a coin flip on the fractional part of
 * `imgH * scale`, i.e. on the sheet's dimensions.
 *
 * The tolerance is what keeps this a fix rather than a new bug: clamping without one would drag
 * a genuinely scrolled-away handle to the nearest edge and report success.
 */
import { describe, it, expect } from 'vitest';
import { clampHandleToOwner } from '../../src/runtime/rendering/interactionHandles';

/** The measured case: canvas at (316,216), 718x279, handle published at y 495.2222…. */
const CANVAS = { left: 316, top: 216, width: 718, height: 279 };

describe('clampHandleToOwner', () => {
  it('pulls the reported sub-pixel overshoot back inside', () => {
    const out = clampHandleToOwner(675, 216 + 279.2222222222222, CANVAS);
    expect(out.y).toBeLessThanOrEqual(CANVAS.top + CANVAS.height);
    expect(out.y).toBeGreaterThan(CANVAS.top + CANVAS.height - 1);
  });

  it('leaves the clamped point on the last addressable pixel, not on the boundary', () => {
    // `document.elementFromPoint` at exactly the box's far edge returns the NEIGHBOUR, which
    // would trade an off-screen refusal for an occlusion refusal — no better.
    expect(clampHandleToOwner(675, 495.2222222222222, CANVAS).y).toBe(216 + 279 - 0.5);
    // ...and the tolerance is measured from THAT point, so it spans the whole sub-pixel range a
    // `Math.round` on the canvas size can produce (< 0.5) plus the inset (0.5).
    expect(clampHandleToOwner(675, 496, CANVAS).y).toBe(496);
  });

  it('does not move a handle that is already inside', () => {
    expect(clampHandleToOwner(675, 300, CANVAS)).toEqual({ x: 675, y: 300 });
  });

  it('clamps the left/top edges the same way', () => {
    expect(clampHandleToOwner(315.7, 215.6, CANVAS)).toEqual({ x: 316, y: 216 });
  });

  it('LEAVES a genuinely out-of-view handle outside, so the refusal still fires', () => {
    // This is the assertion that stops the fix becoming a false success: a keyframe scrolled
    // 200px away is not a rounding artefact, and dragging the canvas edge instead would be a
    // gesture at the wrong place reported as ok.
    const out = clampHandleToOwner(675, CANVAS.top + CANVAS.height + 200, CANVAS);
    expect(out.y).toBe(CANVAS.top + CANVAS.height + 200);
  });

  it('treats the tolerance as an inclusive boundary', () => {
    const justInside = clampHandleToOwner(675, CANVAS.top + CANVAS.height - 0.5 + 1, CANVAS);
    expect(justInside.y).toBe(CANVAS.top + CANVAS.height - 0.5);
    const justOutside = clampHandleToOwner(675, CANVAS.top + CANVAS.height - 0.5 + 1.001, CANVAS);
    expect(justOutside.y).toBeCloseTo(CANVAS.top + CANVAS.height + 0.501, 6);
  });

  it('covers the NINE-SLICE guide case too — an inset of 0 on the right/bottom edge', () => {
    // The sibling the close-out sweep found (`NineSliceEditor.tsx`). `coordOf('r')` returns the
    // image's full width when the right inset is 0 — an ordinary authoring state, not a corner —
    // so the guide publishes the UNROUNDED `imgDims.w * scale` against a canvas sized with
    // `Math.round` of the same product, and Enact refuses to drag it. Same helper, same tolerance.
    const canvas = { left: 100, top: 50, width: 400, height: 300 };
    const unroundedRightEdge = 100 + 400.4;            // imgW * scale, canvas element is 400 wide
    expect(clampHandleToOwner(unroundedRightEdge, 200, canvas).x).toBe(100 + 400 - 0.5);
  });

  it('clamps x independently of y', () => {
    const out = clampHandleToOwner(CANVAS.left + CANVAS.width + 0.3, 300, CANVAS);
    expect(out).toEqual({ x: CANVAS.left + CANVAS.width - 0.5, y: 300 });
  });
});
