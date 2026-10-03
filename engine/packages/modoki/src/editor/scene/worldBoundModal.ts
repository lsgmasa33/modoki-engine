/** A modal that asks about the world it was opened on closes when the editor replaces that world (#1936).
 *
 *  A dialog reads its rows, its entity ids and its question from the live world when it opens, and is answered later. A
 *  route that replaces the world while it is up (a scene load, an outside-change hot reload, New Scene, a prefab-edit
 *  open or exit, a Stop or preview restore, an Apply's undo) left it on screen: still blocking every key, Cmd+S included,
 *  still listing rows for a world that is gone, and its answer then acted on that world or on nothing at all. The prefab
 *  Apply/Revert dialog's Confirm closed with nothing written; the prefab-edit overwrite confirm wrote a snapshot of an
 *  edit that had been left. Nothing tied a modal's lifetime to its world: only the scene-conflict dialog closed from
 *  code, through its own outside-change watcher (#1924).
 *
 *  So every modal whose question is ABOUT the world binds to it here, and closes, says so, and does nothing when it is
 *  replaced. It does not retarget the same guid in the new world — the owner's call on #868, for the prefab dialog: the
 *  human checked rows of the world they were shown. Asset- and disk-bound modals do not bind; their subject survives a
 *  world swap.
 *
 *  ⚠️ Checked a TICK after the swap, not inside the swap listener: `stepSimulation` swaps OUT and BACK within one call,
 *  and an agent's sim step must not close the human's dialog. The same deferral, for the same reason, as
 *  `editorRefLiveness`. The cost is a one-tick window in which a modal is still up over the new world, so a caller that
 *  ACTS on the world still re-checks it after its await (the prefab dialog's pin, Create Prefab's adoption gate, the
 *  prefab-edit save's own check). Not covered, deliberately: `createTestWorld` holds its world from creation to
 *  `dispose()`, so a headless playtest run in the live editor across an await DOES replace the world for that long,
 *  and closes what is open — every live read in that window sees the test world too.
 *
 *  ⚠️ **A swap is not always a moot question.** A game's own scene load during Play swaps the world, but the unsaved
 *  gates list work tracked by the undo history, which that load does not touch — their question is unchanged. Such a
 *  modal passes `stillAsks`, and stays up (watching the new world) while it answers true. ⚠️ **Asked once the editor's
 *  routes have SETTLED, not at the tick:** an editor load clears the dirt it discards in its adopt, which lands after
 *  `SceneManager.loadScene`'s own awaits (manager inits) — past the tick. Asked at the tick, the old list still matched,
 *  and the gate stayed up over work that load had already thrown away (close-out re-review). A runtime navigation
 *  during Play registers no route, so it is asked at once. A `stillAsks` that throws closes the modal. */

import type { World } from 'koota';
import { getCurrentWorld, onWorldSwap } from '../../runtime/core/ecs/world';
import { useEditorStore } from '../store/editorStore';
import { adoptionsSettledGate } from './adoptionGate';

/** Call `onReplaced` once, a tick after `world` stops being the current world. Returns the unsubscribe, which a modal
 *  calls when it closes for any other reason — a watcher left behind would close nothing, but would stay subscribed. */
export function watchWorldReplaced(world: World, onReplaced: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let unsubscribe: () => void = () => {};
  const stop = () => {
    stopped = true;
    unsubscribe();
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  const check = () => {
    timer = null;
    if (stopped || getCurrentWorld() === world) return;
    stop();
    onReplaced();
  };
  const schedule = () => { if (!stopped && timer === null) timer = setTimeout(check, 0); };
  unsubscribe = onWorldSwap(schedule);
  // Already replaced by the time the modal bound (a swap between the gesture and the open): the same deferred check.
  if (getCurrentWorld() !== world) schedule();
  return stop;
}

/** The sentence a world-bound modal closes with: `what` names the dialog, `retry` says how to ask again. */
export function worldReplacedNotice(what: string, retry: string): string {
  return `${what} closed: the scene was reloaded while it was open, so nothing was done. ${retry}`;
}

/** Say it in the console as well as the toast: a toast lasts seconds and no agent reads it, and a dialog that vanished
 *  with no record was the "silent" half of #1936. */
export function reportWorldReplaced(notice: string): void {
  console.warn(`[Editor] ${notice}`);
  useEditorStore.getState().showToast(notice, 'warn');
}

export interface WorldBoundOptions {
  /** The world the question is about (default: the current one). Pass the one captured before an await. */
  world?: World;
  /** Asked when the world is replaced: true keeps the modal up, watching the new world — its question did not change. */
  stillAsks?: () => boolean;
}

/** Ask a plain-DOM modal (`openChoiceModal`, `confirmInEditor`) bound to its world: `ask` gets a signal that aborts once
 *  the world is replaced, which closes the modal as its cancel answer, after `notice` is reported. The watch ends with
 *  the question, however it ends. */
export async function askWhileWorldHolds<T>(
  notice: string,
  ask: (signal: AbortSignal) => Promise<T>,
  opts: WorldBoundOptions = {},
): Promise<T> {
  const replaced = new AbortController();
  let stop = () => {};
  let asking = true;
  const close = () => {
    reportWorldReplaced(notice);
    replaced.abort();
  };
  const stillAsks = (): boolean => {
    try { return opts.stillAsks?.() ?? false; } catch (e) {
      console.error('[Editor] a world-bound modal could not re-read its question, so it closes:', e);
      return false;
    }
  };
  const bind = (world: World) => {
    stop = watchWorldReplaced(world, () => {
      if (!opts.stillAsks) { close(); return; }
      const settling = adoptionsSettledGate();
      const decide = () => {
        if (!asking) return;
        if (stillAsks()) bind(getCurrentWorld()); else close();
      };
      if (settling) void settling.then(decide); else decide();
    });
  };
  bind(opts.world ?? getCurrentWorld());
  try {
    return await ask(replaced.signal);
  } finally {
    asking = false;
    stop();
  }
}
