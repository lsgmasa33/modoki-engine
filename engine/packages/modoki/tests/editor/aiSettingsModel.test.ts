/** aiSettingsModel — the per-project AI-panel settings client + its module cache. The cache is what
 *  lets enterPlay read `captureContactOnLaunch` SYNCHRONOUSLY (no backend round-trip on the Play
 *  path), and the "never block/throw on a settings read" contract keeps a backend hiccup out of Play.
 *
 *  Only `fetch` is stubbed: the save reads its answer through the real `readBackendAnswer` (#1824), so a
 *  stubbed backend module would assert the mock, not the verdict. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchAiSettings, saveAiSettingsPatch, getCachedAiSettings } from '../../src/editor/panels/aiSettingsModel';

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) => new Response(body === null ? '' : JSON.stringify(body), { status });
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });

describe('aiSettingsModel', () => {
  it('a successful fetch populates the synchronous cache', async () => {
    fetchMock.mockResolvedValue(reply({ captureContactOnLaunch: true }));
    expect(await fetchAiSettings()).toEqual({ captureContactOnLaunch: true });
    expect(getCachedAiSettings()).toEqual({ captureContactOnLaunch: true });
  });

  it('a non-ok response degrades to {} (and caches it)', async () => {
    fetchMock.mockResolvedValue(reply(null, 500));
    expect(await fetchAiSettings()).toEqual({});
    expect(getCachedAiSettings()).toEqual({});
  });

  it('a throwing fetch returns the prior cache and never rejects (Play must not throw)', async () => {
    fetchMock.mockResolvedValue(reply({ captureContactOnLaunch: true }));
    await fetchAiSettings(); // prime the cache
    fetchMock.mockRejectedValue(new Error('backend offline'));
    await expect(fetchAiSettings()).resolves.toEqual({ captureContactOnLaunch: true });
  });

  it('save updates the cache to the merged server result', async () => {
    fetchMock.mockResolvedValue(reply({ captureContactOnLaunch: false, other: 1 }));
    expect(await saveAiSettingsPatch({ captureContactOnLaunch: false })).toEqual({ ok: true, settings: { captureContactOnLaunch: false, other: 1 } });
    expect(getCachedAiSettings()).toEqual({ captureContactOnLaunch: false, other: 1 });
  });

  // #1824: this answered the CACHED settings on a refusal, which read to its caller as a save. Mutation: return
  // `{ok:true, settings:_cached}` on `!a.ok` — this goes red.
  it('a refused save is a refusal with the route\'s reason, and the cache is untouched', async () => {
    fetchMock.mockResolvedValue(reply({ captureContactOnLaunch: true }));
    await fetchAiSettings();
    fetchMock.mockResolvedValue(reply({ error: 'no project is open' }, 409));
    expect(await saveAiSettingsPatch({ captureContactOnLaunch: false })).toEqual({ ok: false, error: 'no project is open' });
    expect(getCachedAiSettings()).toEqual({ captureContactOnLaunch: true });
  });
});
