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
import { hasRecentUserInput, msSinceUserInput } from '../core/userActivity';
import { getFrameProfile, resetFrameProfile } from '../core/frameProfiler';
import { onWorldSwap } from '../core/ecs/world';
import { getActiveRenderer } from '../core/activeRenderer';
import { forceResizeAllSurfaces } from './resizeBus';
import {
  getActiveQualityTier, getAssessedQualityTier, setActiveQualityTier, getEffectiveThreeSettings,
  getEffectiveTargetFps, getRenderSettings, getActiveTierOverrides, getTierSwitchMessage,
} from './renderSettings';
import { setTargetFPS } from './frameDriver';
import {
  evaluateTierChange, freshTierChangeState, promotionCeiling, configCount,
  tierAbove, applyTierToTargetFps, resolveTierOverrides, ASSUMED_UNCAPPED_FPS,
  type QualityTier, type TierChangeState, type TierSource,
} from './qualityTier';
import { hasPlayerQualityTier } from './playerQualityTier';
import { setActiveTextureSizeCap } from '../core/textureSizeCap';

/** How often the profile is judged. Not every frame: the policy needs a SUSTAINED signal
 *  (`PROMOTION_HOLD_MS` is 5 s), so sampling faster buys nothing and just reads the ring buffer
 *  more often. Any value well under the hold times preserves their meaning. */
export const CALIBRATION_INTERVAL_MS = 500;

/** How long a queued promotion waits for a scene boundary before giving up and applying itself
 *  mid-play behind the overlay (#227).
 *
 *  A judgement call, and the trade-off is real in both directions: a multi-scene game may have a
 *  free boundary just past this deadline, and applying early spends a visible pause that waiting
 *  would have avoided. Waiting longer makes the mid-play path rarer but leaves a SINGLE-scene game
 *  — which has no boundary, ever — at the lower tier for that much more of its run. 15 s errs
 *  toward landing the promotion, because the overlay makes the pause explained rather than
 *  mysterious, and a promotion that never lands is the failure this whole path exists to fix. */
export const PROMOTION_BOUNDARY_GRACE_MS = 15_000;

/** How long after the first tick calibration arms itself if no world swap ever arrives (#227).
 *
 *  ⚠️ **A FAILSAFE, NOT A GRACE PERIOD, AND THE DIFFERENCE IS WHY IT IS THIS LONG.** The real arm
 *  signal is the first world swap (see the `onWorldSwap` subscription below) — a scene that has
 *  finished loading. This exists only so a project that never completes one cannot leave
 *  calibration asleep for the whole session, which would be #227's own failure shape inverted: a
 *  genuinely slow device that can never be demoted because the mechanism is politely waiting.
 *  A SHORT value would be actively harmful — it would fire DURING a slow first load and hand the
 *  policy exactly the boot frames the arming exists to exclude, which is #227 verbatim. So it must
 *  sit comfortably beyond any plausible load: the worst first-scene prewarm this repo has measured
 *  is postfx-demo's 16.5 s on a Huawei Y6 (`scene3DSync.ts`), and 30 s clears it. */
export const ARM_BACKSTOP_MS = 30_000;

/** How recently a human must have touched the device for the frame profile to count as evidence.
 *
 *  Sized off the LONGER of the two sustain windows the policy uses (`PROMOTION_HOLD_MS` 5 s,
 *  `DEMOTION_HOLD_MS` 2 s): a decision needs at most that much evidence, so requiring input inside
 *  the same span means the frames that voted were plausibly measured while somebody was playing.
 *  Shorter would let a governor that has not yet dropped clocks vote; much longer would let one
 *  that already has. */
export const IDLE_EVIDENCE_MS = 5_000;

/** How long a session must have run before "nobody is touching this" is worth reporting. Long
 *  on purpose: this fires as a `console.warn`, which is a Crashlytics issue, so it must describe
 *  a game whose input is genuinely unwired — not a player who has not tapped yet. */
export const IDLE_REPORT_AFTER_MS = 60_000;

