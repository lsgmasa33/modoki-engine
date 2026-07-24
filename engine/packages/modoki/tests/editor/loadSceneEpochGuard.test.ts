// @vitest-environment jsdom
/** Regression guard for the scene-load epoch guard in `editor/scene/serialize.ts`'s
 *  `loadScene` wrapper.
 *
 *  `SceneManager.loadScene` cancels any in-flight load when a newer one starts (a boot autoload
 *  racing an agent/menu-triggered open, or rapid scene switches) — the superseded call rejects
 *  with an AbortError. Two bugs are easy to reintroduce here:
 *   1. The superseded (loser) call's `finally` clearing `sceneLoadStatus.active` AFTER the
 *      winner has already set it — hiding the winning load's progress modal mid-load.
 *   2. The loser's `onProgress` firing (it may still be mid-flight when aborted) and
 *      overwriting the winner's loaded/total counts with stale numbers.
 *  A monotonic per-call epoch is the fix: only the CURRENT epoch's calls are allowed to touch
 *  the store. This test drives two overlapping `loadScene` calls with full manual control over
 *  when each resolves/rejects/progresses, so it can assert the ordering bugs don't return
 *  regardless of which call's promise settles first.
 *
 *  SceneManager itself is mocked — its OWN abort/cancel-in-flight semantics are already covered
 *  by SceneManager.test.ts; this file exercises only the epoch-guard wiring around it. */

import { describe, it, expect, afterEach, vi } from 'vitest';

interface LoadCall {
  path: string;
  opts: { onProgress?: (loaded: number, total: number) => void; gameId?: string | null };
  resolve: () => void;
  reject: (e: unknown) => void;
}

const h = vi.hoisted(() => ({
  loadCalls: [] as LoadCall[],
}));

vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    loadScene: (path: string, opts: LoadCall['opts']) =>
      new Promise<void>((resolve, reject) => {
        h.loadCalls.push({ path, opts, resolve, reject });
      }),
  },
}));

import { loadScene } from '../../src/editor/scene/serialize';
import { useEditorStore } from '../../src/editor/store/editorStore';

// serialize.ts persists the last-scene path to localStorage on a successful load; this
// package's jsdom env doesn't provide one (see newScene.test.ts), so back it with a tiny
// in-memory store.
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
  useEditorStore.getState().setSceneLoadStatus({ active: false, loaded: 0, total: 0 });
  vi.restoreAllMocks();
});

describe('loadScene epoch guard (superseded loads cannot clobber the winner)', () => {
  it('a stale loser resolving/rejecting AFTER the winner does not hide its active progress', async () => {
    const p1 = loadScene('/sceneA.json');
    await Promise.resolve(); // let the mocked sceneManager.loadScene call get recorded
    const p2 = loadScene('/sceneB.json');
    await Promise.resolve();

    expect(h.loadCalls).toHaveLength(2);
    const [call1, call2] = h.loadCalls;

    // The winner (call2, the latest epoch) reports progress.
    call2.opts.onProgress?.(1, 4);
    expect(useEditorStore.getState().sceneLoadStatus).toEqual({ active: true, loaded: 1, total: 4 });

    // The loser (call1) is superseded and rejects with AbortError — its `finally` must NOT
    // clear the modal the winner is actively driving.
    call1.reject(new DOMException('Aborted', 'AbortError'));
    await expect(p1).resolves.toBe(false);
    expect(useEditorStore.getState().sceneLoadStatus.active).toBe(true);
    expect(useEditorStore.getState().sceneLoadStatus).toEqual({ active: true, loaded: 1, total: 4 });

    // A late onProgress from the (already-superseded) loser must be ignored too — it would
    // otherwise overwrite the winner's counts with stale numbers.
    call1.opts.onProgress?.(99, 100);
    expect(useEditorStore.getState().sceneLoadStatus).toEqual({ active: true, loaded: 1, total: 4 });

    // The winner completes normally — NOW the modal clears.
    call2.resolve();
    await expect(p2).resolves.toBe(true);
    expect(useEditorStore.getState().sceneLoadStatus.active).toBe(false);
  });

  it('the loser resolving successfully (race won by the "wrong" promise) still does not clobber the winner', async () => {
    // Exercises the opposite settle order: the FIRST call's promise happens to settle
    // (successfully, not via abort) before the second — the epoch guard must still gate on
    // "is this the LATEST call", not "which one settled first".
    const p1 = loadScene('/sceneA.json');
    await Promise.resolve();
    const p2 = loadScene('/sceneB.json');
    await Promise.resolve();
    const [call1, call2] = h.loadCalls;

    call2.opts.onProgress?.(2, 5);
    expect(useEditorStore.getState().sceneLoadStatus).toEqual({ active: true, loaded: 2, total: 5 });

    // call1 resolves (not aborted) — still not the latest epoch, so its finally is a no-op.
    call1.resolve();
    await p1;
    expect(useEditorStore.getState().sceneLoadStatus).toEqual({ active: true, loaded: 2, total: 5 });

    call2.resolve();
    await p2;
    expect(useEditorStore.getState().sceneLoadStatus.active).toBe(false);
  });

  it('AbortError from a superseded load is swallowed, not logged as a console error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const p1 = loadScene('/sceneA.json');
    await Promise.resolve();
    const [call1] = h.loadCalls;
    call1.reject(new DOMException('Aborted', 'AbortError'));
    await expect(p1).resolves.toBe(false);

    expect(errSpy).not.toHaveBeenCalled();
  });

  it('a genuine (non-abort) load failure IS logged and clears the modal', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const p1 = loadScene('/sceneA.json');
    await Promise.resolve();
    const [call1] = h.loadCalls;
    call1.reject(new Error('HTTP 404'));
    await expect(p1).resolves.toBe(false);

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().sceneLoadStatus.active).toBe(false);
  });

  it('a normal, uncontested load reports progress and clears active on completion', async () => {
    const p1 = loadScene('/sceneA.json');
    await Promise.resolve();
    const [call1] = h.loadCalls;

    expect(useEditorStore.getState().sceneLoadStatus.active).toBe(true);
    call1.opts.onProgress?.(0, 3);
    call1.opts.onProgress?.(3, 3);
    expect(useEditorStore.getState().sceneLoadStatus).toEqual({ active: true, loaded: 3, total: 3 });

    call1.resolve();
    await expect(p1).resolves.toBe(true);
    expect(useEditorStore.getState().sceneLoadStatus.active).toBe(false);
  });
});
