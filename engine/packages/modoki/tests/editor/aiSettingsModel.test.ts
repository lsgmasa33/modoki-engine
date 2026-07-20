/** aiSettingsModel — the per-project AI-panel settings client + its module cache. The cache is what
 *  lets enterPlay read `captureContactOnLaunch` SYNCHRONOUSLY (no backend round-trip on the Play
 *  path), and the "never block/throw on a settings read" contract keeps a backend hiccup out of Play.
 *  backendFetch/backendPostJson are mocked so no server is needed. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const backendFetch = vi.fn();
const backendPostJson = vi.fn();
vi.mock('../../src/editor/backend/editorBackend', () => ({
  backendFetch: (...a: unknown[]) => backendFetch(...a),
  backendPostJson: (...a: unknown[]) => backendPostJson(...a),
}));

import { fetchAiSettings, saveAiSettings, getCachedAiSettings } from '../../src/editor/panels/aiSettingsModel';

const jsonRes = (body: unknown, ok = true) => ({ ok, json: async () => body });
beforeEach(() => { backendFetch.mockReset(); backendPostJson.mockReset(); });

describe('aiSettingsModel', () => {
  it('a successful fetch populates the synchronous cache', async () => {
    backendFetch.mockResolvedValue(jsonRes({ captureContactOnLaunch: true }));
    expect(await fetchAiSettings()).toEqual({ captureContactOnLaunch: true });
    expect(getCachedAiSettings()).toEqual({ captureContactOnLaunch: true });
  });

  it('a non-ok response degrades to {} (and caches it)', async () => {
    backendFetch.mockResolvedValue(jsonRes(null, false));
    expect(await fetchAiSettings()).toEqual({});
    expect(getCachedAiSettings()).toEqual({});
  });

  it('a throwing fetch returns the prior cache and never rejects (Play must not throw)', async () => {
    backendFetch.mockResolvedValue(jsonRes({ captureContactOnLaunch: true }));
    await fetchAiSettings(); // prime the cache
    backendFetch.mockRejectedValue(new Error('backend offline'));
    await expect(fetchAiSettings()).resolves.toEqual({ captureContactOnLaunch: true });
  });

  it('save updates the cache to the merged server result', async () => {
    backendPostJson.mockResolvedValue(jsonRes({ captureContactOnLaunch: false, other: 1 }));
    expect(await saveAiSettings({ captureContactOnLaunch: false })).toEqual({ captureContactOnLaunch: false, other: 1 });
    expect(getCachedAiSettings()).toEqual({ captureContactOnLaunch: false, other: 1 });
  });
});
