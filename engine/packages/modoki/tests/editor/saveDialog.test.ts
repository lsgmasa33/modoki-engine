// @vitest-environment jsdom
/** chooseNewAssetPath (the save dialog) branch coverage (Missing Tests #5).
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

import { chooseNewAssetPath, confirmReplaceAsset } from '../../src/editor/utils/saveDialog';

/** The chosen path alone — what most branches below pin. */
const saveAssetDialog = async (o: Parameters<typeof chooseNewAssetPath>[0]) => (await chooseNewAssetPath(o))?.path ?? null;

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

describe('chooseNewAssetPath — the chosen path', () => {
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

/** The in-app modal's KEYBOARD contract (#1215). The fallback prompt and the Replace confirmation
 *  share one shell, and the close-out review found the shared keydown listener submitting a prompt
 *  when Enter was pressed on a focused Cancel. */
describe('modal keyboard behaviour', () => {
  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const settled = async <T>(p: Promise<T>) => {
    let done = false; let value: T | undefined;
    p.then((v) => { done = true; value = v; });
    await tick();
    return { done, value };
  };
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

  it('prompt: Enter in the INPUT submits the typed path', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ unsupported: true }));
    const p = saveAssetDialog(opts);
    await tick();
    modalInput()!.value = '/games/x/assets/Typed';
    press(modalInput()!, 'Enter');
    expect(await p).toBe('/games/x/assets/Typed.anim.json');
  });

  it('prompt: Enter on a focused CANCEL does not submit', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ unsupported: true }));
    const p = saveAssetDialog(opts);
    await tick();
    press(button('Cancel'), 'Enter');
    expect((await settled(p)).done, 'Enter on Cancel must not resolve the prompt with the path').toBe(false);
    button('Cancel').click();
    expect(await p).toBeNull();
  });

  it('confirm: Replace resolves true; Cancel and Escape resolve false', async () => {
    const yes = confirmReplaceAsset('/a/rock.mat.json');
    await tick();
    expect(document.body.textContent).toContain('/a/rock.mat.json');
    button('Replace').click();
    expect(await yes).toBe(true);

    const no = confirmReplaceAsset('/a/rock.mat.json');
    await tick();
    button('Cancel').click();
    expect(await no).toBe(false);

    const esc = confirmReplaceAsset('/a/rock.mat.json');
    await tick();
    press(document.activeElement ?? document.body, 'Escape');
    expect(await esc).toBe(false);
  });

  it('confirm: Enter does NOT replace — a destructive Replace takes a click', async () => {
    const p = confirmReplaceAsset('/a/rock.mat.json');
    await tick();
    expect(document.activeElement?.textContent).toBe('Cancel');
    press(document.activeElement ?? document, 'Enter');
    expect((await settled(p)).done).toBe(false);
    button('Cancel').click();
    expect(await p).toBe(false);
  });

  it('registers no GLOBAL key listener — the modal listens on its own overlay', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const addWin = vi.spyOn(window, 'addEventListener');
    try {
      const p = confirmReplaceAsset('/a/one.mat.json');
      await tick();
      expect(add.mock.calls.filter((c) => c[0] === 'keydown')).toEqual([]);
      expect(addWin.mock.calls.filter((c) => c[0] === 'keydown')).toEqual([]);
      button('Cancel').click();
      expect(await p).toBe(false);
      expect(document.querySelectorAll('button').length).toBe(0);
    } finally { add.mockRestore(); addWin.mockRestore(); }
  });
});

describe('chooseNewAssetPath — which Replace question the create should ask (#1264)', () => {
  // The macOS panel runs its own "Replace?" — but against the name IT returned, before ensureExt.
  it('the native panel already checked the EXACT destination → no second, in-app question', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ path: '/games/x/assets/scenes/level.json' }));
    const pick = await chooseNewAssetPath({ defaultName: 'scene.json', ext: '.json' });
    expect(pick?.path).toBe('/games/x/assets/scenes/level.json');
    // Raced against a tick, so a regression that opens the modal fails HERE rather than as a timeout.
    const answer = await Promise.race([pick!.confirmReplace(pick!.path), tick().then(() => 'still waiting on a modal')]);
    expect(answer).toBe(true);
    expect(document.querySelector('button'), 'no modal was opened').toBeNull();
  });

  it('the native panel checked the COLLAPSED name (Walk.json ≠ Walk.anim.json) → asks in-app', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ path: '/games/x/assets/Walk.json' }));
    const pick = await chooseNewAssetPath(opts);
    expect(pick?.path).toBe('/games/x/assets/Walk.anim.json');
    const answer = pick!.confirmReplace(pick!.path);
    await tick();
    expect(document.body.textContent).toContain('/games/x/assets/Walk.anim.json already exists');
    clickBtn('Cancel');
    expect(await answer).toBe(false);
  });

  it('the fallback text box never checks → asks in-app', async () => {
    backendFetch.mockResolvedValue(jsonResponse({ unsupported: true }));
    const p = chooseNewAssetPath(opts);
    await tick();
    modalInput()!.value = '/games/x/assets/Walk.anim.json';
    clickBtn('Create');
    const pick = await p;
    const answer = pick!.confirmReplace(pick!.path);
    await tick();
    expect(document.body.textContent).toContain('already exists');
    clickBtn('Replace');
    expect(await answer).toBe(true);
  });
});
