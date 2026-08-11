/** Installs the PlayerPrefs-backed implementation of `core/playerTierStore` (#121 P3d).
 *
 *  Lives on the STORAGE side of the seam on purpose: `rendering/` may not import `storage/`
 *  (both L2 — see docs/architecture-layers.md), so the direction is inverted here. Self-registers
 *  at module-evaluation time, in the same style as the loader-owned slots.
 *
 *  The pref KEY belongs here too, not in the rendering module: where the value is stored is this
 *  layer's business, and rendering asks only for "the player's tier". */

import { playerTierStore, type PersistedQualityTier } from '../core/playerTierStore';
import { PlayerPrefs } from './playerPrefs';

/** Namespaced so a game's own prefs cannot collide with it. */
export const PLAYER_TIER_PREF_KEY = 'modoki.rendering.qualityTier';

/** Narrowing set for what may come back out of prefs. Typed against `PersistedQualityTier`, so
 *  adding a tier there fails to compile here until this list follows — which is what stopped
 *  `'mid'` (#188) from being writable but unreadable. */
const VALID: readonly PersistedQualityTier[] = ['low', 'mid', 'high'];

playerTierStore.provide({
  read() {
    // Validated by the caller, but narrowed here too: prefs are persisted JSON that outlives
    // engine upgrades, so a value written by an older build must not reach the renderer raw.
    const raw = PlayerPrefs.get<string>(PLAYER_TIER_PREF_KEY);
    return VALID.includes(raw as PersistedQualityTier) ? (raw as PersistedQualityTier) : null;
  },
  write(tier) {
    if (tier === null) PlayerPrefs.delete(PLAYER_TIER_PREF_KEY);
    else PlayerPrefs.set(PLAYER_TIER_PREF_KEY, tier);
  },
});
