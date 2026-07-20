/** fields.tsx widget unit tests (editor-inspector Tests P1).
 *  fields.tsx is deliberately dependency-light (React only) so these run in jsdom
 *  with no editor/three/store transitive deps. Covers the pure wheel-step math and
 *  the useBufferedValue mixed-mode commit guard (F7 regression). */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, render, fireEvent } from '@testing-library/react';
import { applyWheelStep, useBufferedValue, parseNumber, clampRange, BufferedNumberInput } from '../../src/editor/panels/fields';

describe('applyWheelStep', () => {
  it('steps up/down by step × multiplier', () => {
    expect(applyWheelStep(1, 1, 0.1, 1)).toBe(1.1);
    expect(applyWheelStep(1, -1, 0.1, 1)).toBeCloseTo(0.9);
    expect(applyWheelStep(1, 1, 0.1, 10)).toBe(2); // shift = ×10
  });
  it('rounds to the step precision (no float drift)', () => {
    expect(applyWheelStep(0.1, 1, 0.2, 1)).toBe(0.3); // not 0.30000000000000004
  });
  it('clamps to min/max', () => {
    expect(applyWheelStep(0.95, 1, 0.1, 1, 0, 1)).toBe(1);
    expect(applyWheelStep(0.05, -1, 0.1, 1, 0, 1)).toBe(0);
  });
});

describe('useBufferedValue — mixed-mode commit guard (F7)', () => {
  it('does NOT broadcast on a transient empty string in mixed mode', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useBufferedValue(5, onChange, parseNumber, /* mixed */ true));
    act(() => result.current.handleChange('')); // type then backspace to empty
    expect(onChange).not.toHaveBeenCalled();    // no mass-overwrite to 0
    expect(result.current.localValue).toBe(''); // display still cleared
  });

  it('DOES broadcast once a real value is typed in mixed mode', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useBufferedValue(5, onChange, parseNumber, true));
    act(() => result.current.handleChange('3'));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('non-mixed mode still commits an empty string (parse fallback)', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useBufferedValue(5, onChange, parseNumber, false));
    act(() => result.current.handleChange(''));
    expect(onChange).toHaveBeenCalledWith(0); // parseNumber('') → 0
  });

  it('shows empty (placeholder) initial value in mixed mode, external value otherwise', () => {
    const mixedHook = renderHook(() => useBufferedValue(5, vi.fn(), parseNumber, true));
    expect(mixedHook.result.current.localValue).toBe('');
    const plainHook = renderHook(() => useBufferedValue(5, vi.fn(), parseNumber, false));
    expect(plainHook.result.current.localValue).toBe('5');
  });
});

describe('clampRange', () => {
  it('clamps to min and max independently', () => {
    expect(clampRange(1.5, 0, 1)).toBe(1);
    expect(clampRange(-0.3, 0, 1)).toBe(0);
    expect(clampRange(0.4, 0, 1)).toBe(0.4);
  });
  it('leaves an unbounded side alone', () => {
    expect(clampRange(999, 0, undefined)).toBe(999); // no max
    expect(clampRange(-999, undefined, 1)).toBe(-999); // no min
    expect(clampRange(5, undefined, undefined)).toBe(5);
  });
});

describe('BufferedNumberInput — min/max cap on commit', () => {
  it('caps a typed over-max value (e.g. glowSize past its budget)', () => {
    const onChange = vi.fn();
    const { container } = render(<BufferedNumberInput value={0.2} onChange={onChange} min={0} max={1} />);
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: '1.8' } });
    expect(onChange).toHaveBeenLastCalledWith(1); // clamped to max, not 1.8
  });
  it('caps a typed under-min value', () => {
    const onChange = vi.fn();
    const { container } = render(<BufferedNumberInput value={0.2} onChange={onChange} min={0} max={1} />);
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: '-5' } });
    expect(onChange).toHaveBeenLastCalledWith(0); // clamped to min
  });
  it('passes an in-range value through unchanged', () => {
    const onChange = vi.fn();
    const { container } = render(<BufferedNumberInput value={0.2} onChange={onChange} min={0} max={1} />);
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: '0.6' } });
    expect(onChange).toHaveBeenLastCalledWith(0.6);
  });
});
