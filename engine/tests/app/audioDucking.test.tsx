/** Pins #548's stateful half: `useAudioDucking` (`engine/app/useAudioDucking.ts`). Its own header
 *  says the module split exists so "this contract can then be pinned by a test", and
 *  `audioDuckingReachable.test.ts` claims the logic is "covered by the hook's own unit test" —
 *  neither was true until this file. Modeled directly on the #489 sibling,
 *  `audioResumeRearm.test.tsx`: mock `@capacitor/core` / `@capacitor/app`, drive the hook through
 *  a trivial probe component, and read state back rather than asserting on the mocks.
 *
 *  `@modoki/engine/runtime` is deliberately NOT mocked here (unlike the #489 sibling) — the whole
 *  point is to observe the duck decision through the real `setAudioMusicDucked`/
 *  `isAudioMusicDucked` (`audioService.ts`), which track a plain module flag and touch the Web
 *  Audio graph only if one already exists (none does in jsdom), so no fake AudioContext is
 *  needed. Asserting on the mock plugin calls alone would only prove the hook CALLED something,
 *  not that the music actually ducks — see CLAUDE.md's "a test that asserts the mock is a test
 *  of the mock". */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import React from 'react';
import { isAudioMusicDucked, setAudioMusicDucked } from '@modoki/engine/runtime';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const spies = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  registerPlugin: vi.fn(),
  configure: vi.fn(async (_opts: { category: string }) => {}),
  shouldSilenceSecondaryAudio: vi.fn(async () => ({ silence: false })),
  pluginAddListener: vi.fn(async (_event: string, _handler: (arg: { silence: boolean }) => void) => ({ remove: vi.fn() })),
  appAddListener: vi.fn(async (_event: string, _handler: (arg: { isActive: boolean }) => void) => ({ remove: vi.fn() })),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: spies.isNativePlatform },
  registerPlugin: spies.registerPlugin,
}));

vi.mock('@capacitor/app', () => ({
  App: { addListener: spies.appAddListener },
}));

vi.mock('virtual:modoki-project-config', () => ({
  default: { capacitor: { audioSessionCategory: 'ambient' } },
}));

// Imported AFTER the mocks above so the hook resolves against the mocked modules.
import { useAudioDucking } from '../../app/useAudioDucking';

function AudioDuckingProbe() {
  useAudioDucking();
  return null;
}

/** The plugin instance handed back by `registerPlugin('ModokiAudio')`. */
function fakePlugin() {
  return {
    configure: spies.configure,
    shouldSilenceSecondaryAudio: spies.shouldSilenceSecondaryAudio,
    addListener: spies.pluginAddListener,
  };
}

/** The single `secondaryAudioHint` handler the hook registered, once addListener resolves. */
async function hintHandler(): Promise<(arg: { silence: boolean }) => void> {
  await vi.waitFor(() => expect(spies.pluginAddListener).toHaveBeenCalledWith('secondaryAudioHint', expect.any(Function)));
  return spies.pluginAddListener.mock.calls[0][1];
}

/** The single `appStateChange` handler the hook registered, once addListener resolves. */
async function appStateHandler(): Promise<(arg: { isActive: boolean }) => void> {
  await vi.waitFor(() => expect(spies.appAddListener).toHaveBeenCalledWith('appStateChange', expect.any(Function)));
  return spies.appAddListener.mock.calls[0][1];
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  spies.isNativePlatform.mockReturnValue(false);
  spies.registerPlugin.mockReturnValue(fakePlugin());
  spies.configure.mockResolvedValue(undefined);
  spies.shouldSilenceSecondaryAudio.mockResolvedValue({ silence: false });
  setAudioMusicDucked(false);
});

// registerPlugin returns the fake plugin from the very first render — set the default before
// each `it` runs too, since `beforeEach`-style setup happens above but the mock is defined once.
spies.registerPlugin.mockReturnValue(fakePlugin());

