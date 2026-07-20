/** Control-track spawn registry — the live prefab instances a timeline's control tracks created,
 *  keyed `${directorId}:${trackId}:${clipIndex}` → spawned root ecs id. A clip's END (and a loop
 *  re-spawn) destroys the exact instance it made. Depends only on the world-swap hook so the
 *  scene-swap teardown and the preview-restore path can clear it without a cycle through
 *  `timelineSystem`.
 *
 *  BOTH the keys (Director `rootId`) and the values (spawned ecs id) are runtime entity ids that
 *  are LOCAL to one world and reassigned on the next scene load. So a stale entry surviving a
 *  scene swap could make `controlSpawn`'s "already spawned? destroy it first" branch call
 *  `deleteEntity` on an unrelated live entity that happens to reuse the id. The module-level
 *  `onWorldSwap` reset below drops the whole map on every world promotion (mirroring
 *  `focusManager` / `uiValues`) so no world-local id ever leaks across a swap. */

import { onWorldSwap } from '../ecs/world';

let _spawns = new Map<string, number>();

export function getControlSpawn(key: string): number | undefined { return _spawns.get(key); }
export function setControlSpawn(key: string, id: number): void { _spawns.set(key, id); }
export function hasControlSpawn(key: string): boolean { return _spawns.has(key); }
export function deleteControlSpawn(key: string): void { _spawns.delete(key); }
/** Snapshot of every tracked (key → spawned id) — for teardown that must DESTROY the entities
 *  (editor scrub cleanup), which `clearControlSpawns` (map-only) does not. */
export function listControlSpawns(): [string, number][] { return [..._spawns]; }

/** Drop the registry (scene swap / preview restore — the spawned entities are gone with the world).
 *  Does NOT delete entities; the caller already tore the world down. No alloc when already empty. */
export function clearControlSpawns(): void { if (_spawns.size) _spawns = new Map(); }

// A world-local registry MUST NOT survive a world swap — clear it whenever the active world changes.
onWorldSwap(() => clearControlSpawns());
