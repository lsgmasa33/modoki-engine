/** Pins #489: the AudioContext gesture unlock must stay ARMED, and the app must re-arm audio
 *  on foreground, or an iOS Music.app interruption silences the game until a relaunch.
 *
 *  BEFORE this fix, App.tsx's unlock effect removed its own listeners on the FIRST gesture
 *  (`{ once: false }` was a red herring — the handler self-removed), so `audioResume()` had
 *  exactly one call in the app's whole lifetime. When iOS suspends the shared AudioContext during
 *  an interruption, nothing ever called `audioResume()` again: every later `play()` was a silent
 *  no-op. Test 1 below is the regression case — against the old code, `unlock` runs once, removes
 *  itself, and a second gesture calls nothing.
 *
 *  This drives the SHIPPING hook — `engine/app/useAudioResumeRearm.ts` — through a trivial probe
 *  component, not a hand-copy of its body. App.tsx's only remaining obligation is to call it
 *  (`useAudioResumeRearm()`, App.tsx), which is a plain, un-mockable one-liner. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

const spies = vi.hoisted(() => ({
  audioResume: vi.fn(),
  isNativePlatform: vi.fn(() => false),
  addListener: vi.fn(async (_event: string, _handler: (state: { isActive: boolean }) => void) => ({ remove: vi.fn() })),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: spies.isNativePlatform },
}));

vi.mock('@capacitor/app', () => ({
  App: { addListener: spies.addListener },
}));

vi.mock('@modoki/engine/runtime', () => ({
  audioResume: spies.audioResume,
}));

// Imported AFTER the mocks above so the hook resolves against the mocked modules.
import { useAudioResumeRearm } from '../../app/useAudioResumeRearm';

function AudioRearmProbe() {
  useAudioResumeRearm();
  return null;
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  spies.isNativePlatform.mockReturnValue(false);
  setVisibility('visible');
});

describe('audio re-arms after an interruption instead of relying on a single gesture (#489)', () => {
  it('a second user gesture still calls audioResume (regression: old code self-removed after the first)', () => {
    render(React.createElement(AudioRearmProbe));

    fireEvent.pointerDown(window);
    expect(spies.audioResume).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(window);
    expect(spies.audioResume).toHaveBeenCalledTimes(2);
  });

  it('appStateChange with isActive:true calls audioResume', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    render(React.createElement(AudioRearmProbe));
    await vi.waitFor(() => expect(spies.addListener).toHaveBeenCalledWith('appStateChange', expect.any(Function)));

    const handler = spies.addListener.mock.calls[0][1] as (state: { isActive: boolean }) => void;
    handler({ isActive: true });

    expect(spies.audioResume).toHaveBeenCalledTimes(1);
  });

  it('appStateChange with isActive:false does not call audioResume', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    render(React.createElement(AudioRearmProbe));
    await vi.waitFor(() => expect(spies.addListener).toHaveBeenCalledWith('appStateChange', expect.any(Function)));

    const handler = spies.addListener.mock.calls[0][1] as (state: { isActive: boolean }) => void;
    handler({ isActive: false });

    expect(spies.audioResume).not.toHaveBeenCalled();
  });

  it('visibilitychange to visible calls audioResume; to hidden does not', () => {
    render(React.createElement(AudioRearmProbe));

    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(spies.audioResume).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(spies.audioResume).toHaveBeenCalledTimes(1);
  });
});