describe('useAudioDucking (#548)', () => {
  it('web/non-native: no plugin calls, no listeners registered', () => {
    spies.isNativePlatform.mockReturnValue(false);
    render(React.createElement(AudioDuckingProbe));

    expect(spies.registerPlugin).not.toHaveBeenCalled();
    expect(spies.configure).not.toHaveBeenCalled();
    expect(spies.pluginAddListener).not.toHaveBeenCalled();
    expect(spies.appAddListener).not.toHaveBeenCalled();
  });

  it('native mount: configure() gets the configured category, snapshot is taken, both listeners register', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    render(React.createElement(AudioDuckingProbe));

    await vi.waitFor(() => expect(spies.configure).toHaveBeenCalledWith({ category: 'ambient' }));
    await vi.waitFor(() => expect(spies.shouldSilenceSecondaryAudio).toHaveBeenCalled());
    await hintHandler();
    await appStateHandler();
  });

  it('a hint ducks and un-ducks music, observed through isAudioMusicDucked()', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    render(React.createElement(AudioDuckingProbe));
    const onHint = await hintHandler();

    expect(isAudioMusicDucked()).toBe(false);

    act(() => onHint({ silence: true }));
    expect(isAudioMusicDucked()).toBe(true);

    act(() => onHint({ silence: false }));
    expect(isAudioMusicDucked()).toBe(false);
  });

  it('backgrounding un-ducks even while otherAudioPlaying is still true (the foreground term)', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    render(React.createElement(AudioDuckingProbe));
    const onHint = await hintHandler();
    const onAppState = await appStateHandler();

    act(() => onHint({ silence: true }));
    expect(isAudioMusicDucked()).toBe(true);

    act(() => onAppState({ isActive: false }));
    expect(isAudioMusicDucked()).toBe(false);
  });

  it('foregrounding re-snapshots shouldSilenceSecondaryAudio()', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    render(React.createElement(AudioDuckingProbe));
    const onAppState = await appStateHandler();
    const callsBefore = spies.shouldSilenceSecondaryAudio.mock.calls.length;

    spies.shouldSilenceSecondaryAudio.mockResolvedValueOnce({ silence: true });
    await act(async () => { onAppState({ isActive: true }); });

    expect(spies.shouldSilenceSecondaryAudio.mock.calls.length).toBeGreaterThan(callsBefore);
    await vi.waitFor(() => expect(isAudioMusicDucked()).toBe(true));
  });

  it('teardown always un-ducks, even mid-duck (the duck node persists across graph recreation)', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    const { unmount } = render(React.createElement(AudioDuckingProbe));
    const onHint = await hintHandler();

    act(() => onHint({ silence: true }));
    expect(isAudioMusicDucked()).toBe(true);

    unmount();
    expect(isAudioMusicDucked()).toBe(false);
  });

  it('unmounting before addListener resolves still removes the handle and registers nothing live', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    const hintHandle = { remove: vi.fn() };
    const hintDeferred = deferred<typeof hintHandle>();
    spies.pluginAddListener.mockReturnValueOnce(hintDeferred.promise);

    const { unmount } = render(React.createElement(AudioDuckingProbe));
    unmount();

    // Resolve AFTER teardown — the cancelled flag must make the hook remove the handle
    // immediately instead of leaving a live listener behind.
    await act(async () => { hintDeferred.resolve(hintHandle); });

    expect(hintHandle.remove).toHaveBeenCalledTimes(1);
    expect(isAudioMusicDucked()).toBe(false);
  });

  it('a hint that arrives after a snapshot was issued wins over that snapshot\'s stale result', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    const snapshotDeferred = deferred<{ silence: boolean }>();
    // The mount snapshot is the one we leave in flight.
    spies.shouldSilenceSecondaryAudio.mockReturnValueOnce(snapshotDeferred.promise);

    render(React.createElement(AudioDuckingProbe));
    const onHint = await hintHandler();

    // A hint arrives while the snapshot is still in flight, ducking the music...
    act(() => onHint({ silence: true }));
    expect(isAudioMusicDucked()).toBe(true);

    // ...then the STALE snapshot resolves reporting no other audio. It must not undo the hint —
    // the hook bumps `snapshotGen` on every hint, so this stale resolution is discarded.
    await act(async () => { snapshotDeferred.resolve({ silence: false }); });
    expect(isAudioMusicDucked()).toBe(true);
  });

  it('a plugin that is not there rejects without an unhandled rejection, and leaves music unducked', async () => {
    // Pins the review's finding #2. Without the `.catch()` on the listener registrations, an absent
    // or SPM-stripped plugin turns into an unhandled rejection — which globalErrors.ts reports to
    // Crashlytics, i.e. one non-fatal per launch on every device.
    //
    // Listen on PROCESS, not `window`: jsdom does not emit `unhandledrejection` on the window, so a
    // window-based probe passes whether or not the catch is there. (It was written that way first
    // and the mutation check caught it — a probe that cannot detect the positive case is not a
    // test.) Node raises the event at the end of the microtask checkpoint, so the awaited macrotask
    // below is what gives it a chance to fire.
    spies.isNativePlatform.mockReturnValue(true);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const notImplemented = new Error('"ModokiAudio" plugin is not implemented on ios');
      spies.pluginAddListener.mockRejectedValueOnce(notImplemented);
      spies.shouldSilenceSecondaryAudio.mockRejectedValueOnce(notImplemented);
      spies.configure.mockRejectedValueOnce(notImplemented);

      render(React.createElement(AudioDuckingProbe));
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      await new Promise((r) => setTimeout(r, 0));

      expect(unhandled).toEqual([]);
      // Ducking is simply unavailable — never stuck ON, which would silence music with no way back.
      expect(isAudioMusicDucked()).toBe(false);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
