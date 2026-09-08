// @vitest-environment jsdom
/** #784 phase C3, item 2 — `editor/scene/serialize.ts`'s `loadScene()` must tell a `too-new`/
 *  `unreadable` scene format-version refusal (docs/format-versioning.md § 2b-bis) apart from an
 *  ordinary `'failed'` load: "Failed to load — check the path" is a wrong diagnosis for a right
 *  symptom when the bytes are fine and this build simply refuses to read them.
 *
 *  Exercises the DECISION LOGIC only — `sceneManager` is mocked to reject with the real
 *  `SceneFormatRefusedError` `loadSceneFile` throws (SceneManager.test.ts already covers that
 *  the throw reaches here for real); this file never mounts a panel. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { SceneFormatRefusedError } from '../../src/runtime/loaders/loadSceneFile';

const h = vi.hoisted(() => ({ nextError: null as unknown }));

vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    loadScene: async () => { throw h.nextError; },
    getCurrentBaseScene: () => undefined,
  },
}));

import { loadScene, getLastSceneLoadFailureMessage } from '../../src/editor/scene/serialize';
import { useEditorStore } from '../../src/editor/store/editorStore';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

afterEach(() => {
  useEditorStore.setState({ toast: null });
  vi.restoreAllMocks();
});

describe('loadScene() — format-version refusal outcome', () => {
  it('returns "refused" (not "failed") for a SceneFormatRefusedError, and toasts the reason', async () => {
    h.nextError = new SceneFormatRefusedError(
      'Scene not loaded: its format version (99) is newer than this engine supports (13). Update the engine to open this scene.',
      'too-new',
    );

    const outcome = await loadScene('/tooNew.json');

    expect(outcome).toBe('refused');
    expect(getLastSceneLoadFailureMessage()).toContain('newer than this engine supports');
    // Surfaced via the editor's existing toast vocabulary (engine/app/editor/setup.ts precedent),
    // not a new banner/modal.
    const toast = useEditorStore.getState().toast;
    expect(toast?.kind).toBe('warn');
    expect(toast?.message).toContain('Scene not loaded');
  });

  it('returns "failed" (not "refused") for an ordinary throw, and does not toast', async () => {
    h.nextError = new Error('no asset at /missing.json');

    const outcome = await loadScene('/missing.json');

    expect(outcome).toBe('failed');
    expect(getLastSceneLoadFailureMessage()).toBe('no asset at /missing.json');
    expect(useEditorStore.getState().toast).toBeNull();
  });
});
