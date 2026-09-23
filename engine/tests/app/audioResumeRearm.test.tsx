// @vitest-environment jsdom
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
  noteAudioForeground: vi.fn(),
  holdAudioForFullscreenAd: vi.fn(),
  noteAudioBackground: vi.fn(),
  adListeners: new Set<(showing: boolean) => void>(),
  isNativePlatform: vi.fn(() => false),
  addListener: vi.fn(async (_event: string, _handler: (state: { isActive: boolean }) => void) => ({ remove: vi.fn() })),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: spies.isNativePlatform },
}));

vi.mock('@capacitor/app', () => ({
  App: { addListener: spies.addListener },
}));

// ⚠️ An EXPLICIT-LIST mock: every binding the hook imports must appear here, or the hook resolves
// `undefined` and dies at the call. `noteAudioForeground` (#1455) is the second one.
vi.mock('@modoki/engine/runtime', () => ({
  audioResume: spies.audioResume,
  noteAudioForeground: spies.noteAudioForeground,
  holdAudioForFullscreenAd: spies.holdAudioForFullscreenAd,
  noteAudioBackground: spies.noteAudioBackground,
  onFullscreenAdChange: (fn: (showing: boolean) => void) => {
    spies.adListeners.add(fn);
    return () => { spies.adListeners.delete(fn); };
  },
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

/** #1455: the owner's report ("music is lost after a LONG app background") could not be acted on
 *  because nothing recorded how long "long" was, or what state the context came back in. These pin
 *  the measurement itself — the recovery behaviour above is unchanged. */
describe('the foreground notes how long the app was away, before resuming (#1455)', () => {
  /** Drive `Date.now()` so a background duration is an exact number rather than a timing race.
   *  Restored per-test below rather than by a global `restoreAllMocks()`, which would also strip
   *  the hoisted `addListener` implementation the native cases depend on. */
  let clockSpy: { mockRestore(): void; mockReturnValue(v: number): unknown } | null = null;
  function pinClock(t: number) {
    const s = vi.spyOn(Date, 'now').mockReturnValue(t);
    clockSpy = s;
    return s;
  }
  afterEach(() => { clockSpy?.mockRestore(); clockSpy = null; });

  it('measures the background duration across hidden -> visible', () => {
    const clock = pinClock(1_000);
    render(React.createElement(AudioRearmProbe));

    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));

    clock.mockReturnValue(1_000 + 1_800_000); // 30 minutes away — #1455's case
    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));

    expect(spies.noteAudioForeground).toHaveBeenCalledWith(1_800_000);
  });

  it('notes the state BEFORE resuming it, not after', () => {
    // Load-bearing ordering, not cosmetics: `audioResume()` mutates `ctx.state`, so a note taken
    // afterwards would read `running` every time and record nothing about what the OS left behind
    // — which is the entire fact the trace exists to keep.
    pinClock(1_000);
    render(React.createElement(AudioRearmProbe));

    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));

    expect(spies.noteAudioForeground.mock.invocationCallOrder[0])
      .toBeLessThan(spies.audioResume.mock.invocationCallOrder[0]);
  });

  it('measures from the FIRST hide when iOS fires visibilitychange twice on the way down', () => {
    // Taking the latest hide would report a 30-minute background as a few seconds — the exact
    // number the report turns on, quietly wrong.
    const clock = pinClock(1_000);
    render(React.createElement(AudioRearmProbe));

    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    clock.mockReturnValue(1_000 + 5_000);
    fireEvent(document, new Event('visibilitychange')); // a second hide, still hidden

    clock.mockReturnValue(1_000 + 600_000);
    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));

    expect(spies.noteAudioForeground).toHaveBeenCalledWith(600_000);
  });

  it('reports null, not 0, when the first event is a foreground with no preceding hide', () => {
    // A gesture-driven or boot-time foreground has no duration to report. `0` would conflate that
    // with a genuine instant return, and a reader takes the most recent foreground entry.
    // Accept side: it must still NOTE, because the context STATE is worth recording regardless.
    pinClock(1_000);
    render(React.createElement(AudioRearmProbe));

    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));

    expect(spies.noteAudioForeground).toHaveBeenCalledWith(null);
  });

  it('iOS fires BOTH appStateChange and visibilitychange for one foreground — it is noted once', async () => {
    // The case the suite did not have, and the one that fails. Noting on both wrote a second
    // entry reading `backgroundedMs: 0` with a post-resume state, and since a reader takes the
    // MOST RECENT foreground, that entry said "no long background, context healthy" — the inverse
    // of the truth, on exactly the platform and the exact axis #1455 is about.
    spies.isNativePlatform.mockReturnValue(true);
    const clock = pinClock(1_000);
    render(React.createElement(AudioRearmProbe));
    await vi.waitFor(() => expect(spies.addListener).toHaveBeenCalled());
    const handler = spies.addListener.mock.calls[0][1];

    handler({ isActive: false });                      // going down: native first
    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange')); // ...then web

    clock.mockReturnValue(1_000 + 1_800_000);
    handler({ isActive: true });                       // coming up: native first
    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange')); // ...then web, same transition

    expect(spies.noteAudioForeground).toHaveBeenCalledTimes(1);
    expect(spies.noteAudioForeground).toHaveBeenCalledWith(1_800_000);
  });

  it('...and the RESUME still runs on both, because deduping a note must not cost a retry', () => {
    // The accept side of the dedupe. audioResume() self-guards and a second attempt is a real
    // recovery opportunity (#1428) — suppressing it would trade a recovery for a tidier trace.
    pinClock(1_000);
    render(React.createElement(AudioRearmProbe));

    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));
    fireEvent(document, new Event('visibilitychange')); // duplicate foreground

    expect(spies.noteAudioForeground).toHaveBeenCalledTimes(1);
    expect(spies.audioResume).toHaveBeenCalledTimes(2);
  });

  it('a SECOND background/foreground cycle notes again', () => {
    // The dedupe must re-arm on the way down, or only the first cycle of a session is ever
    // recorded and every later one — including the one being reported — is silently dropped.
    const clock = pinClock(1_000);
    render(React.createElement(AudioRearmProbe));

    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    clock.mockReturnValue(1_000 + 60_000);
    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));

    clock.mockReturnValue(1_000 + 120_000);
    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    clock.mockReturnValue(1_000 + 120_000 + 1_800_000);
    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));

    expect(spies.noteAudioForeground).toHaveBeenCalledTimes(2);
    expect(spies.noteAudioForeground).toHaveBeenLastCalledWith(1_800_000);
  });

  it('the native appStateChange path measures the same way', async () => {
    // Both paths go through one helper precisely so they cannot drift; on iOS this is the one
    // that fires.
    spies.isNativePlatform.mockReturnValue(true);
    const clock = pinClock(1_000);
    render(React.createElement(AudioRearmProbe));
    await vi.waitFor(() => expect(spies.addListener).toHaveBeenCalled());
    const handler = spies.addListener.mock.calls[0][1];

    handler({ isActive: false });
    clock.mockReturnValue(1_000 + 900_000);
    handler({ isActive: true });

    expect(spies.noteAudioForeground).toHaveBeenCalledWith(900_000);
  });
});

describe('the fullscreen-ad audio hold (#1455)', () => {
  it('forwards every ad edge to the audio hold, and on unmount unhooks and releases', () => {
    const { unmount } = render(<AudioRearmProbe />);
    expect(spies.adListeners.size).toBe(1);
    for (const fn of spies.adListeners) fn(true);
    expect(spies.holdAudioForFullscreenAd).toHaveBeenLastCalledWith(true);
    for (const fn of spies.adListeners) fn(false);
    expect(spies.holdAudioForFullscreenAd).toHaveBeenLastCalledWith(false);
    for (const fn of spies.adListeners) fn(true);
    unmount();
    expect(spies.adListeners.size).toBe(0);
    expect(spies.holdAudioForFullscreenAd, 'never left held by an ad nobody can hear end').toHaveBeenLastCalledWith(false);
  });
});

describe('the background half of the dead-audio check (#1455)', () => {
  it('notes the background ONCE per transition, on the first hide', () => {
    render(<AudioRearmProbe />);
    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    fireEvent(document, new Event('visibilitychange'));   // iOS can fire more than once going down
    expect(spies.noteAudioBackground).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));
    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(spies.noteAudioBackground).toHaveBeenCalledTimes(2);
  });
});

