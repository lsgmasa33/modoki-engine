/** The one hook on an entity-guid RENAME (#1785): every store that keys something by an entity's durable guid
 *  registers here, and `applyGuidRemap` (`memberHome.ts`) walks the registry after it renames.
 *
 *  `applyGuidRemap` is the one rename — Create Prefab's stamp, its undo and redo, unpack/promote, a detach's relink,
 *  Apply's promoted guids — and it re-keys the world itself: trait values (`remapWorldGuidRefs`) and the guid index.
 *  Nothing outside the world heard it. So a store held under the old guid was read under the new one and missed: a
 *  CameraFrame's gizmo vanished, a collapsed Hierarchy node came back expanded, a pooled view lost its window, R2's
 *  kept orphan rows were never written again (#1778, which was patched with a direct call before this existed).
 *
 *  Each store registers FROM ITS OWN MODULE, when that module loads. That is the whole argument for a registry over a
 *  list of calls here: the stores live in L0, L2, the editor and the app shell, and core imports none of them. It is
 *  also sufficient — a store whose module never loaded holds nothing to re-key.
 *
 *  Registration is BY NAME, and a second registration under a name REPLACES the first: an HMR re-execution of a
 *  registering module must not leave the old closure (bound to the old module's state) running beside the new one.
 *  Listeners are isolated (`notifyListeners`): one that throws is reported and the rest still run, because the rename
 *  has already happened by the time they are told. */

import type { World } from 'koota';
import { notifyListeners } from '../notifyListeners';

/** `remap` is old guid → new guid; `world` is the world the rename happened in. A store that holds one world's
 *  entities (a pooled view, focus, the editor's pointers) checks it; a persisted store keyed by durable guid does not
 *  need to, because a durable guid names one entity whatever world it is live in. */
export type GuidRemapListener = (remap: ReadonlyMap<string, string>, world: World) => void;

const listeners = new Map<string, GuidRemapListener>();

/** Register `fn` under `name`, replacing any listener already there. Returns an unregister that removes `fn` only if
 *  it is still the one registered under `name`. */
export function onGuidRemap(name: string, fn: GuidRemapListener): () => void {
  listeners.set(name, fn);
  return () => { if (listeners.get(name) === fn) listeners.delete(name); };
}

/** Tell every registered store about a rename. Called by `applyGuidRemap` only. */
export function notifyGuidRemap(remap: ReadonlyMap<string, string>, world: World): void {
  if (!remap.size) return;
  notifyListeners(listeners.values(), 'guidRemap', [remap, world]);
}

/** `key` with its guid renamed: the guid is the whole key, or the part before the first `sep` (`viewGuid:slot:field`,
 *  `guid field`). A key naming no renamed guid comes back unchanged. */
export function remapGuidKey(key: string, remap: ReadonlyMap<string, string>, sep = ':'): string {
  const whole = remap.get(key);
  if (whole !== undefined) return whole;
  const at = key.indexOf(sep);
  if (at <= 0) return key;
  const to = remap.get(key.slice(0, at));
  return to === undefined ? key : to + key.slice(at);
}

/** Rename the keys of `set` in place. Every key is mapped from the set as it was, so a remap that swaps two guids
 *  (a → b, b → a) swaps them rather than collapsing both into one. True when anything changed. */
export function remapGuidSet(set: Set<string>, remap: ReadonlyMap<string, string>, sep = ':'): boolean {
  const before = [...set];
  const next = before.map((k) => remapGuidKey(k, remap, sep));
  if (next.every((k, i) => k === before[i])) return false;
  set.clear();
  for (const k of next) set.add(k);
  return true;
}

/** Rename the keys of `map` in place, taking every moving entry out before any goes back (swap-safe, as above). A
 *  moved entry replaces one already under its new key. True when anything moved. */
export function remapGuidMapKeys<V>(map: Map<string, V>, remap: ReadonlyMap<string, string>, sep = ':'): boolean {
  const moving: Array<[string, V]> = [];
  for (const [k, v] of map) {
    const to = remapGuidKey(k, remap, sep);
    if (to !== k) moving.push([to, v]);
  }
  if (!moving.length) return false;
  for (const [k] of [...map]) if (remapGuidKey(k, remap, sep) !== k) map.delete(k);
  for (const [to, v] of moving) map.set(to, v);
  return true;
}

/** Test-only: the names registered now. */
export function _guidRemapListenerNames(): string[] {
  return [...listeners.keys()];
}
