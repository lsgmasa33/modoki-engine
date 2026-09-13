/** Opening a scene holds the world-replacement token until its load lands (#1164).
 *
 *  The editor's `loadScene` wrapper flips the run mode to 'stopped' BEFORE it loads. Opening a scene
 *  during Play is ordinary, and a hot reload deferred during that Play replays on "authoring
 *  settled" by reloading `sceneManager.getCurrent()` — which, until the swap, is still the OLD
 *  scene. So a settle fired by the flip would load the old scene over the one being opened. Real
 *  `serialize.loadScene`, real `authoringSettle`; SceneManager is stubbed so the load can be held open. */

import { describe, it, expect, vi } from 'vitest';

let releaseLoad: (() => void) | null = null;
let loadResolved = false;
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    loadScene: async () => {
      await new Promise<void>((resolve) => { releaseLoad = resolve; });
      loadResolved = true;
    },
    getCurrent: () => null,
    getNext: () => null,
    getLoadedScenes: () => new Map(),
    getCurrentBaseScene: () => null,
  },
}));

const { loadScene } = await import('../../src/editor/scene/serialize');
const { setRunMode, getPlayState } = await import('../../src/runtime/core/playState');
const { onAuthoringSettled } = await import('../../src/editor/scene/authoringSettle');

describe('serialize.loadScene holds the replacement token (#1164)', () => {
  it('opening a scene during Play settles only AFTER its load resolves', async () => {
    setRunMode('playing');
    const seen: boolean[] = [];
    const unsubscribe = onAuthoringSettled(() => { seen.push(loadResolved); });
    try {
      const opening = loadScene('/assets/scenes/other.scene.json');
      expect(getPlayState(), 'the wrapper flipped to stopped before loading').toBe('stopped');
      expect(seen, 'the flip settled while the scene open was still loading').toEqual([]);
      await vi.waitFor(() => expect(releaseLoad).not.toBeNull());
      releaseLoad!();
      await opening;
      expect(seen).toEqual([true]);
    } finally {
      unsubscribe();
    }
  });
});
