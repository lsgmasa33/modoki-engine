/** useTimelineDrag (anim-editors F8) — shared timeline pointer-drag plumbing.
 *  Verifies the common machinery the Dopesheet + Curves views both delegate to:
 *    1. playhead drag → snapped px→time scrub
 *    2. multi-key group drag → raw px→time target
 *    3. marquee drag → box state during, keysInBox hit-test on release
 *    4. a view-specific ("custom") drag kind routes to onCustomDrag with the
 *       local point, and is NOT mistaken for keys/marquee at release.
 *  These were ~120 LOC duplicated (with subtle divergence) before the extraction. */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { useTimelineDrag, type MarqueeBox } from '../../src/editor/panels/animation/useTimelineDrag';
import { TRACK_PAD_LEFT, type TimelineView } from '../../src/editor/panels/animation/timelineMath';

// jsdom's PointerEvent constructor drops clientX/Y — build events with them defined.
function firePointer(target: EventTarget, type: string, clientX: number, clientY: number) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clientX', { value: clientX });
  Object.defineProperty(ev, 'clientY', { value: clientY });
  target.dispatchEvent(ev);
}

beforeAll(() => {
  // Container at origin so clientX maps straight to local x.
  HTMLDivElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
});

interface Drag { kind: string; ti?: number; ki?: number; additive?: boolean; x0?: number; y0?: number }

// pxPerSec = 10 so t = (x - originX) / 10. originX = TRACK_PAD_LEFT (8).
const VIEW: TimelineView = { originX: TRACK_PAD_LEFT, pxPerSec: 10 };
const xToT = (x: number) => (x - VIEW.originX) / VIEW.pxPerSec;

interface Spies {
  onScrub: ReturnType<typeof vi.fn>;
  onDragSelectedKeys: ReturnType<typeof vi.fn>;
  onEndKeyDrag: ReturnType<typeof vi.fn>;
  onMarqueeSelect: ReturnType<typeof vi.fn>;
  onCustomDrag: ReturnType<typeof vi.fn>;
  keysInBox: (b: MarqueeBox) => string[];
}

function Harness({ spies, begin }: { spies: Spies; begin: { drag: Drag; x: number; y: number } }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { startDrag, marquee } = useTimelineDrag<Drag>({
    ref, view: VIEW, duration: 100, frameRate: 0, // frameRate 0 → snapToFrame is identity
    onScrub: spies.onScrub,
    onDragSelectedKeys: spies.onDragSelectedKeys,
    onEndKeyDrag: spies.onEndKeyDrag,
    keysInBox: spies.keysInBox,
    onMarqueeSelect: spies.onMarqueeSelect,
    onCustomDrag: spies.onCustomDrag,
  });
  return (
    <div ref={ref} data-testid="area">
      <button data-testid="start" onClick={() => startDrag(begin.drag, begin.x, begin.y)} />
      <span data-testid="marquee">{marquee ? `${marquee.x0},${marquee.y0},${marquee.x1},${marquee.y1}` : 'none'}</span>
    </div>
  );
}

function setup(begin: { drag: Drag; x: number; y: number }) {
  const spies: Spies = {
    onScrub: vi.fn(),
    onDragSelectedKeys: vi.fn(),
    onEndKeyDrag: vi.fn(),
    onMarqueeSelect: vi.fn(),
    onCustomDrag: vi.fn(),
    keysInBox: vi.fn((b: MarqueeBox) => [`box:${b.x0}-${b.x1}`]),
  };
  const utils = render(<Harness spies={spies} begin={begin} />);
  const start = () => (utils.getByTestId('start') as HTMLElement).click();
  const marqueeText = () => utils.getByTestId('marquee').textContent;
  return { spies, start, marqueeText };
}

