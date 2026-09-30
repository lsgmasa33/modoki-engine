/** The Animation panel's `NumBox` (clip Samples/Len, selected key frame/value) ends its edit on an
 *  undo or redo (#1905). It commits on blur/Enter, so before this the blur after a Cmd+Z committed
 *  the typed text on top of the undo — observed by a live revert-run (Samples 24 → typed 60 → Cmd+Z →
 *  the field kept `60`, and the blur committed 60). */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { NumBox } from '../../src/editor/panels/animation/AnimationToolbar';
import { pushAction, undo, clearHistory } from '../../src/editor/undo/undoManager';
import { setRunMode } from '../../src/runtime/core/playState';

beforeEach(() => { setRunMode('stopped'); clearHistory(); });

let setStore!: (v: number) => void;
function Samples({ onSet }: { onSet: (v: number) => void }) {
  const [v, setV] = useState(24);
  setStore = setV;
  return <NumBox value={v} min={1} step={1} width={42} onSet={onSet} />;
}

describe('NumBox — an undo or redo ends the edit (#1905)', () => {
  it('⭐ Cmd+Z mid-edit drops the uncommitted text, and the blur commits nothing', async () => {
    const onSet = vi.fn();
    const { container } = render(<Samples onSet={onSet} />);
    const input = container.querySelector('input')!;
    input.focus();
    fireEvent.change(input, { target: { value: '60' } }); // typed, not committed
    pushAction({ label: 'animation frameRate', undo: () => setStore(30), redo: () => setStore(24) });

    await act(async () => { await undo(); });
    expect(input.value).toBe('30');

    fireEvent.blur(input);
    expect(onSet).not.toHaveBeenCalled();
    expect(input.value).toBe('30');
  });

  it('the undone value landing a render AFTER the step still shows, and the blur commits nothing', async () => {
    // At the notification `value` is still 24; ending the edit (not just re-setting the text) is what
    // lets the 30 through when it lands. Held back, the blur would commit the stale 24 over it.
    const onSet = vi.fn();
    const { container } = render(<Samples onSet={onSet} />);
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: '60' } });
    pushAction({ label: 'animation frameRate', undo: () => { setTimeout(() => setStore(30), 0); }, redo: () => {} });

    await act(async () => { await undo(); await new Promise((r) => setTimeout(r, 5)); });
    expect(input.value).toBe('30');
    fireEvent.blur(input);
    expect(onSet).not.toHaveBeenCalled();
  });

  it('typing after the undo is a new edit: Enter commits it', async () => {
    const onSet = vi.fn();
    const { container } = render(<Samples onSet={onSet} />);
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: '60' } });
    pushAction({ label: 'animation frameRate', undo: () => setStore(30), redo: () => {} });
    await act(async () => { await undo(); });

    fireEvent.change(input, { target: { value: '48' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSet).toHaveBeenCalledWith(48);
  });
});
