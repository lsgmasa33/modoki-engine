// @vitest-environment jsdom
/** #1936 — a modal that asks about the world closes when the editor replaces that world (`scene/worldBoundModal.ts`).
 *
 *  The prefab Apply/Revert dialog stayed up across a scene load: rows for a world that was gone, Cmd+S swallowed, and a
 *  Confirm that closed with nothing written. Every world-bound modal binds to the one watcher here, so its timing is
 *  the mechanism under test — real `setCurrentWorld` swaps, a real plain-DOM `save-dialog`.
 *
 *  Mutations, each checked:
 *  - fire inside the swap listener instead of a tick later — the out-and-back case goes red;
 *  - drop the `getCurrentWorld() === world` re-check at the tick — the out-and-back case goes red;
 *  - `stop` not unsubscribing, or not clearing the pending check — the 'stop ends the watch' case goes red;
 *  - drop the at-bind check — the already-replaced case goes red;
 *  - drop the `signal` wiring in `saveDialog.openModal` — the confirm cases go red;
 *  - drop the `finally { stop() }` in `askWhileWorldHolds` — the answered-first case goes red;
 *  - `runOnPinnedSubject` always saying "deleted" — the reloaded-notice case goes red;
 *  - `stillAsks` ignored (or not re-bound to the new world) — the still-asks case goes red;
 *  - `sceneReparentTargets` without its world check — the reparent case goes red. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createWorld, type World } from 'koota';
import { getCurrentWorld, setCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { worldSwapListenerCount } from '../../packages/modoki/src/runtime/core/ecs/worldRegistry';
import {
  watchWorldReplaced, askWhileWorldHolds, worldReplacedNotice,
} from '../../packages/modoki/src/editor/scene/worldBoundModal';
import { confirmInEditor } from '../../packages/modoki/src/editor/utils/saveDialog';
import { clearOverlays } from '../../packages/modoki/src/editor/input/focusScope';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { pinEntityAt } from '../../packages/modoki/src/runtime/core/ecs/entityPin';
import { findEntity } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { runOnPinnedSubject } from '../../packages/modoki/src/editor/panels/prefabDialogSubject';
import { sceneReparentTargets } from '../../packages/modoki/src/editor/undo/entityActions';
import type { EntityRef } from '../../packages/modoki/src/editor/undo/entityRef';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const dialogUp = () => document.querySelector('[data-modal-shell="save-dialog"]') !== null;

let home: World;
const spare: World[] = [];
/** A fresh world to swap to; destroyed in afterEach (koota caps live worlds). */
const fresh = () => { const w = createWorld(); spare.push(w); return w; };

beforeEach(() => { home = getCurrentWorld(); });
afterEach(() => {
  setCurrentWorld(home);
  for (const w of spare.splice(0)) w.destroy();
  document.body.innerHTML = '';
  clearOverlays();
  vi.restoreAllMocks();
});