let state: TierChangeState = freshTierChangeState();
let lastCheck = 0;
/** Whether the "held at the assessed ceiling" explanation has already been printed this session. */
let loggedHold = false;
/** Whether the "calibration is idle" explanation has already been printed this session. */
let loggedIdle = false;
/** Was the previous tick inside an idle window? Drives the one-shot window drop on the way OUT —
 *  see the idle gate in {@link tickTierCalibration}. */
let wasIdle = false;
/** A promotion waiting for a scene boundary. Promotions are NOT applied where they are decided —
 *  see `applyPendingPromotion`. `since` is when it was queued, for {@link PROMOTION_BOUNDARY_GRACE_MS}. */
let pendingPromotion: { tier: QualityTier; reason: string; since: number } | null = null;
/** Has calibration been armed — i.e. is the frame profile now describing the GAME rather than a
 *  scene load? See {@link armTierCalibration}. */
let armed = false;
/** When `tickTierCalibration` first ran, so the backstop has something to measure from.
 *
 *  ⚠️ `-1` for "never", NOT `0`. The clock this reads is injected and starts at 0 in every test and
 *  on any manual-clock harness, so a `0` sentinel is indistinguishable from a legitimate first
 *  reading — and the branch below would re-stamp the start on EVERY tick until the clock happened
 *  to move off zero, pushing the deadline forever and disarming the backstop entirely. Caught by
 *  the backstop test, which ticks from 0. */
let firstTickAt = -1;
/** Is an overlay-covered mid-play tier switch in flight? Guards against a second one being started
 *  while the first is still waiting out its frames. */
let switchInFlight = false;

/** Reset all calibration state. For tests, and for a deliberate fresh session. */
export function resetTierCalibration(): void {
  state = freshTierChangeState();
  lastCheck = 0;
  pendingPromotion = null;
  loggedHold = false;
  loggedIdle = false;
  wasIdle = false;
  armed = false;
  firstTickAt = -1;
  switchInFlight = false;
  publishTierSwitchOverlay(null);
}

// ── The tier-switch overlay seam ────────────────────────────────────────────────────────────
//
// ⚠️ **A LISTENER, NOT A STORE WRITE, AND THAT IS A LAYER CONSTRAINT RATHER THAN A PREFERENCE.**
// `runtime/store` is L3 and `runtime/rendering` is L2 (see `engine/eslint.config.js`), so this
// module physically cannot import the game store to publish into — an upward import is an ESLint
// error, and the cycle guard exists because that class of edge is an order-sensitive correctness
// bug. So the engine publishes and the APP SHELL subscribes, which also keeps a UI dependency out
// of the engine package entirely.
//
// There is exactly ONE reader (`engine/app/App.tsx`). Keep it that way: a second subscriber that
// also decides to render something would double the overlay with nothing to arbitrate between them.
type TierSwitchOverlayListener = (message: string | null) => void;
const overlayListeners = new Set<TierSwitchOverlayListener>();

/** Subscribe to tier-switch overlay copy. `message` is the text to show, `null` to hide.
 *  Returns an unsubscribe function. The app shell is the only intended caller. */
export function onTierSwitchOverlay(fn: TierSwitchOverlayListener): () => void {
  overlayListeners.add(fn);
  return () => { overlayListeners.delete(fn); };
}

/** Current overlay copy, for tests and for a late subscriber. */
let overlayMessage: string | null = null;
export function getTierSwitchOverlayMessage(): string | null { return overlayMessage; }

function publishTierSwitchOverlay(message: string | null): void {
  overlayMessage = message;
  for (const fn of overlayListeners) {
    try { fn(message); } catch (e) { console.warn('[qualityTier] overlay listener failed:', e); }
  }
}

