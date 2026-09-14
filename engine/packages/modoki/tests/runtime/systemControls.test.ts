/** `system.openUrl` (#1196) — the engine's route from an authored link to the system browser.
 *
 *  `@capacitor/core` is mocked because the thing under test IS the platform fork: which of the
 *  plugin, `window.open` or a refusal a dispatch reaches depends on `isNativePlatform` and
 *  `isPluginAvailable`, and an unmocked run can only ever be "web". Every refusal is pinned
 *  beside the accept that shares its condition, so neither side can pass by the other being broken. */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENABLE_URLS, REFUSED_URLS } from './openUrlVectors';

const platform = { native: false, pluginAvailable: true };
/** `Capacitor.Plugins` — what a native bridge writes at document start, or a game's registration. */
const bridgePlugins: Record<string, unknown> = {};
const openUrl = vi.fn(async (_opts: { url: string }) => ({ opened: true }));
const registerPlugin = vi.fn(() => ({ openUrl }));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    isPluginAvailable: (name: string) => platform.pluginAvailable && name === 'ModokiSystem',
    Plugins: bridgePlugins,
  },
  registerPlugin,
}));

const PRIVACY = 'https://apiarygames.com/privacy.html';

// Imported ONCE: every module reset spawns a fresh koota world, and this file's case table alone
// would pass koota's 16-world cap. The journal is the only state a test reads back, so it is cleared.
type Modules = typeof import('../../src/runtime/core/actionRegistry') & typeof import('../../src/runtime/core/journal');
let modules: Modules;
beforeAll(async () => {
  const { registerSystemControls } = await import('../../src/runtime/actions/systemControls');
  modules = { ...(await import('../../src/runtime/core/actionRegistry')), ...(await import('../../src/runtime/core/journal')) };
  registerSystemControls();
});

async function setup(): Promise<Modules> {
  modules.clearJournal();
  return modules;
}

