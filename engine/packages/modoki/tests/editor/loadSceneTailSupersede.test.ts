// @vitest-environment jsdom
/** Reproduces #495: a load superseded during the WINNER's TAIL previously ran the full success
 *  path anyway. `loadSceneEpochGuard.test.ts` covers only the CANCELLED-EARLY case, where
 *  `SceneManager` aborts the in-flight load and its own `sceneManager.loadScene` promise
 *  REJECTS with an AbortError — `loadScene`'s `catch` swallows that.
 *
 *  Per `sceneManager.ts:885-900`, a load that starts during the winner's tail finds nothing left
 *  to cancel — `nextLoad` was already cleared at the winner's swap — so it "skips straight to
 *  resolving": its OWN `sceneManager.loadScene` call resolves successfully and throws nothing.
 *  Before the fix, `loadScene`'s success path consulted the epoch guard nowhere, so the loser ran
 *  `setCurrentScenePath`/`swapHistory`/`editorEmit('!scene-load', …)` over the winner's, in full.
 *
 *  This file drives that exact interleaving: two overlapping `loadScene` calls where the FIRST
 *  (loser) call's own `sceneManager.loadScene` promise resolves successfully AFTER the second
 *  (winner) call has already completed its entire success path. */

import { describe, it, expect, afterEach, vi } from 'vitest';

interface LoadCall {
  path: string;
  opts: { onProgress?: (loaded: number, total: number) => void; gameId?: string | null };
  resolve: () => void;
  reject: (e: unknown) => void;
}

const h = vi.hoisted(() => ({
  loadCalls: [] as LoadCall[],
  swapHistoryCalls: [] as string[],
  emitCalls: [] as Array<{ event: string; payload: unknown }>,
}));

vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    loadScene: (path: string, opts: LoadCall['opts']) =>
      new Promise<void>((resolve, reject) => {
        h.loadCalls.push({ path, opts, resolve, reject });
      }),
    getCurrentBaseScene: () => undefined,
  },
}));

// Spy on the two success-path writes that matter most (undo-stack binding, Percept journal) —
// `serialize.ts` calls these directly by import binding, so they must be mocked at the module
// level (a `vi.spyOn` on the imported namespace does not intercept an internal caller's own
// reference under Vite/esbuild's ESM interop).
vi.mock('../../src/editor/undo/undoManager', () => ({
  swapHistory: (path: string) => { h.swapHistoryCalls.push(path); },
  getEditVersion: () => 0,
}));

vi.mock('../../src/editor/editorJournal', () => ({
  editorEmit: (type: string, payload: unknown) => { h.emitCalls.push({ event: type, payload }); },
}));

import { loadScene, getCurrentScenePath } from '../../src/editor/scene/serialize';

// serialize.ts persists the last-scene path to localStorage on a successful load; this
// package's jsdom env doesn't provide one (see newScene.test.ts / loadSceneEpochGuard.test.ts).
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
  h.loadCalls.length = 0;
  h.swapHistoryCalls.length = 0;
  h.emitCalls.length = 0;
  vi.restoreAllMocks();
});

describe('loadScene: a load superseded in the WINNER\'S TAIL (#495)', () => {
  it('the loser returns "superseded" and performs none of the success-path writes over the winner', async () => {
    const p1 = loadScene('/sceneA.json'); // will lose
    await Promise.resolve(); // let the mocked sceneManager.loadScene call get recorded
    const p2 = loadScene('/sceneB.json'); // will win
    await Promise.resolve();

    expect(h.loadCalls).toHaveLength(2);
    const [call1, call2] = h.loadCalls;

    // The winner's own SceneManager.loadScene resolves; the winner runs its full success path.
    call2.resolve();
    await expect(p2).resolves.toBe('loaded');
    expect(getCurrentScenePath()).toBe('/sceneB.json');
    expect(h.swapHistoryCalls).toEqual(['/sceneB.json']);
    expect(h.emitCalls).toEqual([
      { event: '!scene-load', payload: { path: '/sceneB.json', entityCount: expect.any(Number) } },
    ]);

    // The loser's OWN SceneManager.loadScene call now resolves successfully too — the tail
    // supersede: nothing was left to cancel, so it "skips straight to resolving" with no
    // AbortError (sceneManager.ts:885-900).
    call1.resolve();
    const outcome1 = await p1;

    expect(outcome1).toBe('superseded');
    // Must NOT have clobbered the winner's current path (also: NOT re-persisted to localStorage).
    expect(getCurrentScenePath()).toBe('/sceneB.json');
    // Must NOT have rebound the undo stack to the loser's own scene.
    expect(h.swapHistoryCalls).toEqual(['/sceneB.json']);
    // Must NOT have journalled the loser's path (against the winner's live entity count).
    expect(h.emitCalls).toEqual([
      { event: '!scene-load', payload: { path: '/sceneB.json', entityCount: expect.any(Number) } },
    ]);
  });

  it('regression guard: an ordinary, uncontested single load still returns "loaded" and performs its writes', async () => {
    const p1 = loadScene('/sceneA.json');
    await Promise.resolve();
    const [call1] = h.loadCalls;
    call1.resolve();

    await expect(p1).resolves.toBe('loaded');
    expect(getCurrentScenePath()).toBe('/sceneA.json');
    expect(h.swapHistoryCalls).toEqual(['/sceneA.json']);
    expect(h.emitCalls).toEqual([
      { event: '!scene-load', payload: { path: '/sceneA.json', entityCount: expect.any(Number) } },
    ]);
  });
});
