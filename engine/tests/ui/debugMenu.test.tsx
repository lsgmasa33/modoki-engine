/** DebugMenu overlay — DOM integration tests (Phase 1).
 *
 *  Exercises the real component end-to-end in jsdom: hidden until toggled, F12 +
 *  3-finger-tap gestures, tab switching, the built-in Stats tab rendering against a
 *  world-less runtime (graceful zeros), and the command → auto "Cheats" tab flow. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { DebugMenu } from '../../packages/modoki/src/runtime/debug/DebugMenu';
import { StatsTab } from '../../packages/modoki/src/runtime/debug/tabs/StatsTab';
import {
  registerDebugTab,
  registerDebugCommand,
  __resetDebugMenuRegistry,
} from '../../packages/modoki/src/runtime/debug/debugMenuRegistry';

function pressF12() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12' }));
  });
}
function threeFingerTap() {
  act(() => {
    const start = new Event('touchstart') as Event & { touches: { length: number } };
    start.touches = { length: 3 };
    window.dispatchEvent(start);
    const end = new Event('touchend') as Event & { touches: { length: number } };
    end.touches = { length: 0 };
    window.dispatchEvent(end);
  });
}

beforeEach(() => __resetDebugMenuRegistry());
afterEach(() => cleanup());

describe('DebugMenu visibility + gestures', () => {
  it('is hidden until F12 opens it, and F12 closes it again', () => {
    registerDebugTab({ id: 'stats', title: 'Stats', order: 0, Component: StatsTab });
    const { queryByText } = render(<DebugMenu />);
    expect(queryByText('DEBUG')).toBeNull();
    pressF12();
    expect(queryByText('DEBUG')).not.toBeNull();
    pressF12();
    expect(queryByText('DEBUG')).toBeNull();
  });

  it('opens on a 3-finger tap', () => {
    registerDebugTab({ id: 'stats', title: 'Stats', order: 0, Component: StatsTab });
    const { queryByText } = render(<DebugMenu />);
    expect(queryByText('DEBUG')).toBeNull();
    threeFingerTap();
    expect(queryByText('DEBUG')).not.toBeNull();
  });

  it('does not toggle for F12 while a text field is focused', () => {
    registerDebugTab({ id: 'stats', title: 'Stats', order: 0, Component: StatsTab });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const { queryByText } = render(<DebugMenu />);
    pressF12();
    expect(queryByText('DEBUG')).toBeNull();
    input.remove();
  });
});

describe('DebugMenu tabs', () => {
  it('renders the built-in Stats launcher (world-less → graceful, no crash)', () => {
    registerDebugTab({ id: 'stats', title: 'Stats', order: 0, Component: StatsTab });
    const { queryByText } = render(<DebugMenu />);
    pressF12();
    // Stats is now a launcher for the floating widgets + a static snapshot.
    expect(queryByText('Performance monitors')).not.toBeNull();
    expect(queryByText('Snapshot')).not.toBeNull();
    expect(queryByText('Renderer')).not.toBeNull();
  });

  it('switches the body when another tab is clicked', () => {
    registerDebugTab({ id: 'a', title: 'Alpha', order: 0, Component: () => <div>ALPHA-BODY</div> });
    registerDebugTab({ id: 'b', title: 'Beta', order: 1, Component: () => <div>BETA-BODY</div> });
    const { queryByText, getByText } = render(<DebugMenu />);
    pressF12();
    expect(queryByText('ALPHA-BODY')).not.toBeNull();
    expect(queryByText('BETA-BODY')).toBeNull();
    fireEvent.click(getByText('Beta'));
    expect(queryByText('ALPHA-BODY')).toBeNull();
    expect(queryByText('BETA-BODY')).not.toBeNull();
  });

  it('surfaces registered commands under an auto "Cheats" tab and runs them', () => {
    const run = vi.fn();
    registerDebugTab({ id: 'stats', title: 'Stats', order: 0, Component: StatsTab });
    registerDebugCommand({ label: 'Win Level', run });
    const { getByText } = render(<DebugMenu />);
    pressF12();
    fireEvent.click(getByText('Cheats'));
    fireEvent.click(getByText('Win Level'));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
