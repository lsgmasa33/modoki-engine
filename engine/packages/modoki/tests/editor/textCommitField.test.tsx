/** TextCommitField (VideoAssetView) — the "Remote URL" text field, and the same class of
 *  component elsewhere in this sweep.
 *
 *  #233: same class of bug as `RenameInput` (fixed in `a03249ca`). Chromium only dispatches
 *  focus/blur while `document.hasFocus()` — with the editor window not OS-focused (the
 *  permanent state of an agent-driven session, and an ordinary one for a human), Enter's old
 *  `.blur()` → `onBlur`-commits chain silently never ran, and the `onFocus`-driven `focused`
 *  gate on the resync effect never engaged either. Enter now commits DIRECTLY, and the
 *  in-progress-edit tracking is driven by `onChange` instead of `onFocus`; Escape reverts
 *  directly rather than relying on the blur it also triggers.
 *
 *  These tests never simulate a focus event landing — same technique as
 *  `renameInput.test.tsx` — because jsdom otherwise dispatches focus/blur eagerly and would
 *  let a reverted, still-broken component pass anyway. */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { TextCommitField } from '../../src/editor/panels/assetViews/VideoAssetView';

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

function setup(value = '') {
  const onCommit = vi.fn();
  const { container, rerender } = render(<TextCommitField label="URL" value={value} onCommit={onCommit} />);
  const input = container.querySelector('input') as HTMLInputElement;
  return { input, onCommit, rerender };
}

describe('TextCommitField', () => {
  it('re-commits a value it committed before, once the value changed externally (latch reset)', () => {
    // Same reasoning as numBox.test.tsx: the latch exists only to swallow Enter's trailing
    // blur in the same synchronous tick. Reselecting the asset (or an undo) can restore the
    // old value, and re-typing the previous one must commit again rather than compare equal
    // to a stale latch and silently do nothing.
    const onCommit = vi.fn();
    const el = (v: string) => <TextCommitField label="URL" value={v} onCommit={onCommit} />;
    const { container, rerender } = render(el('a'));
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'b' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenNthCalledWith(1, 'b');

    rerender(el('b'));
    rerender(el('a'));

    fireEvent.change(input, { target: { value: 'b' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenNthCalledWith(2, 'b');
  });

  it('commits on Enter DIRECTLY — no blur involved', () => {
    const { input, onCommit } = setup('');
    fireEvent.change(input, { target: { value: 'https://example.com/a.mp4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('https://example.com/a.mp4');
  });

  it('Enter with an unchanged value does not call onCommit — a repeat commit is a no-op', () => {
    const { input, onCommit } = setup('https://example.com/a.mp4');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('still commits on blur — that is the click-away path', () => {
    const { input, onCommit } = setup('');
    fireEvent.change(input, { target: { value: 'https://example.com/a.mp4' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('https://example.com/a.mp4');
  });

  it('fires at most ONCE across the Enter → blur sequence a real gesture produces', () => {
    // ⚠️ This assertion does NOT on its own discriminate fixed-from-broken: under the
    // pre-#233 component the stubbed no-op blur() swallowed Enter entirely, so only the
    // explicit fireEvent.blur below committed — also exactly once. It pins the ABSENCE of a
    // double commit, which is what the idempotency latch exists for; the "commits on Enter
    // DIRECTLY" test above is the one that catches a revert.
    const { input, onCommit } = setup('');
    fireEvent.change(input, { target: { value: 'https://example.com/a.mp4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input); // the browser's own blur, arriving after the commit
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('Escape reverts the field DIRECTLY, without depending on the blur it also triggers', () => {
    const { input, onCommit } = setup('https://example.com/a.mp4');
    fireEvent.change(input, { target: { value: 'garbage' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('https://example.com/a.mp4');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not clobber an in-progress edit when the external value changes underneath it — the resync gate is NOT keyed off onFocus', () => {
    const { input, onCommit, rerender } = setup('https://example.com/a.mp4');
    fireEvent.change(input, { target: { value: 'https://example.com/b.mp4' } });
    rerender(<TextCommitField label="URL" value="https://example.com/c.mp4" onCommit={onCommit} />);
    expect(input.value).toBe('https://example.com/b.mp4');
  });
});

/** The OTHER window state. Every test above stubs focus/blur into non-dispatching no-ops to model
 *  `document.hasFocus() === false` — which is the #233 condition, and which by construction cannot
 *  see a bug that only exists when blur REALLY fires. This block models a genuinely OS-focused
 *  window: `.blur()` dispatches synchronously, from inside the keydown handler, BEFORE React has
 *  flushed anything the handler scheduled. */
describe('TextCommitField — window genuinely focused (blur really dispatches)', () => {
  let realBlur: () => void;
  beforeEach(() => {
    realBlur = HTMLElement.prototype.blur;
    HTMLElement.prototype.blur = function (this: HTMLElement) {
      // React attaches onBlur to the focusout event; dispatch synchronously, as Chromium does.
      this.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    };
  });
  afterEach(() => { HTMLElement.prototype.blur = realBlur; cleanup(); });

  it('Escape does not commit the discarded text', () => {
    // Escape schedules a React revert (setLocal(value)) and then blurs on the next line. With a
    // real focused window that blur fires BEFORE React flushes the revert, so a commit path that
    // reads state — or reads a DOM node the revert has not reached yet — persists the very text
    // the user just discarded. The field then repaints as reverted, so it LOOKS like Escape worked.
    const onCommit = vi.fn();
    const { container } = render(<TextCommitField label="URL" value="orig" onCommit={onCommit} />);
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'garbage' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('orig');
  });

  it('Enter still commits exactly once when blur really fires', () => {
    const onCommit = vi.fn();
    const { container } = render(<TextCommitField label="URL" value="orig" onCommit={onCommit} />);
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'next' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('next');
  });
});
