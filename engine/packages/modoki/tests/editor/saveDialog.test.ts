// @vitest-environment jsdom
/** saveAssetDialog branch coverage (Missing Tests #5).
 *
 *  Native "Save As" via the dev server, with an in-app prompt fallback. Pins:
 *  ensureExt idempotence (via the returned path), the cancelled / chosen-path /
 *  outside-asset-roots / fallback-prompt branches, and the network-error →
 *  fallback path. backendFetch is mocked so no server is needed. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const backendFetch = vi.fn();
vi.mock('../../src/editor/backend/editorBackend', () => ({
  backendFetch: (...args: unknown[]) => backendFetch(...args),
}));

import { saveAssetDialog } from '../../src/editor/utils/saveDialog';

const jsonResponse = (body: unknown) => ({ json: async () => body }) as unknown as Response;

const opts = { defaultName: 'New Animation.anim.json', ext: '.anim.json', defaultFolder: '/games/x/assets' };

let promptSpy: ReturnType<typeof vi.spyOn>;
let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  backendFetch.mockReset();
  promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
});
afterEach(() => {
  promptSpy.mockRestore();
  alertSpy.mockRestore();
});

describe('saveAssetDialog', () => {
  it('returns null when the user cancels the native panel', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ cancelled: true }));
    expect(await saveAssetDialog(opts)).toBeNull();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('returns the chosen path, enforcing the extension (ensureExt)', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ path: '/games/x/assets/Walk' }));
    expect(await saveAssetDialog(opts)).toBe('/games/x/assets/Walk.anim.json');
  });

  it('does not double-append the extension when already present (ensureExt idempotent)', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ path: '/games/x/assets/Walk.anim.json' }));
    expect(await saveAssetDialog(opts)).toBe('/games/x/assets/Walk.anim.json');
  });

  it('fixes the macOS-collapsed outer .json (typed "wave" → wave.json → wave.anim.json)', async () => {
    // The native panel collapses the ".anim.json" default to ".json", so typing "wave"
    // returns "wave.json". Must NOT become "wave.json.anim.json".
    backendFetch.mockResolvedValue(jsonResponse({ path: '/games/x/assets/wave.json' }));
    expect(await saveAssetDialog(opts)).toBe('/games/x/assets/wave.anim.json');
  });

  it('is case-insensitive about the existing extension', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ path: '/games/x/assets/Walk.ANIM.JSON' }));
    // already ends with the ext (case-insensitively) → returned unchanged
    expect(await saveAssetDialog(opts)).toBe('/games/x/assets/Walk.ANIM.JSON');
  });

  it('alerts and returns null on outside-asset-roots', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ error: 'outside-asset-roots' }));
    expect(await saveAssetDialog(opts)).toBeNull();
    expect(alertSpy).toHaveBeenCalledOnce();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('falls back to an in-app prompt when the native panel is unsupported', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ unsupported: true }));
    promptSpy.mockReturnValue('/games/x/assets/Typed');
    expect(await saveAssetDialog(opts)).toBe('/games/x/assets/Typed.anim.json');
    // The seed offered to the prompt joins folder + default name.
    expect(promptSpy).toHaveBeenCalledWith(expect.any(String), '/games/x/assets/New Animation.anim.json');
  });

  it('prepends a leading slash to a relative typed path', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ unsupported: true }));
    promptSpy.mockReturnValue('games/x/assets/Rel');
    expect(await saveAssetDialog(opts)).toBe('/games/x/assets/Rel.anim.json');
  });

  it('returns null when the fallback prompt is cancelled', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ unsupported: true }));
    promptSpy.mockReturnValue(null);
    expect(await saveAssetDialog(opts)).toBeNull();
  });

  it('falls back to the prompt on a network error (no throw)', async () => {
    backendFetch.mockRejectedValue(new Error('network down'));
    promptSpy.mockReturnValue('/games/x/assets/Offline');
    expect(await saveAssetDialog(opts)).toBe('/games/x/assets/Offline.anim.json');
  });
});
