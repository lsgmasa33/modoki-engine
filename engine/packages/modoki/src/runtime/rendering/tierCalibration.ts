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
  getActiveQualityTier, getAssessedQualityTier, setActiveQualityTier, getEffectiveThreeSettings,
  getEffectiveTargetFps, getRenderSettings,
} from './renderSettings';
import { setTargetFPS } from './frameDriver';
import {
  evaluateTierChange, freshTierChangeState, promotionCeiling, configCount,
  type QualityTier, type TierChangeState, type TierSource,
} from './qualityTier';
import { hasPlayerQualityTier } from './playerQualityTier';

/** How often the profile is judged. Not every frame: the policy needs a SUSTAINED signal
 *  (`PROMOTION_HOLD_MS` is 5 s), so sampling faster buys nothing and just reads the ring buffer
 *  more often. Any value well under the hold times preserves their meaning. */
export const CALIBRATION_INTERVAL_MS = 500;

let state: TierChangeState = freshTierChangeState();
let lastCheck = 0;
/** Whether the "held at the assessed ceiling" explanation has already been printed this session. */
let loggedHold = false;
/** A promotion waiting for a scene boundary. Promotions are NOT applied where they are decided —
 *  see `applyPendingPromotion`. */
let pendingPromotion: { tier: QualityTier; reason: string } | null = null;

/** Reset all calibration state. For tests, and for a deliberate fresh session. */
export function resetTierCalibration(): void {
  state = freshTierChangeState();
  lastCheck = 0;
  pendingPromotion = null;
  loggedHold = false;
}

/** Test seam: what is queued for the next scene boundary, if anything. */
export function getPendingTierPromotion(): { tier: QualityTier; reason: string } | null {
  return pendingPromotion;
}

/** May a tier's `targetFps` reach the frame driver? Default TRUE — a shipped game is the case
 *  this exists for, so the safe default is "the cap works". */
let frameCapEnabled = true;

/** Opt the tier's FRAME CAP out, without touching any of its other knobs. The editor calls this
 *  (`app/main.tsx`, beside `setJournalEnabled`/`setDebugMenuEnabled`/`setDebugHandlesEnabled` —
 *  the established shape for "the editor is not a shipped game").
 *
 *  ⚠️ **WHY THIS ONE KNOB IS SPECIAL.** `targetFPS` is a single module-level global in
 *  `frameDriver` gating EVERY registered callback — the ECS tick and `PRIORITY_EDITOR_3D` /
 *  `PRIORITY_EDITOR_2D` alongside the game's own render passes. `tickTierCalibration` runs from
 *  `Scene3D`, which the EDITOR mounts, and two viewports doing double the work is precisely what
 *  pushes a frame profile over budget — so without this a demotion inside the editor would
 *  throttle the AUTHOR'S WHOLE SESSION to the tier's cap, gizmo dragging and panel updates
 *  included, for a symptom the shipped build never had. Every other tier knob degrades how the
 *  preview LOOKS, which is arguably informative; this one degrades the tool.
 *
 *  ⚠️ **A RUNTIME SETTER, DELIBERATELY, NOT `if (!__MODOKI_EDITOR__)` AT THE CALL SITE.** That was
 *  tried first and is wrong twice over: no `runtime/**` module references that build-time global
 *  today (every real use is in `engine/app/**`), and it resolves TRUE under both `vitest` and a
 *  plain `npm run dev`, so the gate would have silently disabled the cap for a developer running
 *  their own game — and made the behaviour untestable by construction, which is how a knob like
 *  this rots. An injected flag keeps the decision where the other three like it already live.
 *
 *  The cost, stated rather than discovered: GameView does not preview the frame cap. That is the
 *  right trade — the editor is not the shipping target — and it matches `Canvas2DMount`'s opt-in
 *  `applyWebSizeMode`, which exists so a game's config can never shrink the editor's viewport. */
export function setTierFrameCapEnabled(enabled: boolean): void {
  frameCapEnabled = enabled;
}

/** Push whatever the CURRENTLY ACTIVE tier implies into the live runtime. Reads the tier from
 *  `renderSettings`; publishing it is the caller's job.
 *
 *  ⚠️ **CALL THIS FROM EVERY PUBLISH POINT, INCLUDING THE FIRST ONE (#202).** It was inlined in
 *  {@link applyQualityTier} — which runs only on a live promote/demote and on a player's menu
 *  choice — while the tier a device actually ships with is published by
 *  `scene3DSync.resolveActiveTierOnce` calling `setActiveQualityTier` DIRECTLY. Three survives
 *  that because `makeWebGPURenderer` re-reads `getEffectiveThreeSettings()` immediately after
 *  awaiting the resolution; the frame cap and the 2D backing size have no such reader, so wiring
 *  them into `applyQualityTier` alone would have left both inert on the path nearly every device
 *  takes and never leaves. That is a field that reads as wired and does nothing — the failure this
 *  workstream keeps producing.
 *
 *  What it can and cannot apply is unchanged from the header: the two `antialias` fields are
 *  constructor options (a `WebGPURenderer`'s swapchain, a Pixi `Application`'s), so they catch up
 *  on the next renderer/slot creation rather than being walked back live. */
