/** Unit tests for the sustained-pointer + scroll primitives in rendererOps — the trusted
 *  `sendInputEvent` emitters. A fake webContents RECORDS every injected event, so we assert on
 *  the exact wire shape without a live Electron window.
 *
 *  The load-bearing case: a HELD pointerMove must carry the `*ButtonDown` modifier for the held
 *  button. Live testing found that without it Blink reports `buttons=0` on the move — a hover, not
 *  a drag — so a slingshot/charge handler that gates on `e.buttons` treats the gesture as released.
 *  There was NO unit test at that spot; this is it. */

import { describe, it, expect } from 'vitest';
import type { BrowserWindow } from 'electron';
import { pointerDown, pointerMove, pointerUp, scroll, drag } from '../../electron/rendererOps';

interface RecordedEvent { type: string; x?: number; y?: number; button?: string; clickCount?: number; modifiers?: string[]; deltaX?: number; deltaY?: number }

/** A fake window whose webContents records injected events and reports a fixed zoom factor. */
function makeWin(zoomFactor = 1) {
  const events: RecordedEvent[] = [];
  const win = { webContents: {
    getZoomFactor: () => zoomFactor,
    sendInputEvent: (e: RecordedEvent) => { events.push(e); },
  } } as unknown as BrowserWindow;
  return { win, events };
}

describe('pointerDown', () => {
  it('emits a bare mouseMove then a mouseDown with the button held (buttons via the down)', async () => {
    const { win, events } = makeWin();
    await pointerDown(win, 10, 20, { button: 'left' });
    expect(events).toEqual([
      { type: 'mouseMove', x: 10, y: 20, modifiers: undefined },
      { type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: undefined },
    ]);
  });

  it('scales page-CSS coords to DIP by the zoom factor', async () => {
    const { win, events } = makeWin(1.2);
    await pointerDown(win, 10, 20);
    // 10*1.2=12, 20*1.2=24 — see toDip.
    expect(events.map((e) => [e.type, e.x, e.y])).toEqual([
      ['mouseMove', 12, 24],
      ['mouseDown', 12, 24],
    ]);
    expect(events[1].button).toBe('left'); // default button
  });
});

describe('pointerMove — the held-button modifier (regression: buttons=0 bug)', () => {
  it.each([
    ['left', 'leftButtonDown'],
    ['right', 'rightButtonDown'],
    ['middle', 'middleButtonDown'],
  ] as const)('a held %s move carries the %s modifier', async (button, heldMod) => {
    const { win, events } = makeWin();
    await pointerMove(win, 30, 40, { button });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'mouseMove', x: 30, y: 40, button });
    expect(events[0].modifiers).toContain(heldMod);
  });

  it('appends the held modifier to caller-supplied modifiers (does not replace them)', async () => {
    const { win, events } = makeWin();
    await pointerMove(win, 1, 2, { button: 'left', modifiers: ['shift'] });
    expect(events[0].modifiers).toEqual(['shift', 'leftButtonDown']);
  });

  it('defaults to the left held modifier when no button is given', async () => {
    const { win, events } = makeWin();
    await pointerMove(win, 1, 2);
    expect(events[0].modifiers).toEqual(['leftButtonDown']);
  });
});

describe('pointerUp', () => {
  it('emits a single mouseUp releasing the button', async () => {
    const { win, events } = makeWin();
    await pointerUp(win, 50, 60, { button: 'right' });
    expect(events).toEqual([
      { type: 'mouseUp', x: 50, y: 60, button: 'right', clickCount: 1, modifiers: undefined },
    ]);
  });
});

describe('drag — the atomic down→moves→up gesture (regression: modifier parity with pointerMove)', () => {
  // Live testing found the SAME buttons=0 bug in the atomic `drag()` as pointerMove had:
  // each intermediate move sent no `*ButtonDown` modifier, so Blink reported `buttons=0`
  // on every move of an atomic drag — a listener gating on `e.buttons` (or a game whose
  // drag-detection mirrors pointerMove's contract) would see a hover burst, not a drag.
  it('carries the held-button modifier on every INTERMEDIATE move, but not the leading move or the final mouseUp', async () => {
    const { win, events } = makeWin();
    await drag(win, { x: 0, y: 0 }, { x: 100, y: 100 }, { steps: 3 });
    // Sequence: leading mouseMove, mouseDown, 3 intermediate mouseMoves, mouseUp.
    expect(events).toHaveLength(6);
    expect(events[0]).toMatchObject({ type: 'mouseMove' });
    expect(events[0].modifiers).toBeUndefined();
    expect(events[1]).toMatchObject({ type: 'mouseDown', button: 'left', clickCount: 1 });
    for (const e of events.slice(2, 5)) {
      expect(e).toMatchObject({ type: 'mouseMove', button: 'left' });
      expect(e.modifiers).toContain('leftButtonDown');
    }
    const up = events[5];
    expect(up).toMatchObject({ type: 'mouseUp', button: 'left', clickCount: 1 });
    expect(up.modifiers).toBeUndefined();
  });

  it.each([
    ['right', 'rightButtonDown'],
    ['middle', 'middleButtonDown'],
  ] as const)('uses the %s held modifier for a %s-button drag', async (button, heldMod) => {
    const { win, events } = makeWin();
    await drag(win, { x: 0, y: 0 }, { x: 10, y: 10 }, { steps: 2, button });
    const moves = events.filter((e) => e.type === 'mouseMove' && e.button === button);
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect(m.modifiers).toContain(heldMod);
  });

  it('appends the held modifier to caller-supplied modifiers on intermediate moves (does not replace them)', async () => {
    const { win, events } = makeWin();
    await drag(win, { x: 0, y: 0 }, { x: 10, y: 10 }, { steps: 2, modifiers: ['shift'] });
    const intermediateMoves = events.filter((e) => e.type === 'mouseMove' && e.button === 'left');
    expect(intermediateMoves.length).toBe(2);
    for (const m of intermediateMoves) expect(m.modifiers).toEqual(['shift', 'leftButtonDown']);
    // The leading (pre-down) move and the final mouseUp keep the BARE caller modifiers.
    expect(events[0].modifiers).toEqual(['shift']);
    expect(events[events.length - 1].modifiers).toEqual(['shift']);
  });

  it('scales page-CSS coords to DIP by the zoom factor for both endpoints', async () => {
    const { win, events } = makeWin(1.2);
    await drag(win, { x: 10, y: 10 }, { x: 20, y: 20 }, { steps: 2 });
    // 10*1.2=12, 20*1.2=24.
    expect(events[0]).toMatchObject({ x: 12, y: 12 }); // leading move at `from`
    expect(events[events.length - 1]).toMatchObject({ x: 24, y: 24 }); // mouseUp at `to`
  });
});

describe('scroll modifiers', () => {
  it('carries modifiers on the wheel event when provided, and negates the DOM-sign delta', async () => {
    const { win, events } = makeWin();
    await scroll(win, 5, 6, 0, -120, ['control']);
    expect(events).toHaveLength(1);
    // DOM deltaY -120 → native +120 (see the GOTCHA in scroll).
    expect(events[0]).toMatchObject({ type: 'mouseWheel', x: 5, y: 6, deltaY: 120, modifiers: ['control'] });
  });

  it('omits the modifiers field entirely for a bare wheel', async () => {
    const { win, events } = makeWin();
    await scroll(win, 5, 6, 0, -120);
    expect('modifiers' in events[0]).toBe(false);
    await scroll(win, 5, 6, 0, -120, []);
    expect('modifiers' in events[1]).toBe(false); // empty array → still omitted
  });
});
