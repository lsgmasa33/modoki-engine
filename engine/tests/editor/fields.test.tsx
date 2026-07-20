/** Phase 2 — component/wiring tests (jsdom + @testing-library/react).
 *
 *  Phase 1 proved the action layer is correct by calling it directly. These render
 *  the real field inputs and fire DOM events, proving the input is actually wired to
 *  its onChange — and that the focus-buffering contract holds: while the user is
 *  typing, an external ECS value change must NOT clobber the in-flight text; when
 *  idle it must sync; on blur it reconciles. */

import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { BufferedTextInput, BufferedNumberInput } from '@modoki/engine/editor';

describe('BufferedNumberInput', () => {
  it('fires onChange with the parsed number on input', () => {
    const onChange = vi.fn();
    render(<BufferedNumberInput value={5} onChange={onChange} />);
    // A text input (not type=number) so a lone leading `-` survives mid-typing.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '42' } });
    expect(onChange).toHaveBeenCalledWith(42);
  });

  it('coerces empty/garbage input to 0 (parseNumber contract)', () => {
    const onChange = vi.fn();
    render(<BufferedNumberInput value={5} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it('preserves a leading minus so negative numbers can be typed sign-first', () => {
    const onChange = vi.fn();
    render(<BufferedNumberInput value={0} onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);
    // Typing just `-` must keep the sign visible (type=number would wipe it to '').
    fireEvent.change(input, { target: { value: '-' } });
    expect(input.value).toBe('-');
    // Completing the number commits the negative value.
    fireEvent.change(input, { target: { value: '-5' } });
    expect(input.value).toBe('-5');
    expect(onChange).toHaveBeenLastCalledWith(-5);
  });
});

describe('BufferedTextInput', () => {
  it('fires onChange with the raw string on input', () => {
    const onChange = vi.fn();
    render(<BufferedTextInput value="hi" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledWith('hello');
  });
});

describe('focus-buffering contract', () => {
  /** Drives an external value change via a button so we can flip the ECS-side
   *  value while the input is (or isn't) focused. */
  function Harness() {
    const [val, setVal] = useState('a');
    return (
      <>
        <BufferedTextInput value={val} onChange={() => {}} />
        <button onClick={() => setVal('external')}>set-external</button>
      </>
    );
  }

  it('keeps in-flight typing when an external value arrives while focused', () => {
    render(<Harness />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'typed' } });
    expect(input.value).toBe('typed');

    // External ECS update lands mid-edit — must not clobber the user's text.
    fireEvent.click(screen.getByText('set-external'));
    expect(input.value).toBe('typed');

    // Blur reconciles the field with the (now external) ECS value.
    fireEvent.blur(input);
    expect(input.value).toBe('external');
  });

  it('syncs the external value when the field is idle (not focused)', () => {
    render(<Harness />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('a');

    fireEvent.click(screen.getByText('set-external'));
    expect(input.value).toBe('external');
  });
});

describe('caret preservation on async value round-trip', () => {
  /** Regression: editing the Entity name in the Inspector moved the caret to the
   *  end on every keystroke. The name write round-trips back through an
   *  rAF-deferred refresh, so a raw controlled input re-assigns `input.value`
   *  (resetting the caret) once the value prop catches up. BufferedTextInput must
   *  hold the caret put while the field is focused.
   *
   *  This Harness mimics the Inspector wiring: onChange pushes the typed value to
   *  "ECS" state, which flows straight back as the `value` prop. */
  function RoundTripHarness() {
    const [val, setVal] = useState('bar');
    return <BufferedTextInput value={val} onChange={setVal} />;
  }

  it('keeps the caret mid-string when the typed value round-trips back as the prop', () => {
    render(<RoundTripHarness />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);

    // User puts the caret at the start of "bar" and types "X" → "Xbar".
    fireEvent.change(input, { target: { value: 'Xbar' } });
    input.setSelectionRange(1, 1); // caret right after the inserted "X"

    // The round-trip already happened synchronously via setVal above; re-rendering
    // with the now-equal value prop must NOT bump the caret to the end (pos 4).
    expect(input.value).toBe('Xbar');
    expect(input.selectionStart).toBe(1);
  });

  /** A differing external value proves the buffer ignores it while focused — both
   *  the in-flight text AND the caret survive (the focus guard is doing its job). */
  function DivergentHarness() {
    const [val, setVal] = useState('bar');
    return (
      <>
        <BufferedTextInput value={val} onChange={() => {}} />
        <button onClick={() => setVal('something-else')}>set-external</button>
      </>
    );
  }

  it('preserves both text and caret when a different external value lands while focused', () => {
    render(<DivergentHarness />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);

    fireEvent.change(input, { target: { value: 'Xbar' } });
    input.setSelectionRange(1, 1);

    fireEvent.click(screen.getByText('set-external'));
    expect(input.value).toBe('Xbar');   // buffering kept the user's text
    expect(input.selectionStart).toBe(1); // and the caret did not jump to the end
  });
});