export function applyActiveTierToRuntime(): void {
  const r = getActiveRenderer() as unknown as { shadowMap?: { enabled: boolean } } | null;
  const three = getEffectiveThreeSettings();
  if (r?.shadowMap) r.shadowMap.enabled = three.shadows;
  // The frame cap. Re-derived from the AUTHORED value every time rather than remembered, so a
  // promotion back up restores what the project asked for instead of whatever a demotion left.
  //
  // ⚠️ Gated, and this is the one knob that needed to be — see {@link setTierFrameCapEnabled}.
  if (frameCapEnabled) setTargetFPS(getEffectiveTargetFps());
  // Re-runs every surface's own resize handler, which recomputes the pixel ratio from the now
  // tier-adjusted cap — `Scene3D`'s observer AND `Canvas2DMount`'s `updateSize`, both of which are
  // on this bus and both of which re-read the settings on every run. That is the whole of "apply
  // the new DPR cap" for 3D and 2D alike. `shadowMapCeiling` needs no call — syncLights re-reads
  // it each frame.
  forceResizeAllSurfaces();
}

export function applyQualityTier(tier: QualityTier, source: TierSource, reason: string): void {
  setActiveQualityTier({ tier, source, reason });
  applyActiveTierToRuntime();

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

  // ⭐ ONE CONFIG ⇒ NOTHING TO CHANGE TO (plan §2.2/§4). The boot probe already skips itself in
  // this case; this is the same rule applied to the LIVE half, and it is the less obvious of the
  // two. With only the default authored, every tier resolves to the same unclamped overrides — so
  // a demotion would move the tier NAME, free no memory, drop no effect, and cost a `[qualityTier]
  // switched to…` log and a `forceResizeAllSurfaces()` on a device that is already struggling.
  // Doing nothing is not a missing safety net here; it is the accurate statement that this project
  // did not author one. A project that wants the net authors a `low`.
  if (configCount(getRenderSettings().three.tiers) <= 1) return;

  const active = getActiveQualityTier();
  if (!active) return; // no renderer has resolved a tier yet

  if (now - lastCheck < CALIBRATION_INTERVAL_MS) return;
  lastCheck = now;

  // The ceiling comes from the ASSESSED resolution, never the active one — see `promotionCeiling`.
  //
  // ⚠️ THE TWO AGREE TODAY, AND THAT IS A COINCIDENCE WORTH NOT DEPENDING ON. Every live change
  // republishes with `source: 'measured'`, and `promotionCeiling` caps `'measured'` at its own
  // tier, so reading `active` would currently produce the same number. It stops being the same
  // number the moment a live change writes any source whose rule is not "cap at yourself" —
  // `'calibrating'` gets a step, so a promotion that wrote it would authorise the next promotion,
  // and the ladder would have no top. The cap is a property of what ASSESSED the device, so it
  // reads the thing that holds that, and does not rely on a string chosen elsewhere for a
  // different purpose. It is also what keeps the log below honest: `active.source` is `'measured'`
  // on a device nothing ever measured.
  const assessed = getAssessedQualityTier();
  const ceiling = promotionCeiling(assessed);
  const { decision, state: next } = evaluateTierChange(active.tier, getFrameProfile(), state, now, ceiling);
  state = next;

  // ⚠️ THE TARGET TIER COMES FROM THE DECISION, never from a literal here. It used to be
  // `'low'`/`'high'` at these two call sites, which was correct only while there were exactly two
  // tiers — with `mid` (#188) a hardcoded demote would have skipped straight past it, turning a
  // one-step ladder into an all-or-nothing switch. The policy owns the ladder (`TIER_ORDER`); this
  // module only applies what it decided.
  if (decision.action === 'hold') {
    // ONCE PER SESSION. The policy re-reports every PROMOTION_HOLD_MS (it has no memory), and a
    // capped device on a light scene qualifies on every single evaluation — so an undeduped log
    // would print every 5 s for the life of the process and train everyone to filter it out.
    if (!loggedHold) {
      loggedHold = true;
      console.warn(
        `[qualityTier] holding at '${active.tier}' — ${decision.reason}`
        + `${assessed ? ` (assessed via ${assessed.source}: ${assessed.reason})` : ''}`,
      );
    }
  } else if (decision.action === 'demote') {
    // IMMEDIATE. A demotion is an emergency, not an upgrade: the device is already missing the
    // budget, and deferring relief to a scene boundary could mean never (a game with one scene).
    applyQualityTier(decision.tier, 'measured', decision.reason);
  } else if (decision.action === 'promote') {
    // DEFERRED. A tier switch recompiles shaders, and boot on the Y6 already produced a 6.65 s
    // frameDriver stall from prewarm alone. A promotion that freezes mid-play for several seconds
    // is worse than the low tier it escapes; a scene load hides the recompile inside a stall the
    // player has already accepted.
    pendingPromotion = { tier: decision.tier, reason: decision.reason };
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
