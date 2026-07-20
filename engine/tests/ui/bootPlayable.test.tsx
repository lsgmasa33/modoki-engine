/** bootPlayable — the playable audio-mute gate (Phase 5). Locks the contract that a playable
 *  build holds ALL audio muted until the ad is VIEWABLE, then releases it. A regression here
 *  = a playable that blares audio off-screen (a network rejection reason). */

import { describe, it, expect, vi, afterEach } from 'vitest';

// bootPlayable's only runtime dep is setAudioMuted; mock it to a spy (the real graph would drag
// in the whole engine + a live AudioContext).
const setAudioMuted = vi.fn();
vi.mock('@modoki/engine/runtime', () => ({ setAudioMuted: (v: boolean) => setAudioMuted(v), isAudioMuted: () => false }));
// Don't actually mount React — assert the overlay root was created + render() was called.
const render = vi.fn();
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render, unmount: vi.fn() }) }));

import { bootPlayable } from '../../app/playable/bootPlayable';

type Listener = (...args: unknown[]) => void;
function mockMraid(init: { state?: string; viewable?: boolean } = {}) {
  const listeners: Record<string, Listener[]> = {};
  const state = init.state ?? 'default';
  let viewable = init.viewable ?? true;
  const m = {
    getState: () => state,
    isViewable: () => viewable,
    addEventListener: (e: string, l: Listener) => { (listeners[e] ??= []).push(l); },
    removeEventListener: (e: string, l: Listener) => { listeners[e] = (listeners[e] ?? []).filter((x) => x !== l); },
    open: vi.fn(),
    fire: (e: string, ...args: unknown[]) => { for (const l of [...(listeners[e] ?? [])]) l(...args); },
    setViewable: (v: boolean) => { viewable = v; },
  };
  (globalThis as { mraid?: unknown }).mraid = m;
  return m;
}

afterEach(() => {
  delete (globalThis as { mraid?: unknown }).mraid;
  document.getElementById('playable-overlay')?.remove();
  vi.clearAllMocks();
});

const tap = () => window.dispatchEvent(new Event('pointerdown'));

describe('bootPlayable audio-mute gate', () => {
  it('unmutes ONLY after the ad is viewable AND the user interacts (never auto-plays)', async () => {
    const m = mockMraid({ state: 'default', viewable: false }); // on-screen gate pends
    const done = bootPlayable('https://store/app');

    // Muted immediately; not unmuted before viewable.
    expect(setAudioMuted).toHaveBeenCalledWith(true);
    expect(setAudioMuted).not.toHaveBeenCalledWith(false);

    // Viewable but NO gesture yet → STILL muted (this is the auto-play case). Overlay still mounts.
    m.setViewable(true); m.fire('viewableChange', true);
    await done;
    expect(setAudioMuted).toHaveBeenLastCalledWith(true);
    expect(render).toHaveBeenCalledTimes(1);
    expect(document.getElementById('playable-overlay')).not.toBeNull();

    // First user gesture → unmute.
    tap();
    expect(setAudioMuted).toHaveBeenLastCalledWith(false);
  });

  it('re-mutes when the ad scrolls off-screen, unmutes when it returns (after first interaction)', async () => {
    const m = mockMraid({ state: 'default', viewable: false });
    const done = bootPlayable('https://store/app');
    m.setViewable(true); m.fire('viewableChange', true);
    await done;
    tap(); // interact once
    expect(setAudioMuted).toHaveBeenLastCalledWith(false);

    setAudioMuted.mockClear();
    m.setViewable(false); m.fire('viewableChange', false);
    expect(setAudioMuted).toHaveBeenLastCalledWith(true);   // off-screen → muted
    m.setViewable(true); m.fire('viewableChange', true);
    expect(setAudioMuted).toHaveBeenLastCalledWith(false);  // on-screen (already interacted) → unmuted
  });

  it('standalone (no mraid): stays muted until the first user gesture', async () => {
    await bootPlayable('https://store/app');
    expect(setAudioMuted).toHaveBeenNthCalledWith(1, true);
    expect(setAudioMuted).toHaveBeenLastCalledWith(true);  // viewable-immediate, but no tap → still muted
    tap();
    expect(setAudioMuted).toHaveBeenLastCalledWith(false);
  });

  it('isolates #root + the overlay host so game z-indexes can\'t cover the ad container chrome', async () => {
    // The engine layers renderers with z-index (2D canvas host = z-index:2); without a stacking
    // context on #root those leak into <body> and paint over AppLovin's z-index:auto chrome +
    // "successfully clicked" banner. isolation:isolate contains them.
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    mockMraid({ state: 'default', viewable: true });

    await bootPlayable('https://store/app');

    expect(root.style.isolation).toBe('isolate');
    expect(document.getElementById('playable-overlay')?.style.isolation).toBe('isolate');
    root.remove();
  });
});
