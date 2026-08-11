/** The player's own quality-tier choice (#121 P3d) — the honest escape hatch.
 *
 *  `resolveTier` has always given the player the highest precedence, above the project setting,
 *  the allowlist and calibration. Nothing supplied it: the field existed and was never read from
 *  anywhere. This is where it comes from.
 *
 *  WHY THE PLAYER OUTRANKS EVERYTHING. They can see the screen and we cannot. The allowlist can be
 *  stale, calibration can misjudge a device that is briefly busy, and a project's pin can be wrong
 *  for hardware nobody tested — this is the one control that is never wrong about what the player
 *  prefers. A game exposes it in its own settings menu; the engine only stores and applies it.
 *
 *  ── PERSISTENCE, AND WHY IT IS BEHIND A SLOT ─────────────────────────────────────────────
 *  Backed by `PlayerPrefs` (engine-owned, `@capacitor/preferences`-backed on device) so the choice
 *  survives relaunches — but reached through the `playerTierStore` provider slot, NOT imported.
 *  `rendering/` and `storage/` are both L2 subsystems and the layer contract forbids one importing
 *  the other; the seam lives in L0 and storage installs the implementation. Unprovided (a headless
 *  test, a DCE'd playable build) it reads null, which is exactly "the player has chosen nothing".
 *
 *  Reads are synchronous off the hydrated prefs cache, so a read BEFORE hydration returns null and
 *  the tier resolves without it. That is why `choosePlayerQualityTier` APPLIES the change as well
 *  as storing it — the player is sitting in a settings menu and expects to see the result now. */

import { playerTierStore } from '../core/playerTierStore';
import { getDeviceCapsSync } from './deviceCaps';
import { isQualityTier, resolveTier, type QualityTier } from './qualityTier';
import { getRenderSettings } from './renderSettings';
import { applyQualityTier } from './tierCalibration';

/** The player's stored choice, or null for "no choice — let the project and calibration decide".
 *
 *  Validates rather than trusting: prefs are persisted JSON that survives engine upgrades, so a
 *  value written by an older build (or edited by hand) must not be able to smuggle a bogus tier
 *  into the renderer. Anything unrecognised reads as "no choice". */
export function getPlayerQualityTier(): QualityTier | null {
  const raw = playerTierStore.get()?.read() ?? null;
  // Through `isQualityTier`, never a hand-written union: a second copy of the valid set is how a
  // newly added tier (`mid`, #188) would persist fine and then read back as "no choice" on the
  // next launch, which looks exactly like the player never picked it.
  return isQualityTier(raw) ? raw : null;
}

/** Record the player's choice. `null` clears it, handing control back to the project setting and
 *  calibration — which is what an "Auto" option in a settings menu should write.
 *
 *  Persistence only. Applying it to the live renderer is the caller's job (`applyQualityTier`),
 *  kept separate so this module stays free of renderer imports and trivially testable. */
export function setPlayerQualityTier(tier: QualityTier | null): void {
  playerTierStore.get()?.write(tier);
}

/** Has the player pinned a tier? Used to stop calibration from arguing with them. */
export function hasPlayerQualityTier(): boolean {
  return getPlayerQualityTier() !== null;
}

/** The one call a game's settings menu makes: persist the choice AND apply it now.
 *
 *  `null` means "Auto" — it clears the override and hands control back to the project setting and
 *  calibration. Applying that case needs a decision about what tier to sit on until calibration
 *  next speaks, and the honest answer is the project's own: re-resolving from scratch is what a
 *  fresh launch would do.
 *
 *  Applied through `applyQualityTier` (the calibration loop's own path) so the two callers can
 *  never drift on which knobs are live — notably that antialias will not change until the next
 *  renderer creation. */
export function choosePlayerQualityTier(tier: QualityTier | null): void {
  setPlayerQualityTier(tier);
  if (tier) {
    applyQualityTier(tier, 'player', 'player selected this tier');
    return;
  }
  const setting = getRenderSettings().three.qualityTier;
  // Feed the CACHED probe, never a bare `{platform:''}` (#155). Since `'auto'` became the default,
  // an input with no facts resolves `low` — so passing none would downgrade a desktop the moment
  // its player picked "Auto", which is the opposite of what Auto means. Sync by design: the probe
  // ran at renderer bring-up, so by the time a settings menu exists it is cached; `null` falls
  // through to the same safe side as a failed probe.
  //
  // ⚠️ `null` IS ROUTINE NOW, not the "somehow it did not" this comment used to call it. A
  // project that authored ONE quality config never reaches `getDeviceCaps()` at all — bring-up
  // returns at the `single-config` gate above it (`resolveActiveTierOnce`), deliberately, since
  // building a throwaway caps-probe renderer to choose between configs that do not exist is
  // exactly the cost that gate removes. What keeps this from being a #155 regression is that
  // with one config EVERY tier resolves to the same unclamped overrides, so the tier named here
  // cannot change a pixel. If that ever stops being true, warm the caps before this line.
  const caps = getDeviceCapsSync();
  const resolved = resolveTier({
    platform: caps?.platform ?? '',
    deviceModel: caps?.deviceModel,
    gpuRenderer: caps?.gpuRenderer,
    formFactor: caps?.formFactor,
    projectSetting: setting,
  });
  applyQualityTier(resolved.tier, resolved.source, `player chose Auto — ${resolved.reason}`);
}
