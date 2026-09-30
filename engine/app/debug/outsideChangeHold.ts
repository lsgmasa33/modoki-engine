/** The HOLD in front of the watcher's reloads (#1879): an outside change to a scene, prefab or asset-def file is noted
 *  here and applied only when the editor regains focus or an agent calls `modoki_refresh` — Unity's Auto Refresh and
 *  `AssetDatabase.Refresh()`. A git pull of N files becomes ONE refresh, and nothing reloads under a human mid-edit.
 *
 *  Only the watcher's messages come here (`agentBridge.ts`, both hosts). The editor's own put-backs — a discarded park
 *  re-imported in place, `reloadPrefabFromDisk` — are the editor's work, not an outside change, and never wait.
 *
 *  Keyed by path: a second write of a held file replaces its message and moves it to the end, so the batch replays in
 *  the order of the latest writes (the order `replaySuppressedSceneReloads` keeps for a deferral, which is where a
 *  release hands them). Listeners hear every change of the held list: the backend stamps it on every MCP answer, so an
 *  agent never measures a stale editor without knowing it. */

import { notifyListeners } from '@modoki/engine/runtime/core/notifyListeners';

export interface HeldChange { urlPath: string }

export interface OutsideChangeHold<M extends HeldChange> {
  hold(msg: M): void;
  /** Take every held change, in replay order, and empty the hold. */
  take(): M[];
  /** Put changes back that a release did not apply (a scene whose unsaved work waits for a decision). A change held since
   *  for the same path is newer and wins. */
  putBack(msgs: readonly M[]): void;
  paths(): string[];
  /** The held changes, in replay order, left held. */
  peek(): M[];
  /** Remove every held change `pred` picks (a load that read the file applied it, #1899). Returns what it removed. */
  drop(pred: (msg: M) => boolean): M[];
  onChange(cb: (paths: string[]) => void): () => void;
}

export function createOutsideChangeHold<M extends HeldChange>(): OutsideChangeHold<M> {
  const held = new Map<string, M>();
  const listeners = new Set<(paths: string[]) => void>();
  const paths = () => [...held.keys()];
  const notify = () => notifyListeners(listeners, 'outsideChangeHold', [paths()]);
  return {
    hold(msg) {
      held.delete(msg.urlPath);
      held.set(msg.urlPath, msg);
      notify();
    },
    take() {
      const out = [...held.values()];
      if (!out.length) return out;
      held.clear();
      notify();
      return out;
    },
    putBack(msgs) {
      let changed = false;
      for (const m of msgs) if (!held.has(m.urlPath)) { held.set(m.urlPath, m); changed = true; }
      if (changed) notify();
    },
    paths,
    peek: () => [...held.values()],
    drop(pred) {
      const out = [...held.values()].filter(pred);
      for (const m of out) held.delete(m.urlPath);
      if (out.length) notify();
      return out;
    },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
}
