/**
 * The AppsFlyer attribution lifecycle (#1332) — moved here from Court's and Weaveling's
 * `packages/app-services/services.test.ts` along with the code. Each game keeps only what proves its
 * WIRING (its config, its plugin, its bundle id); every rule is tested once, here, against a fake SDK
 * and a fake platform, with no module mocks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAttribution,
  isTrackingAllowed,
  type AttributionConfig,
  type AttributionSdk,
  type TrackingStatus,
} from '../../../src/runtime/core/attribution';
import { getBootTimeline, resetBootTimeline } from '../../../src/runtime/core/bootTimeline';

type SdkMock = { [K in keyof AttributionSdk]: ReturnType<typeof vi.fn> };

function fakeSdk(): SdkMock {
  return {
    initialize: vi.fn().mockResolvedValue({ ok: true }),
    requestTrackingAuthorization: vi.fn().mockResolvedValue({ status: 'notSupported' }),
    anonymizeUser: vi.fn().mockResolvedValue({ ok: true }),
    start: vi.fn().mockResolvedValue({ ok: true }),
    logEvent: vi.fn().mockResolvedValue({ ok: true }),
    setCustomerUserId: vi.fn().mockResolvedValue({ ok: true }),
    getAppsFlyerUID: vi.fn().mockResolvedValue({ uid: 'af-uid' }),
    getAdvertisingId: vi.fn().mockResolvedValue({ id: '', kind: 'none', available: false, limitAdTracking: false }),
  };
}

const CONFIGURED: AttributionConfig = { devKey: 'TEST_DEV_KEY', appleAppId: '1234567890', isDebug: true, waitForAttTimeoutSec: 42 };
const BLANK: AttributionConfig = { devKey: '', appleAppId: '', isDebug: false, waitForAttTimeoutSec: 60 };
const NONE = { id: '', kind: 'none', available: false, limitAdTracking: false };

let sdk: SdkMock;
let platform: { isNativePlatform: ReturnType<typeof vi.fn<() => boolean>>; getPlatform: ReturnType<typeof vi.fn<() => string>> };

function make(config: AttributionConfig, { native = true, os = 'android' } = {}) {
  platform.isNativePlatform.mockReturnValue(native);
  platform.getPlatform.mockReturnValue(os);
  return createAttribution({ config, sdk: sdk as unknown as AttributionSdk, platform, bundleId: 'com.example.game' });
}

beforeEach(() => {
  sdk = fakeSdk();
  platform = { isNativePlatform: vi.fn<() => boolean>(() => false), getPlatform: vi.fn<() => string>(() => 'web') };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => vi.restoreAllMocks();
});

describe('attribution — unconfigured', () => {
  it('does not call the plugin when the dev key is blank, even on native', async () => {
    const a = make(BLANK);
    await a.initAppsFlyer();
    expect(sdk.initialize).not.toHaveBeenCalled();
    expect(sdk.start).not.toHaveBeenCalled();
  });

  it('is a no-op off native (editor / web / tests), independent of the key', async () => {
    const a = make(CONFIGURED, { native: false });
    await a.initAppsFlyer();
    expect(sdk.initialize).not.toHaveBeenCalled();
    expect(sdk.start).not.toHaveBeenCalled();
  });

  it('logEvent / setCustomerUserId / getAppsFlyerUID are no-ops, and nothing throws', async () => {
    const a = make(BLANK);
    await expect(a.initAppsFlyer()).resolves.toBeUndefined();
    await expect(a.logEvent('test', { key: 1 })).resolves.toBeUndefined();
    await expect(a.setCustomerUserId('player-1')).resolves.toBeUndefined();
    await expect(a.getAppsFlyerUID()).resolves.toBe('');
    expect(sdk.logEvent).not.toHaveBeenCalled();
    expect(sdk.setCustomerUserId).not.toHaveBeenCalled();
    expect(sdk.getAppsFlyerUID).not.toHaveBeenCalled();
  });
});

/**
 * The tests above are NEGATIVE, and every one passes against `initAppsFlyer() {}`. These are the
 * distinguishing ones: with a key the plugin MUST be driven, and IN ORDER — calling start() before
 * requestTrackingAuthorization() ships every install without IDFA on iOS 14+ and reports no error.
 * The v7 SDK no longer manages ATT timing, so this ordering test is the ONLY thing enforcing it.
 */
