/** Weights-mode press classification (#287).
 *
 *  The bug: a stroke that STARTED over a bone joint was silently swallowed — `onPointerDown`
 *  hit-tested joints first and returned, so it selected a bone instead of painting. For an
 *  agent that was fatal, not merely annoying: `skin:bone:N` joints are the only handles
 *  SkinCanvas registers, so `drag_handle` could never produce a stroke at all. */
import { describe, it, expect } from 'vitest';
import { paintPressIntent, promotesToStroke, PAINT_DRAG_SLOP } from '../../src/editor/panels/skinPaintGesture';

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
