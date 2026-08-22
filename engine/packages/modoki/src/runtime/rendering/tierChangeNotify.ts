/** The game-facing quality-tier notification seam (#241).
 *
 *  A game could already READ the tier (`getActiveTierOrDefault`) and a player could CHOOSE one,
 *  but nothing could TELL a game the tier had changed — so anything a game wants to degrade for
 *  itself (spawn counts, particle budgets, an LOD bias, an expensive gameplay effect) had to poll
 *  and hope it read at the right moment. Polling is adequate at a scene boundary and wrong for the
 *  case the tier system exists for: calibration demotes mid-session, on the weak hardware where a
 *  game's own degradation matters most.
 *
 *  ⚠️ **PUBLISHED FROM `setActiveQualityTier`, NOT FROM `applyQualityTier` — and that distinction
 *  is #202 repeating itself.** `applyQualityTier` looks like the single funnel and is not: it runs
 *  on a live promote/demote and on a player's menu choice, while the tier a device actually SHIPS
 *  WITH is published by `tierResolve.publishActiveTier` calling `setActiveQualityTier` directly.
 *  Wiring a new tier consumer into `applyQualityTier` alone is exactly how the frame cap and the
 *  2D backing size ended up inert on the path nearly every device takes and never leaves. So this
 *  hangs off the one place the active tier value actually changes.
 *
 *  Unlike `onTierSwitchOverlay` — the other listener seam in this subsystem, which carries overlay
 *  COPY and documents that it has exactly one intended reader — this one is explicitly
 *  MULTI-subscriber. N games and systems reading a value cannot conflict the way two overlay
 *  renderers would.
 *
 *  A listener rather than a store write, for the same layer reason the overlay seam gives:
 *  `runtime/store` is L3 and `runtime/rendering` is L2, so an upward import is an ESLint error. */

import { emit } from '../core/journal';
import { peekCurrentWorld } from '../core/ecs/worldRegistry';
import type { QualityTier, TierResolution } from './qualityTier';

/** `prev` is `null` on the first resolution of a session — the tier a device booted into,
 *  which is a change from "nothing decided yet" and is delivered rather than swallowed. */
export type QualityTierChangeListener = (res: TierResolution, prev: QualityTier | null) => void;

const listeners = new Set<QualityTierChangeListener>();

/** Subscribe to live quality-tier changes. Returns an unsubscribe function.
 *
 *  Fires on every change of the ACTIVE tier: the first-of-session resolution (`prev === null`), a
 *  calibration demote/promote, and a player's explicit pick. It does NOT fire when the tier is
 *  re-published unchanged — a new `reason` for the same tier is not a tier change — nor on
 *  teardown, when the active tier is cleared. */
export function onQualityTierChange(fn: QualityTierChangeListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Drop every subscriber. For test isolation — NOT part of a normal reset: a subscription is a
 *  caller's, and a settings reset has no business cancelling one. */
export function resetQualityTierChangeListeners(): void {
  listeners.clear();
}

/** Announce a tier change. Called by `setActiveQualityTier`, which owns deciding that the tier
 *  actually changed. */
export function publishQualityTierChange(res: TierResolution, prev: QualityTier | null): void {
  // ⚠️ `peekCurrentWorld`, never `getCurrentWorld` — the latter LAZILY CREATES a world, and a tier
  // resolves at renderer bring-up, which can precede any game world. Spawning one here would both
  // journal into a world nothing else uses and count against koota's 16-world cap in fresh-module
  // tests. No world yet simply means nobody could have read the event.
  const world = peekCurrentWorld();
  if (world) emit('@tier', { tier: res.tier, prev, source: res.source, reason: res.reason }, world);

  for (const fn of listeners) {
    try { fn(res, prev); } catch (e) { console.warn('[qualityTier] tier-change listener failed:', e); }
  }
}
