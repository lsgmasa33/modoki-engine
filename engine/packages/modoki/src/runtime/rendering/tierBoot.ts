/** Resolving a quality tier on a project that never mounts `Scene3D` (#203).
 *
 *  ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *  `resolveActiveTier` ran from exactly ONE place: `makeWebGPURenderer`. So a project with
 *  `disable3D: true` (`games/chess`, `games/audio-demo`) or `build.modules.render3d: false`
 *  (`games/space-invader`) built no renderer, resolved no tier, and left
 *  `getActiveQualityTier()` null for the whole process — with `getActiveTierOverrides()` returning
 *  `UNCLAMPED_OVERRIDES`. Every one of those projects was seeded with `rendering.three.tiers` by
 *  A4, and **every field in those configs has done nothing since.** #202 made it consequential by
 *  giving tiers a 2D DPR cap and a frame cap: the first two fields those projects would actually
 *  have benefited from.
 *
 *  It has a second half that the issue did not record, and it is the worse one:
 *  **`tickTierCalibration` is called from `Scene3D.tsx` and nowhere else.** So a 2D project has no
 *  live calibration either — it cannot be demoted when it drops frames, and it cannot be promoted
 *  when it turns out to have headroom. Resolving a tier at boot without fixing that would buy a
 *  first guess and no way to correct it, which on the unrecognised tail is the worse half.
 *
 *  ── WHY THIS IS CHEAP NOW, AND WAS NOT BEFORE ─────────────────────────────────────────────
 *  #203 was filed as needing "an explicit decision rather than a default", because the only Android
 *  classifier BUILT A THREE RENDERER — so a 2D project had to choose between a launch-blocking
 *  probe it had no use for and falling through to `low` forever. Two changes removed that fork:
 *    - **#210**: GPU identity answers for recognised hardware from a string, with no renderer, no
 *      probe and no frame. `getDeviceCaps` needs only a throwaway 1x1 WebGL2 context, which it
 *      already creates on every device.
 *    - **`rampWorkloadGL`**: the probe itself no longer needs Three, so the fallback is available
 *      to a 2D project too — with the FILL ramp as its deciding axis, since `pixiPixelRatioCap` is
 *      the only GPU knob a 2D tier moves and it is fill-rate bound.
 *
 *  ⚠️ **This module must NOT be imported by `Scene3D`'s path.** A 3D project still resolves inside
 *  `makeWebGPURenderer` too — it must, because `antialias` is a renderer CONSTRUCTOR option and a
 *  tier decided after the first drawing buffer exists cannot apply it. Resolving in both places is
 *  merely idempotent (`resolveActiveTier` early-outs on an existing tier).
 *
 *  ⭐ **"Resolving earlier from here would be harmless but POINTLESS" — that sentence stood here
 *  until 2026-08-14 and it is now false, which is why {@link resolveTierBeforeSceneLoad} exists.**
 *  It was true while every tier knob was read by the renderer itself. Texture LOD by tier (#212)
 *  broke that: the tier's `textureMaxSize` is read by `resolveTextureVariantUrl` when a SCENE's
 *  textures resolve, and scene load races renderer creation. Measured on a Galaxy A23 with the
 *  tier pinned `low` from boot — cap 512 in force, `sizes:[512]` in the manifest, all 21 `@512`
 *  files shipped in the APK, and **0 of 21 textures fetched the capped URL** (first KTX2 request
 *  at 873 ms). Nothing errored: an unresolved cap falls back to the full-size URL, which is the
 *  correct behaviour and therefore completely silent. */

import { resolveActiveTier, resolveActiveTierForNo3D } from './tierResolve';
import { getRenderSettings } from './renderSettings';
import { registerFrameCallback, unregisterFrameCallback, PRIORITY_RENDER_2D } from './frameDriver';
import { tickTierCalibration } from './tierCalibration';

const CALIBRATION_KEY = 'tier-calibration-2d';

