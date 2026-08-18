/** RenameInput — the inline rename field shared by the Hierarchy + Assets panels.
 *
 *  QA-ASSET-0004. Both of the things this component did through FOCUS EVENTS were broken,
 *  and jsdom is exactly the right place to pin them because jsdom — like a Chromium window
 *  that lacks OS focus — does not give you the browser's focus choreography for free.
 *
 *  The live failure (measured 2026-08-18 against a running editor): Chromium dispatches
 *  `focus`/`blur` only while `document.hasFocus()`. With the editor window behind another
 *  window — the normal state of any agent-driven session, and an ordinary one for a human —
 *  `el.focus()`/`el.blur()` still move `document.activeElement` but fire NO events. So:
 *    - Enter called `blur()` and let `onBlur` do the commit → the rename silently did nothing
 *      and left the field mounted forever, immune to Enter, Escape, blur and click-away alike.
 *    - `autoFocus` + `onFocus={select}` left the field focused with NOTHING selected, so typing
 *      appended to the old name instead of replacing it.
 *
 *  These tests therefore never simulate a focus event: they assert Enter and Escape act on
 *  their own, and that the selection is made imperatively at mount. */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import RenameInput from '../../src/editor/components/RenameInput';

/** Model the measured Chromium behaviour: with `document.hasFocus() === false`, `focus()` and
 *  `blur()` still move `document.activeElement` but dispatch NO events.
 *
 *  Without this the tests do not discriminate — jsdom dispatches focus/blur eagerly and
 *  happily, so the OLD component passes every assertion below on the strength of behaviour the
 *  real browser was not providing. That is the whole failure mode: a green suite over a
 *  gesture that was completely non-functional in the app. */
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

function setup(initial = 'hero') {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const { container } = render(<RenameInput initial={initial} onCommit={onCommit} onCancel={onCancel} />);
  const input = container.querySelector('input')!;
  return { input, onCommit, onCancel };
}

describe('RenameInput', () => {
  it('selects its whole contents at MOUNT, without waiting for a focus event', () => {
    // The old component selected from `onFocus`, which never fires in this state — so the
    // field came up focused with nothing selected and typing APPENDED to the old name.
    const { input } = setup('hero');
    expect(input.value).toBe('hero');
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]);
  });

  it('commits on Enter DIRECTLY — no blur involved', () => {
    // The old component called blur() here and let onBlur commit. With no blur event, that
    // meant nothing happened at all, and the field stayed mounted forever.
    const { input, onCommit, onCancel } = setup('hero');
    input.value = 'villain';
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('villain');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Enter with an UNCHANGED value cancels rather than committing a no-op rename', () => {
    const { input, onCommit, onCancel } = setup('hero');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('Enter with a blank/whitespace value cancels — an empty name is never a rename', () => {
    const { input, onCommit, onCancel } = setup('hero');
    input.value = '   ';
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('trims before committing', () => {
    const { input, onCommit } = setup('hero');
    input.value = '  villain  ';
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('villain');
  });

  it('Escape cancels and locks out the later blur, so click-away cannot resurrect the commit', () => {
    const { input, onCommit, onCancel } = setup('hero');
    input.value = 'villain';
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('still commits on blur — that is the click-away path', () => {
    // Dispatched explicitly rather than via blur(): a real click-away only happens while the
    // window IS focused, which is exactly when the browser does deliver the event.
    const { input, onCommit } = setup('hero');
    input.value = 'villain';
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('villain');
  });

  it('fires at most ONCE across the Enter → blur sequence a real gesture produces', () => {
    const { input, onCommit } = setup('hero');
    input.value = 'villain';
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);   // the browser's own blur, arriving after the commit
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
