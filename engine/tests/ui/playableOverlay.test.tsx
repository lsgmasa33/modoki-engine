/** PlayableOverlay — the playable CTA/install overlay. Locks: there is NO persistent Install
 *  affordance (#1139), the end-card appears on the time-cap AND on a `playable:end` event, its
 *  Install routes the tap through installClick, and Replay clears it. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { PlayableOverlay } from '../../app/playable/PlayableOverlay';

afterEach(() => { cleanup(); delete (globalThis as { mraid?: unknown }).mraid; vi.restoreAllMocks(); vi.useRealTimers(); });

describe('PlayableOverlay', () => {
  /**
   * ⚠️ **INVERTED by #1139** — this asserted that a persistent Install pill rendered. There was one,
   * fixed to the bottom 57 CSS px, and a game's own bottom clearance is a DESIGN-space reserve, so
   * on a short viewport the pill overhung onto the letter board's bottom row: opaque, hit-testable,
   * and a drag there left the ad. AppLovin requires no install affordance of ours, so the owner
   * removed it. The regression this now guards is the pill coming BACK.
   *
   * Asserted as "no button at all before the end card", not merely "no button named Install" — a
   * replacement CTA under a different label is the same defect.
   */
  it('renders NO persistent CTA before the end card (#1139)', () => {
    render(<PlayableOverlay clickUrl="https://store/app" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  /** Reaching the end card first is the point: it is the ONLY route to a click since #1139. */
  const endCard = (clickUrl = 'https://store/app') => {
    render(<PlayableOverlay clickUrl={clickUrl} />);
    act(() => { window.dispatchEvent(new Event('playable:end')); });
    return screen.getByRole('button', { name: 'Install Now' });
  };

  it('routes the end-card Install through mraid.open in an ad container', () => {
    const open = vi.fn();
    (globalThis as { mraid?: unknown }).mraid = { getState: () => 'default', isViewable: () => true, addEventListener: () => {}, removeEventListener: () => {}, open };
    fireEvent.click(endCard());
    expect(open).toHaveBeenCalledWith('https://store/app');
  });

  it('falls back to window.open when standalone', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    fireEvent.click(endCard());
    expect(open).toHaveBeenCalledWith('https://store/app', '_blank');
  });

  it('shows the end-card when the time-cap fires', () => {
    vi.useFakeTimers();
    render(<PlayableOverlay clickUrl="x" capSeconds={5} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install Now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replay' })).toBeTruthy();
  });

  it('shows the end-card early on a playable:end event', () => {
    render(<PlayableOverlay clickUrl="x" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { window.dispatchEvent(new Event('playable:end')); });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Replay clears the end-card and calls onReplay', () => {
    const onReplay = vi.fn();
    render(<PlayableOverlay clickUrl="x" onReplay={onReplay} />);
    act(() => { window.dispatchEvent(new Event('playable:end')); });
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(onReplay).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
