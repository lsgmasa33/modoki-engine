/** Trusted-input coordinates under VS Code–style page zoom.
 *
 *  The PUBLIC coordinate space for Enact/Percept is zoomed-CSS (what getBoundingClientRect,
 *  selectors and Percept bounds report). `sendInputEvent` takes DIP, and Chromium maps an
 *  injected DIP coordinate into the page by DIVIDING by the zoom factor — so to land on the
 *  element at zoomed-CSS point P we must inject P·f. This pins that scaling for tap/drag/
 *  hover/scroll so a future refactor can't silently reintroduce the off-by-zoom miss that a
 *  live audit measured (docs/plans/editor-ui-zoom-plan.md). */
import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { tap, drag, hover, scroll, captureGesture } from '../../electron/rendererOps';

/** A window whose webContents reports a fixed zoom factor and records every injected event. */
function fakeWindow(zoomFactor: number) {
  const events: Array<{ type: string; x?: number; y?: number }> = [];
  const win = { webContents: {
    getZoomFactor: () => zoomFactor,
    sendInputEvent: (e: { type: string; x?: number; y?: number }) => { events.push(e); },
  } };
  return { win: win as unknown as BrowserWindow, events };
}
const moves = (events: Array<{ type: string; x?: number; y?: number }>) =>
  events.filter((e) => e.type === 'mouseMove' || e.type === 'mouseDown' || e.type === 'mouseUp' || e.type === 'mouseWheel');

describe('trusted input scales zoomed-CSS → DIP', () => {
  it('tap at factor 1 passes coordinates through unchanged', async () => {
    const { win, events } = fakeWindow(1);
    await tap(win, 500, 300);
    for (const e of moves(events)) { expect(e.x).toBe(500); expect(e.y).toBe(300); }
  });

  it('tap at factor 1.44 injects P·f (so the renderer receives P)', async () => {
    const { win, events } = fakeWindow(1.44);
    await tap(win, 500, 300);
    for (const e of moves(events)) { expect(e.x).toBeCloseTo(720, 6); expect(e.y).toBeCloseTo(432, 6); }
  });

  it('hover scales its point', async () => {
    const { win, events } = fakeWindow(1.2);
    await hover(win, 100, 200);
    const m = moves(events)[0];
    expect(m.x).toBeCloseTo(120, 6); expect(m.y).toBeCloseTo(240, 6);
  });

  it('drag scales both endpoints and every interpolated move', async () => {
    const { win, events } = fakeWindow(2);
    await drag(win, { x: 10, y: 10 }, { x: 20, y: 30 }, { steps: 2 });
    const m = moves(events);
    // down at from·2 = (20,20); up at to·2 = (40,60); all interpolated moves within the DIP box.
    expect(m[0]).toMatchObject({ x: 20, y: 20 });
    expect(m[m.length - 1]).toMatchObject({ x: 40, y: 60 });
    for (const e of m) { expect(e.x!).toBeGreaterThanOrEqual(20); expect(e.x!).toBeLessThanOrEqual(40); }
  });

  it('scroll scales the wheel target point (deltas are NOT scaled)', async () => {
    const { win, events } = fakeWindow(1.5);
    await scroll(win, 200, 100, 0, 120);
    const w = events.find((e) => e.type === 'mouseWheel') as { x: number; y: number; deltaY: number };
    expect(w.x).toBeCloseTo(300, 6); expect(w.y).toBeCloseTo(150, 6);
    expect(w.deltaY).toBe(-120); // unchanged magnitude (DOM→native sign flip only)
  });

  it('captureGesture injects DIP-scaled events but REPORTS the trajectory in public coords', async () => {
    const { win, events } = fakeWindow(2);
    let samples = 0;
    const { frames } = await captureGesture(win, {
      from: { x: 10, y: 10 }, to: { x: 20, y: 30 }, steps: 2, sample: async () => ++samples,
    });
    // Dispatched events are scaled x2: down at from*2, up at to*2, and interpolation in between.
    const down = events.find((e) => e.type === 'mouseDown') as { x: number; y: number };
    const up = events.find((e) => e.type === 'mouseUp') as { x: number; y: number };
    expect(down).toMatchObject({ x: 20, y: 20 });   // from (10,10) * 2
    expect(up).toMatchObject({ x: 40, y: 60 });     // to (20,30) * 2
    expect(events.some((e) => e.type === 'mouseMove' && e.x === 30 && e.y === 40)).toBe(true); // mid (15,20)*2
    // But the returned frames stay in UNSCALED public coords so feel numbers are comparable.
    expect(frames[0]).toMatchObject({ x: 15, y: 20 });                 // interpolated raw, t=0.5
    expect(frames[frames.length - 1]).toMatchObject({ x: 20, y: 30, t: 1 }); // to, raw
    expect(frames[0].t).toBeCloseTo(0.5, 6);
  });
});