describe('system.openUrl', () => {
  const windowOpen = vi.fn((..._args: unknown[]) => null);
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    platform.native = false;
    platform.pluginAvailable = true;
    openUrl.mockClear();
    openUrl.mockImplementation(async () => ({ opened: true }));
    registerPlugin.mockClear();
    for (const k of Object.keys(bridgePlugins)) delete bridgePlugins[k];
    windowOpen.mockClear();
    // The package suite runs in node — there is no `window` unless a test gives it one.
    vi.stubGlobal('window', { open: windowOpen });
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    error.mockRestore();
  });

  it('declares a typed `url` param, so the Inspector renders a text field for it', async () => {
    const { getUIActionParams } = await setup();
    expect(getUIActionParams('system.openUrl')).toEqual({ url: expect.objectContaining({ type: 'string' }) });
  });

  describe('the https-only rule', () => {
    it.each(REFUSED_URLS)('REFUSES %s, and opens nothing', async (_label, url) => {
      const { dispatchUIAction, isActionRefusal } = await setup();
      const result = dispatchUIAction('system.openUrl', { params: { url } });
      expect(isActionRefusal(result) && result.reason).toMatch(/not an https:\/\/ URL/);
      expect(windowOpen).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
    });

    // The authoring routes' "nothing chosen" is `''`, which normaliseParams turns into ABSENT (#1075)
    // — so an unfilled binding must refuse as a missing URL, not crash on `new URL(undefined)`.
    it('REFUSES an unfilled binding (`url: ""`) naming the value as null', async () => {
      const { dispatchUIAction, isActionRefusal } = await setup();
      const result = dispatchUIAction('system.openUrl', { params: { url: '' } });
      expect(isActionRefusal(result) && result.reason).toMatch(/^\[system\.openUrl\] null is not an https/);
      expect(error).toHaveBeenCalled();
    });

    it.each(OPENABLE_URLS)('accepts %s', async (_label, url) => {
      const { dispatchUIAction, isActionRefusal } = await setup();
      expect(isActionRefusal(dispatchUIAction('system.openUrl', { params: { url } }))).toBe(false);
      expect(windowOpen).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
    });

    it('accepts an https URL on the web: window.open in a new, opener-less tab, journaled as opened', async () => {
      const { dispatchUIAction, isActionRefusal, journalEvents } = await setup();
      const result = dispatchUIAction('system.openUrl', { params: { url: PRIVACY } });
      expect(isActionRefusal(result)).toBe(false);
      expect(windowOpen).toHaveBeenCalledWith(PRIVACY, '_blank', 'noopener,noreferrer');
      expect(openUrl).not.toHaveBeenCalled();
      expect(journalEvents({ type: 'system.openUrl' }).map((e) => e.payload)).toEqual([{ url: PRIVACY, opened: true }]);
    });
  });

  it('REFUSES quietly in a headless run with no window, rather than throwing', async () => {
    vi.unstubAllGlobals();
    const { dispatchUIAction, isActionRefusal } = await setup();
    const result = dispatchUIAction('system.openUrl', { params: { url: PRIVACY } });
    expect(isActionRefusal(result) && result.reason).toMatch(/no window/);
    expect(error).not.toHaveBeenCalled();
  });

  describe('native', () => {
    beforeEach(() => { platform.native = true; });

    it('routes an https URL through the plugin, NOT window.open, and holds the input lock until it answers', async () => {
      const { dispatchUIAction, isActionRefusal, journalEvents } = await setup();
      const result = dispatchUIAction('system.openUrl', { params: { url: PRIVACY } });
      expect(isActionRefusal(result)).toBe(false);
      expect(typeof (result as Promise<unknown>)?.then).toBe('function');
      await result;
      expect(openUrl).toHaveBeenCalledWith({ url: PRIVACY });
      expect(windowOpen).not.toHaveBeenCalled();
      expect(journalEvents({ type: 'system.openUrl' }).map((e) => [e.payload, e.level])).toEqual([[{ url: PRIVACY, opened: true }, 'info']]);
    });

    // The real device shape: the native bridge wrote a plain object with one method per native method.
    it('calls the object the native bridge wrote into Capacitor.Plugins, and never registers the plugin', async () => {
      const bridged = { openUrl: vi.fn(async () => ({ opened: true })) };
      bridgePlugins.ModokiSystem = bridged;
      const { dispatchUIAction } = await setup();
      await dispatchUIAction('system.openUrl', { params: { url: PRIVACY } });
      expect(bridged.openUrl).toHaveBeenCalledWith({ url: PRIVACY });
      expect(openUrl).not.toHaveBeenCalled();
      // ⚠️ Proves nothing in file order: an earlier native test already filled the module's
      // `registerPlugin` cache, so a registration made BEFORE reading the bridge object would not call
      // the mock again. The real guard is `systemControlsRegistration.test.ts` (real core, the warning).
      expect(registerPlugin).not.toHaveBeenCalled();
    });

    // An OTA bundle on an older native binary: the bridge object exists but predates openUrl.
    it('falls back to registerPlugin when the bridged object has no openUrl', async () => {
      bridgePlugins.ModokiSystem = { openAppSettings: vi.fn() };
      const { dispatchUIAction } = await setup();
      await dispatchUIAction('system.openUrl', { params: { url: PRIVACY } });
      // `openUrl` belongs to the object `registerPlugin` returns (the module caches that result across
      // this file, so whether the mock is called again depends on test order — the call target does not).
      expect(openUrl).toHaveBeenCalledWith({ url: PRIVACY });
    });

    it('REFUSES synchronously when the build does not include the plugin, and calls nothing', async () => {
      platform.pluginAvailable = false;
      const { dispatchUIAction, isActionRefusal } = await setup();
      const result = dispatchUIAction('system.openUrl', { params: { url: PRIVACY } });
      expect(isActionRefusal(result) && result.reason).toMatch(/does not include capacitor-modoki-system/);
      expect(openUrl).not.toHaveBeenCalled();
      expect(windowOpen).not.toHaveBeenCalled();
    });

    it('journals an OS that opened nothing as a warn, not as opened', async () => {
      openUrl.mockImplementation(async () => ({ opened: false }));
      const { dispatchUIAction, journalEvents } = await setup();
      await dispatchUIAction('system.openUrl', { params: { url: PRIVACY } });
      expect(journalEvents({ type: 'system.openUrl' }).map((e) => [e.payload, e.level])).toEqual([[{ url: PRIVACY, opened: false }, 'warn']]);
    });

    it('turns a plugin rejection into a warn journal entry rather than an unhandled rejection', async () => {
      openUrl.mockImplementation(async () => { throw new Error('not implemented on ios'); });
      const { dispatchUIAction, journalEvents } = await setup();
      await dispatchUIAction('system.openUrl', { params: { url: PRIVACY } });
      expect(journalEvents({ type: 'system.openUrl' }).map((e) => [e.payload, e.level])).toEqual([
        [{ url: PRIVACY, opened: false, error: 'Error: not implemented on ios' }, 'warn'],
      ]);
    });
  });
});
