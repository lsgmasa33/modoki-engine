/** NumBox (AnimationToolbar) — the small numeric field used by the toolbar's Samples/Len
 *  fields and the frame field.
 *
 *  #233: same class of bug as `RenameInput` (fixed in `a03249ca`). Chromium only dispatches
 *  focus/blur while `document.hasFocus()` — with the editor window not OS-focused (the
 *  permanent state of an agent-driven session, and an ordinary one for a human), Enter's old
 *  `.blur()` → `onBlur`-commits chain silently never ran, and the `onFocus`-driven `focused`
 *  gate on the resync effect never engaged either (so an external `value` change could stomp
 *  an in-progress edit without anyone noticing). Enter now commits DIRECTLY, and the
 *  in-progress-edit tracking is driven by `onChange` instead of `onFocus`.
 *
 *  These tests never simulate a focus event landing — same technique as
 *  `renameInput.test.tsx` — because jsdom otherwise dispatches focus/blur eagerly and would
 *  let a reverted, still-broken component pass anyway. */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { NumBox } from '../../src/editor/panels/animation/AnimationToolbar';

/** Model the measured Chromium behaviour: with `document.hasFocus() === false`, `focus()`
 *  and `blur()` still move `document.activeElement` but dispatch NO events. */
let realFocus: () => void;
let realBlur: () => void;
beforeEach(() => {
  realFocus = HTMLElement.prototype.focus;
  realBlur = HTMLElement.prototype.blur;
  HTMLElement.prototype.focus = function () { /* activeElement would move; no event fires */ };
  HTMLElement.prototype.blur = function () { /* likewise */ };
});
afterEach(() => {
  HTMLElement.prototype.focus = realFocus;
  HTMLElement.prototype.blur = realBlur;
  cleanup();
});

function setup(value = 5, extra: { min?: number; step?: number } = {}) {
  const onSet = vi.fn();
  const { container, rerender } = render(<NumBox value={value} onSet={onSet} width={40} {...extra} />);
  const input = container.querySelector('input') as HTMLInputElement;
  return { input, onSet, rerender };
}

describe('NumBox', () => {
  it('re-commits a value it committed before, once the value changed externally (latch reset)', () => {
    // The idempotency latch that swallows Enter's trailing blur must not outlive that
    // synchronous window. Undo (or the playhead, or another panel) can put `value` back to
    // what it was, and typing the SAME number again must commit again — a latch held across
    // renders would compare equal and silently do nothing, reintroducing #233's own symptom
    // through its fix.
    const onSet = vi.fn();
    const el = (v: number) => <NumBox value={v} onSet={onSet} width={40} />;
    const { container, rerender } = render(el(5));
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSet).toHaveBeenNthCalledWith(1, 10);

    rerender(el(10));  // the parent accepted it…
    rerender(el(5));   // …then something external put it back (an undo).

    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSet).toHaveBeenNthCalledWith(2, 10);
  });

  it('commits on Enter DIRECTLY — no blur involved', () => {
    const { input, onSet } = setup(5);
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSet).toHaveBeenCalledWith(9);
  });

  it('Enter with an unchanged value does not call onSet — a repeat commit is a no-op', () => {
    const { input, onSet } = setup(5);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSet).not.toHaveBeenCalled();
  });

  it('still commits on blur — that is the click-away path', () => {
    // Dispatched explicitly rather than via blur(): a real click-away only happens while the
    // window IS focused, which is exactly when the browser does deliver the event.
    const { input, onSet } = setup(5);
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.blur(input);
    expect(onSet).toHaveBeenCalledWith(9);
  });

  it('fires at most ONCE across the Enter → blur sequence a real gesture produces', () => {
    // ⚠️ This assertion does NOT on its own discriminate fixed-from-broken: under the
    // pre-#233 component the stubbed no-op blur() swallowed Enter entirely, so only the
    // explicit fireEvent.blur below committed — also exactly once. It pins the ABSENCE of a
    // double commit, which is what the idempotency latch exists for; the "commits on Enter
    // DIRECTLY" test above is the one that catches a revert.
    const { input, onSet } = setup(5);
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input); // the browser's own blur, arriving after the commit
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it('clamps to min on commit', () => {
    const { input, onSet } = setup(5, { min: 0 });
    fireEvent.change(input, { target: { value: '-3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSet).toHaveBeenCalledWith(0);
  });

  it('reverts to the last known value on invalid input, without calling onSet', () => {
    const { input, onSet } = setup(5);
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSet).not.toHaveBeenCalled();
    expect(input.value).toBe('5');
  });

  it('resyncs local text to an external value change when not mid-edit', () => {
    const { input, onSet, rerender } = setup(5);
    rerender(<NumBox value={7} onSet={onSet} width={40} />);
    expect(input.value).toBe('7');
  });

  it('does not clobber an in-progress edit when the external value changes underneath it — the resync gate is NOT keyed off onFocus', () => {
    // The old `focused` gate depended on `onFocus`, which never fires in an unfocused
    // window, so an external `value` change mid-edit would silently stomp the user's
    // keystroke. `editingRef` is set from `onChange` instead, which fires regardless.
    const { input, onSet, rerender } = setup(5);
    fireEvent.change(input, { target: { value: '9' } });
    rerender(<NumBox value={7} onSet={onSet} width={40} />);
    expect(input.value).toBe('9');
  });
});
