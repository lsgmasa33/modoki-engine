/** Installs the PlayerPrefs-backed implementation of `core/probeVerdictStore` (#188).
 *
 *  Storage side of the seam, self-registering at module-evaluation time — same shape and same
 *  rationale as `playerTierProvider`. The pref KEY belongs here rather than in the rendering
 *  module: where a value is stored is this layer's business.
 *
 *  Validates on read rather than trusting. Prefs are persisted JSON that outlives engine upgrades
 *  and can be hand-edited, and this particular value decides whether a phone boots into the tier
 *  that once cost a Huawei Y6 its GPU context — so a malformed or partial record must read as
 *  "no cache" (re-probe) and never as a verdict. */

import { probeVerdictStore, type CachedProbeVerdict } from '../core/probeVerdictStore';
import { PlayerPrefs } from './playerPrefs';

/** Namespaced so a game's own prefs cannot collide with it. */
export const PROBE_VERDICT_PREF_KEY = 'modoki.rendering.probeVerdict';

probeVerdictStore.provide({
  read(): CachedProbeVerdict | null {
    // Typed as a loose string map, not as `CachedProbeVerdict`: this is unvalidated persisted
    // JSON, and reading it at the shape we WANT is how a malformed record gets waved through.
    const raw = PlayerPrefs.get<Record<string, string>>(PROBE_VERDICT_PREF_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const { fingerprint, deviceClass } = raw as Partial<CachedProbeVerdict>;
    if (typeof fingerprint !== 'string' || !fingerprint) return null;
    if (deviceClass !== 'weak' && deviceClass !== 'capable') return null;
    return { fingerprint, deviceClass };
  },
  write(verdict) {
    if (verdict === null) PlayerPrefs.delete(PROBE_VERDICT_PREF_KEY);
    else PlayerPrefs.set(PROBE_VERDICT_PREF_KEY, { ...verdict });
  },
});
