/** `createCoalescedEdit` — the undo-step coalescer behind the Sprite Editor's
 *  commit-per-keystroke fields (#244).
 *
 *  The bug it replaces was invisible to a unit test because it lived in a focus EVENT:
 *  the snapshot was taken in `onFocus`, which Chromium never dispatches while the window
 *  is not OS-focused, so nothing was ever pushed. These tests pin the replacement's two
 *  load-bearing properties — a session opens on the first CHANGE, and it is closed by
 *  signals that don't depend on focus (an idle timer, or an explicit flush from anything
 *  else that touches the history). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCoalescedEdit, DEFAULT_COALESCE_MS } from '../../src/editor/panels/coalescedEdit';

/** A stand-in for the editor: one number of state, one undo stack. */
function harness(idleMs?: number) {
  const state = { v: 0 };
  const pushed: number[] = [];
  const edit = createCoalescedEdit<number>({
    take: () => state.v,
    same: (a, b) => a === b,
    push: (before) => { pushed.push(before); },
    ...(idleMs === undefined ? {} : { idleMs }),
  });
  /** What a field's onChange does: note BEFORE mutating, so the snapshot is pre-edit. */
  const type = (v: number) => { edit.note(); state.v = v; };
  return { state, pushed, edit, type };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('createCoalescedEdit', () => {
  it('pushes the PRE-edit value once for a run of keystrokes', () => {
    const { pushed, type } = harness();
    type(1); type(12); type(123);
    expect(pushed).toEqual([]);            // nothing committed mid-run
    vi.advanceTimersByTime(DEFAULT_COALESCE_MS);
    expect(pushed).toEqual([0]);           // one entry, the value before the run
  });

  it('re-arms the idle timer on every keystroke, so a fast run stays one entry', () => {
    const { pushed, type } = harness(100);
    type(1);
    vi.advanceTimersByTime(80);
    type(2);
    vi.advanceTimersByTime(80);            // 160ms total, but only 80 since the last change
    expect(pushed).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(pushed).toEqual([0]);
  });

  it('starts a NEW session after a commit', () => {
    const { pushed, type } = harness(100);
    type(5);
    vi.advanceTimersByTime(100);
    type(9);
    vi.advanceTimersByTime(100);
    expect(pushed).toEqual([0, 5]);
  });

  it('pushes nothing when the value ends up unchanged', () => {
    const { pushed, edit, type } = harness(100);
    type(7);
    type(0);                               // typed back to where it started
    vi.advanceTimersByTime(100);
    expect(pushed).toEqual([]);
    expect(edit.pending()).toBe(false);
  });

  it('flush() commits immediately — this is what undo/redo must call first (#244)', () => {
    const { pushed, edit, type } = harness();
    type(3);
    expect(edit.pending()).toBe(true);
    edit.flush();
    expect(pushed).toEqual([0]);           // the entry exists BEFORE the stack is popped
  });

  it('typing after a flush opens a FRESH session, from the flushed value', () => {
    const { pushed, edit, type } = harness();
    type(3);
    edit.flush();
    type(4);
    vi.advanceTimersByTime(DEFAULT_COALESCE_MS);
    expect(pushed).toEqual([0, 3]);        // two steps, second starting where the first ended
  });

  // NOTE: `flush()`'s own `clearTimeout` is deliberately NOT pinned — mutation-checked
  // 2026-08-19 and it is UNOBSERVABLE. A timer left armed by a flush is either disarmed by
  // the next `note()` (which clears before re-arming) or fires into `start === null` and
  // no-ops. The line stays because leaving a timer pending for nothing is untidy, not
  // because behaviour depends on it — so no test claims otherwise.

  it('flush() with no open session is a no-op, however often it is called', () => {
    const { pushed, edit } = harness();
    edit.flush(); edit.flush();
    expect(pushed).toEqual([]);
  });

  it('cancel() drops the pending session and its timer (unmount)', () => {
    const { pushed, edit, type } = harness();
    type(2);
    edit.cancel();
    vi.advanceTimersByTime(DEFAULT_COALESCE_MS * 10);
    expect(pushed).toEqual([]);
    expect(edit.pending()).toBe(false);
  });

  it('idleMs: 0 disables the timer — flush-only', () => {
    const { pushed, edit, type } = harness(0);
    type(1);
    vi.advanceTimersByTime(60_000);
    expect(pushed).toEqual([]);
    edit.flush();
    expect(pushed).toEqual([0]);
  });

  it('snapshots by VALUE at note() time, not by reference at flush() time', () => {
    // The real snapshot is an object the editor keeps mutating around; a coalescer that
    // stored a live reference would compare it against itself and never push.
    const state = { v: { cols: 4 } };
    const pushed: { cols: number }[] = [];
    const edit = createCoalescedEdit<{ cols: number }>({
      take: () => ({ ...state.v }),
      same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      push: (before) => { pushed.push(before); },
    });
    edit.note();
    state.v = { cols: 8 };
    edit.flush();
    expect(pushed).toEqual([{ cols: 4 }]);
  });
});