/** Arm live calibration: from here on, the frame profile is treated as evidence about what this
 *  device can SUSTAIN (#227).
 *
 *  ── WHY ARMING EXISTS ─────────────────────────────────────────────────────────────────────
 *  Calibration used to start judging the moment a tier resolved, which on `demos/forest-camp` /
 *  Galaxy A23 meant judging GLB parsing and shader compilation. Measured: two independent methods
 *  assessed the device `mid` (`[rampProbe] middle`, then `mid via gpu-benchmark`), and 3.57 s later
 *  a 95.5 ms median — produced entirely inside the load — demoted it to `low` and, because demotion
 *  is sticky, pinned it there for the session. Pinned to `mid` the same scene on the same phone
 *  runs 16.8-20.5 ms, inside the 20 ms budget it was condemned against.
 *
 *  ── WHY IT ALSO RESETS THE PROFILE, WHICH IS THE HALF THAT IS EASY TO MISS ─────────────────
 *  Gating the VERDICT is not enough on its own. `PROFILE_WINDOW_FRAMES` is a frame COUNT (120),
 *  deliberately, so a slow device gets a longer window — at the A23's 95.5 ms load frames that is
 *  ~11.4 s of history. Arming without dropping the window would hand the policy a median still
 *  dominated by the load it just waited out, and the demotion would fire a moment later anyway.
 *  `MIN_SAMPLES_TO_JUDGE` (30) then refills honestly before anything is judged.
 *
 *  Idempotent — the first call wins, so a game with many scene loads arms once. */
export function armTierCalibration(): void {
  if (armed) return;
  armed = true;
  resetFrameProfile();
}

/** Test seam: has calibration armed yet? */
export function isTierCalibrationArmed(): boolean { return armed; }

// THE ARM SIGNAL. `onWorldSwap` fires from `setCurrentWorld` — the atomic swap at the END of a
// scene load, after the staging world is populated AND after the beforeSwap prewarm hook has
// compiled shaders. That is precisely "the scene is loaded", and it is the last expensive thing
// in the sequence.
//
// ⚠️ **`onWorldSwap`, NOT `sceneManager.registerSceneCallback('*', …)`**, which is the API that
// looks purpose-built for this. Its registry is a `Map` KEYED BY PATTERN, so a second `'*'`
// registrant silently REPLACES the first — arming would be one game callback away from vanishing,
// and nothing would report it. `onWorldSwap` holds a `Set` and appends. It is also L0, so this L2
// module may import it (`registerSceneCallback` lives in L3 `scene/` and may not be imported here
// at all), and it covers the 2D path for free — `tierBoot`'s no-Scene3D projects swap worlds
// through the same SceneManager.
// ⚠️ **GATED ON `liveCalibrationEnabled`, and it must be** (close-out 2026-08-18). Arming calls
// `resetFrameProfile()`, and the EDITOR explicitly opts out of live calibration
// (`main.tsx: setTierCalibrationEnabled(!__MODOKI_EDITOR__)`) — but a module-scope listener does
// not care what the tick's gates say, so an ungated one fired there too and zeroed the frame
// window on the first scene load. That window is what `debug/perfSources.ts` feeds to the Profiler
// panel and to `modoki_profiler`, so an agent measuring right after loading the scene it wants to
// measure got percentiles over a handful of frames, or an empty profile, with nothing indicating
// why. A mechanism the editor has opted out of must not have side effects there.
onWorldSwap(() => { if (liveCalibrationEnabled) armTierCalibration(); });

// THE SCENE BOUNDARY, for projects whose renderer does not provide one. `Scene3D` applies a queued
// promotion from its `beforeSwap` prewarm hook — EARLIER than this, and deliberately so, because
// applying the tier first means the prewarm that follows compiles the shaders the new tier actually
// needs. A 2D project has no prewarm hook to hang that on, so the swap itself is its boundary.
// Running on both paths is harmless: whichever fires first clears `pendingPromotion` and the other
// is a no-op.
//
// ⚠️ This REPLACES a per-frame `applyPendingTierPromotion()` in `tierBoot`'s frame callback, whose
// own comment claimed "the promotion is applied at a SCENE BOUNDARY, not here" while the code
// applied it on the very next frame — i.e. mid-play, uncovered, which is what the deferral exists
// to prevent. A mid-play application is now a deliberate path with an overlay
// (`applyPromotionBehindOverlay`), not an accident of where a call sat.
onWorldSwap(() => applyPendingTierPromotion());

