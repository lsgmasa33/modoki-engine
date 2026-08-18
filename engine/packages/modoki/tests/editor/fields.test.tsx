/** fields.tsx widget unit tests (editor-inspector Tests P1).
 *  fields.tsx is deliberately dependency-light (React only) so these run in jsdom
 *  with no editor/three/store transitive deps. Covers the pure wheel-step math and
 *  the useBufferedValue mixed-mode commit guard (F7 regression). */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, render, fireEvent } from '@testing-library/react';
import { useState } from 'react';
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

describe('BufferedNumberInput — dataUiId reaches the DOM', () => {
  // Bug y9WMNPkT0DivkxZKJDWU: a QA case aimed a CSS selector at the input's stale
  // `value` attribute, which stops matching the moment the value changes. The fix is a
  // stable `data-ui-id`; this confirms the prop actually lands on the rendered <input>
  // rather than only existing in the type signature.
  it('renders the id as data-ui-id when passed, and omits the attribute when not', () => {
    const { container: withId } = render(
      <BufferedNumberInput value={18.4} onChange={vi.fn()} dataUiId="inspector.field.Transform.x" />,
    );
    expect(withId.querySelector('input')!.getAttribute('data-ui-id')).toBe('inspector.field.Transform.x');

    const { container: withoutId } = render(<BufferedNumberInput value={18.4} onChange={vi.fn()} />);
    expect(withoutId.querySelector('input')!.hasAttribute('data-ui-id')).toBe(false);
  });
});


/** ⭐ **THE RE-SYNC MUST NOT CLOBBER A BUFFER MID-EDIT (#242).**
 *
 *  `useBufferedValue`'s anti-clobber guard used to be `focusedRef`, set from `onFocus` — and
 *  Chromium dispatches `focus`/`blur` only while `document.hasFocus()`. With the editor window not
 *  OS-focused (the permanent state of an agent-driven MCP session, and an ordinary one for a human
 *  with another window on top) no focus event ever lands, so the ECS re-sync ran mid-edit. What did
 *  the clobbering was the field's OWN commit: clearing it commits `parse('')` (0), the store echoes
 *  0 back, and the echo rewrote the empty buffer to '0' — so `-3.5` typed into a cleared field
 *  landed as '0-3.5' and stored 0, with the input tool reporting success. Measured on `games/sling`
 *  Lvl-0002 before the fix, and re-measured as `-3.5` after it.
 *
 *  ⚠️ **NOT ONE OF THESE MAY FIRE A FOCUS EVENT.** `fireEvent.focus` would restore the old guard
 *  and every test here would pass against the unfixed code — the bug IS the absence of that event.
 *  This is the same class as #233 (`qa/knowledge.md` §5: nothing in the editor may depend on a
 *  focus event firing). */
