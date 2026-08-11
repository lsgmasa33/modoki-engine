/** Provider slot for the player's persisted quality-tier choice (#121 P3d).
 *
 *  `rendering/` is an L2 subsystem and `storage/` (PlayerPrefs) is another, so rendering cannot
 *  import it — the layer guard refuses, correctly. The tier code needs a persisted value; it does
 *  not need to know WHERE it is persisted. So the seam lives here in L0 and the storage side
 *  installs an implementation, exactly as `docs/architecture-layers.md` prescribes.
 *
 *  Unprovided, `get()` returns null and every caller behaves as "the player has chosen nothing" —
 *  which is also the correct behaviour for a headless test or a DCE'd playable-ad build that
 *  never wires storage at all. */

import { createProviderSlot } from './providerSlot';

/** The tier names, spelled out rather than imported from `rendering/qualityTier`: this is an L0
 *  core module and may not import an L2 subsystem (see docs/architecture-layers.md). Keep in step
 *  with `QualityTier`. The compiler catches the DANGEROUS direction — adding a tier there and
 *  forgetting this mirror fails at `playerQualityTier`'s `write(tier)` call. It does NOT catch the
 *  reverse (a value here that `QualityTier` lacks), because the read path narrows through
 *  `isQualityTier(raw: unknown)`, and a type guard whose parameter is `unknown` is never compared
 *  against the static type of what was passed. One direction enforced, one direction discipline. */
export type PersistedQualityTier = 'low' | 'mid' | 'high';

export interface PlayerTierStore {
  /** A tier, or null when the player has expressed no preference. */
  read(): PersistedQualityTier | null;
  /** null clears the override. */
  write(tier: PersistedQualityTier | null): void;
}

export const playerTierStore = createProviderSlot<PlayerTierStore>('playerTierStore');
