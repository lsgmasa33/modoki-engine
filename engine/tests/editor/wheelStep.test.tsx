/** Mouse-wheel value adjustment for editor number inputs (jsdom):
 *  - applyWheelStep: pure step math (precision rounding + min/max clamp)
 *  - useWheelStep: non-passive wheel listener that only fires while focused, reports
 *    direction + Shift multiplier, and preventDefaults so the panel doesn't scroll. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { applyWheelStep, useWheelStep } from '@modoki/engine/editor';

describe('applyWheelStep', () => {
  it('steps up and down by the step size', () => {
    expect(applyWheelStep(5, 1, 1, 1)).toBe(6);
    expect(applyWheelStep(5, -1, 1, 1)).toBe(4);
  });

  it('rounds to the step precision (no float drift)', () => {
    expect(applyWheelStep(0.1, 1, 0.2, 1)).toBe(0.3);          // not 0.30000000000000004
    expect(applyWheelStep(0.3, -1, 0.1, 1)).toBe(0.2);
  });

  it('applies the multiplier (Shift = ×10)', () => {
    expect(applyWheelStep(0, 1, 0.5, 10)).toBe(5);
    expect(applyWheelStep(2, -1, 1, 10)).toBe(-8);
  });

  it('clamps to min and max', () => {
    expect(applyWheelStep(0, -1, 1, 1, 0, 1)).toBe(0);   // would be -1, clamped to min
    expect(applyWheelStep(1, 1, 1, 1, 0, 1)).toBe(1);    // would be 2, clamped to max
  });

  it('preserves negatives', () => {
    expect(applyWheelStep(-3, -1, 1, 1)).toBe(-4);
  });
});

/** Renders a single input wired with useWheelStep; reports each step via the spy. */
function Harness({ onStep, enabled = true }: { onStep: (d: 1 | -1, m: number) => void; enabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useWheelStep(ref, onStep, enabled);
  return <input ref={ref} defaultValue="0" />;
}

describe('useWheelStep', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('does not fire while the input is not focused', () => {
    const onStep = vi.fn();
    render(<Harness onStep={onStep} />);
    fireEvent.wheel(screen.getByRole('textbox'), { deltaY: -100 });
    expect(onStep).not.toHaveBeenCalled();
  });

  it('fires with +1 on wheel-up and -1 on wheel-down while focused', () => {
    const onStep = vi.fn();
    render(<Harness onStep={onStep} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.wheel(input, { deltaY: -100 }); // up
    expect(onStep).toHaveBeenLastCalledWith(1, 1);
    fireEvent.wheel(input, { deltaY: 100 });  // down
    expect(onStep).toHaveBeenLastCalledWith(-1, 1);
  });

  it('reports ×10 when Shift is held', () => {
    const onStep = vi.fn();
    render(<Harness onStep={onStep} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.focus();
    fireEvent.wheel(input, { deltaY: -100, shiftKey: true });
    expect(onStep).toHaveBeenLastCalledWith(1, 10);
  });

  it('preventDefaults the wheel so the panel does not scroll', () => {
    const onStep = vi.fn();
    render(<Harness onStep={onStep} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.focus();
    const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('does nothing when disabled', () => {
    const onStep = vi.fn();
    render(<Harness onStep={onStep} enabled={false} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.focus();
    fireEvent.wheel(input, { deltaY: -100 });
    expect(onStep).not.toHaveBeenCalled();
  });
});
