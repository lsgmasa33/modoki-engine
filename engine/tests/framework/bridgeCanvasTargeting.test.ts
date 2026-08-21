/** Which canvas synthetic device input is dispatched ON (#93).
 *
 *  The defect: `dispatchTapAt`/`handleDrag`/`handlePointer` all did `document.querySelector('canvas')`
 *  — the FIRST canvas in the document, whatever the call aimed at. Measured on `games/3d-test`
 *  (a full-screen Three.js canvas at index 0, a 200x300 PixiJS canvas at index 1): an aim at
 *  (130,503), squarely inside the Pixi canvas, was dispatched on canvas 0, while the reply said `ok`
 *  and echoed the coordinates. It read as a hit.
 *
 *  Nothing caught it because every existing bridge test mounts exactly ONE canvas, where
 *  "first canvas" and "canvas under the point" are the same element. The bug is only expressible
 *  with two, which is what this file adds.
 *
 *  jsdom has no layout engine — every `getBoundingClientRect()` is 0x0 and `elementFromPoint` cannot
 *  hit-test — so both are stubbed per test. That is not a workaround around the thing under test:
 *  the logic under test is *which element we choose given a hit-test and geometry*, and supplying
 *  those is the only way to state a case. The real hit-testing is the browser's, not ours. */

import { describe, it, expect, afterEach } from 'vitest';
import { handleTap, handleDrag, handlePointer, _resetHeldPointerForTests } from '../../app/debug/bridge';

// jsdom has no `elementFromPoint`; tests/setup.ts installs an always-miss stub. Restore that
// baseline after each case so one test's stubbed hit cannot leak into the next.
const baselineElementFromPoint = document.elementFromPoint;

afterEach(() => {
  _resetHeldPointerForTests();
  document.elementFromPoint = baselineElementFromPoint;
  document.body.innerHTML = '';
});

/** A canvas with a stubbed layout rect, since jsdom lays nothing out. */
function canvasAt(left: number, top: number, width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  document.body.appendChild(c);
  c.getBoundingClientRect = () =>
    ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top } as DOMRect);
  return c;
}

/** Stub the browser hit-test: return whichever element the caller says is topmost at that point. */
function hitTestReturns(el: Element | null) {
  document.elementFromPoint = () => el;
}

/** Record the pointer events a canvas actually receives. */
function record(c: HTMLCanvasElement): Array<{ type: string; x: number; y: number }> {
  const seen: Array<{ type: string; x: number; y: number }> = [];
  for (const t of ['pointerdown', 'pointermove', 'pointerup']) {
    c.addEventListener(t, (e) => seen.push({ type: t, x: (e as PointerEvent).clientX, y: (e as PointerEvent).clientY }));
  }
  return seen;
}

