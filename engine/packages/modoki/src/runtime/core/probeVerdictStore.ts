/** Provider slot for the cached boot-probe verdict (#188).
 *
 *  Same seam, and the same reason, as `playerTierStore`: `rendering/` runs the probe and needs the
 *  answer to survive a relaunch, but `storage/` (PlayerPrefs) is a sibling L2 subsystem it may not
 *  import. So the interface lives here in L0 and storage installs the implementation — see
 *  docs/architecture-layers.md.
 *
 *  ⚠️ THIS SLOT IS WHAT MAKES THE PROBE AFFORDABLE. The probe BLOCKS THE LAUNCH (owner, 2026-08-09
 *  — it must, because `antialias` is baked into the swapchain at renderer creation and a tier
 *  decided later cannot apply it). Paying that on every boot would be indefensible; paying it once
 *  per device is the whole bargain. Unprovided — a headless test, a DCE'd playable build — `get()`
 *  returns null and the probe simply re-runs, which is correct but is the SLOW path, not the
 *  intended one. */

import { createProviderSlot } from './providerSlot';

/** What the probe concluded, plus the fingerprint of the hardware it concluded it about. The
 *  fingerprint is not optional: a cache keyed only by "this device" is wrong the moment the value
 *  outlives the thing it described — a GPU driver update, an OS upgrade, or a restored backup on
 *  different hardware. */
export interface CachedProbeVerdict {
  fingerprint: string;
  deviceClass: 'weak' | 'capable';
}

export interface ProbeVerdictStore {
  read(): CachedProbeVerdict | null;
  /** null clears the cache, forcing a re-probe on the next launch. */
  write(verdict: CachedProbeVerdict | null): void;
}

export const probeVerdictStore = createProviderSlot<ProbeVerdictStore>('probeVerdictStore');
