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
  /** The measured bands only. Spelled out rather than imported from `rendering/rampProbe`'s
   *  `DeviceClass` because this is an L0 module (see `playerTierStore` for the same seam) — and
   *  narrower than it on purpose: `'unknown'` is not a verdict and must never be cached, or a
   *  device that probed before the thresholds existed would be frozen in that state forever. */
  deviceClass: 'weak' | 'middle' | 'capable';
  /** The raw readings this verdict is folded from, oldest first — NOT just the verdict.
   *
   *  ⚠️ **A BAND CANNOT BE AVERAGED; READINGS CAN.** Refining across launches means taking the
   *  MEDIAN of what several launches measured, and "the median of `weak`, `middle`, `weak`" is a
   *  vote, not a measurement — it throws away how close each pass was to a boundary, which is the
   *  whole signal. So the numbers are what persists and the band is recomputed from them.
   *
   *  Also why this is a list and not a running mean: a mean cannot be un-skewed by a later sample,
   *  and the outlier passes this exists to survive are exactly the ones that would skew it.
   *
   *  ⚠️ **`fillMpxPerMs` REJOINED THEM (#203, 2026-08-13) — as the 2D probe's DECIDING axis, not
   *  as the resurrection of the old fill/draw pair.** A 2D project's only tier-controlled GPU knob
   *  is fill-rate bound, so a 2D probe runs `fill` + `cpu` where a 3D one runs `shade` + `cpu`.
   *  Both fields are always written and only the relevant one is read; which that is comes from
   *  `ProbeMeasurement.axes`, and `CLASSIFIER_VERSION` (now 5) keeps a record written under one
   *  instrument from being medianed against another's.
   *
   *  ⚠️ **THE AXES CHANGED (#188, 2026-08-11): these are `cpu` and `shade`, not `fill` and `draw`.**
   *  A persisted sample is a reading of a SPECIFIC quantity, so renaming the fields is not cosmetic
   *  — `CLASSIFIER_VERSION` is part of the fingerprint precisely so a record written under the old
   *  pair can never be medianed against one written under the new. Spelled out here rather than
   *  imported as `ProbeReading` for the same L0 reason as `deviceClass` above.
   */
  samples: { cpuUnitsPerMs: number; shadeMfragPerMs: number; fillMpxPerMs: number }[];
  /** Settled — later launches must NOT probe again. While false the device pays one probe per
   *  launch until it settles, which is the cost of the owner's "refine across launches" choice:
   *  no launch pays more than one probe, but the first few launches each pay one. */
  final: boolean;
}

export interface ProbeVerdictStore {
  read(): CachedProbeVerdict | null;
  /** null clears the cache, forcing a re-probe on the next launch. */
  write(verdict: CachedProbeVerdict | null): void;
}

export const probeVerdictStore = createProviderSlot<ProbeVerdictStore>('probeVerdictStore');
