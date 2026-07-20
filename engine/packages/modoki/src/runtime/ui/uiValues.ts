/** Game-bindable UI store — a tiny key→value bag a game publishes for UI text + visibility
 *  bindings (UIBinding.textBinding / visibleBinding), WITHOUT needing zustand/React in game code.
 *
 *  A game system calls `setUIValues({ hearts: 3, enemies: 2, gameOver: false })` whenever its HUD
 *  state changes; the values are merged into the `storeState` the UIRenderer resolves bindings
 *  against (via the auto-registered store hook below). So `text: "Enemies: {enemies}"` and
 *  `visibleBinding: "gameOver"` just work. This is the game-facing complement to the engine's own
 *  fixed store fields (entityCount/gamePhase/fps/…). */
import { useSyncExternalStore } from 'react';
import { addStoreHook } from './storeHooks';
import { onWorldSwap } from '../ecs/world';

type UIValue = string | number | boolean;

let values: Readonly<Record<string, UIValue>> = Object.freeze({});
const listeners = new Set<() => void>();

/** Merge values into the game UI store (only re-renders subscribers when something actually
 *  changed — a per-frame call with unchanged values is a no-op). */
export function setUIValues(patch: Record<string, UIValue>): void {
  let changed = false;
  for (const k in patch) { if (values[k] !== patch[k]) { changed = true; break; } }
  if (!changed) return;
  values = Object.freeze({ ...values, ...patch });
  for (const l of listeners) l();
}

/** Set a single game UI value. */
export function setUIValue(key: string, value: UIValue): void {
  if (values[key] === value) return;
  values = Object.freeze({ ...values, [key]: value });
  for (const l of listeners) l();
}

/** Reset the game UI store (e.g. on scene teardown / a fresh game). */
export function clearUIValues(): void {
  if (Object.keys(values).length === 0) return;
  values = Object.freeze({});
  for (const l of listeners) l();
}

const subscribe = (cb: () => void): (() => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const getSnapshot = (): Readonly<Record<string, UIValue>> => values;

/** Registered as a UIRenderer store hook so game values merge into the binding `storeState`.
 *  Exported for tests; games don't call it directly (setUIValues is the write API). */
export const useGameUIValues = (): Readonly<Record<string, UIValue>> =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

addStoreHook(useGameUIValues);

// Reset the bag on a scene/world swap so a value published by scene A doesn't bleed into scene B's
// first frames (every OTHER storeState field is recomputed from the live world each frame; this is
// the only sticky one). Clears DATA only — the hook stays registered (its count must stay stable
// per the storeHooks Rules-of-Hooks contract). Also resets between serial test worlds.
onWorldSwap(() => clearUIValues());
