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
import { isPointerBlocked, clearPointerBlockers } from '../../packages/modoki/src/runtime/core/pointerBlockers';

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
}
function pressF12() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12' }));
  });
}
/** Tabs live behind the ☰ button — open the dropdown, then click the tab. */
function openTab(getByText: (t: string) => HTMLElement, getByLabelText: (t: string) => HTMLElement, title: string) {
  fireEvent.click(getByLabelText('Debug menu tabs'));
  fireEvent.click(getByText(title));
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
afterEach(() => { cleanup(); clearPointerBlockers(); });

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

  it('switches the body when another tab is picked from the ☰ dropdown', () => {
    registerDebugTab({ id: 'a', title: 'Alpha', order: 0, Component: () => <div>ALPHA-BODY</div> });
    registerDebugTab({ id: 'b', title: 'Beta', order: 1, Component: () => <div>BETA-BODY</div> });
    const { queryByText, getByText, getByLabelText } = render(<DebugMenu />);
    pressF12();
    expect(queryByText('ALPHA-BODY')).not.toBeNull();
    expect(queryByText('BETA-BODY')).toBeNull();
    // Tab names are hidden until ☰ is pressed.
    expect(queryByText('Beta')).toBeNull();
    openTab(getByText, getByLabelText, 'Beta');
    expect(queryByText('ALPHA-BODY')).toBeNull();
    expect(queryByText('BETA-BODY')).not.toBeNull();
    // Picking a tab closes the dropdown again.
    expect(queryByText('Alpha')).toBeNull();
  });

  it('Escape closes the tab dropdown first, then the modal', () => {
    registerDebugTab({ id: 'a', title: 'Alpha', order: 0, Component: () => <div>ALPHA-BODY</div> });
    registerDebugTab({ id: 'b', title: 'Beta', order: 1, Component: () => <div>BETA-BODY</div> });
    const { queryByText, getByLabelText } = render(<DebugMenu />);
    pressF12();
    fireEvent.click(getByLabelText('Debug menu tabs'));
    expect(queryByText('Beta')).not.toBeNull();
    pressEscape();
    expect(queryByText('Beta')).toBeNull();      // dropdown closed
    expect(queryByText('ALPHA-BODY')).not.toBeNull(); // modal still open
    pressEscape();
    expect(queryByText('ALPHA-BODY')).toBeNull();     // modal closed
  });

  it('surfaces registered commands under an auto "Cheats" tab and runs them', () => {
    const run = vi.fn();
    registerDebugTab({ id: 'stats', title: 'Stats', order: 0, Component: StatsTab });
    registerDebugCommand({ label: 'Win Level', run });
    const { getByText, getByLabelText } = render(<DebugMenu />);
    pressF12();
    openTab(getByText, getByLabelText, 'Cheats');
    fireEvent.click(getByText('Win Level'));
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('DebugMenu pointer-block registration', () => {
  it('registers its panel as a pointer-block root only while open', () => {
    registerDebugTab({ id: 'stats', title: 'Stats', order: 0, Component: StatsTab });
    const { container } = render(<DebugMenu />);
    const backdrop = () => container.querySelector('[data-debug-menu]');

    expect(backdrop()).toBeNull(); // closed: nothing to register
    pressF12();
    const panel = backdrop() as HTMLElement;
    expect(panel).not.toBeNull();
    expect(isPointerBlocked(panel)).toBe(true);

    pressF12(); // closes
    expect(backdrop()).toBeNull();
    expect(isPointerBlocked(panel)).toBe(false); // stale reference, no longer blocked
  });

  it('unregisters on unmount while open', () => {
    registerDebugTab({ id: 'stats', title: 'Stats', order: 0, Component: StatsTab });
    const { container, unmount } = render(<DebugMenu />);
    pressF12();
    const panel = container.querySelector('[data-debug-menu]') as HTMLElement;
    expect(isPointerBlocked(panel)).toBe(true);
    unmount();
    expect(isPointerBlocked(panel)).toBe(false);
  });
});
