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
const loadPaths: string[] = [];
const releasers: (() => void)[] = [];
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    loadScene: async (path: string) => {
      loadPaths.push(path);
      await new Promise<void>((resolve) => { releaseLoad = resolve; releasers.push(resolve); });
      loadResolved = true;
      return { keptBaseGuids: new Set<string>() };
    },
    getCurrent: () => null,
    getNext: () => null,
    getLoadedScenes: () => new Map(),
    getCurrentBaseScene: () => null,
  },
}));

const { loadScene, registerBeforeSceneLoad, getLastSceneLoadFailureMessage } = await import('../../src/editor/scene/serialize');
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

describe('serialize.loadScene takes a preview envelope down FIRST (#1548 close-out review)', () => {
  it('awaits the takedown, and a load superseded while it waited never reaches SceneManager', async () => {
    loadPaths.length = 0;
    setRunMode('scrub');
    let finishTakedown!: () => void;
    registerBeforeSceneLoad(() => new Promise<void>((r) => { finishTakedown = r; }));
    try {
      const first = loadScene('/assets/scenes/a.scene.json');           // waits on the takedown
      await Promise.resolve();
      expect(loadPaths, 'nothing loads while the envelope is still coming down').toEqual([]);
      registerBeforeSceneLoad(() => null);                              // the envelope is gone for the next one
      const second = loadScene('/assets/scenes/b.scene.json');
      finishTakedown();
      // MUTATION TARGET: drop the `stillLive()` check after the await and the stale load calls
      // SceneManager AFTER the newer one — superseding the winner with the loser.
      expect(await first).toBe('superseded');
      expect(loadPaths).toEqual(['/assets/scenes/b.scene.json']);
      for (const r of releasers.splice(0)) r();
      await second;
    } finally {
      registerBeforeSceneLoad(() => null);
      for (const r of releasers.splice(0)) r();
      setRunMode('stopped');
    }
  });
});

describe('a takedown that fails is named as such (#1548 re-review)', () => {
  it('the load fails with the REVERT named, not a bare load error', async () => {
    loadPaths.length = 0;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerBeforeSceneLoad(() => Promise.reject(new Error('reload rejected')));
    try {
      expect(await loadScene('/assets/scenes/c.scene.json')).toBe('failed');
      // MUTATION TARGET: await `_beforeSceneLoad` raw again and this reads just "reload rejected".
      expect(getLastSceneLoadFailureMessage()).toMatch(/could not revert the preview before replacing the scene: reload rejected/);
      expect(loadPaths).toEqual([]);
    } finally { registerBeforeSceneLoad(() => null); err.mockRestore(); setRunMode('stopped'); }
  });

  it('a newer load taking over during a failing takedown makes this one superseded, not failed', async () => {
    loadPaths.length = 0;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail!: (e: Error) => void;
    registerBeforeSceneLoad(() => new Promise<void>((_, rej) => { fail = rej; }));
    try {
      const first = loadScene('/assets/scenes/a.scene.json');
      await Promise.resolve();
      registerBeforeSceneLoad(() => null);
      const second = loadScene('/assets/scenes/b.scene.json');
      fail(new Error('reload rejected'));
      // MUTATION TARGET: drop the `stillLive()` check in the catch and this reads 'failed' ("the previous
      // scene is still loaded") while the winner is about to swap.
      expect(await first).toBe('superseded');
      for (const r of releasers.splice(0)) r();
      await second;
    } finally { registerBeforeSceneLoad(() => null); for (const r of releasers.splice(0)) r(); err.mockRestore(); setRunMode('stopped'); }
  });
});
