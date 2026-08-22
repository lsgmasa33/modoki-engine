/** ErrorToaster — shows a sliding toast on console.error, auto-dismisses after 3s
 *  (Phase 4.6). Fed by the debug console-capture.
 *
 *  ⚠️ Every `console.error` here is wrapped in an ASYNC `act`, because the capture store notifies
 *  its subscribers on a microtask rather than synchronously. That is deliberate: a synchronous
 *  notify reaches `useSyncExternalStore` from inside whatever render is in progress, which is a
 *  setState during another component's render — React logs "Cannot update a component
 *  (`ErrorToaster`) while rendering a different component" for it, turning one intentional warning
 *  into a warning plus a scary React error (bug `mfAJ8yTNTqOQbU3sqY46`). A synchronous `act` here
 *  would be pinning the buggy timing. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import {
  installConsoleCapture, __resetConsoleCaptureForTest, subscribeConsole, getConsoleVersion,
} from '../../packages/modoki/src/runtime/debug/consoleCapture';
import { ErrorToaster } from '../../packages/modoki/src/runtime/debug/ErrorToaster';

beforeEach(() => {
  installConsoleCapture();
  __resetConsoleCaptureForTest();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ErrorToaster', () => {
  it('shows a toast on console.error and auto-dismisses after 3s', async () => {
    vi.useFakeTimers();
    const { queryByText } = render(<ErrorToaster anchor="viewport" />);
    // queueMicrotask survives fake timers, which is part of why the store uses it.
    await act(async () => {
      console.error('boom-error');
    });
    expect(queryByText('boom-error')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(queryByText('boom-error')).toBeNull();
  });

  it('dismisses on click', async () => {
    const { queryByText, getByText } = render(<ErrorToaster anchor="viewport" />);
    await act(async () => {
      console.error('click-to-dismiss');
    });
    fireEvent.click(getByText('click-to-dismiss'));
    expect(queryByText('click-to-dismiss')).toBeNull();
  });

  it('ignores non-error console output', async () => {
    const { queryByText } = render(<ErrorToaster anchor="viewport" />);
    await act(async () => {
      console.log('just-a-log');
      console.warn('just-a-warn');
    });
    expect(queryByText('just-a-log')).toBeNull();
    expect(queryByText('just-a-warn')).toBeNull();
  });

  it('does not toast errors that predate mount', async () => {
    console.error('pre-existing');
    const { queryByText } = render(<ErrorToaster anchor="viewport" />);
    await act(async () => {});
    expect(queryByText('pre-existing')).toBeNull();
  });

  it('a throwing listener does not escape the flush, and does not stop the others', async () => {
    // Found by the close-out review. The notify loop used to run inside `record()`, which
    // `installConsoleCapture` wraps in "never let capture break logging" — deferring it to a
    // microtask moved it OUT of that try, so a throwing listener went from a silent no-op to an
    // uncaught exception. Swallowed per-listener now, and reported through the ORIGINAL
    // console.error so it cannot recurse into the capture it is mid-flush of.
    const reached: string[] = [];
    const unsubA = subscribeConsole(() => { throw new Error('listener exploded'); });
    const unsubB = subscribeConsole(() => reached.push('b'));
    console.warn('throwing-listener-probe');
    await act(async () => {});
    expect(reached).toEqual(['b']);
    unsubA(); unsubB();
  });

  it('does NOT notify its subscriber synchronously from the console call', async () => {
    // The regression guard for `mfAJ8yTNTqOQbU3sqY46`. A subscriber called inside the
    // `console.error` frame is a setState during whatever render is on the stack — and the
    // trigger is ordinary: `UINode` warns during its own render when an `imageSrc` points at a
    // 3d-typed KTX2 texture, which produced the warn and React's complaint in the same
    // millisecond. The VERSION must still move immediately, or `useSyncExternalStore` would
    // read a stale snapshot and tear.
    const seen: string[] = [];
    const unsub = subscribeConsole(() => seen.push('notified'));
    const before = getConsoleVersion();
    console.error('sync-notify-probe');
    expect(seen).toEqual([]);                       // not yet — we are still in the same task
    expect(getConsoleVersion()).toBeGreaterThan(before);
    await act(async () => {});
    expect(seen).toEqual(['notified']);             // ...and exactly once, coalesced
    unsub();
  });
});
