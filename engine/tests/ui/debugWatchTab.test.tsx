/** Watch tab (editor-only) — DOM integration tests (Phase 3).
 *
 *  The Watch observer lives in app/debug/watch.ts (editor-side, stripped from game
 *  builds), so this tab is app-level. Sampling itself is covered by watch.ts's own
 *  tests; here we guard the tab's control surface: empty state, starting a watch by
 *  component, and the unknown-component error path. */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { clearWatch } from '../../app/debug/watch';
import '../../app/debug/WatchTab'; // registers the tab + gives us the component via the registry
import { getDebugTabs } from '@modoki/engine/runtime';

registerAllTraits();

const WatchTab = getDebugTabs().find((t) => t.id === 'watch')!.Component;

afterEach(() => {
  cleanup();
  clearWatch(); // drop all watches between tests
});

describe('WatchTab', () => {
  it('registers itself as a debug tab', () => {
    expect(getDebugTabs().some((t) => t.id === 'watch' && t.title === 'Watch')).toBe(true);
  });

  it('shows an empty state with no active watches', () => {
    const { getByText } = render(<WatchTab />);
    expect(getByText(/No active watches/)).toBeTruthy();
  });

  it('starts a watch on a known component', () => {
    const { getByPlaceholderText, getByText, queryByText } = render(<WatchTab />);
    fireEvent.change(getByPlaceholderText(/component/), { target: { value: 'Transform' } });
    fireEvent.click(getByText('Watch'));
    expect(queryByText('Transform')).not.toBeNull(); // watch card header
  });

  it('surfaces an error for an unknown component', () => {
    const { getByPlaceholderText, getByText, queryByText } = render(<WatchTab />);
    fireEvent.change(getByPlaceholderText(/component/), { target: { value: 'NotARealTrait' } });
    fireEvent.click(getByText('Watch'));
    expect(queryByText(/unknown component/)).not.toBeNull();
  });
});
