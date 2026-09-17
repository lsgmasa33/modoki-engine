/**
 * The AppsFlyer attribution lifecycle (#1332) — moved here from Court's and Weaveling's
 * `packages/app-services/services.test.ts` along with the code. Each game keeps only what proves its
 * WIRING (its config, its plugin, its bundle id); every rule is tested once, here, against a fake SDK
 * and a fake platform, with no module mocks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAttribution,
  type AttributionConfig,
  type AttributionSdk,
} from '../../../src/runtime/core/attribution';

type SdkMock = { [K in keyof AttributionSdk]: ReturnType<typeof vi.fn> };

function fakeSdk(): SdkMock {
  return {
    initialize: vi.fn().mockResolvedValue({ ok: true }),
    requestTrackingAuthorization: vi.fn().mockResolvedValue({ status: 'notSupported' }),
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
