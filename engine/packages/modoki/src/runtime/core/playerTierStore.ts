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

export interface PlayerTierStore {
  /** 'low' | 'high', or null when the player has expressed no preference. */
  read(): 'low' | 'high' | null;
  /** null clears the override. */
  write(tier: 'low' | 'high' | null): void;
}

export const playerTierStore = createProviderSlot<PlayerTierStore>('playerTierStore');