/** Resolve the tier for a project that will never mount a 3D surface, and start the live
 *  calibration loop that `Scene3D` would otherwise own.
 *
 *  Idempotent and safe to call unconditionally: `resolveActiveTier` early-outs once a tier exists,
 *  and re-registering the frame callback under the same key replaces rather than duplicates.
 *
 *  ⚠️ **Awaited at boot, deliberately.** The 2D backing-buffer scale is applied from the resolved
 *  tier, and a tier that arrives after `Canvas2DMount` has sized its first buffer would leave the
 *  first frames at the unclamped resolution — visible as a resolution pop on exactly the weak
 *  hardware the clamp exists for. The cost is ~0 ms for a recognised device (a string lookup) and
 *  the probe only for the unrecognised tail. */
export async function resolveTierForNo3DProject(): Promise<void> {
  // ⚠️ From `tierResolve`, NEVER from `scene3DSync` — that module imports `three/webgpu`, which is
  // the exact dependency `build.modules.render3d: false` removes and this whole change exists to
  // stop needing. A static import of it here would silently put the 3D renderer back into a 2D
  // bundle.
  await resolveActiveTierForNo3D();
  startTierCalibrationForNo3DProject();
}

/** Drive `tickTierCalibration` on a project with no `Scene3D` to drive it.
 *
 *  ⚠️ **`PRIORITY_RENDER_2D`, and it must not be `PRIORITY_ECS`.** The tick judges the frame
 *  profile, and the profile for a frame is only complete once that frame's work has been done —
 *  running it at ECS priority would judge the PREVIOUS frame while claiming to judge this one.
 *  `Scene3D` ticks it at the top of its own render callback for the same reason: what it reads is
 *  the profile as of the last completed frame either way, and the ordering only decides which
 *  frame that is.
 *
 *  ⚠️ **THIS ONLY TICKS. It does NOT apply a queued promotion, and it used to (#227).** The call
 *  sat here under a comment reading "the promotion is applied at a SCENE BOUNDARY, not here …it is
 *  a no-op unless something is queued" — true of the no-op case and false of the one that matters:
 *  when something WAS queued, this applied it on the very next frame, mid-play and uncovered,
 *  which is exactly what deferring to a boundary exists to prevent. A 2D project's boundary is now
 *  the world swap (`onWorldSwap` in `tierCalibration.ts`), and a deliberate mid-play application
 *  goes behind the tier-switch overlay. */
export function startTierCalibrationForNo3DProject(): void {
  registerFrameCallback(CALIBRATION_KEY, () => {
    tickTierCalibration();
  }, PRIORITY_RENDER_2D);
}

/** Tear the loop down — for a game swap, and for tests, which must not leak a callback into the
 *  next test's frame driver. */
/** Resolve the quality tier for a project that WILL mount a 3D surface, before the scene loads.
 *
 *  ⚠️ **This is an ORDERING fix, not a second resolver** (#212). `makeWebGPURenderer` still calls
 *  `resolveActiveTier` and still must; this one runs first so the tier exists before anything
 *  resolves an asset URL from it. `resolveActiveTier` early-outs on an existing tier, so whichever
 *  gets there first wins and the other is free.
 *
 *  Three things fall out of resolving here rather than inside the renderer, and they are the
 *  argument for it:
 *    - the tier is in force before `loadScene`, so per-tier texture variants are actually chosen;
 *    - the probe (when a device needs one) runs with NO renderer in existence, which is the
 *      isolation W2 wanted and removes the probe→renderer→probe re-entrancy hazard
 *      (`probeReentrancy.ts`) rather than guarding it;
 *    - `antialias` is unaffected — the renderer reads `getEffectiveThreeSettings()` after its own
 *      (now instant) resolve, and reads a tier that is already correct instead of racing to set it.
 *
 *  ⚠️ NOT `only2D`: a 3D project must be judged on the `shade` axis, not `fill`. Passing the wrong
 *  shape would median a reading against the other table's floors — the mistake `probeFingerprint`
 *  carries the shape for. */
export async function resolveTierBeforeSceneLoad(): Promise<void> {
  await resolveActiveTier(getRenderSettings().three.qualityTier);
}

export function stopTierCalibrationForNo3DProject(): void {
  unregisterFrameCallback(CALIBRATION_KEY);
}
