// @vitest-environment jsdom
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

  /**
   * #1139 — the cap is armed on VIEWABILITY and RESTARTED on the first gesture (owner, 2026-09-13).
   *
   * The arming half is what these two separate: a viewer who never touches the ad must still reach
   * the end card, because with the persistent pill gone it is the only call to action.
   */
  it('arms the cap on mount, so a viewer who never touches the ad still reaches the end card', () => {
    vi.useFakeTimers();
    render(<PlayableOverlay clickUrl="x" capSeconds={5} />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole('dialog'), 'a viewer who never interacted saw no CTA').toBeTruthy();
  });

  /**
   * The restart half. A player who taps at 4 s of a 5 s cap must get a FULL 5 s from the tap, not
   * the 1 s that was left — otherwise engaging with the ad is punished.
   *
   * Mutation: delete the `onFirstGesture` restart in `PlayableOverlay` -> red at the 2 s mark
   * (the original timer fires) while the arming case above stays green.
   */
  it('RESTARTS the cap on the first gesture, so engaging buys a full session', () => {
    vi.useFakeTimers();
    render(<PlayableOverlay clickUrl="x" capSeconds={5} />);
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => { window.dispatchEvent(new Event('pointerdown')); });
    // The ORIGINAL timer's moment. Nothing may fire here — it was cancelled and replaced.
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByRole('dialog'),
      'the end card fired on the pre-gesture timer — the restart did not happen').toBeNull();

    // The RESTARTED timer's moment: 5 s after the gesture.
    act(() => { vi.advanceTimersByTime(3100); });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  /** A second gesture must not restart it again — the cap is a session budget, not a
   *  keep-alive that an active player could push out forever.
   *
   *  Mutation: drop the `fired` latch in `onFirstGesture` -> red. */
  it('restarts on the FIRST gesture only, not on every one', () => {
    vi.useFakeTimers();
    render(<PlayableOverlay clickUrl="x" capSeconds={5} />);
    act(() => { window.dispatchEvent(new Event('pointerdown')); });
    act(() => { vi.advanceTimersByTime(4000); });
    act(() => { window.dispatchEvent(new Event('pointerdown')); });   // must NOT buy another 5 s
    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.getByRole('dialog'),
      'a second gesture pushed the cap out — an active player could defer the CTA forever').toBeTruthy();
  });

  /**
   * ⚠️ Replay must RE-ARM the cap. Before #1139 a spent cap cost nothing because the persistent
   * pill was always there; now the end card is the only CTA, so a replayed session without a timer
   * has none at all.
   *
   * Mutation: drop `setCycle` from `replay` -> red (the end card never comes back).
   */
  it('re-arms the cap after Replay, so the replayed session still gets a CTA', () => {
    vi.useFakeTimers();
    render(<PlayableOverlay clickUrl="x" capSeconds={5} onReplay={() => {}} />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole('dialog')).toBeTruthy();

    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Replay' })); });
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole('dialog'),
      'the replayed session never reached the end card — its only call to action').toBeTruthy();
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