describe('attribution — configured', () => {
  it('drives initialize → requestTrackingAuthorization → start, in that order', async () => {
    const a = make(CONFIGURED);
    await a.initAppsFlyer();
    expect(sdk.initialize).toHaveBeenCalledTimes(1);
    expect(sdk.requestTrackingAuthorization).toHaveBeenCalledTimes(1);
    expect(sdk.start).toHaveBeenCalledTimes(1);
    const initAt = sdk.initialize.mock.invocationCallOrder[0];
    const attAt = sdk.requestTrackingAuthorization.mock.invocationCallOrder[0];
    const startAt = sdk.start.mock.invocationCallOrder[0];
    expect(initAt, 'initialize must precede the consent prompt').toBeLessThan(attAt);
    expect(attAt, 'consent must resolve BEFORE start()').toBeLessThan(startAt);
  });

  it('the ATT prompt is an `att-prompt` boot span, open exactly while the prompt is up (#1475)', async () => {
    // On a fresh iOS install this is the system alert that takes the screen; a first-launch stall is
    // only readable against the timeline if the span brackets the prompt, not merely exists.
    resetBootTimeline();
    let answer!: () => void;
    sdk.requestTrackingAuthorization.mockImplementationOnce(
      () => new Promise((resolve) => { answer = () => resolve({ status: 'authorized' }); }),
    );
    const a = make(CONFIGURED, { os: 'ios' });
    const done = a.initAppsFlyer();
    await vi.waitFor(() => expect(sdk.requestTrackingAuthorization).toHaveBeenCalled());
    const open = getBootTimeline().spans.filter((s) => s.name === 'att-prompt');
    expect(open).toHaveLength(1);
    expect(open[0].endMs).toBe(-1);
    answer();
    await done;
    expect(getBootTimeline().spans.find((s) => s.name === 'att-prompt')!.endMs).toBeGreaterThanOrEqual(0);
  });

  it('start() waits for the consent call to RESOLVE, not merely to be made', async () => {
    let answer!: () => void;
    sdk.requestTrackingAuthorization.mockImplementationOnce(
      () => new Promise((resolve) => { answer = () => resolve({ status: 'authorized' }); }),
    );
    const a = make(CONFIGURED);
    const init = a.initAppsFlyer();
    await vi.waitFor(() => expect(sdk.requestTrackingAuthorization).toHaveBeenCalled());
    await Promise.resolve();
    expect(sdk.start, 'the prompt is still up').not.toHaveBeenCalled();
    answer();
    await init;
    expect(sdk.start).toHaveBeenCalledTimes(1);
  });

  it('passes the whole config through to initialize', async () => {
    const a = make(CONFIGURED);
    await a.initAppsFlyer();
    expect(sdk.initialize).toHaveBeenCalledWith({
      devKey: 'TEST_DEV_KEY', appleAppId: '1234567890', isDebug: true, waitForAttTimeoutSec: 42,
    });
  });

  it('is idempotent — a second call does not re-drive the SDK', async () => {
    const a = make(CONFIGURED);
    await a.initAppsFlyer();
    await a.initAppsFlyer();
    expect(sdk.initialize).toHaveBeenCalledTimes(1);
  });

  it('two services keep separate state — the latch is per service, not per module', async () => {
    const first = make(CONFIGURED);
    await first.initAppsFlyer();
    const second = make(CONFIGURED);
    await second.initAppsFlyer();
    expect(sdk.initialize).toHaveBeenCalledTimes(2);
  });

  it('logEvent / setCustomerUserId / getAppsFlyerUID reach the plugin once configured', async () => {
    const a = make(CONFIGURED);
    await a.logEvent('tutorial_complete', { level: 2 });
    await a.setCustomerUserId('player-1');
    expect(sdk.logEvent).toHaveBeenCalledWith({ eventName: 'tutorial_complete', eventValues: { level: 2 } });
    expect(sdk.setCustomerUserId).toHaveBeenCalledWith({ userId: 'player-1' });
    await expect(a.getAppsFlyerUID()).resolves.toBe('af-uid');
  });

  it('a rejecting logEvent / setCustomerUserId / getAppsFlyerUID resolves instead of throwing', async () => {
    sdk.logEvent.mockRejectedValueOnce(new Error('x'));
    sdk.setCustomerUserId.mockRejectedValueOnce(new Error('x'));
    sdk.getAppsFlyerUID.mockRejectedValueOnce(new Error('x'));
    const a = make(CONFIGURED);
    await expect(a.logEvent('e')).resolves.toBeUndefined();
    await expect(a.setCustomerUserId('u')).resolves.toBeUndefined();
    await expect(a.getAppsFlyerUID()).resolves.toBe('');
  });
});

