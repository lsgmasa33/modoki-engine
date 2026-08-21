/** A held `device_pointer` press must not swallow the next `device_tap`/`device_drag` (#305).
 *
 *  Sibling of #302, found by its close-out sweep. The editor closed this at the backend; the
 *  device bridge had no equivalent, and here the symptom is a FALSE SUCCESS rather than a stuck
 *  panel: `pointerSource` latches `activeId` on the held down and early-returns for every later
 *  `pointerdown`, and #299's trusted-takeover cannot rescue it because a synthetic tap is not
 *  `isTrusted` either. So the tap's press reached nothing while `device_tap` answered `ok`.
 *
 *  THE POINT OF THIS FILE is that it wires the REAL bridge to the REAL `pointerSource` and asks
 *  what the GAME saw. The bridge's own tests can only prove a `pointerdown` was dispatched — which
 *  it always was, before the fix as much as after. "Dispatched" and "delivered" are exactly the two
 *  things this defect separates, so a test that stops at the dispatch passes against the bug. */
// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { handleTap, handleDrag, handlePointer, _resetHeldPointerForTests } from '../../app/debug/bridge';
// Imported from the package SOURCE, not its public surface: `pointerSource` is deliberately not
// exported (games reach it through the `Input` resource, never directly), and the whole point here
// is to drive the real one. Same relative-into-src route the editor UI tests already use.
import { pointerSource } from '../../packages/modoki/src/runtime/input/pointerSource';
import { createInputFrame, computePointerEdge, type InputFrame } from '../../packages/modoki/src/runtime/core/inputActions';

const baselineElementFromPoint = document.elementFromPoint;

beforeEach(() => {
  pointerSource.attach?.();
});

afterEach(() => {
  pointerSource.detach?.();
  _resetHeldPointerForTests();
  document.elementFromPoint = baselineElementFromPoint;
  document.body.innerHTML = '';
});

function canvasAt(left: number, top: number, width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  document.body.appendChild(c);
  c.getBoundingClientRect = () =>
    ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top } as DOMRect);
  return c;
}

/** Sample the real pointerSource exactly as `inputSystem` does, so the assertion is against the
 *  actual `Input` contract a game reads — not a stand-in for it. */
function sample(prevDown = false): InputFrame {
  const frame = createInputFrame();
  pointerSource.sample(frame);
  computePointerEdge(frame, { down: prevDown });
  return frame;
}

/** Drain whatever the held gesture left queued, so a later assertion reads the NEW gesture rather
 *  than the tail of the old one. */
function drain(): void {
  for (let i = 0; i < 8; i++) sample();
}

describe('a held device_pointer press is superseded by the next gesture (#305)', () => {
  it('THE REGRESSION: the game SEES a device_tap dispatched while a press is held', async () => {
    const canvas = canvasAt(0, 0, 400, 800);
    document.elementFromPoint = () => canvas;

    await handlePointer({ action: 'down', x: 100, y: 100 });
    drain(); // the held press's own edges are not what this test is about

    await handleTap({ x: 250, y: 300 });

    // Before the fix `activeId` was still latched, so the tap's pointerdown early-returned and the
    // game saw NOTHING at (250,300) — while device_tap answered ok.
    let sawPress = false;
    for (let i = 0; i < 8 && !sawPress; i++) {
      const f = sample();
      if (f.pointer.pressed && Math.round(f.pointer.x) === 250 && Math.round(f.pointer.y) === 300) sawPress = true;
    }
    expect(sawPress).toBe(true);
  });

  it('THE REGRESSION: the game SEES a device_drag dispatched while a press is held', async () => {
    const canvas = canvasAt(0, 0, 400, 800);
    document.elementFromPoint = () => canvas;

    await handlePointer({ action: 'down', x: 10, y: 10 });
    drain();

    await handleDrag({ fromX: 120, fromY: 140, toX: 200, toY: 240, steps: 2, delayMs: 0 });

    let sawPress = false;
    for (let i = 0; i < 8 && !sawPress; i++) {
      const f = sample();
      if (f.pointer.pressed && Math.round(f.pointer.x) === 120 && Math.round(f.pointer.y) === 140) sawPress = true;
    }
    expect(sawPress).toBe(true);
  });

  it('says so in the reply — a release the agent cannot see is still a surprise', async () => {
    const canvas = canvasAt(0, 0, 400, 800);
    document.elementFromPoint = () => canvas;
    await handlePointer({ action: 'down', x: 100, y: 100 });

    const reply = await handleTap({ x: 250, y: 300 });
    expect(reply).toContain('released a pointer left held');
  });

  it('leaves the reply alone when nothing was held — no phantom note on an ordinary tap', async () => {
    const canvas = canvasAt(0, 0, 400, 800);
    document.elementFromPoint = () => canvas;
    const reply = await handleTap({ x: 250, y: 300 });
    expect(reply).not.toContain('released a pointer left held');
  });

  it('the following move/up is refused with the CAUSE, not a bare "you never pressed"', async () => {
    const canvas = canvasAt(0, 0, 400, 800);
    document.elementFromPoint = () => canvas;
    await handlePointer({ action: 'down', x: 100, y: 100 });
    await handleTap({ x: 250, y: 300 });

    const refusal = await handlePointer({ action: 'move', x: 110, y: 110 });
    expect(refusal).toContain('no pointer is held');
    expect(refusal).toContain('released for you');
    expect(refusal).toContain('100.0,100.0');

    // …and a fresh press clears the story, so the next honest mistake reads as itself.
    await handlePointer({ action: 'down', x: 5, y: 5 });
    await handlePointer({ action: 'up', x: 5, y: 5 });
    expect(await handlePointer({ action: 'move', x: 1, y: 1 })).not.toContain('released for you');
  });

  it('bridge state and pointerSource agree afterwards — a later down is accepted, not 409d', async () => {
    const canvas = canvasAt(0, 0, 400, 800);
    document.elementFromPoint = () => canvas;
    await handlePointer({ action: 'down', x: 100, y: 100 });
    await handleTap({ x: 250, y: 300 });
    // The press is genuinely gone: `down` must not report "a pointer is already held".
    expect(await handlePointer({ action: 'down', x: 30, y: 40 })).not.toContain('already held');
  });

  it('hover/scroll/press_key leave the hold ALONE — they are legitimate mid-gesture', async () => {
    const canvas = canvasAt(0, 0, 400, 800);
    document.elementFromPoint = () => canvas;
    await handlePointer({ action: 'down', x: 100, y: 100 });

    const { handleHover, handleScroll, handlePressKey } = await import('../../app/debug/bridge');
    await handleHover({ x: 150, y: 150 });
    await handleScroll({ x: 150, y: 150, deltaY: 40 });
    await handlePressKey({ key: 'Shift' });

    // Constraining a drag with Shift, or scrolling a list while dragging over it, are real things.
    // A `move` still succeeding is the proof the press survived all three.
    expect(await handlePointer({ action: 'move', x: 120, y: 120 })).toContain('held:true');
  });
});
