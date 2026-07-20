/** PlayableOverlay — the playable CTA/install overlay. Locks: the persistent Install pill
 *  routes the tap through installClick, the end-card appears on the time-cap AND on a
 *  `playable:end` event, and Replay clears it. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { PlayableOverlay } from '../../app/playable/PlayableOverlay';

afterEach(() => { cleanup(); delete (globalThis as { mraid?: unknown }).mraid; vi.restoreAllMocks(); vi.useRealTimers(); });

describe('PlayableOverlay', () => {
  it('renders a persistent Install pill', () => {
    render(<PlayableOverlay clickUrl="https://store/app" />);
    expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy();
  });

  it('routes the Install tap through mraid.open in an ad container', () => {
    const open = vi.fn();
    (globalThis as { mraid?: unknown }).mraid = { getState: () => 'default', isViewable: () => true, addEventListener: () => {}, removeEventListener: () => {}, open };
    render(<PlayableOverlay clickUrl="https://store/app" />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(open).toHaveBeenCalledWith('https://store/app');
  });

  it('falls back to window.open when standalone', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<PlayableOverlay clickUrl="https://store/app" />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
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
