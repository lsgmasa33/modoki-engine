/** `copyToClipboard` (#1398) — the engine's route from a "Copy player ID" button to the clipboard.
 *
 *  `@capacitor/core` is mocked because the thing under test IS the platform fork: native goes to the
 *  plugin's `copyText`, the web to `navigator.clipboard`, and an unmocked run can only ever be "web".
 *  Each failure is pinned beside the success that shares its condition, so neither side can pass by
 *  the other being broken. */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = { native: false, pluginAvailable: true };
const bridgePlugins: Record<string, unknown> = {};
const copyText = vi.fn(async (_opts: { text: string }) => ({ copied: true }));
const registerPlugin = vi.fn(() => ({ openUrl: vi.fn(), copyText }));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    isPluginAvailable: (name: string) => platform.pluginAvailable && name === 'ModokiSystem',
    Plugins: bridgePlugins,
  },
  registerPlugin,
}));

const ID = 'uid-0123456789abcdef';

type Modules = typeof import('../../src/runtime/actions/systemControls') & typeof import('../../src/runtime/core/journal');
let m: Modules;
beforeAll(async () => {
  m = { ...(await import('../../src/runtime/actions/systemControls')), ...(await import('../../src/runtime/core/journal')) };
});

const journaled = () => m.journalEvents({ type: 'system.copyText' }).map((e) => [e.payload, e.level]);

describe('copyToClipboard', () => {
  const writeText = vi.fn(async (_t: string) => {});
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    m.clearJournal();
    platform.native = false;
    platform.pluginAvailable = true;
    for (const k of Object.keys(bridgePlugins)) delete bridgePlugins[k];
    copyText.mockReset();
    copyText.mockImplementation(async () => ({ copied: true }));
    writeText.mockReset();
    writeText.mockImplementation(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    error.mockRestore();
  });

  describe('web and the editor', () => {
    it('writes through navigator.clipboard, resolves true, and journals copied without the text', async () => {
      expect(await m.copyToClipboard(ID)).toBe(true);
      expect(writeText).toHaveBeenCalledWith(ID);
      expect(copyText).not.toHaveBeenCalled();
      expect(journaled()).toEqual([[{ copied: true }, 'info']]);
    });

    // Outside a secure context the API is ABSENT — `?.writeText` would resolve undefined and read as success.
    it('resolves FALSE when navigator.clipboard is absent, never a false "Copied"', async () => {
      vi.stubGlobal('navigator', {});
      expect(await m.copyToClipboard(ID)).toBe(false);
      expect(journaled()).toEqual([[{ copied: false }, 'warn']]);
    });

    it('resolves false when the write rejects (a permission refusal), without rejecting itself', async () => {
      writeText.mockImplementation(async () => { throw new Error('NotAllowedError'); });
      expect(await m.copyToClipboard(ID)).toBe(false);
    });

    it('copies nothing for an empty string', async () => {
      expect(await m.copyToClipboard('')).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
    });
  });

  describe('native', () => {
    beforeEach(() => { platform.native = true; });

    it('uses the plugin\'s copyText, NOT navigator.clipboard', async () => {
      bridgePlugins.ModokiSystem = { openUrl: vi.fn(), copyText };
      expect(await m.copyToClipboard(ID)).toBe(true);
      expect(copyText).toHaveBeenCalledWith({ text: ID });
      expect(writeText).not.toHaveBeenCalled();
      expect(journaled()).toEqual([[{ copied: true }, 'info']]);
    });

    it('passes the plugin\'s own copied:false through', async () => {
      bridgePlugins.ModokiSystem = { openUrl: vi.fn(), copyText };
      copyText.mockImplementation(async () => ({ copied: false }));
      expect(await m.copyToClipboard(ID)).toBe(false);
      expect(journaled()).toEqual([[{ copied: false }, 'warn']]);
    });

    it('resolves false and logs an error when the build does not include the plugin', async () => {
      platform.pluginAvailable = false;
      expect(await m.copyToClipboard(ID)).toBe(false);
      expect(copyText).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/does not include capacitor-modoki-system/));
    });

    // An OTA bundle on an older binary: the bridge object has openUrl but predates copyText.
    it('resolves false and logs an error when the native plugin predates copyText', async () => {
      bridgePlugins.ModokiSystem = { openUrl: vi.fn() };
      expect(await m.copyToClipboard(ID)).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/predates copyText/));
    });

    // Older still: no openUrl either, so `system()` falls back to the registerPlugin proxy, which rejects.
    it('resolves false when the plugin call rejects, rather than rejecting', async () => {
      copyText.mockImplementation(async () => { throw new Error('not implemented on ios'); });
      expect(await m.copyToClipboard(ID)).toBe(false);
      expect(copyText).toHaveBeenCalledWith({ text: ID });
      expect(error).toHaveBeenCalled();
    });
  });
});
