// @vitest-environment jsdom
/** SceneView's "View ▾" toggle persistence (#399) — a fresh reload used to reset Grid/
 *  Colliders/layer visibility to their hardcoded defaults even though the panel LAYOUT was
 *  restored. Covers the round-trip and the malformed/partial-blob self-heal. */

import { describe, it, expect, beforeEach } from 'vitest';

// This jsdom env doesn't provide localStorage — back it with a tiny in-memory store
// (same workaround as layoutStore.test.ts).
function installLocalStorage() {
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
installLocalStorage();

import { loadSceneViewPrefs, saveSceneViewPrefs, DEFAULT_SCENE_VIEW_PREFS } from '../../src/editor/panels/sceneViewPrefs';

describe('sceneViewPrefs', () => {
  beforeEach(() => { localStorage.clear(); });

  it('defaults to the pre-#399 hardcoded values when nothing is persisted', () => {
    expect(loadSceneViewPrefs()).toEqual(DEFAULT_SCENE_VIEW_PREFS);
  });

  it('round-trips a partial patch, merging onto the existing value', () => {
    saveSceneViewPrefs({ showGrid: false });
    saveSceneViewPrefs({ showColliders: true });
    saveSceneViewPrefs({ layers: { show3D: false, show2D: true, showUI: false } });

    expect(loadSceneViewPrefs()).toEqual({
      showGrid: false,
      showColliders: true,
      colliders2DOnly: false,
      layers: { show3D: false, show2D: true, showUI: false },
    });
  });

  it('falls back to defaults for a malformed blob instead of throwing', () => {
    localStorage.setItem('editor:sceneViewOptions', 'not json');
    expect(loadSceneViewPrefs()).toEqual(DEFAULT_SCENE_VIEW_PREFS);
  });

  it('fills in a missing field from an older, partial-shape blob', () => {
    localStorage.setItem('editor:sceneViewOptions', JSON.stringify({ showGrid: false }));
    expect(loadSceneViewPrefs()).toEqual({ ...DEFAULT_SCENE_VIEW_PREFS, showGrid: false });
  });
});
