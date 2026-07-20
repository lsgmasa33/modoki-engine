/** ErrorToaster — shows a sliding toast on console.error, auto-dismisses after 3s
 *  (Phase 4.6). Fed by the debug console-capture. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { installConsoleCapture, __resetConsoleCaptureForTest } from '../../packages/modoki/src/runtime/debug/consoleCapture';
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
  it('shows a toast on console.error and auto-dismisses after 3s', () => {
    vi.useFakeTimers();
    const { queryByText } = render(<ErrorToaster anchor="viewport" />);
    act(() => {
      console.error('boom-error');
    });
    expect(queryByText('boom-error')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(queryByText('boom-error')).toBeNull();
  });

  it('dismisses on click', () => {
    const { queryByText, getByText } = render(<ErrorToaster anchor="viewport" />);
    act(() => {
      console.error('click-to-dismiss');
    });
    fireEvent.click(getByText('click-to-dismiss'));
    expect(queryByText('click-to-dismiss')).toBeNull();
  });

  it('ignores non-error console output', () => {
    const { queryByText } = render(<ErrorToaster anchor="viewport" />);
    act(() => {
      console.log('just-a-log');
      console.warn('just-a-warn');
    });
    expect(queryByText('just-a-log')).toBeNull();
    expect(queryByText('just-a-warn')).toBeNull();
  });

  it('does not toast errors that predate mount', () => {
    console.error('pre-existing');
    const { queryByText } = render(<ErrorToaster anchor="viewport" />);
    expect(queryByText('pre-existing')).toBeNull();
  });
});