describe('watchWorldReplaced (#1936)', () => {
  it('fires once, a tick after a swap — not inside it', async () => {
    const fired = vi.fn();
    watchWorldReplaced(home, fired);
    setCurrentWorld(fresh());
    expect(fired, 'not inside the swap').not.toHaveBeenCalled();
    await tick();
    expect(fired).toHaveBeenCalledTimes(1);
    setCurrentWorld(fresh());
    await tick();
    expect(fired, 'once').toHaveBeenCalledTimes(1);
  });

  it('an out-and-back swap within one call (stepSimulation, createTestWorld) does not fire', async () => {
    const fired = vi.fn();
    const stop = watchWorldReplaced(home, fired);
    setCurrentWorld(fresh());
    setCurrentWorld(home);
    await tick();
    expect(fired).not.toHaveBeenCalled();
    // …and it is still watching.
    setCurrentWorld(fresh());
    await tick();
    expect(fired).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stop ends the watch: no listener left subscribed, no timer left pending', () => {
    vi.useFakeTimers();
    try {
      const subscribed = worldSwapListenerCount();
      const stop = watchWorldReplaced(home, () => {});
      expect(worldSwapListenerCount(), 'premise: subscribed').toBe(subscribed + 1);
      setCurrentWorld(fresh());
      expect(vi.getTimerCount(), 'premise: the check is pending').toBe(1);
      stop();
      expect(vi.getTimerCount(), 'the pending check cleared').toBe(0);
      expect(worldSwapListenerCount(), 'unsubscribed').toBe(subscribed);
    } finally { vi.useRealTimers(); }
  });

  it('stopped before the tick, or before any swap, it never fires', async () => {
    const early = vi.fn();
    const stopEarly = watchWorldReplaced(home, early);
    setCurrentWorld(fresh());
    stopEarly();
    await tick();
    expect(early, 'stopped between the swap and the tick').not.toHaveBeenCalled();
    setCurrentWorld(home);
    const later = vi.fn();
    watchWorldReplaced(home, later)();
    setCurrentWorld(fresh());
    await tick();
    expect(later, 'stopped before the swap').not.toHaveBeenCalled();
  });

  it('a world already replaced when the modal binds fires too', async () => {
    const fired = vi.fn();
    const opened = getCurrentWorld();
    setCurrentWorld(fresh());
    watchWorldReplaced(opened, fired);
    await tick();
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

describe('askWhileWorldHolds closes the save-dialog confirm (#1936)', () => {
  const notice = worldReplacedNotice('Move into another scene?', 'Drag it again.');

  it('a world replaced under the question closes it as a No, and says so in the console and a toast', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const answer = askWhileWorldHolds(notice, (signal) => confirmInEditor('Move into another scene?', 'm', 'Move', { signal }));
    expect(dialogUp(), 'up').toBe(true);
    setCurrentWorld(fresh());
    await tick();
    expect(dialogUp(), 'closed').toBe(false);
    await expect(answer).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(`[Editor] ${notice}`);
    expect(useEditorStore.getState().toast).toMatchObject({ message: notice, kind: 'warn' });
  });

  it('answered before any swap, the watch ends with the question', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const answer = askWhileWorldHolds(notice, (signal) => confirmInEditor('t', 'm', 'Move', { signal }));
    (document.querySelector('[data-ui-id="save-dialog.confirm"]') as HTMLButtonElement).click();
    await expect(answer).resolves.toBe(true);
    setCurrentWorld(fresh());
    await tick();
    expect(warn, 'no notice for a question already answered').not.toHaveBeenCalled();
  });

  it('a signal aborted before the confirm opens never leaves it up', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(confirmInEditor('t', 'm', 'OK', { signal: ctl.signal })).resolves.toBe(false);
    expect(dialogUp()).toBe(false);
  });
});

describe("the prefab dialog's confirm-side notice (#1936)", () => {
  it('says the scene was reloaded when the world was replaced, and that the instance is gone when it was deleted', async () => {
    const e = home.spawn();
    const subject = pinEntityAt(e.id(), findEntity, home);
    expect(subject, 'premise: pinned').not.toBeNull();
    const notices: string[] = [];
    const act = vi.fn();
    expect(await runOnPinnedSubject({ subject, lookup: findEntity, world: fresh(), mode: 'apply', act, onGone: (n) => notices.push(n) })).toBe(false);
    e.destroy();
    expect(await runOnPinnedSubject({ subject, lookup: findEntity, world: home, mode: 'apply', act, onGone: (n) => notices.push(n) })).toBe(false);
    expect(act).not.toHaveBeenCalled();
    expect(notices[0]).toMatch(/^Apply Prefab closed: the scene was reloaded while it was open/);
    expect(notices[1]).toMatch(/no longer exists/);
  });
});

describe('a swap that leaves the question unchanged (#1936 close-out review)', () => {
  // A game's own scene load during Play swaps the world, and the unsaved gates' list does not move with it.
  it('stillAsks keeps the modal up, watching the NEW world, until a swap makes the question moot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let unchanged = true;
    const answer = askWhileWorldHolds('n', (signal) => confirmInEditor('t', 'm', 'OK', { signal }), { stillAsks: () => unchanged });
    setCurrentWorld(fresh());
    await tick();
    expect(dialogUp(), 'still up across a swap that changed nothing').toBe(true);
    expect(warn).not.toHaveBeenCalled();
    unchanged = false;
    setCurrentWorld(fresh());
    await tick();
    expect(dialogUp(), 're-bound: the next swap is still seen').toBe(false);
    await expect(answer).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[Editor] n');
  });
});

describe('a stillAsks that throws (#1936 re-review)', () => {
  // Mutation: let the throw escape the timer — the modal stays up, watching nothing.
  it('closes the modal rather than leaving it up unwatched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = askWhileWorldHolds('n', (signal) => confirmInEditor('t', 'm', 'OK', { signal }), { stillAsks: () => { throw new Error('boom'); } });
    setCurrentWorld(fresh());
    await tick();
    expect(dialogUp()).toBe(false);
    await expect(answer).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[Editor] n');
  });
});

describe('sceneReparentTargets — the cross-scene reparent re-check (#1936 close-out review)', () => {
  const ref = (id: number | null) => ({ resolve: () => id }) as unknown as EntityRef;
  it('refuses a world replaced under the prompt even when both guids resolve there; a gone entity too', () => {
    expect(sceneReparentTargets(ref(3), ref(4), home)).toEqual({ moved: 3, parent: 4 });
    expect(sceneReparentTargets(ref(3), ref(null), home)).toBeNull();
    const planned = home;
    setCurrentWorld(fresh());
    expect(sceneReparentTargets(ref(3), ref(4), planned), 'never re-targeted into the new world').toBeNull();
  });
});
