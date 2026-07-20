/** MRAID v2 shim — unit tests against a mocked `window.mraid` + the standalone fallback.
 *  Locks the container contract (ready/viewable gates, mraid.open clickthrough, time cap)
 *  so a refactor can't silently break how a playable talks to the ad network. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isInAdContainer, whenReady, whenViewable, installClick, startTimeCap } from '../../app/playable/mraid';

type Listener = (...args: unknown[]) => void;

/** A controllable MRAID mock. `fire(event, ...args)` drives the async gates. */
function mockMraid(init: { state?: string; viewable?: boolean } = {}) {
  const listeners: Record<string, Listener[]> = {};
  let state = init.state ?? 'default';
  let viewable = init.viewable ?? true;
  const m = {
    getState: () => state,
    isViewable: () => viewable,
    addEventListener: (e: string, l: Listener) => { (listeners[e] ??= []).push(l); },
    removeEventListener: (e: string, l: Listener) => { listeners[e] = (listeners[e] ?? []).filter((x) => x !== l); },
    open: vi.fn(),
    fire: (e: string, ...args: unknown[]) => { for (const l of [...(listeners[e] ?? [])]) l(...args); },
    setState: (s: string) => { state = s; },
    setViewable: (v: boolean) => { viewable = v; },
    listenerCount: (e: string) => (listeners[e] ?? []).length,
  };
  (globalThis as { mraid?: unknown }).mraid = m;
  return m;
}

afterEach(() => { delete (globalThis as { mraid?: unknown }).mraid; vi.restoreAllMocks(); });

describe('isInAdContainer', () => {
  it('false standalone, true with a valid mraid', () => {
    expect(isInAdContainer()).toBe(false);
    mockMraid();
    expect(isInAdContainer()).toBe(true);
  });
});

describe('whenReady', () => {
  it('resolves immediately when standalone', async () => {
    await expect(whenReady()).resolves.toBeUndefined();
  });
  it('resolves immediately when already past loading', async () => {
    mockMraid({ state: 'default' });
    await expect(whenReady()).resolves.toBeUndefined();
  });
  it('waits for the ready event when loading, then unsubscribes', async () => {
    const m = mockMraid({ state: 'loading' });
    let resolved = false;
    const p = whenReady().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(m.listenerCount('ready')).toBe(1);
    m.setState('default');
    m.fire('ready');
    await p;
    expect(resolved).toBe(true);
    expect(m.listenerCount('ready')).toBe(0); // cleaned up
  });
});

describe('whenViewable', () => {
  it('resolves immediately when already viewable', async () => {
    mockMraid({ viewable: true });
    await expect(whenViewable()).resolves.toBeUndefined();
  });
  it('waits for viewableChange(true) when off-screen', async () => {
    const m = mockMraid({ viewable: false });
    let resolved = false;
    const p = whenViewable().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    m.setViewable(true);
    m.fire('viewableChange', true);
    await p;
    expect(resolved).toBe(true);
    expect(m.listenerCount('viewableChange')).toBe(0);
  });
});

describe('installClick', () => {
  it('routes through mraid.open in a container (returns true)', () => {
    const m = mockMraid();
    expect(installClick('https://store/app')).toBe(true);
    expect(m.open).toHaveBeenCalledWith('https://store/app');
  });
  it('falls back to window.open when standalone (returns false)', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    expect(installClick('https://store/app')).toBe(false);
    expect(open).toHaveBeenCalledWith('https://store/app', '_blank');
  });
});

describe('startTimeCap', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('fires onExpire after the cap', () => {
    const onExpire = vi.fn();
    startTimeCap(30, onExpire);
    vi.advanceTimersByTime(29_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });
  it('the canceller prevents expiry (game ended first)', () => {
    const onExpire = vi.fn();
    const cancel = startTimeCap(30, onExpire);
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
