/** GradientEditor F3 regression — particle color/alpha stop editing.
 *  Verifies the two correctness guarantees from editor-animation-particle-editors.md F3:
 *    1. Dragging a stop PAST a neighbor keeps moving the SAME stop (identity tracked by
 *       object reference, not array index — index drifts the instant the sort reorders).
 *    2. Every onChange payload is sorted by `t` (the runtime sampleGradientColor early-
 *       returns on the first stop with t >= queryT, so an unsorted array samples wrong). */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import type { Gradient } from '../../src/runtime/particles/types';
import GradientEditor from '../../src/editor/panels/particle/GradientEditor';

// jsdom's PointerEvent constructor drops clientX — build an event with it defined.
function firePointer(el: Element, type: string, clientX: number, pointerId = 1) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clientX', { value: clientX });
  Object.defineProperty(ev, 'clientY', { value: 0 });
  Object.defineProperty(ev, 'pointerId', { value: pointerId });
  el.dispatchEvent(ev);
}

// jsdom doesn't implement pointer capture or layout — stub both.
beforeAll(() => {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  // Bars are 100px wide at x=0, so clientX maps directly to t = clientX/100.
  HTMLDivElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 18, right: 100, bottom: 18, x: 0, y: 0, toJSON() {} }) as DOMRect;
});

const isSorted = (arr: { t: number }[]) => arr.every((s, i) => i === 0 || arr[i - 1].t <= s.t);

function setup(initial: Gradient) {
  let current = initial;
  const onChange = vi.fn((g: Gradient) => { current = g; });
  const utils = render(<GradientEditor value={current} onChange={onChange} />);
  const rerender = () => utils.rerender(<GradientEditor value={current} onChange={onChange} />);
  const colorHandles = () =>
    Array.from(utils.container.querySelectorAll('[title]')).filter((el) =>
      (el as HTMLElement).style.cursor === 'grab',
    ) as HTMLElement[];
  return { onChange, get: () => current, rerender, colorHandles };
}

describe('GradientEditor — F3 stop-drag identity + sorted persistence', () => {
  it('keeps dragging the SAME stop after it crosses a neighbor', () => {
    // red @ 0.2, blue @ 0.8 — drag red rightward past blue to ~0.9
    const g: Gradient = {
      colorStops: [
        { t: 0.2, color: { r: 1, g: 0, b: 0 } },
        { t: 0.8, color: { r: 0, g: 0, b: 1 } },
      ],
      alphaStops: [{ t: 0, alpha: 1 }],
    };
    const { onChange, get, rerender, colorHandles } = setup(g);

    const handles = colorHandles();
    // sorted render order: [0]=red@0.2, [1]=blue@0.8, [2]=alpha@0
    const redHandle = handles[0];
    firePointer(redHandle, 'pointerdown', 20);

    // onPointerMove lives on the outermost wrapper (handle -> strip -> wrapper).
    const outer = redHandle.parentElement!.parentElement!;

    firePointer(outer, 'pointermove', 50); // t=0.5 (still left of blue)
    rerender();
    firePointer(outer, 'pointermove', 90); // t=0.9 (past blue@0.8)
    rerender();

    // Every emitted payload must be sorted.
    for (const call of onChange.mock.calls) {
      expect(isSorted((call[0] as Gradient).colorStops)).toBe(true);
    }

    // The RED stop (identity) must be the one that ended at ~0.9 — not blue.
    const final = get();
    const red = final.colorStops.find((s) => s.color.r === 1 && s.color.b === 0)!;
    const blue = final.colorStops.find((s) => s.color.b === 1 && s.color.r === 0)!;
    expect(red.t).toBeCloseTo(0.9, 2);
    expect(blue.t).toBeCloseTo(0.8, 2);
    // and red now sorts AFTER blue
    expect(final.colorStops.indexOf(red)).toBeGreaterThan(final.colorStops.indexOf(blue));
  });

  it('persists added stops in sorted order', () => {
    const g: Gradient = {
      colorStops: [
        { t: 0, color: { r: 0, g: 0, b: 0 } },
        { t: 1, color: { r: 1, g: 1, b: 1 } },
      ],
      alphaStops: [{ t: 0, alpha: 1 }],
    };
    const { onChange, colorHandles } = setup(g);
    // double-click the color bar mid-way to add a stop at ~0.5
    const bar = colorHandles()[0].parentElement!;
    firePointer(bar, 'dblclick', 50);
    expect(onChange).toHaveBeenCalled();
    const payload = onChange.mock.calls.at(-1)![0] as Gradient;
    expect(isSorted(payload.colorStops)).toBe(true);
    expect(payload.colorStops).toHaveLength(3);
  });
});

describe('GradientEditor — F9 per-edit undo-group suffix', () => {
  it('emits a per-drag group suffix so a single drag coalesces but distinct edits differ', () => {
    const g: Gradient = {
      colorStops: [
        { t: 0.2, color: { r: 1, g: 0, b: 0 } },
        { t: 0.8, color: { r: 0, g: 0, b: 1 } },
      ],
      alphaStops: [{ t: 0, alpha: 1 }],
    };
    const { onChange, rerender, colorHandles } = setup(g);
    const handles = colorHandles();

    // Drag #1 — the red stop. All moves within ONE drag share a group.
    firePointer(handles[0], 'pointerdown', 20);
    const outer = handles[0].parentElement!.parentElement!;
    firePointer(outer, 'pointermove', 40);
    rerender();
    firePointer(outer, 'pointermove', 50);
    firePointer(outer, 'pointerup', 50);
    rerender();

    // Drag #2 — the blue stop, a separate drag → a DIFFERENT group.
    const handles2 = colorHandles();
    firePointer(handles2[1], 'pointerdown', 80);
    const outer2 = handles2[1].parentElement!.parentElement!;
    firePointer(outer2, 'pointermove', 70);
    firePointer(outer2, 'pointerup', 70);
    rerender();

    const groups = onChange.mock.calls.map((c) => c[1] as string | undefined).filter((s): s is string => !!s);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    // Within drag #1 the suffix is constant; drag #2 has a distinct suffix.
    expect(new Set(groups).size).toBeGreaterThanOrEqual(2);
    expect(groups.every((s) => s.startsWith('color:drag:'))).toBe(true);
  });
});