/**
 * `ads.ts` in each game waits on `whenTrackingPromptSettled()` before Google's consent form
 * (#1309/#1312), so the two launch-time full-screen asks never race. The engine starts both in the
 * same tick, which is why the promise must be armed before `initAppsFlyer`'s first await.
 */
describe('attribution — whenTrackingPromptSettled', () => {
  it('is settled before any init', async () => {
    const a = make(CONFIGURED);
    await expect(Promise.race([a.whenTrackingPromptSettled().then(() => 'settled'), Promise.resolve().then(() => 'pending')]))
      .resolves.toBe('settled');
  });

  it('holds until the ATT request returns, armed in the same tick', async () => {
    let answer!: () => void;
    sdk.requestTrackingAuthorization.mockImplementationOnce(
      () => new Promise((resolve) => { answer = () => resolve({ status: 'authorized' }); }),
    );
    const a = make(CONFIGURED);
    const init = a.initAppsFlyer();
    let settled = false;
    void a.whenTrackingPromptSettled().then(() => { settled = true; });
    await vi.waitFor(() => expect(sdk.requestTrackingAuthorization).toHaveBeenCalled());
    await Promise.resolve();
    expect(settled, 'must not settle while the ATT prompt is up').toBe(false);
    answer();
    await init;
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('settles when initialize fails before any prompt', async () => {
    sdk.initialize.mockRejectedValueOnce(new Error('bridge not ready'));
    const a = make(CONFIGURED);
    const pending = a.initAppsFlyer();
    const settled = a.whenTrackingPromptSettled();
    await pending;
    // A promise that never settled would block the ad consent form, and so every ad, for the run.
    await expect(Promise.race([settled.then(() => 'settled'), new Promise((r) => setTimeout(() => r('hung'), 50))]))
      .resolves.toBe('settled');
  });

  it('settles when the consent call itself rejects', async () => {
    sdk.requestTrackingAuthorization.mockRejectedValueOnce(new Error('plugin bridge not ready'));
    const a = make(CONFIGURED);
    const pending = a.initAppsFlyer();
    const settled = a.whenTrackingPromptSettled();
    await pending;
    await expect(Promise.race([settled.then(() => 'settled'), new Promise((r) => setTimeout(() => r('hung'), 50))]))
      .resolves.toBe('settled');
  });
});

/**
 * Regressions from the first real iOS device run (iPhone 8, iOS 16.7.16, 2026-08-19). Both were
 * invisible to every check that existed — the suite and the Android run were green, and the app still
 * terminated on launch.
 */
describe('attribution — iOS device regressions', () => {
  const NO_APP_ID: AttributionConfig = { ...CONFIGURED, appleAppId: '' };

  it('does not start the SDK on iOS when appleAppId is blank — starting it CRASHES the app', async () => {
    const a = make(NO_APP_ID, { os: 'ios' });
    await a.initAppsFlyer();
    expect(sdk.initialize).not.toHaveBeenCalled();
    expect(sdk.start).not.toHaveBeenCalled();
    // And no consent prompt for a run that cannot use the answer.
    expect(sdk.requestTrackingAuthorization).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls[0][0], 'the error names the App Store record to create')
      .toContain('com.example.game');
  });

  it('still starts on ANDROID with a blank appleAppId — the guard is iOS-only', async () => {
    const a = make(NO_APP_ID, { os: 'android' });
    await a.initAppsFlyer();
    expect(sdk.initialize).toHaveBeenCalledTimes(1);
    expect(sdk.start).toHaveBeenCalledTimes(1);
  });

  it('prompts for ATT ONCE when two callers race — the guard latches before the first await', async () => {
    const a = make(CONFIGURED, { os: 'ios' });
    await Promise.all([a.initAppsFlyer(), a.initAppsFlyer()]);
    expect(sdk.requestTrackingAuthorization).toHaveBeenCalledTimes(1);
    expect(sdk.initialize).toHaveBeenCalledTimes(1);
    expect(sdk.start).toHaveBeenCalledTimes(1);
  });
});

/**
 * The retry rule: the latch may be released on failure only while consent was never asked. Holding it
 * would disable attribution for the run over one transient failure; releasing it would re-prompt.
 */
describe('attribution — failure and retry', () => {
  it('retries when initialize() fails — no prompt was shown', async () => {
    sdk.initialize.mockRejectedValueOnce(new Error('bridge not ready'));
    const a = make(CONFIGURED);
    await a.initAppsFlyer();
    expect(sdk.start).not.toHaveBeenCalled();
    await a.initAppsFlyer();
    expect(sdk.initialize).toHaveBeenCalledTimes(2);
    expect(sdk.start).toHaveBeenCalledTimes(1);
  });

  it('retries when the consent CALL ITSELF rejects — the bridge failed, the player saw nothing', async () => {
    // A test once asserted the opposite. A rejection means no dialog was shown, so refusing the retry
    // discarded attribution for the run to protect the player from a prompt they never saw.
    sdk.requestTrackingAuthorization.mockRejectedValueOnce(new Error('plugin bridge not ready'));
    const a = make(CONFIGURED);
    await a.initAppsFlyer();
    expect(sdk.start).not.toHaveBeenCalled();
    await a.initAppsFlyer();
    expect(sdk.requestTrackingAuthorization).toHaveBeenCalledTimes(2);
    expect(sdk.start).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when the consent call resolved and a LATER step failed', async () => {
    sdk.start.mockRejectedValueOnce(new Error('start failed'));
    const a = make(CONFIGURED);
    await expect(a.initAppsFlyer()).resolves.toBeUndefined();   // never throws into the game
    await a.initAppsFlyer();
    expect(sdk.requestTrackingAuthorization).toHaveBeenCalledTimes(1);
    expect(sdk.start).toHaveBeenCalledTimes(1);
  });
});

/**
 * `getAdvertisingId` passes the plugin's answer through, and `available` is what a caller branches on:
 * Android 12+ returns the all-zero UUID rather than null once the user deletes the id, so `id` is
 * non-empty and a null check sails past it.
 */
describe('attribution — getAdvertisingId', () => {
  it.each([
    ['a real IDFA',          { id: '97FFB6D4-530E-45AA-823A-769EAC22C82B', kind: 'idfa', available: true,  limitAdTracking: false }, true],
    ['a real GAID',          { id: '9c30704c-295a-408b-b350-f3ff642569c9', kind: 'gaid', available: true,  limitAdTracking: false }, true],
    ['the all-zero UUID',    { id: '00000000-0000-0000-0000-000000000000', kind: 'gaid', available: false, limitAdTracking: false }, false],
    ['an empty id',          { id: '',                                     kind: 'gaid', available: false, limitAdTracking: false }, false],
    ['limit-ad-tracking on', { id: '9c30704c-295a-408b-b350-f3ff642569c9', kind: 'gaid', available: false, limitAdTracking: true  }, false],
  ])('passes the plugin answer through unchanged: %s', async (_label, native, expectAvailable) => {
    sdk.getAdvertisingId.mockResolvedValueOnce(native);
    const got = await make(CONFIGURED).getAdvertisingId();
    expect(got).toEqual(native);
    expect(got.available).toBe(expectAvailable);
  });

  it('resolves the none-sentinel instead of throwing when the plugin rejects', async () => {
    sdk.getAdvertisingId.mockRejectedValueOnce(new Error('no play services'));
    await expect(make(CONFIGURED).getAdvertisingId()).resolves.toEqual(NONE);
  });

  it('does not touch the plugin off-device, or without a key', async () => {
    await expect(make(CONFIGURED, { native: false }).getAdvertisingId()).resolves.toEqual(NONE);
    await expect(make(BLANK).getAdvertisingId()).resolves.toEqual(NONE);
    expect(sdk.getAdvertisingId).not.toHaveBeenCalled();
  });

  it('hands each caller its own sentinel, so one caller cannot mutate another\'s', async () => {
    const a = make(BLANK);
    const first = await a.getAdvertisingId();
    first.id = 'mutated';
    await expect(a.getAdvertisingId()).resolves.toEqual(NONE);
  });
});

/**
 * #1510: iOS answers `notDetermined` at once, with no prompt drawn, when the app is not active. The
 * plugin now holds the request until it is (`capacitor-appsflyer/att-core`). If the answer still comes
 * back, the log has to say the player was never asked rather than pass it off as an answer.
 */
describe('attribution — an ATT answer that means no prompt was shown (#1510)', () => {
  const warned = () =>
    (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('did not show the tracking prompt'));

  it('warns on iOS when the answer is notDetermined, and still starts the SDK', async () => {
    sdk.requestTrackingAuthorization.mockResolvedValueOnce({ status: 'notDetermined' });
    await make(CONFIGURED, { os: 'ios' }).initAppsFlyer();
    expect(warned()).toBe(true);
    expect(sdk.start).toHaveBeenCalledTimes(1);
  });

  it.each(['authorized', 'denied', 'restricted'])('stays quiet for a real answer (%s)', async (status) => {
    sdk.requestTrackingAuthorization.mockResolvedValueOnce({ status });
    await make(CONFIGURED, { os: 'ios' }).initAppsFlyer();
    expect(warned()).toBe(false);
  });

  it('stays quiet off iOS, where there is no prompt to miss', async () => {
    sdk.requestTrackingAuthorization.mockResolvedValueOnce({ status: 'notDetermined' });
    await make(CONFIGURED, { os: 'android' }).initAppsFlyer();
    expect(warned()).toBe(false);
  });
});

/**
 * #1920 — App Store guideline 5.1.1(iv): Court 0.1.0 was rejected for tracking after "Ask App Not to Track".
 * Anything but an ATT yes must put AppsFlyer in anonymous mode BEFORE start() (owner ruling on #1522), and
 * hand the same answer to ads and analytics through `trackingStatus()`.
 */
describe('attribution — an ATT answer other than authorized means no tracking (#1920)', () => {
  const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0];

  it.each(['denied', 'restricted', 'notDetermined'] as const)(
    'on iOS, `%s` anonymizes AppsFlyer BEFORE start(), and trackingStatus() reports it',
    async (status) => {
      sdk.requestTrackingAuthorization.mockResolvedValue({ status });
      const a = make(CONFIGURED, { os: 'ios' });
      await a.initAppsFlyer();
      expect(sdk.anonymizeUser).toHaveBeenCalledExactlyOnceWith({ anonymize: true });
      expect(sdk.start).toHaveBeenCalledTimes(1);
      expect(order(sdk.anonymizeUser), 'anonymous mode must cover the install, so it precedes start()')
        .toBeLessThan(order(sdk.start));
      expect(order(sdk.requestTrackingAuthorization)).toBeLessThan(order(sdk.anonymizeUser));
      await expect(a.trackingStatus()).resolves.toBe(status);
    },
  );

  it('on iOS, `authorized` turns anonymous mode OFF explicitly, before start()', async () => {
    sdk.requestTrackingAuthorization.mockResolvedValue({ status: 'authorized' });
    const a = make(CONFIGURED, { os: 'ios' });
    await a.initAppsFlyer();
    expect(sdk.anonymizeUser).toHaveBeenCalledExactlyOnceWith({ anonymize: false });
    expect(order(sdk.anonymizeUser)).toBeLessThan(order(sdk.start));
    await expect(a.trackingStatus()).resolves.toBe('authorized');
  });

  it('off iOS (`notSupported`) the call is never made — Android starts exactly as it shipped', async () => {
    const a = make(CONFIGURED, { os: 'android' });
    await a.initAppsFlyer();
    expect(sdk.anonymizeUser).not.toHaveBeenCalled();
    expect(sdk.start).toHaveBeenCalledTimes(1);
    await expect(a.trackingStatus()).resolves.toBe('notSupported');
  });

  it('a failing anonymizeUser keeps AppsFlyer OFF — and a second init does not ask again', async () => {
    sdk.requestTrackingAuthorization.mockResolvedValue({ status: 'denied' });
    sdk.anonymizeUser.mockRejectedValue(new Error('bridge failed'));
    const a = make(CONFIGURED, { os: 'ios' });
    await a.initAppsFlyer();
    expect(sdk.start, 'a player who said no must never be tracked un-anonymized').not.toHaveBeenCalled();
    await a.initAppsFlyer();
    expect(sdk.requestTrackingAuthorization).toHaveBeenCalledTimes(1);
    await expect(a.trackingStatus()).resolves.toBe('denied');
  });

  it('trackingStatus() waits for the prompt, armed in the same tick as init', async () => {
    let answer!: (v: unknown) => void;
    sdk.requestTrackingAuthorization.mockReturnValue(new Promise((r) => { answer = r; }));
    const a = make(CONFIGURED, { os: 'ios' });
    const init = a.initAppsFlyer();
    let got: TrackingStatus | null = null;
    void a.trackingStatus().then((s) => { got = s; });
    await vi.waitFor(() => expect(sdk.requestTrackingAuthorization).toHaveBeenCalled());
    await Promise.resolve();
    expect(got, 'must not answer while the ATT prompt is up').toBeNull();
    answer({ status: 'denied' });
    await init;
    await vi.waitFor(() => expect(got).toBe('denied'));
  });

  it('with no answer, iOS reports `unknown` (a no) and everywhere else `notSupported`', async () => {
    await expect(make(BLANK, { os: 'ios' }).trackingStatus()).resolves.toBe('unknown');
    await expect(make(CONFIGURED, { native: false, os: 'ios' }).trackingStatus()).resolves.toBe('notSupported');
    await expect(make(BLANK, { os: 'android' }).trackingStatus()).resolves.toBe('notSupported');

    // The consent call itself rejecting is no answer either.
    sdk.requestTrackingAuthorization.mockRejectedValue(new Error('bridge failed'));
    const failed = make(CONFIGURED, { os: 'ios' });
    await failed.initAppsFlyer();
    await expect(failed.trackingStatus()).resolves.toBe('unknown');
  });

  it('an answer the plugin does not define reads as `unknown`, and is anonymized', async () => {
    sdk.requestTrackingAuthorization.mockResolvedValue({ status: 'maybe' });
    const a = make(CONFIGURED, { os: 'ios' });
    await a.initAppsFlyer();
    await expect(a.trackingStatus()).resolves.toBe('unknown');
    expect(sdk.anonymizeUser).toHaveBeenCalledExactlyOnceWith({ anonymize: true });
  });

  it('isTrackingAllowed: only `authorized` and `notSupported` say yes', () => {
    const table = Object.fromEntries(
      (['authorized', 'denied', 'restricted', 'notDetermined', 'notSupported', 'unknown'] as const)
        .map((s) => [s, isTrackingAllowed(s)]),
    );
    expect(table).toEqual({
      authorized: true, denied: false, restricted: false, notDetermined: false, notSupported: true, unknown: false,
    });
  });
});