/** Test seam: what is queued for the next scene boundary, if anything. `since` is when it was
 *  FIRST queued — see the queue site for why re-deciding must not re-stamp it. */
export function getPendingTierPromotion(): { tier: QualityTier; reason: string; since: number } | null {
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

/** May the LIVE calibration loop change the tier by itself? Default TRUE — a shipped game is what
 *  it exists for. */
let liveCalibrationEnabled = true;

/** Opt live tier calibration out entirely. The editor calls this (`app/main.tsx`), and this is the
 *  broader sibling of {@link setTierFrameCapEnabled}.
 *
 *  ⚠️ **THE FRAME-CAP CARVE-OUT WAS TOO NARROW, AND ITS OWN REASONING SAID SO WITHOUT NOTICING.**
 *  It justified itself with "every other tier knob degrades how the preview LOOKS, which is
 *  arguably informative; this one degrades the tool." The other knobs do not stop at the preview:
 *  `applyActiveTierToRuntime` ends in an UNGATED `forceResizeAllSurfaces()`, and the editor's own
 *  SceneView is on that bus — so a demotion silently dropped IBL, ambient, exposure, the shadow-map
 *  ceiling and the 2D backing buffer on the AUTHORING viewport, stickily, for the rest of the
 *  session. And what trips the demotion is the editor's own double-viewport load, a symptom the
 *  shipped build never has. An author was being quietly moved to worse settings while judging how
 *  their scene looks (review 2026-08-12, R7.4).
 *
 *  Owner's decision: the editor does not auto-calibrate at all. Setting a tier BY HAND still works
 *  (`applyQualityTier`, the debug menu's tier buttons, Project Settings), which is the honest way
 *  to preview `low` — you choose it, rather than the tool deciding your machine is slow.
 *
 *  ⚠️ It also removes a second defect for free, which is why the narrower alternative was not
 *  taken: the live shadow toggle writes `shadowMap.enabled` to `getActiveRenderer()`, a SINGLE
 *  global handle, while the editor registers TWO renderers — so which viewport received it depended
 *  on registration order, and that order changes whenever a context-loss rebuild or a SceneView
 *  remount re-registers. With no live tier change in the editor, the ambiguous case cannot arise.
 *  A shipped game has one renderer, so nothing there needs the per-renderer state that fixing it
 *  properly would require.
 *
 *  Deliberately NOT the other route considered — making SceneView read `getRenderSettings()`
 *  instead of the `getEffective*` accessors. That would re-create exactly the
 *  code-shadows-the-source-of-truth split `renderSettings.ts` documents as the reason there is ONE
 *  resolution point, and it would only cover the fields somebody remembered to change. */
export function setTierCalibrationEnabled(enabled: boolean): void {
  liveCalibrationEnabled = enabled;
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
  // Texture LOD by quality tier (#212). Not a `ThreeRenderSettings` field — there is no
  // project-authored counterpart to clamp against (unlike `pixelRatioCap`), so this reads the
  // resolved tier's own `textureMaxSize` directly rather than through `getEffectiveThreeSettings`.
  // Written to the L0 seam (`runtime/core/textureSizeCap.ts`) so `textureResolver.ts` can read
  // it without `runtime/loaders` statically importing `runtime/rendering` — see that module's
  // header. No `forceResizeAllSurfaces()`-style re-apply needed: a texture in flight keeps
  // loading at whatever cap was active when it was requested, exactly like every other
  // already-loaded resource under a live tier change.
  setActiveTextureSizeCap(getActiveTierOverrides().textureMaxSize);
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

  // `log`, not `warn` — same rule as tierResolve's boot lines, and this one was MISSED by that
  // sweep. Measured on a Galaxy S22 (2026-08-20): a cold boot switched to 'mid' and then 'low' as
  // the first frames came in over budget, and with `console.warn` reporting as a Crashlytics ISSUE
  // that is two alerting issues per session for the adaptive tier system working exactly as
  // designed. The device that most needs the headroom is the one that files the most noise.
  console.log(
    `[qualityTier] switched to '${tier}' — ${reason}. `
    + 'Anti-aliasing changes only take effect on the next renderer creation (constructor option).',
  );
}

/** The frame interval, in ms, that the tier ABOVE `tier` is asking for — the bar promotion is
 *  judged against (see `hasHeadroom` in qualityTier.ts).
 *
 *  `0` from `applyTierToTargetFps` means UNCAPPED — the engine was never told what to aim for —
 *  so it stands in {@link ASSUMED_UNCAPPED_FPS}. Returning a long frame instead (whatever the
 *  display happens to give) would make the promotion bar trivially easy to clear, which is the
 *  wrong direction for a target nobody authored.
 *
 *  With no tier above, the number is never read — the promotion branch returns first — but a real
 *  frame is returned anyway rather than 0, so a later caller cannot inherit a bar of `0 * share`
 *  and silently promote everything. */
function promotionTargetFrameMs(tier: QualityTier): number {
  const up = tierAbove(tier);
  const settings = getRenderSettings();
  const fps = up
    ? applyTierToTargetFps(settings.targetFps, resolveTierOverrides(up, settings.three.tiers))
    : settings.targetFps;
  return 1000 / (fps > 0 ? fps : ASSUMED_UNCAPPED_FPS);
}

/** Judge the current frame profile and act. Call once per frame; it throttles itself.
 *
 *  A no-op unless the project asked for `'auto'` — a pinned tier is a decision the project
 *  already made, and measuring its way out of it would silently override the author. */
export function tickTierCalibration(now: number = rawNow()): void {
  // FIRST, above every other gate: the editor opts out entirely. See `setTierCalibrationEnabled`
  // — auto-demoting the surface an author is judging their scene on, because the editor's own two
  // viewports missed a budget the shipped build never would, is the tool degrading itself.
  if (!liveCalibrationEnabled) return;
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

  // Stamped HERE rather than inside the `!armed` branch below, because two readers now depend on
  // it and only one of them is reached through that branch. `armTierCalibration()` can arm from a
  // world swap before this function has ever run, which used to leave `firstTickAt` at `-1` — and
  // `now - (-1)` is `now`, a number in the millions, so the idle report below would have fired on
  // the first armed tick instead of after IDLE_REPORT_AFTER_MS. Session start is a fact about the
  // session, not about arming.
  if (firstTickAt < 0) firstTickAt = now;

  // ⭐ NOT ARMED ⇒ THE PROFILE IS NOT EVIDENCE YET (#227). See `armTierCalibration` for the
  // measurement this exists for. Suppression covers BOTH directions deliberately, not just the
  // demotion that was observed misfiring: a promotion decided off load frames would be reading
  // the same contaminated window, and letting one direction through would make the window's
  // meaning depend on which way it happened to point.
  //
  // ⚠️ DEMOTION IS SUPPRESSED TOO, AND THAT IS THE OWNER'S CALL RATHER THAN AN OVERSIGHT (owner,
  // 2026-08-18). The alternative considered was keeping demotion live at a much harsher threshold
  // so only catastrophic frames trip it, and the measurement rules it out: the A23's load frames
  // ran 95.5 ms against a 20 ms budget — nearly 5x over — so any threshold high enough to ignore a
  // load is high enough to ignore a genuinely broken device too. The cost, stated: a device that
  // truly cannot render gets no relief until its first scene finishes loading. That is cheap
  // because the player is watching a LOAD, not playing — the knobs a demotion would apply (DPR,
  // shadows, frame cap) change how a rendered game looks, and there is not one yet. The one knob
  // that matters during a load is the texture cap, and that is already resolved from the probe
  // before assets start fetching (`tierBoot.resolveTierBeforeSceneLoad`, #212); demoting mid-load
  // would not retroactively re-request textures already in flight.
  if (!armed) {
    // The failsafe. See ARM_BACKSTOP_MS — long on purpose, so a slow load can never trip it.
    if (now - firstTickAt >= ARM_BACKSTOP_MS) {
      console.warn(
        `[qualityTier] arming calibration after ${ARM_BACKSTOP_MS / 1000}s with no world swap — `
        + 'no scene finished loading, so the frame profile is being trusted without one',
      );
      armTierCalibration();
    }
    // Return either way: `armTierCalibration` just dropped the profile window, so there is nothing
    // to judge on this tick regardless of which branch armed it.
    return;
  }

  // ⭐ AN IDLE WINDOW IS NOT EVIDENCE EITHER (owner, 2026-08-20). Exactly the rule the `armed`
  // gate above applies to load frames, applied to the other window that does not describe the
  // device the player plays on: mobile CPU governors drop clocks when nothing is being touched,
  // so an idle sample measures a THROTTLED phone, not a slow one.
  //
  // Measured on a Galaxy S22 — the most powerful Android handset in the lab — idle on Court's
  // tutorial (bug `lvROp0yDYPSzS0VZM6LH`): ~41.6 ms medians against a 20 ms budget walked it
  // `high → mid → low` in ~66 ticks, while the GPU identity table had deterministically resolved
  // `high` on the same phone at boot. The demotion is sticky in the direction that hurts — the
  // player taps, the CPU unthrottles, and the game is now on `low` (pixelRatioCap 1, shadows off,
  // ibl off, textureMaxSize 512) on a flagship. It is not lab-specific either: reading a tutorial,
  // taking a call, or looking away is the same window.
  //
  // BOTH DIRECTIONS, for the reason the `armed` gate gives: letting one through would make the
  // window's meaning depend on which way it happened to point. The cost, stated: a device that
  // genuinely cannot render gets no relief while nobody is touching it — cheap, because the knobs
  // a demotion turns (DPR, shadows, frame cap) change how a game LOOKS to a player who, by
  // construction, is not interacting with it.
  if (!hasRecentUserInput(now, IDLE_EVIDENCE_MS)) {
    // Not silent. A project whose input never reaches `noteUserInput` (a custom InputSource that
    // does not call it) would otherwise have calibration disabled forever with nothing to say so —
    // the same no-silent-caps rule the listings follow. Once per session, and only after the
    // backstop, so an ordinary pause never prints.
    //
    // ⚠️ MEASURE THE SESSION, NOT `msSinceUserInput`. Before the first input of a session that
    // value is `Infinity` — deliberately, it means "never" — so gating on it fired on the FIRST
    // armed tick of every launch and printed `calibration idle for Infinitys` (measured on an
    // S22, 2026-08-20, ~0.2 s after boot). Two things were wrong with that, and only one of them
    // was cosmetic: a `console.warn` is a Crashlytics ISSUE since 2026-08-20, and logcat shows
    // `FirebaseCrashlytics.recordException` firing directly behind this line — so an ordinary
    // launch nobody had touched yet filed an alerting issue, per session, on every install.
    // A device untouched since boot is the NORMAL state of a game that just started; it is worth
    // saying only once it has lasted long enough to be a real answer.
    if (!loggedIdle && now - firstTickAt >= IDLE_REPORT_AFTER_MS) {
      loggedIdle = true;
      const since = msSinceUserInput(now);
      const howLong = Number.isFinite(since)
        ? `idle for ${Math.round(since / 1000)}s`
        : 'seen no input at all this session';
      console.warn(
        `[qualityTier] calibration ${howLong} — the `
        + 'frame profile is not being judged, because a device nobody is touching is throttled '
        + 'rather than slow. If this game DOES take input, its InputSource should call '
        + 'noteUserInput() (runtime/core/userActivity.ts).',
      );
    }
    wasIdle = true;
    return;
  }
  if (wasIdle) {
    // COMING BACK is where the window has to be dropped, not going away. The frame profiler keeps
    // filling its ring throughout the idle stretch, and the sustain clocks
    // (`overBudgetSince`/`headroomSince`) keep whatever they held when input stopped — so without
    // this, the first interacting tick judges a ring full of throttled frames against a clock that
    // has been running the whole time, and demotes instantly on evidence that was almost entirely
    // idle. That is the reported bug in slow motion. Same shape as `armTierCalibration`, and the
    // same consequence: there is nothing to judge on THIS tick, by construction.
    wasIdle = false;
    state = freshTierChangeState();
    resetFrameProfile();
    lastCheck = now;
    return;
  }

  if (now - lastCheck < CALIBRATION_INTERVAL_MS) return;
  lastCheck = now;

  // A queued promotion that has waited long enough for a scene boundary applies itself mid-play,
  // behind the overlay. See `applyPromotionBehindOverlay` — a one-scene game reaches no boundary
  // EVER, so without this the promotion path is dead for a whole class of game and nothing says so.
  if (pendingPromotion && now - pendingPromotion.since >= PROMOTION_BOUNDARY_GRACE_MS) {
    const queued = pendingPromotion;
    pendingPromotion = null;
    applyPromotionBehindOverlay(queued.tier, queued.reason);
    return;
  }

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
  // The frame the tier ABOVE is asking for — the only thing promotion is judged against now (see
  // `hasHeadroom`). Resolved HERE rather than inside `evaluateTierChange` because a tier's
  // `targetFps` is authored project data and that function is pure by contract; and through
  // `resolveTierOverrides`, the one resolution point, so a project that authored no `targetFps`
  // on that tier inherits the project's exactly as the live frame cap would.
  const promoteTargetMs = promotionTargetFrameMs(active.tier);
  const { decision, state: next } = evaluateTierChange(
    active.tier, getFrameProfile(), state, now, ceiling, promoteTargetMs,
  );
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
      // A hold is the steady state, not an anomaly — see the switch above.
      console.log(
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
    // ⚠️ `since` IS THE ORIGINAL QUEUE TIME, NOT `now`, WHEN THE SAME TIER IS ALREADY QUEUED.
    // The policy re-decides a promotion every PROMOTION_HOLD_MS for as long as the headroom holds
    // (it has no memory — see `evaluateTierChange`), so re-stamping here would push the deadline
    // out on every re-decision and `PROMOTION_BOUNDARY_GRACE_MS` could never elapse on the device
    // that needs it most: one comfortably fast enough to keep qualifying. The mid-play path would
    // be dead code that looks wired. Caught by the grace test, not by reading this function.
    pendingPromotion = {
      tier: decision.tier,
      reason: decision.reason,
      since: pendingPromotion?.tier === decision.tier ? pendingPromotion.since : now,
    };
  }
}

/** Run `fn` after `n` animation frames have been presented. Used to get the overlay PAINTED before
 *  the stall starts, and to keep it up across the stall afterwards.
 *
 *  Frames, not a timer: what has to happen is a paint, and a `setTimeout` would fire on a schedule
 *  that has nothing to do with whether one occurred — under the very main-thread block this exists
 *  to cover, a timer would elapse and the overlay still would not be on screen. */
function afterFrames(n: number, fn: () => void): void {
  if (n <= 0) { fn(); return; }
  if (typeof requestAnimationFrame !== 'function') { fn(); return; } // headless/tests
  requestAnimationFrame(() => afterFrames(n - 1, fn));
}

/** Apply a promotion MID-PLAY, with the tier-switch overlay covering the shader recompile (#227).
 *
 *  ── WHY A PROMOTION CAN COST SECONDS ──────────────────────────────────────────────────────
 *  A tier change alters which shader VARIANTS the scene needs (IBL on/off is enough on its own),
 *  and cold compilation is ~1.2 s per distinct program — measured 2.9 s on a Galaxy A23 and 16.5 s
 *  on a Huawei Y6 for postfx-demo's 14 distinct pairs (`scene3DSync.ts`). `compileAsync` is already
 *  in use and does NOT remove it. Normally that hides inside a scene load; here there is no load.
 *
 *  ── WHY THE SPINNER SURVIVES THE STALL AND A PROGRESS BAR WOULD NOT ───────────────────────
 *  `LoadingOverlay`'s spinner animates `transform: rotate()`, which browsers run on the COMPOSITOR
 *  thread — it keeps turning while the main thread is blocked. Its indeterminate progress bar
 *  animates `margin-left`, which is main-thread layout and would freeze mid-slide. A frozen
 *  progress bar reads as a crash, so this path must use the spinner variant.
 *
 *  ✅ **MEASURED on the Galaxy A23's WebView** (2026-08-18), not inferred: the same spinner CSS
 *  under a 6.03 s synchronous WebGL compile+link storm (367 programs) kept rotating for all 10
 *  captured frames inside the block, at the same per-frame delta as the 8 frames before it.
 *  Captured with `adb exec-out screencap`, which reads the native framebuffer and so cannot be
 *  fooled by the blocked webview thread. See docs/rendering.md § "Quality tiers".
 *
 *  ── WHY TWO FRAMES BEFORE, THREE AFTER ────────────────────────────────────────────────────
 *  Before: one frame for the subscriber to render the overlay, one more for it to be presented. If
 *  the switch started in the same frame as the publish, the block would begin before anything was
 *  on screen and the player would get the freeze with no explanation — the exact outcome this
 *  covers. After: the stall lands on the first frame that renders under the new tier, so the
 *  overlay has to outlive it; three frames is enough to be past it without depending on knowing
 *  when the compile finished, which nothing here can observe. */
function applyPromotionBehindOverlay(tier: QualityTier, reason: string): void {
  // A second switch while one is in flight would publish `null` from the first one's tail and
  // uncover the second one's stall.
  if (switchInFlight) return;
  switchInFlight = true;
  publishTierSwitchOverlay(getTierSwitchMessage());
  afterFrames(2, () => {
    try {
      applyQualityTier(tier, 'measured', `${reason} (applied mid-play behind the tier-switch overlay)`);
    } finally {
      // `finally`, so a throw inside the apply cannot leave the overlay covering the game forever.
      afterFrames(3, () => {
        publishTierSwitchOverlay(null);
        switchInFlight = false;
      });
    }
  });
}

/** Apply a queued promotion. Call at a scene boundary (SceneManager's before-swap hook), where
 *  the shader recompile is hidden inside a load the player has already accepted.
 *
 *  ⚠️ **THE GATES ARE RE-RUN HERE, because the decision can be a whole scene old.** A promotion is
 *  deferred deliberately, and everything `tickTierCalibration` checked before queuing it can change
 *  in the meantime — the player can open a settings menu and pin a tier, or pick "Auto"; a project
 *  setting can be edited live in the editor. Without this, an explicit human choice was silently
 *  overwritten at the next scene load by an inference made before they made it, which is precisely
 *  what the player control exists to prevent (review 2026-08-12).
 *
 *  Note what is deliberately NOT reset: `state.demoted` and the headroom streak. Those carry the
 *  anti-oscillation stickiness, and clearing them on a player action would let a device that has
 *  already proven it cannot hold a tier climb straight back into it. */
export function applyPendingTierPromotion(): void {
  if (!pendingPromotion) return;
  // An overlay-covered mid-play switch is already running this promotion's replacement; applying
  // a second one underneath it would uncover the stall it is covering.
  if (switchInFlight) return;
  const { tier, reason } = pendingPromotion;
  pendingPromotion = null;
  // Same gate as the tick, for the queue's sake: a promotion decided before calibration was turned
  // off must not still land at the next scene boundary.
  if (!liveCalibrationEnabled) return;
  if (getRenderSettings().three.qualityTier !== 'auto') return;
  if (hasPlayerQualityTier()) return;
  if (configCount(getRenderSettings().three.tiers) <= 1) return;
  applyQualityTier(tier, 'measured', `${reason} (applied at a scene boundary)`);
}