describe('useBufferedValue — the echo of our own commit is not an external change (#242)', () => {
  /** The Inspector's real shape: a parent owning the value, re-rendering the field with what the
   *  field just committed. Driving the hook alone cannot show the defect — the echo is the
   *  round-trip, so the round-trip has to be in the test. */
  function InspectorLikeField({ initial }: { initial: number }) {
    const [v, setV] = useState(initial);
    return (
      <>
        <BufferedNumberInput value={v} onChange={setV} />
        <output data-testid="committed">{String(v)}</output>
      </>
    );
  }

  /** The same harness with a clamping parse — `min`/`max` make `parse` non-injective, which is the
   *  one place the echo test cannot distinguish a reformat from a real change. */
  function ClampedField({ initial }: { initial: number }) {
    const [v, setV] = useState(initial);
    return (
      <>
        <BufferedNumberInput value={v} onChange={setV} min={0} max={1} />
        <output data-testid="committed">{String(v)}</output>
      </>
    );
  }

  it('⭐ a cleared field STAYS cleared, so the next keystrokes do not land on a re-synced 0', () => {
    const { container, getByTestId } = render(<InspectorLikeField initial={6.14} />);
    const input = container.querySelector('input')!;

    fireEvent.change(input, { target: { value: '' } }); // what clearFirst does

    expect(getByTestId('committed').textContent).toBe('0'); // the commit still happens...
    expect(input.value).toBe('');                          // ...and the echo does NOT rewrite it
  });

  it('⭐ the measured repro end to end: clear, then type -3.5, and get -3.5', () => {
    // ⚠️ **EACH KEYSTROKE APPENDS TO WHAT IS ACTUALLY IN THE FIELD** — `input.value + c`, not a
    // whole replacement value handed to `fireEvent`. That distinction IS the bug: a replacement
    // test passes against the unfixed code, because the corruption is the buffer the next keystroke
    // lands on. Unfixed, the clear re-syncs to '0' and this types '0-3.5', which parses to 0 — the
    // exact string `modoki_type_text` reported as `valueAfter` while claiming success.
    const { container, getByTestId } = render(<InspectorLikeField initial={6.14} />);
    const input = container.querySelector('input')!;

    fireEvent.change(input, { target: { value: '' } }); // clearFirst
    for (const c of '-3.5') fireEvent.change(input, { target: { value: input.value + c } });

    expect(input.value).toBe('-3.5');
    expect(getByTestId('committed').textContent).toBe('-3.5');
  });

  it('a GENUINE external change still re-syncs — a gizmo drag, an undo, a selection change', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useBufferedValue(v, vi.fn(), parseNumber),
      { initialProps: { v: 5 } },
    );
    act(() => result.current.handleChange('-3.5'));
    rerender({ v: 9.25 }); // not the echo of anything this field committed
    expect(result.current.localValue).toBe('9.25');
  });

  it('⚠️ a value dragged AWAY and BACK re-syncs — the staleness a last-committed ref would leave', () => {
    // The fix the issue sketched was "remember the value this field last committed and skip the
    // re-sync when `externalValue` equals it". It settles the same repro and goes stale here: the
    // remembered 5 matches forever, so the field would sit on '8' while the store held 5. Comparing
    // against what the DISPLAYED TEXT parses to has no such state to go stale.
    const { result, rerender } = renderHook(
      ({ v }) => useBufferedValue(v, vi.fn(), parseNumber),
      { initialProps: { v: 5 } },
    );
    act(() => result.current.handleChange('5'));
    rerender({ v: 8 });
    expect(result.current.localValue).toBe('8');
    rerender({ v: 5 }); // back to the value this field once committed
    expect(result.current.localValue).toBe('5');
  });

  it('⚠️ a CLAMPED field now keeps the typed text and diverges from the store until blur', () => {
    // ⚠️ **A DELIBERATE CONSEQUENCE OF THE ECHO GUARD, RECORDED SO IT IS A DECISION AND NOT A
    // SURPRISE.** `BufferedNumberInput`'s parse clamps, so it is not injective: '1.8' into a
    // max=1 field commits 1, and 1 is what '1.8' parses to — the echo test cannot tell that from
    // a reformat, so the display keeps '1.8' while the store holds 1. Before #242 an UNFOCUSED
    // window re-synced the display to '1' here; a focused one already behaved exactly as it does
    // now (`focusedRef` suppressed the same re-sync, and `onBlur` reconciled). So this ALIGNS the
    // two, which is the rule #233 exists for — focus must not change behaviour — and the cost is
    // that an agent-driven session, where blur never fires either, can read '1.8' off a field
    // whose stored value is 1. `modoki_get_scene_state` is the verification of record for exactly
    // this reason; the field is not it.
    const { container, getByTestId } = render(<ClampedField initial={0.2} />);
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: '1.8' } });
    expect(getByTestId('committed').textContent).toBe('1'); // the store gets the clamped truth
    expect(input.value).toBe('1.8');                        // ...the display keeps what was typed
  });

  it('entering MIXED mode still clears the buffer, even when it parses to the external value', () => {
    // The multi-select transition changes `mixed` without changing `externalValue`, and the field
    // must go empty so MIXED_PLACEHOLDER shows. The echo guard is gated on `!mixed` for this.
    const { result, rerender } = renderHook(
      ({ v, m }) => useBufferedValue(v, vi.fn(), parseNumber, m),
      { initialProps: { v: 6.14, m: false } },
    );
    expect(result.current.localValue).toBe('6.14');
    rerender({ v: 6.14, m: true });
    expect(result.current.localValue).toBe('');
  });
});
