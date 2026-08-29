/** Weights-mode press classification (#287).
 *
 *  The bug: a stroke that STARTED over a bone joint was silently swallowed — `onPointerDown`
 *  hit-tested joints first and returned, so it selected a bone instead of painting. For an
 *  agent that was fatal, not merely annoying: `skin:bone:N` joints are the only handles
 *  SkinCanvas registers, so `drag_handle` could never produce a stroke at all. */
import { describe, it, expect } from 'vitest';
import {
  paintPressIntent, promotesToStroke, paintStrokeCenters, advancePaintStroke,
  PAINT_DRAG_SLOP, PAINT_SWEEP_STEP_FRACTION,
} from '../../src/editor/panels/skinPaintGesture';

const press = (paintSubTool: string, jointHit: number, selBone: number) =>
  paintPressIntent({ paintSubTool, jointHit, selBone });

describe('paintPressIntent', () => {
  it('parks a joint press when the brush is active and a bone is selected', () => {
    // THE REGRESSION. Before #287 this returned 'select' unconditionally, and the stroke died.
    expect(press('paint', 2, 0)).toBe('park');
    expect(press('paint', 0, 5)).toBe('park');
  });

  it('selects outright when there is no bone to paint yet', () => {
    // Parking here would only delay an inevitable selection by one pointer-up — and would
    // hand paintAt a selBone of -1 on the promoting frame.
    expect(press('paint', 2, -1)).toBe('select');
  });

  it('selects outright under the Transform sub-tool, which never paints', () => {
    expect(press('transform', 2, 0)).toBe('select');
    expect(press('transform', 2, -1)).toBe('select');
  });

  it('strokes immediately on empty space when a bone is selected', () => {
    expect(press('paint', -1, 0)).toBe('paint');
    expect(press('paint', -1, 3)).toBe('paint');
  });

  it('has nothing to do on empty space with no bone selected', () => {
    expect(press('paint', -1, -1)).toBe('ignore');
    expect(press('transform', -1, -1)).toBe('ignore');
  });

  it('never strokes under the Transform sub-tool, selection or not', () => {
    // Unreachable via SkinCanvas today — its gizmo branch intercepts a Transform press once a
    // bone is selected — but the classifier must not depend on its caller's control flow to
    // be right, or the next caller inherits a trap.
    expect(press('transform', -1, 0)).toBe('ignore');
    expect(press('transform', -1, 3)).toBe('ignore');
  });

  it('parks ONLY on the paint sub-tool with a selection — every other combination resolves now', () => {
    // Exhaustive over the axes that matter, so a future edit cannot widen 'park' unnoticed.
    const parked: string[] = [];
    for (const tool of ['paint', 'transform']) {
      for (const hit of [-1, 0, 3]) {
        for (const sel of [-1, 0, 3]) {
          if (press(tool, hit, sel) === 'park') parked.push(`${tool}/${hit}/${sel}`);
        }
      }
    }
    expect(parked.sort()).toEqual(['paint/0/0', 'paint/0/3', 'paint/3/0', 'paint/3/3']);
    // ...and the same sweep for 'paint', so widening EITHER outcome fails here.
    const strokes: string[] = [];
    for (const tool of ['paint', 'transform']) {
      for (const hit of [-1, 0, 3]) {
        for (const sel of [-1, 0, 3]) {
          if (press(tool, hit, sel) === 'paint') strokes.push(`${tool}/${hit}/${sel}`);
        }
      }
    }
    expect(strokes.sort()).toEqual(['paint/-1/0', 'paint/-1/3']);
  });
});

