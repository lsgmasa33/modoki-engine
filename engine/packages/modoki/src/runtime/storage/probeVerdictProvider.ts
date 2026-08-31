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

/** Typed against the stored union, so adding a band (`'middle'`, #188) fails to compile here
 *  until this list follows — the alternative being a verdict that writes fine and then reads back
 *  as "no cache", i.e. a launch-blocking probe on every single boot with nothing to show for it. */
const VALID_CLASSES: readonly CachedProbeVerdict['deviceClass'][] = ['weak', 'middle', 'capable'];

type SampleKey = keyof CachedProbeVerdict['samples'][number];

/** The numeric fields a persisted sample must carry, DERIVED FROM THE TYPE rather than retyped.
 *
 *  ⚠️ **THIS SHAPE IS TYPED AS LOOSE JSON ON PURPOSE, WHICH MEANS NOTHING ELSE CAN CATCH A RENAME —
 *  and one got through.** When #188 swapped the classifier from `fill`/`draw` to `cpu`/`shade`, the
 *  validator below kept checking `fillMpxPerMs`/`drawUnitsPerMs` through the `as` casts that exist
 *  to stop us reading unvalidated prefs at the shape we WANT. It compiled perfectly and returned
 *  `null` for every well-formed record: the cache was dead, so the probe re-ran on every launch and
 *  never accumulated the samples it needs to settle. Nothing failed; it just quietly cost every
 *  launch a blocking probe, forever.
 *
 *  A `Record<SampleKey, true>` closes both directions at compile time. Rename a field and the stale
 *  key is an excess property here; ADD one and the record is missing a key. Either way this file
 *  fails to build until the validator follows — which is the only mechanism available, since the
 *  runtime shape is deliberately untyped. Paired with a write→read round-trip test
 *  (`tests/storage/probeVerdictProvider.test.ts`), because a compile-time guard cannot prove the
 *  two halves actually agree at runtime. */
// ⭐ And it EARNED ITS KEEP AGAIN on 2026-08-13: adding `fillMpxPerMs` for the 2D probe (#203)
// failed this file to build, which is the whole design working. Without it the new field would
// have been written by every 2D launch and silently dropped by every read, so a 2D device could
// never accumulate the samples its verdict needs to settle — the same dead cache as before, in a
// mechanism whose entire point is to settle within three launches.
const SAMPLE_KEY_SET: Record<SampleKey, true> = {
  cpuUnitsPerMs: true, shadeMfragPerMs: true, fillMpxPerMs: true,
};
const SAMPLE_KEYS = Object.keys(SAMPLE_KEY_SET) as readonly SampleKey[];

probeVerdictStore.provide({
  read(): CachedProbeVerdict | null {
    // Typed as a loose string map, not as `CachedProbeVerdict`: this is unvalidated persisted
    // JSON, and reading it at the shape we WANT is how a malformed record gets waved through.
    const raw = PlayerPrefs.get<Record<string, string>>(PROBE_VERDICT_PREF_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const { fingerprint, deviceClass, samples, final } = raw as Partial<CachedProbeVerdict>;
    if (typeof fingerprint !== 'string' || !fingerprint) return null;
    if (!deviceClass || !VALID_CLASSES.includes(deviceClass)) return null;
    // A record written before cross-launch refinement existed has no `samples`, and reading one as
    // "settled with zero samples" would freeze a device on the single pass this change exists to
    // stop trusting. Rejecting it re-probes, which is the cheap and correct outcome.
    if (!Array.isArray(samples) || samples.length === 0) return null;
    const clean = samples.filter((s): s is CachedProbeVerdict['samples'][number] =>
      !!s && typeof s === 'object'
      && SAMPLE_KEYS.every((k) => Number.isFinite((s as Record<string, unknown>)[k])));
    if (clean.length !== samples.length) return null;
    return { fingerprint, deviceClass, samples: clean, final: final === true };
  },
  write(verdict, session) {
    // `session` is the capture-before/compare-after pattern from `PlayerPrefs.swapGeneration()`'s
    // own doc comment (worked precedent: `agentBridge.ts`'s `player-prefs-write` op). Checked only
    // when the caller supplied one — `null`/`undefined` means "no session supplied", so existing
    // callers (and the write→read round-trip test) are unaffected.
    if (session !== undefined && session !== null) {
      // A malformed token (wrong shape, or a store that spells "no session" as `null` and got past
      // the check above some other way) is treated as a MISMATCH, not trusted and not thrown.
      // Throwing here is the worst outcome available: `resolveProbeClass`'s own `try` swallows it,
      // so the verdict is never cached and the device pays a launch-BLOCKING probe every boot
      // forever, with nothing in the log pointing back at this file.
      const wellFormed = typeof session === 'object'
        && typeof (session as { gen?: unknown }).gen === 'number'
        && typeof (session as { ns?: unknown }).ns === 'string';
      if (!wellFormed) {
        console.log('[probeVerdictProvider] discarded a probe verdict: malformed session token');
        return;
      }
      const { gen, ns } = session as { gen: number; ns: string };
      const currentNs = PlayerPrefs.namespace();
      if (ns !== currentNs) {
        // Ordinary path (an OTA sub-game switch, a hash navigation) — see
        // `globalErrors.ts`'s rule that `console.warn` is a Crashlytics alerting issue and must
        // not fire on one.
        console.log(
          `[probeVerdictProvider] discarded a probe verdict captured for namespace "${ns}" — the ` +
          `store was re-namespaced to "${currentNs}" while the probe ran; one re-probe next launch`,
        );
        return;
      }
      if (gen !== PlayerPrefs.swapGeneration()) {
        // Namespace matches, but the generation moved: a swap opened AND CLOSED entirely inside
        // the probe's own awaits — the case `isSwapInFlight()` structurally cannot see (see
        // `swapGeneration()`'s doc comment in `playerPrefs.ts`).
        console.log(
          `[probeVerdictProvider] discarded a probe verdict captured for namespace "${ns}" — a ` +
          `swap opened and closed while the probe ran; one re-probe next launch`,
        );
        return;
      }
      if (PlayerPrefs.isSwapInFlight()) {
        console.log(
          `[probeVerdictProvider] discarded a probe verdict captured for namespace "${ns}" — a ` +
          `swap is currently in flight; one re-probe next launch`,
        );
        return;
      }
    }
    if (verdict === null) PlayerPrefs.delete(PROBE_VERDICT_PREF_KEY);
    else PlayerPrefs.set(PROBE_VERDICT_PREF_KEY, { ...verdict });
  },
  session() {
    return { gen: PlayerPrefs.swapGeneration(), ns: PlayerPrefs.namespace() };
  },
});
