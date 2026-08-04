/** Marquee box-selection geometry + policy (#105 Phase 2).
 *
 *  Extracted from `SceneView.tsx`, which measured 2,311 executable lines at 0%
 *  coverage — reaching any of this meant driving a real pointer drag through a
 *  mounted viewport. */

import { describe, it, expect } from 'vitest';
import {
  MARQUEE_DRAG_THRESHOLD_PX, marqueeExceededThreshold, marqueeOverlayBox, marqueeRect,
  enclosedByMarquee, mergeMarqueeSelection, type MarqueeCandidate,
} from '../../src/editor/scene/marqueeSelect';

const at = (id: number, x: number, y: number, over: Partial<MarqueeCandidate> = {}): MarqueeCandidate =>
  ({ id, x, y, visible: true, canvasId: 1, ...over });

describe('the drag threshold decides marquee vs click', () => {
  // Below it, a Shift+drag is a Shift+CLICK and the marquee is abandoned — which
  // is what PRESERVES an existing selection. A smaller threshold means a shaky
  // click silently replaces the user's multi-selection.
  it('is strictly greater-than, so exactly the threshold is still a click', () => {
    expect(marqueeExceededThreshold(0, 0, MARQUEE_DRAG_THRESHOLD_PX, 0)).toBe(false);
    expect(marqueeExceededThreshold(0, 0, MARQUEE_DRAG_THRESHOLD_PX + 0.01, 0)).toBe(true);
  });

  it('measures diagonal distance, not per-axis', () => {
    // 3-4-5: neither axis alone exceeds 4, but the travel is 5.
    expect(marqueeExceededThreshold(0, 0, 3, 4)).toBe(true);
    expect(marqueeExceededThreshold(0, 0, 3, 0)).toBe(false);
  });

  it('is direction-agnostic', () => {
    expect(marqueeExceededThreshold(100, 100, 90, 90)).toBe(true);
    expect(marqueeExceededThreshold(100, 100, 101, 101)).toBe(false);
  });
});

describe('the overlay box is always positive-extent', () => {
  it('handles a top-left to bottom-right drag', () => {
    expect(marqueeOverlayBox(10, 20, 40, 60)).toEqual({ left: 10, top: 20, width: 30, height: 40 });
  });

  it('handles a drag back up and to the left identically', () => {
    expect(marqueeOverlayBox(40, 60, 10, 20)).toEqual({ left: 10, top: 20, width: 30, height: 40 });
  });

  it('handles mixed direction', () => {
    expect(marqueeOverlayBox(40, 20, 10, 60)).toEqual({ left: 10, top: 20, width: 30, height: 40 });
  });
});

describe('marqueeRect normalizes the corners', () => {
  it('does not care which corner was dragged from', () => {
    const a = marqueeRect({ x: 5, y: 5 }, { x: -5, y: -5 });
    expect(a).toEqual({ minX: -5, maxX: 5, minY: -5, maxY: 5 });
    expect(marqueeRect({ x: -5, y: -5 }, { x: 5, y: 5 })).toEqual(a);
  });

  it('survives an inverted Y axis (game space is not client space)', () => {
    expect(marqueeRect({ x: 0, y: 100 }, { x: 10, y: -100 })).toEqual({ minX: 0, maxX: 10, minY: -100, maxY: 100 });
  });
});

describe('enclosedByMarquee', () => {
  const rect = { minX: 0, maxX: 10, minY: 0, maxY: 10 };
  const none = new Set<number>();

  it('takes what is inside and leaves what is outside', () => {
    const got = enclosedByMarquee([at(1, 5, 5), at(2, 50, 5), at(3, 5, -50)], rect, none, 1);
    expect(got).toEqual([1]);
  });

  it('is INCLUSIVE on every edge and corner', () => {
    // A box drawn "up to" something should take it.
    const edges = [at(1, 0, 5), at(2, 10, 5), at(3, 5, 0), at(4, 5, 10), at(5, 0, 0), at(6, 10, 10)];
    expect(enclosedByMarquee(edges, rect, none, 1)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('excludes a hidden entity', () => {
    expect(enclosedByMarquee([at(1, 5, 5, { visible: false }), at(2, 5, 5)], rect, none, 1)).toEqual([2]);
  });

  it('excludes a deactivated entity', () => {
    expect(enclosedByMarquee([at(1, 5, 5), at(2, 5, 5)], rect, new Set([1]), 1)).toEqual([2]);
  });

  it('excludes entities belonging to a DIFFERENT canvas', () => {
    // Without this, a marquee in one canvas silently grabs overlapping entities
    // from another — invisible until the user moves them.
    const got = enclosedByMarquee([at(1, 5, 5, { canvasId: 2 }), at(2, 5, 5, { canvasId: 1 })], rect, none, 1);
    expect(got).toEqual([2]);
  });

  it('matches canvas-less entities only when editing outside any canvas', () => {
    const rootless = [at(1, 5, 5, { canvasId: null })];
    expect(enclosedByMarquee(rootless, rect, none, null)).toEqual([1]);
    expect(enclosedByMarquee(rootless, rect, none, 1)).toEqual([]);
  });

  it('preserves query order, so the LAST one becomes the primary', () => {
    expect(enclosedByMarquee([at(7, 1, 1), at(3, 2, 2), at(5, 3, 3)], rect, none, 1)).toEqual([7, 3, 5]);
  });

  it('returns empty for a box over nothing', () => {
    expect(enclosedByMarquee([at(1, 99, 99)], rect, none, 1)).toEqual([]);
  });

  it('handles a zero-area rect as a point test', () => {
    const point = { minX: 5, maxX: 5, minY: 5, maxY: 5 };
    expect(enclosedByMarquee([at(1, 5, 5), at(2, 5.01, 5)], point, none, 1)).toEqual([1]);
  });
});

describe('mergeMarqueeSelection — a marquee ADDS, it never replaces', () => {
  it('unions with the existing selection', () => {
    expect(mergeMarqueeSelection([1, 2], [3, 4])).toEqual({ ids: [1, 2, 3, 4], primary: 4 });
  });

  it('does not duplicate an already-selected entity', () => {
    expect(mergeMarqueeSelection([1, 2], [2, 3])).toEqual({ ids: [1, 2, 3], primary: 3 });
  });

  it('makes the LAST enclosed entity the primary, which is what the Inspector shows', () => {
    expect(mergeMarqueeSelection([], [9, 8, 7])!.primary).toBe(7);
  });

  it('returns null for an empty enclosure, leaving the selection untouched', () => {
    // Not an empty selection — dragging a box over nothing must not clear what the
    // user already had.
    expect(mergeMarqueeSelection([1, 2], [])).toBeNull();
  });

  it('does not mutate the incoming selection', () => {
    const current = [1, 2];
    mergeMarqueeSelection(current, [3]);
    expect(current).toEqual([1, 2]);
  });
});
