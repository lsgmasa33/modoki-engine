// @vitest-environment jsdom
/** saveAssetDialog branch coverage (Missing Tests #5).
 *
 *  Native "Save As" via the dev server, with an in-app MODAL fallback (window.prompt() throws in
 *  the Electron renderer). Pins: ensureExt idempotence (via the returned path), the cancelled /
 *  chosen-path / outside-asset-roots / fallback-modal branches, and the network-error → fallback
 *  path. backendFetch is mocked so no server is needed. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const backendFetch = vi.fn();
vi.mock('../../src/editor/backend/editorBackend', () => ({
  backendFetch: (...args: unknown[]) => backendFetch(...args),
}));

import { saveAssetDialog } from '../../src/editor/utils/saveDialog';

const jsonResponse = (body: unknown) => ({ json: async () => body }) as unknown as Response;

const opts = { defaultName: 'New Animation.anim.json', ext: '.anim.json', defaultFolder: '/games/x/assets' };

let alertSpy: ReturnType<typeof vi.spyOn>;

// Flush pending microtasks + timers so the fallback modal has been rendered into the DOM.
const tick = () => new Promise((r) => setTimeout(r, 0));
const modalInput = () => document.querySelector('input') as HTMLInputElement | null;
const clickBtn = (label: string) => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  btn?.click();
};

beforeEach(() => {
  backendFetch.mockReset();
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
});
afterEach(() => {
  alertSpy.mockRestore();
  document.body.innerHTML = ''; // drop any leftover modal between tests
});

describe('saveAssetDialog', () => {
  it('returns null when the user cancels the native panel', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ cancelled: true }));
    expect(await saveAssetDialog(opts)).toBeNull();
    expect(modalInput()).toBeNull(); // no fallback modal shown
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
    backendFetch.mockResolvedValue(jsonResponse({ path: '/games/x/assets/wave.json' }));
    expect(await saveAssetDialog(opts)).toBe('/games/x/assets/wave.anim.json');
  });

  it('is case-insensitive about the existing extension', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ path: '/games/x/assets/Walk.ANIM.JSON' }));
    expect(await saveAssetDialog(opts)).toBe('/games/x/assets/Walk.ANIM.JSON');
  });

  it('alerts and returns null on outside-asset-roots', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ error: 'outside-asset-roots' }));
    expect(await saveAssetDialog(opts)).toBeNull();
    expect(alertSpy).toHaveBeenCalledOnce();
    expect(modalInput()).toBeNull();
  });

  it('falls back to an in-app modal when the native panel is unsupported', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ unsupported: true }));
    const p = saveAssetDialog(opts);
    await tick();
    const input = modalInput()!;
    expect(input).not.toBeNull();
    expect(input.value).toBe('/games/x/assets/New Animation.anim.json'); // seed = folder + default name
    input.value = '/games/x/assets/Typed';
    clickBtn('Create');
    expect(await p).toBe('/games/x/assets/Typed.anim.json');
  });

  it('prepends a leading slash to a relative typed path', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ unsupported: true }));
    const p = saveAssetDialog(opts);
    await tick();
    modalInput()!.value = 'games/x/assets/Rel';
    clickBtn('Create');
    expect(await p).toBe('/games/x/assets/Rel.anim.json');
  });

  it('returns null when the fallback modal is cancelled', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ unsupported: true }));
    const p = saveAssetDialog(opts);
    await tick();
    clickBtn('Cancel');
    expect(await p).toBeNull();
  });

  it('falls back to the modal on a network error (no throw)', async () => {
    backendFetch.mockRejectedValue(new Error('network down'));
    const p = saveAssetDialog(opts);
    await tick();
    modalInput()!.value = '/games/x/assets/Offline';
    clickBtn('Create');
    expect(await p).toBe('/games/x/assets/Offline.anim.json');
  });
});