describe('useTimelineDrag — F8 shared timeline drag', () => {
  it('playhead drag scrubs snapped px→time and clamps to [0, duration]', () => {
    const { spies, start } = setup({ drag: { kind: 'playhead' }, x: 28, y: 0 });
    start(); // begin: applies the first frame immediately at x=28 → t=2
    expect(spies.onScrub).toHaveBeenLastCalledWith(xToT(28));
    firePointer(window, 'pointermove', 108, 5); // x=108 → t=10
    expect(spies.onScrub).toHaveBeenLastCalledWith(xToT(108));
    firePointer(window, 'pointermove', -50, 5); // negative → clamped to 0
    expect(spies.onScrub).toHaveBeenLastCalledWith(0);
    firePointer(window, 'pointerup', -50, 5);
    expect(spies.onEndKeyDrag).not.toHaveBeenCalled();
  });

  it('keys group drag waits for movement, then reports raw px→time target and ends with onEndKeyDrag', () => {
    const { spies, start } = setup({ drag: { kind: 'keys' }, x: 48, y: 0 });
    start(); // pointer-DOWN must NOT commit anything (a plain select-click)
    expect(spies.onDragSelectedKeys).not.toHaveBeenCalled();
    firePointer(window, 'pointermove', 88, 0); // first real move: x=88 → t=8
    expect(spies.onDragSelectedKeys).toHaveBeenLastCalledWith(xToT(88));
    expect(spies.onEndKeyDrag).not.toHaveBeenCalled();
    firePointer(window, 'pointerup', 88, 0);
    expect(spies.onEndKeyDrag).toHaveBeenCalledTimes(1);
    expect(spies.onMarqueeSelect).not.toHaveBeenCalled();
  });

  it('select-click (down then up, no movement) on a key commits NO move — regression for spurious retime', () => {
    const { spies, start } = setup({ drag: { kind: 'keys' }, x: 48, y: 0 });
    start();
    firePointer(window, 'pointerup', 48, 0); // released at the exact down point
    expect(spies.onDragSelectedKeys).not.toHaveBeenCalled(); // no zero-move commit
    // onEndKeyDrag still fires so the drag base is cleared.
    expect(spies.onEndKeyDrag).toHaveBeenCalledTimes(1);
  });

  it('custom mutating kind (tangent/key) also waits for movement before editing', () => {
    const { spies, start } = setup({ drag: { kind: 'key', ti: 0, ki: 0 }, x: 48, y: 10 });
    start();
    expect(spies.onCustomDrag).not.toHaveBeenCalled(); // no edit on pointer-down
    firePointer(window, 'pointermove', 68, 20);
    expect(spies.onCustomDrag).toHaveBeenLastCalledWith({ kind: 'key', ti: 0, ki: 0 }, { x: 68, y: 20 });
  });

  it('marquee drag tracks the box live and hit-tests on release', () => {
    const { spies, start, marqueeText } = setup({
      drag: { kind: 'marquee', additive: true, x0: 10, y0: 20 }, x: 10, y: 20,
    });
    start();
    act(() => firePointer(window, 'pointermove', 60, 70)); // marquee box is React state — flush it
    expect(marqueeText()).toBe('10,20,60,70');
    act(() => firePointer(window, 'pointerup', 60, 70));
    // keysInBox called with anchor + release point; selection forwarded additive.
    expect(spies.keysInBox).toHaveBeenLastCalledWith({ x0: 10, y0: 20, x1: 60, y1: 70 });
    expect(spies.onMarqueeSelect).toHaveBeenCalledWith(['box:10-60'], true);
    expect(marqueeText()).toBe('none'); // box cleared on release
  });

  it('a view-specific (custom) drag kind routes to onCustomDrag with the local point (on movement)', () => {
    const { spies, start } = setup({ drag: { kind: 'in', ti: 1, ki: 2 }, x: 38, y: 44 });
    start();
    expect(spies.onCustomDrag).not.toHaveBeenCalled(); // waits for movement (no zero-move edit)
    firePointer(window, 'pointermove', 58, 24);
    expect(spies.onCustomDrag).toHaveBeenLastCalledWith(
      { kind: 'in', ti: 1, ki: 2 }, { x: 58, y: 24 },
    );
    firePointer(window, 'pointerup', 58, 24);
    // custom kinds are NOT treated as keys/marquee at release
    expect(spies.onEndKeyDrag).not.toHaveBeenCalled();
    expect(spies.onMarqueeSelect).not.toHaveBeenCalled();
  });

  it('after pointerup the drag is over — further moves are ignored', () => {
    const { spies, start } = setup({ drag: { kind: 'playhead' }, x: 28, y: 0 });
    start();
    firePointer(window, 'pointerup', 28, 0);
    const callsAfterUp = spies.onScrub.mock.calls.length;
    firePointer(window, 'pointermove', 98, 0);
    expect(spies.onScrub.mock.calls.length).toBe(callsAfterUp); // no new scrub
  });
});