describe('promotesToStroke', () => {
  it('holds a press under the slop — it is still a possible click', () => {
    expect(promotesToStroke(0, 0)).toBe(false);
    expect(promotesToStroke(1, 1)).toBe(false);   // 2 < 3
    expect(promotesToStroke(-2, 0)).toBe(false);
  });

  it('promotes once travel reaches the slop, in any direction', () => {
    expect(promotesToStroke(PAINT_DRAG_SLOP, 0)).toBe(true);
    expect(promotesToStroke(0, -PAINT_DRAG_SLOP)).toBe(true);
    expect(promotesToStroke(-2, 2)).toBe(true);   // Manhattan: 4 >= 3
    expect(promotesToStroke(40, 40)).toBe(true);
  });

  it('is symmetric in sign — a leftward drag is as much a drag as a rightward one', () => {
    for (const d of [3, 7, 50]) expect(promotesToStroke(d, 0)).toBe(promotesToStroke(-d, 0));
  });
});

describe('paintStrokeCenters', () => {
  it('a slow move (under one step) paints only the endpoint, like today', () => {
    // Brush radius 40 → step 10. A 5px move stays under one step.
    const out = paintStrokeCenters({ x: 0, y: 0 }, { x: 5, y: 0 }, 40);
    expect(out).toEqual([{ x: 5, y: 0 }]);
  });

  it('a fast flick across several radii is interpolated into multiple centers ending at the endpoint', () => {
    // #392's repro shape: the cursor advances several brush diameters between two samples.
    const radius = 40;
    const out = paintStrokeCenters({ x: 0, y: 0 }, { x: 400, y: 0 }, radius);
    expect(out.length).toBeGreaterThan(1);
    expect(out[out.length - 1]).toEqual({ x: 400, y: 0 });
    // No gap between consecutive centers wider than the step (radius * fraction).
    const step = radius * PAINT_SWEEP_STEP_FRACTION;
    let prevX = 0;
    for (const c of out) {
      expect(c.x - prevX).toBeLessThanOrEqual(step + 1e-6);
      prevX = c.x;
    }
  });

  it('opening a stroke (prev === null) paints only the press point', () => {
    expect(paintStrokeCenters(null, { x: 12, y: 34 }, 40)).toEqual([{ x: 12, y: 34 }]);
  });
});

describe('advancePaintStroke', () => {
  // This is the seam SkinCanvas.tsx actually calls, once per pointer-down/move — reverting the
  // panel to a single stamp per move (re-introducing #392) means it simply stops calling this
  // function, which `paintStrokeCenters`'s own tests above cannot catch on their own (they never
  // simulate a SEQUENCE of samples through a carried-forward state).
  it('opens a stroke at the press point, then chains each subsequent move with no gap across the whole sequence', () => {
    const radius = 40;
    const step = radius * PAINT_SWEEP_STEP_FRACTION;
    const samples = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 440, y: 0 }]; // press + two big jumps
    let state: ReturnType<typeof advancePaintStroke>['state'] | null = null;
    const allCenters: Array<{ x: number; y: number }> = [];
    for (const to of samples) {
      const step1 = advancePaintStroke(state, to, radius);
      allCenters.push(...step1.centers);
      state = step1.state;
    }
    // The press point is painted exactly once, as the very first center of the whole chain.
    expect(allCenters[0]).toEqual({ x: 0, y: 0 });
    // The chain ends exactly at the last sample.
    expect(allCenters[allCenters.length - 1]).toEqual({ x: 440, y: 0 });
    // No gap wider than the step ANYWHERE across the concatenated chain — including at the
    // boundary between what two separate `advancePaintStroke` calls produced, which is exactly
    // the seam a per-move-only test cannot see.
    for (let i = 1; i < allCenters.length; i++) {
      expect(allCenters[i].x - allCenters[i - 1].x).toBeLessThanOrEqual(step + 1e-6);
    }
    // State carries forward the true last point, not e.g. a stale one from an earlier sample.
    expect(state).toEqual({ last: { x: 440, y: 0 } });
  });

  it('state === null opens a stroke — the whole answer is the press point', () => {
    const { centers, state } = advancePaintStroke(null, { x: 12, y: 34 }, 40);
    expect(centers).toEqual([{ x: 12, y: 34 }]);
    expect(state).toEqual({ last: { x: 12, y: 34 } });
  });
});