describe('synthetic tap targets the canvas UNDER the aim point (#93)', () => {
  it('THE REGRESSION: with a 2D canvas over a 3D one, the tap goes to the aimed canvas, not the first', async () => {
    // The exact shape measured on games/3d-test.
    const threeCanvas = canvasAt(0, 0, 400, 800);   // index 0 — full screen, and the OLD target
    const pixiCanvas = canvasAt(30, 353, 200, 300); // index 1 — genuinely topmost at (130,503)
    const onThree = record(threeCanvas);
    const onPixi = record(pixiCanvas);
    hitTestReturns(pixiCanvas);

    const reply = await handleTap({ x: 130, y: 503 });

    expect(onPixi.map((e) => e.type)).toEqual(['pointerdown', 'pointerup']);
    expect(onThree).toEqual([]);          // before the fix this was the ONLY canvas that saw it
    expect(reply).toContain('canvas:hit');
  });

  it('reports `only` when there is a single canvas — nothing to disambiguate', async () => {
    // Back-compat for every existing single-canvas caller, and the shape jsdom-based tests use.
    const c = canvasAt(0, 0, 400, 800);
    const seen = record(c);
    hitTestReturns(document.body); // a miss: no layout means no hit in the real jsdom case either

    const reply = await handleTap({ x: 10, y: 20 });

    expect(seen).toHaveLength(2);
    expect(reply).toContain('canvas:only');
  });

  it('falls back to GEOMETRY when the hit-test answers a CONTAINER, preferring the topmost canvas', async () => {
    // `<body>` wins the hit-test: no canvas covers the point, so the aim is still meant for a canvas
    // and we have to guess which. DOM order approximates paint order, so the LAST containing canvas
    // wins. (This case used to be stated with an overlay DIV as the hit target; #299 moved that to
    // the DOM path below — a div IS a plausible UI control and a real finger would land on it,
    // whereas `<body>` never is.)
    const back = canvasAt(0, 0, 400, 800);
    const front = canvasAt(0, 0, 400, 800);   // same rect, later in the document == on top
    const onBack = record(back);
    const onFront = record(front);
    hitTestReturns(document.body);

    const reply = await handleTap({ x: 100, y: 100 });

    expect(onFront).toHaveLength(2);
    expect(onBack).toEqual([]);
    expect(reply).toContain('canvas:contains');
  });

  it('ADMITS a guess: several canvases, the point in none of them, says `ambiguous`', async () => {
    // The honesty requirement. The old code produced this case constantly and still replied a clean
    // `ok`, which is what made the defect survive — it never looked like a miss.
    canvasAt(0, 0, 100, 100);
    canvasAt(0, 0, 100, 100);
    hitTestReturns(document.body);

    const reply = await handleTap({ x: 9000, y: 9000 });

    expect(reply).toContain('canvas:ambiguous');
  });

  it('still refuses when there is no canvas at all', async () => {
    hitTestReturns(document.body);
    expect(await handleTap({ x: 10, y: 20 })).toMatch(/^Error: No canvas element found/);
  });
});

describe('a synthetic gesture stays on the canvas it grabbed (#93)', () => {
  it('drag: the whole sequence goes to the canvas under FROM, even when TO is over another', async () => {
    // Pointer capture semantics. Re-picking per step would deliver the tail of a drag — including
    // its `up` — to an element that never saw the `down`, which no real finger can produce.
    // `other` is mounted FIRST deliberately: if the grabbed canvas were index 0, the old
    // first-canvas bug would satisfy this test by accident and it would prove nothing.
    const other = canvasAt(200, 0, 200, 200);
    const grabbed = canvasAt(0, 0, 200, 200);
    const onGrabbed = record(grabbed);
    const onOther = record(other);
    hitTestReturns(grabbed);

    const reply = await handleDrag({ fromX: 50, fromY: 50, toX: 350, toY: 50, steps: 2, delayMs: 0 });

    expect(onGrabbed.map((e) => e.type)).toEqual(['pointerdown', 'pointermove', 'pointermove', 'pointerup']);
    expect(onOther).toEqual([]);
    expect(onGrabbed.at(-1)).toMatchObject({ type: 'pointerup', x: 350 }); // left the canvas, still delivered
    expect(reply).toContain('canvas:hit');
  });

  it('pointer: the canvas is captured at `down` and reused for move/up across separate calls', async () => {
    // handlePointer is a SUSTAINED gesture spanning calls, so the capture has to outlive one call —
    // the held button and held position already do; the canvas has to as well.
    const other = canvasAt(200, 0, 200, 200);   // index 0 — see the note on the drag case above
    const grabbed = canvasAt(0, 0, 200, 200);
    const onGrabbed = record(grabbed);
    const onOther = record(other);

    hitTestReturns(grabbed);
    await handlePointer({ action: 'down', x: 50, y: 50 });
    hitTestReturns(other);                                  // the finger drifts over the other canvas
    await handlePointer({ action: 'move', x: 350, y: 50 });
    const up = await handlePointer({ action: 'up' });

    expect(onGrabbed.map((e) => e.type)).toEqual(['pointerdown', 'pointermove', 'pointerup']);
    expect(onOther).toEqual([]);
    expect(up).toContain('canvas:hit');
  });
});
