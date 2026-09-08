/** Pins #619: pending PlayerPrefs writes must flush while a Google Play billing sheet is open.
 *
 *  Play Billing's `ProxyBillingActivity` is TRANSLUCENT, so opening a purchase sheet pauses the
 *  host Activity without ever stopping it — Capacitor's `appStateChange` fires only from
 *  `onStop` (`BridgeActivity.java`), so no background edge fired at all while the sheet was up,
 *  and neither did `visibilitychange`/`pagehide` (measured on a Galaxy A23: `visibilityState`
 *  stayed `"visible"`, with 46 requestAnimationFrame ticks in 1010 ms, for the whole time the
 *  sheet was up). `@capacitor/app`'s `pause` event, dispatched on every Activity pause, is the
 *  edge that actually fires there — this test drives the SHIPPING hook
 *  (`engine/app/useBackgroundFlush.ts`) through a trivial probe component, not a hand-copy of its
 *  body, the same precedent `audioResumeRearm.test.tsx` states in its own header. App.tsx's only
 *  remaining obligation is to call it (`useBackgroundFlush()`, App.tsx), which is a plain,
 *  un-mockable one-liner.
 *
 *  ⚠️ This file MUST stay `.test.tsx`. `engine/vite.config.ts`'s include list carries
 *  `tests/app/**\/*.test.tsx` and NO `.ts` sibling for this directory, so a file named
 *  `.test.ts` here is collected by nothing and reports green by being absent. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

const spies = vi.hoisted(() => ({
  flush: vi.fn(async () => {}),
  runRealmShutdownTasks: vi.fn(async () => {}),
  notifyRealmSurvived: vi.fn(),
  isNativePlatform: vi.fn(() => false),
  addListener: vi.fn(async (_event: string, _handler: (...args: unknown[]) => void) => ({ remove: vi.fn() })),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: spies.isNativePlatform },
}));

vi.mock('@capacitor/app', () => ({
  App: { addListener: spies.addListener },
}));

// ⚠️ An EXPLICIT export list: adding an import to useBackgroundFlush.ts breaks this at
// import-binding time, not in an assertion. That is how `notifyRealmSurvived` arrived — #611
// merged from main and moved the realm-death backstop into the effect this hook now owns.
// `./realmDeathBackstop` is deliberately NOT mocked: it is pure, and using the real decision core
// means this file tests the WIRING while `realmDeathBackstop.test.tsx` tests the decision.
vi.mock('@modoki/engine/runtime', () => ({
  PlayerPrefs: { flush: spies.flush },
  runRealmShutdownTasks: spies.runRealmShutdownTasks,
  notifyRealmSurvived: spies.notifyRealmSurvived,
}));

// Imported AFTER the mocks above so the hook resolves against the mocked modules.
import { useBackgroundFlush } from '../../app/useBackgroundFlush';

function BackgroundFlushProbe() {
  useBackgroundFlush();
  return null;
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

// `addListener` calls are (event, handler) pairs; find the handler registered for `event`.
function handlerFor(event: string) {
  const call = spies.addListener.mock.calls.find((c) => c[0] === event);
  if (!call) throw new Error(`no addListener call for "${event}"`);
  return call[1] as (...args: unknown[]) => void;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  spies.isNativePlatform.mockReturnValue(false);
  setVisibility('visible');
});

describe('PlayerPrefs flushes while a translucent activity (e.g. a billing sheet) is up (#619)', () => {
  it('registers both appStateChange and pause listeners on native', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    render(React.createElement(BackgroundFlushProbe));

    await vi.waitFor(() => expect(spies.addListener).toHaveBeenCalledWith('appStateChange', expect.any(Function)));
    await vi.waitFor(() => expect(spies.addListener).toHaveBeenCalledWith('pause', expect.any(Function)));
  });

  it('the pause handler calls PlayerPrefs.flush()', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    render(React.createElement(BackgroundFlushProbe));
    await vi.waitFor(() => expect(spies.addListener).toHaveBeenCalledWith('pause', expect.any(Function)));

    handlerFor('pause')();

    expect(spies.flush).toHaveBeenCalled();
  });

  it('appStateChange with isActive:false flushes; isActive:true does not', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    render(React.createElement(BackgroundFlushProbe));
    await vi.waitFor(() => expect(spies.addListener).toHaveBeenCalledWith('appStateChange', expect.any(Function)));

    const handler = handlerFor('appStateChange') as (state: { isActive: boolean }) => void;
    handler({ isActive: true });
    expect(spies.flush).not.toHaveBeenCalled();

    handler({ isActive: false });
    expect(spies.flush).toHaveBeenCalledTimes(1);
  });

  it('registers no Capacitor listener on non-native, but still wires visibilitychange/pagehide', () => {
    const addVisibility = vi.spyOn(document, 'addEventListener');
    const addPageHide = vi.spyOn(window, 'addEventListener');

    render(React.createElement(BackgroundFlushProbe));

    expect(spies.addListener).not.toHaveBeenCalled();
    expect(addVisibility).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(addPageHide).toHaveBeenCalledWith('pagehide', expect.any(Function));
    expect(addPageHide).toHaveBeenCalledWith('pageshow', expect.any(Function));

    addVisibility.mockRestore();
    addPageHide.mockRestore();
  });

  it('unmount removes both native handles', async () => {
    spies.isNativePlatform.mockReturnValue(true);
    const removeAppStateChange = vi.fn();
    const removePause = vi.fn();
    spies.addListener.mockImplementation(async (event: string) => (
      event === 'appStateChange' ? { remove: removeAppStateChange } : { remove: removePause }
    ));

    const { unmount } = render(React.createElement(BackgroundFlushProbe));
    await vi.waitFor(() => expect(spies.addListener).toHaveBeenCalledWith('appStateChange', expect.any(Function)));
    await vi.waitFor(() => expect(spies.addListener).toHaveBeenCalledWith('pause', expect.any(Function)));
    // Let the pending addListener() promises' .then() callbacks run and populate appListeners
    // before unmount — vi.waitFor above only proves the call happened, not that its promise chain
    // has settled.
    await new Promise((resolve) => setTimeout(resolve, 0));

    unmount();

    expect(removeAppStateChange).toHaveBeenCalled();
    expect(removePause).toHaveBeenCalled();
  });

  it('visibilitychange to hidden flushes', () => {
    render(React.createElement(BackgroundFlushProbe));

    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(spies.flush).not.toHaveBeenCalled();

    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(spies.flush).toHaveBeenCalledTimes(1);
  });

  it('pagehide with persisted:false flushes and runs realm shutdown tasks; persisted:true flushes but does not', () => {
    render(React.createElement(BackgroundFlushProbe));

    const persistedEvent = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(persistedEvent, 'persisted', { value: true });
    fireEvent(window, persistedEvent);
    expect(spies.flush).toHaveBeenCalledTimes(1);
    expect(spies.runRealmShutdownTasks).not.toHaveBeenCalled();

    const deadEvent = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(deadEvent, 'persisted', { value: false });
    fireEvent(window, deadEvent);
    expect(spies.flush).toHaveBeenCalledTimes(2);
    expect(spies.runRealmShutdownTasks).toHaveBeenCalledTimes(1);
  });

  // #611's backstop moved into this hook when its change merged with the #619 extraction. The
  // decision itself is pinned by realmDeathBackstop.test.tsx; these pin that this hook actually
  // WIRES all three of its edges to it — the failure mode being a backstop that can trigger a
  // shutdown but never learn the realm survived, leaving ads dead for the run.
  it('a foreground after a shutdown-triggering pagehide reports the realm survived (#611)', () => {
    render(React.createElement(BackgroundFlushProbe));

    const dead = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(dead, 'persisted', { value: false });
    fireEvent(window, dead);
    expect(spies.runRealmShutdownTasks).toHaveBeenCalledTimes(1);
    expect(spies.notifyRealmSurvived).not.toHaveBeenCalled();

    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(spies.notifyRealmSurvived).toHaveBeenCalledTimes(1);
  });

  it('pageshow is wired to the same recovery as visibilitychange (#611)', () => {
    render(React.createElement(BackgroundFlushProbe));

    const dead = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(dead, 'persisted', { value: false });
    fireEvent(window, dead);

    fireEvent(window, new Event('pageshow'));
    expect(spies.notifyRealmSurvived).toHaveBeenCalledTimes(1);
  });

  it('an ordinary foreground with no prior shutdown does not re-arm the seam (#611)', () => {
    render(React.createElement(BackgroundFlushProbe));

    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));
    fireEvent(window, new Event('pageshow'));

    expect(spies.notifyRealmSurvived).not.toHaveBeenCalled();
  });

  // The weak form this replaces asserted `removeEventListener` was CALLED WITH ('pageshow',
  // expect.any(Function)) — that passes even if the cleanup removes a DIFFERENT function
  // reference than the one still registered, the classic listener leak. The distinguishing check
  // is behavioural: after unmount, replay the exact sequence that would trigger the backstop and
  // prove neither callback fires again, i.e. the listeners are genuinely detached.
  it('unmount actually detaches the pagehide/pageshow listeners, not just calls removeEventListener (#611)', () => {
    const { unmount } = render(React.createElement(BackgroundFlushProbe));
    unmount();
    // Clear AFTER unmount: the hook's own cleanup does a "final flush on teardown", which would
    // otherwise register as a call and make the assertions below pass for the wrong reason.
    vi.clearAllMocks();

    const dead = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(dead, 'persisted', { value: false });
    fireEvent(window, dead);
    fireEvent(window, new Event('pageshow'));

    expect(spies.runRealmShutdownTasks).not.toHaveBeenCalled();
    expect(spies.notifyRealmSurvived).not.toHaveBeenCalled();
  });

  // The file had no removal assertion at all for visibilitychange/pagehide before this — both are
  // covered here in one test, behaviourally: after unmount, neither edge may flush.
  // ⚠️ The sibling detach tests CANNOT catch a `pageshow`-only leak, and that is not obvious:
  // the backstop's `weTriggeredShutdown` episode flag is armed only through the `pagehide`
  // listener, so if `pagehide` is detached correctly and `pageshow` leaks, a post-unmount
  // `pagehide` does nothing and the leaked `pageshow` handler no-ops against an unarmed flag —
  // both assertions pass while the listener is still attached. Arming the flag BEFORE unmount is
  // what makes the leak observable, so this is the only test here that distinguishes it.
  it('a leaked pageshow listener is caught — flag armed before unmount, pageshow fired after (#611)', () => {
    const { unmount } = render(React.createElement(BackgroundFlushProbe));

    // Arm the episode while still mounted: this is what a leaked pageshow handler would act on.
    const dead = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(dead, 'persisted', { value: false });
    fireEvent(window, dead);
    expect(spies.runRealmShutdownTasks).toHaveBeenCalledTimes(1);

    unmount();
    spies.notifyRealmSurvived.mockClear(); // the hook's teardown must not taint the assertion

    fireEvent(window, new Event('pageshow'));

    expect(spies.notifyRealmSurvived).not.toHaveBeenCalled();
  });

  it('unmount also detaches visibilitychange and pagehide — neither flushes after (#611)', () => {
    const { unmount } = render(React.createElement(BackgroundFlushProbe));
    unmount();
    // See the note above: clear AFTER unmount so the teardown's own final flush doesn't taint
    // the "not called" assertions below.
    vi.clearAllMocks();

    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(spies.flush).not.toHaveBeenCalled();

    const dead = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(dead, 'persisted', { value: false });
    fireEvent(window, dead);
    expect(spies.flush).not.toHaveBeenCalled();
  });
});
