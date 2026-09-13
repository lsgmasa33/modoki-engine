/** #1176 — a slicer drag moves an edge by the pointer's travel since the press, on the handle's
 *  own axes, clamped to the sheet. Each case is one symptom measured live on
 *  `games/space-invader` `catvader_1` (252×392 on a 1008×392 sheet, fit scale 0.7123). The
 *  capture half, which lets a drag overshoot the canvas at all, is `dragPointerCapture.test.ts`
 *  plus the live run in qa/cases/assets/sprite-slice-handle-resize-writes-rect.md. */

import { describe, it, expect } from 'vitest';
import { resizeSliceRect, dragNineSliceGuide, type Handle } from '../../src/editor/panels/sliceDrag';

const SHEET = { w: 1008, h: 392 };
const CATVADER_1 = { x: 252, y: 0, w: 252, h: 392 };
const SCALE = 0.7123;
/** A pointer `dx`/`dy` CSS px from `press`, in image px. */
const moved = (press: { x: number; y: number }, dx: number, dy: number) => ({ x: press.x + dx / SCALE, y: press.y + dy / SCALE });

describe('resizeSliceRect', () => {
  it('a side handle moves only its own axis: an `e` drag that drifts vertically keeps y and h (was {y:195, h:1})', () => {
    // The live run pressed the `e` handle at mid-height and moved +20 px right.
    const press = { x: 504, y: 196 };
    expect(resizeSliceRect(CATVADER_1, 'e', press, moved(press, 20, 3), SHEET)).toEqual({ x: 252, y: 0, w: 280, h: 392 });
    const pressN = { x: 378, y: 0 };
    expect(resizeSliceRect(CATVADER_1, 'n', pressN, moved(pressN, 40, 10), SHEET)).toEqual({ x: 252, y: 14, w: 252, h: 378 });
  });

  it('a corner press that landed off the true corner changes nothing on an axis the drag did not move (was h 392 -> 389)', () => {
    // The live `se` press: 0.72 CSS px inside the bottom edge (the published handle), and every
    // move read 1.33 CSS px higher again. Press and pointer share that y, so dy is 0.
    const press = { x: 504, y: 392 - 0.72 / SCALE };
    const pointer = { x: press.x + 20 / SCALE, y: press.y };
    expect(resizeSliceRect(CATVADER_1, 'se', press, pointer, SHEET)).toEqual({ x: 252, y: 0, w: 280, h: 392 });
  });

  it('an overshoot past the sheet pins the edge exactly on the boundary', () => {
    const press = { x: 504, y: 391 };
    // 60 px below and 900 px right of the canvas: only reachable under pointer capture.
    expect(resizeSliceRect(CATVADER_1, 'se', press, moved(press, 900, 60), SHEET)).toEqual({ x: 252, y: 0, w: 756, h: 392 });
    const pressNW = { x: 252, y: 0 };
    expect(resizeSliceRect(CATVADER_1, 'nw', pressNW, moved(pressNW, -900, -60), SHEET)).toEqual({ x: 0, y: 0, w: 504, h: 392 });
  });

  it('dragging an edge past the opposite edge flips the span instead of going negative', () => {
    const press = { x: 504, y: 196 };
    // 300 source px left: the `e` edge ends at 204, 48 px left of the fixed `w` edge at 252.
    expect(resizeSliceRect(CATVADER_1, 'e', press, { x: 204, y: 196 }, SHEET)).toEqual({ x: 204, y: 0, w: 48, h: 392 });
  });

  it('an edge landing on an exact half pixel never moves the FIXED edge (close-out review: {x:241, w:264})', () => {
    // `w` from 252 to 240.5: rounding start and length separately sent both up, ending at 505.
    const r = resizeSliceRect(CATVADER_1, 'w', { x: 252, y: 196 }, { x: 240.5, y: 196 }, SHEET);
    expect(r.x + r.w).toBe(504);
    const n = resizeSliceRect({ x: 0, y: 100, w: 10, h: 292 }, 'n', { x: 5, y: 100 }, { x: 5, y: 99.5 }, SHEET);
    expect(n.y + n.h).toBe(392);
  });

  it('a span collapsed against the sheet edge keeps 1 px INSIDE the sheet', () => {
    const r = resizeSliceRect({ x: 1000, y: 0, w: 8, h: 10 }, 'w', { x: 1000, y: 5 }, { x: 2000, y: 5 }, SHEET);
    expect(r).toEqual({ x: 1007, y: 0, w: 1, h: 10 });
  });

  it('a span collapsed by its NEAR edge keeps the far edge fixed (review: a `w` drag onto 504 took catvader_2\'s first column)', () => {
    expect(resizeSliceRect(CATVADER_1, 'w', { x: 252, y: 196 }, { x: 503.5, y: 196 }, SHEET)).toEqual({ x: 503, y: 0, w: 1, h: 392 });
    expect(resizeSliceRect(CATVADER_1, 'e', { x: 504, y: 196 }, { x: 251.5, y: 196 }, SHEET)).toEqual({ x: 252, y: 0, w: 1, h: 392 });
  });

  it('a fractional or zero rect from the numeric fields comes out whole, on the axis the drag does not own too', () => {
    expect(resizeSliceRect({ x: 10.5, y: 0, w: 0, h: 20 }, 'n', { x: 0, y: 0 }, { x: 0, y: 2 }, SHEET)).toEqual({ x: 11, y: 2, w: 1, h: 18 });
  });

  it('every handle leaves the axes it does not own untouched on a diagonal drag', () => {
    const owns: Record<Handle, [boolean, boolean]> = {
      nw: [true, true], n: [false, true], ne: [true, true], e: [true, false],
      se: [true, true], s: [false, true], sw: [true, true], w: [true, false],
    };
    const rect = { x: 300, y: 100, w: 200, h: 150 };
    for (const [h, [ownsX, ownsY]] of Object.entries(owns) as [Handle, [boolean, boolean]][]) {
      const r = resizeSliceRect(rect, h, { x: 0, y: 0 }, { x: 10, y: 10 }, SHEET);
      if (!ownsX) expect([h, r.x, r.w]).toEqual([h, rect.x, rect.w]);
      if (!ownsY) expect([h, r.y, r.h]).toEqual([h, rect.y, rect.h]);
      if (ownsX) expect([h, r.w]).not.toEqual([h, rect.w]);
      if (ownsY) expect([h, r.h]).not.toEqual([h, rect.h]);
    }
  });
});

describe('dragNineSliceGuide', () => {
  const START = { l: 10, r: 20, t: 30, b: 0 };

  it('a guide pressed off its line moves by the travel, not to the pointer (was: jumped to the press point)', () => {
    // `b` sits on the bottom edge (inset 0); the press lands 3 source px above it.
    expect(dragNineSliceGuide(START, 'b', 389, 389, SHEET)).toEqual(START);
    expect(dragNineSliceGuide(START, 'l', 13, 18, SHEET)).toEqual({ ...START, l: 15 });
    expect(dragNineSliceGuide(START, 'r', 985, 980, SHEET)).toEqual({ ...START, r: 25 });
  });

  it('an overshoot past the sheet pins the guide on the boundary, and a guide never crosses its opposite', () => {
    expect(dragNineSliceGuide({ ...START, b: 12 }, 'b', 380, 900, SHEET)).toEqual({ ...START, b: 0 });
    expect(dragNineSliceGuide(START, 'l', 10, -500, SHEET)).toEqual({ ...START, l: 0 });
    expect(dragNineSliceGuide(START, 't', 30, 5000, SHEET)).toEqual({ ...START, t: SHEET.h - START.b - 1 });
  });
});
