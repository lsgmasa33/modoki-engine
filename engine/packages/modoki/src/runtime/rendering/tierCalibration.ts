/** Quality-tier calibration loop (#121 P3b) — the thing that makes `auto` mean something.
 *
 *  P3a wired a PINNED tier through to the renderer. `auto` resolved correctly and then sat there:
 *  `resolveTier` starts an unrecognised device at `low` and marks it `calibrating`, but nothing
 *  ever measured, so nothing ever promoted. This is the measuring half.
 *
 *  The DECISION is not made here — `qualityTier.ts` owns it (`evaluateTierChange`: vsync-aware
 *  headroom, hold times, sticky demotion), pure and already tested. This module only supplies the
 *  three things that policy refuses to own: a profile, a clock reading, and somewhere to put the
 *  answer. Keeping it that way is what lets every branch of the policy be tested without waiting
 *  real seconds.
 *
 *  ── WHAT A LIVE TIER CHANGE CAN AND CANNOT APPLY ──────────────────────────────────────────
 *  Three of the four tier knobs are live-changeable; `antialias` is NOT — it is a
 *  `WebGPURenderer` CONSTRUCTOR option, baked into the swapchain, and changing it requires
 *  building a new renderer.
 *
 *    pixelRatioCap     → applied via the resize bus (see below)
 *    shadows           → renderer.shadowMap.enabled
 *    shadowMapCeiling  → re-read every frame by syncLights, so it follows on its own
 *    antialias         → NEXT RENDERER CREATION ONLY
 *
 *  We deliberately do NOT rebuild the renderer to apply antialias. A rebuild costs the measured
 *  ~316 ms hitch (see rendering.md), which is a lot to pay during a DEMOTION — the one moment the
 *  device is already struggling and the point is to give it relief immediately. AA is also the
 *  smallest of the four knobs. So a live demote applies the three that matter and antialias
 *  catches up whenever a renderer is next created. This is a stated limitation, not an oversight.
 *
 *  ── WHY THE RESIZE BUS ────────────────────────────────────────────────────────────────────
 *  `pixelRatioCap` is not applied by writing a number anywhere: the real value is
 *  `clampPixelRatio(w, h, basePixelRatio(dpr, cap), web)`, which needs the live container size.
 *  Scene3D's `applyResize` already computes exactly that from `getEffectiveThreeSettings()`.
 *  Re-running it is therefore the whole of "apply the new cap", and it keeps ONE implementation
 *  of the clamp instead of a second copy here that could drift. */

import { rawNow } from '../core/clock';
import { getFrameProfile } from '../core/frameProfiler';
import { getActiveRenderer } from '../core/activeRenderer';
import { forceResizeAllSurfaces } from './resizeBus';
import {
  getActiveQualityTier, setActiveQualityTier, getEffectiveThreeSettings, getRenderSettings,
} from './renderSettings';
import {
  evaluateTierChange, freshTierChangeState,
  type QualityTier, type TierChangeState, type TierSource,
} from './qualityTier';
import { hasPlayerQualityTier } from './playerQualityTier';

/** How often the profile is judged. Not every frame: the policy needs a SUSTAINED signal
 *  (`PROMOTION_HOLD_MS` is 5 s), so sampling faster buys nothing and just reads the ring buffer
 *  more often. Any value well under the hold times preserves their meaning. */
export const CALIBRATION_INTERVAL_MS = 500;

let state: TierChangeState = freshTierChangeState();
let lastCheck = 0;
/** A promotion waiting for a scene boundary. Promotions are NOT applied where they are decided —
 *  see `applyPendingPromotion`. */
let pendingPromotion: { tier: QualityTier; reason: string } | null = null;

/** Reset all calibration state. For tests, and for a deliberate fresh session. */
export function resetTierCalibration(): void {
  state = freshTierChangeState();
  lastCheck = 0;
  pendingPromotion = null;
}

/** Test seam: what is queued for the next scene boundary, if anything. */
export function getPendingTierPromotion(): { tier: QualityTier; reason: string } | null {
  return pendingPromotion;
}

/** Push a tier into the renderer. Applies only what can be applied live — see the header.
 *
 *  Exported because the player-facing setting (#121 P3d) needs the same application path: a player
 *  choosing a tier in a settings menu must see it take effect now, not on the next launch. Keeping
 *  ONE apply function means the live knobs (and the antialias caveat) can never diverge between
 *  the two callers. */
export function applyQualityTier(tier: QualityTier, source: TierSource, reason: string): void {
  setActiveQualityTier({ tier, source, reason });

  const r = getActiveRenderer() as unknown as { shadowMap?: { enabled: boolean } } | null;
  const three = getEffectiveThreeSettings();
  if (r?.shadowMap) r.shadowMap.enabled = three.shadows;
  // Re-runs every surface's own resize handler, which recomputes the pixel ratio from the now
  // tier-adjusted cap. `shadowMapCeiling` needs no call — syncLights re-reads it each frame.
  forceResizeAllSurfaces();

  console.warn(
    `[qualityTier] switched to '${tier}' — ${reason}. `
    + 'Anti-aliasing changes only take effect on the next renderer creation (constructor option).',
  );
}

/** Judge the current frame profile and act. Call once per frame; it throttles itself.
 *
 *  A no-op unless the project asked for `'auto'` — a pinned tier is a decision the project
 *  already made, and measuring its way out of it would silently override the author. */
export function tickTierCalibration(now: number = rawNow()): void {
  if (getRenderSettings().three.qualityTier !== 'auto') return;
  // A PLAYER CHOICE OUTRANKS MEASUREMENT. Without this, someone who picked `low` in a settings
  // menu on an `auto` project would be silently promoted back to `high` five seconds later by the
  // calibration loop — the engine overriding an explicit human decision with an inference, which
  // is the one thing the player control exists to prevent.
  if (hasPlayerQualityTier()) return;
  const active = getActiveQualityTier();
  if (!active) return; // no renderer has resolved a tier yet

  if (now - lastCheck < CALIBRATION_INTERVAL_MS) return;
  lastCheck = now;

  const { decision, state: next } = evaluateTierChange(active.tier, getFrameProfile(), state, now);
  state = next;

  if (decision.action === 'demote') {
    // IMMEDIATE. A demotion is an emergency, not an upgrade: the device is already missing the
    // budget, and deferring relief to a scene boundary could mean never (a game with one scene).
    applyQualityTier('low', 'measured', decision.reason);
  } else if (decision.action === 'promote') {
    // DEFERRED. A tier switch recompiles shaders, and boot on the Y6 already produced a 6.65 s
    // frameDriver stall from prewarm alone. A promotion that freezes mid-play for several seconds
    // is worse than the low tier it escapes; a scene load hides the recompile inside a stall the
    // player has already accepted.
    pendingPromotion = { tier: 'high', reason: decision.reason };
  }
}

/** Apply a queued promotion. Call at a scene boundary (SceneManager's before-swap hook), where
 *  the shader recompile is hidden inside a load the player has already accepted. */
export function applyPendingTierPromotion(): void {
  if (!pendingPromotion) return;
  const { tier, reason } = pendingPromotion;
  pendingPromotion = null;
  applyQualityTier(tier, 'measured', `${reason} (applied at a scene boundary)`);
}
