/** Deciding the quality tier — the whole precedence, in one place, with no renderer (#203).
 *
 *  ⚠️ **THIS LIVED INSIDE `scene3DSync.ts` AND THAT WAS THE BUG.** `resolveActiveTier` ran from
 *  exactly one call site, `makeWebGPURenderer`, so a project that never mounts `Scene3D` —
 *  `disable3D: true` on `games/chess` and `games/audio-demo`, `build.modules.render3d: false` on
 *  `games/space-invader` — resolved NO tier at all, and every field in the `rendering.three.tiers`
 *  config those projects were seeded with has done nothing since. Extracting the decision is what
 *  lets a 2D boot reach it, and `scene3DSync` now imports the same function it used to own so the
 *  3D path is unchanged: the tier is still resolved before the first drawing buffer is allocated,
 *  which it must be, because `antialias` is a constructor option a later decision cannot apply.
 *
 *  ⚠️ **The extraction is the point — do not add a second entry point.** Every branch below
 *  (player choice, project pin, one-config, iOS model id, GPU identity, then the probe) is
 *  precedence, and a caller that re-implemented any part of it is exactly the drift that made
 *  "Auto" throw away the probe's verdict once already (#155). `resolveActiveTier` and
 *  `resolveActiveTierForNo3D` are the only doors, and the second is the first with `only2D` set.
 *
 *  ⚠️ **Nothing here may import `three/webgpu`, directly or transitively.** That import is what
 *  `build.modules.render3d: false` dead-code-eliminates, and pulling it back in through the tier
 *  resolver would re-break the projects this module exists for — silently, since it would only show
 *  up as a bundle that grew by ~173 KB. The probe reaches its GL work through `rampWorkloadGL`,
 *  which is Three-free for the same reason. */

import { getRenderSettings, getActiveQualityTier, setActiveQualityTier } from './renderSettings';
import {
  buildTierResolveInput, resolveTier, configCount,
  type QualityTierSetting, type TierResolution,
} from './qualityTier';
import { applyActiveTierToRuntime } from './tierCalibration';
import {
  classifyDevice, classifyMedianOf, probeFingerprint, readingOf, refineProbeVerdict,
  fillMegapixelsPerMs, shadeMegaFragmentsPerMs, PROBE_SAMPLE_TARGET,
  type DeviceClass, type ProbeMeasurement, type ProbeReading, type RampReading,
} from './rampProbe';
import { rawNow } from '../core/clock';
import { probeVerdictStore } from '../core/probeVerdictStore';
import { areDebugHandlesEnabled } from '../core/debugHandles';
import { isBootProbeAllowed } from '../core/bootProbeAllowed';
import { isProbeInFlight, withProbeInFlight, shareTierResolution } from './probeReentrancy';
import { getDeviceCaps } from './deviceCaps';
import { getPlayerQualityTier } from './playerQualityTier';

/** Resolve the quality tier once, before the first drawing buffer is allocated (#121 P3).
 *
 *  Idempotent: a second viewport (the editor mounts SceneView + GameView) reuses the resolution
 *  rather than re-probing, so both surfaces are guaranteed the same tier.
 *
 *  The device probe is only awaited for `'auto'`. A pinned `'low'`/`'high'` resolves synchronously
 *  from the setting alone, so it pays nothing for a capability probe it would ignore.
 *
 *  ⚠️ Since #155 made `'auto'` the DEFAULT, the probe is on the common path rather than the opt-in
 *  one — an unpinned project now awaits `getDeviceCaps()` before the first drawing buffer. That is
 *  the cost of deciding the tier before a buffer is allocated, and it cannot be deferred: the
 *  knobs the tier clamps (`antialias` especially) are baked into the buffer at creation. */
export async function resolveActiveTier(setting: QualityTierSetting, only2D = false): Promise<void> {
  if (getActiveQualityTier()) return;
  // ⚠️ RE-ENTRANCY. The probe below builds a renderer, renderer construction lands back here, and
  // nothing has set a tier yet — so without this the call recurses without bound and the process
  // dies. It killed an iPhone 13 mini's tab in ~80 ms, and was invisible on every desktop, which
  // resolves 'desktop' and never reaches the probe. See probeReentrancy.ts.
  //
  // Returning without resolving is correct here: the probe's own renderer is throwaway, it is
  // explicitly clamped to DPR 1 by the runner, and `getEffectiveThreeSettings()` falls back to the
  // project's authored settings when no tier is active. The tier is resolved by the OUTER call
  // once the probe returns.
  //
  // ⚠️ THIS CHECK MUST STAY ABOVE THE DEDUP BELOW. The re-entrant call arrives from INSIDE the
  // in-flight resolution, so making it await that same promise would deadlock the launch — it
  // would be waiting for the thing that is waiting for it. Breaking the recursion first is what
  // makes the dedup safe.
  if (isProbeInFlight()) return;
  // ── CONCURRENT FIRST CALLS SHARE ONE RESOLUTION ──────────────────────────────────────────
  // The guard above stops RECURSION; it does not stop two surfaces racing. Both `getDeviceCaps()`
  // and the probe are awaited, so two renderers created in the same tick each get past every
  // check above before either sets `probing` — and would then each run a launch-blocking probe.
  // That was survivable when the probe ran once ever and wrote the same verdict twice. It is not
  // now: the verdict refines across launches, both would read the SAME prior samples, and the
  // second write would discard the first's reading — so a device would pay two probes and bank
  // one sample. This makes "no launch pays more than one probe" true rather than nearly true.
  return shareTierResolution(() => resolveActiveTierOnce(setting, only2D));
}

/** Publish a first-of-session tier resolution AND push what it implies into the live runtime.
 *
 *  ⚠️ **`setActiveQualityTier` ALONE IS NOT ENOUGH, and it used to be all this did (#202).** It
 *  records the tier; it applies nothing. That was invisible while a tier only clamped Three.js
 *  knobs, because `makeWebGPURenderer` reads `getEffectiveThreeSettings()` on the very next line
 *  after awaiting this resolution — so the three fields appeared to "just work" and every other
 *  field a tier gained would silently not. The frame cap and the 2D backing size are the first two
 *  with no such reader. Route every publish through here so the next one cannot be forgotten
 *  either. */
function publishActiveTier(res: TierResolution): void {
  setActiveQualityTier(res);
  applyActiveTierToRuntime();
  // ⚠️ **ONE LINE, UNGATED, AND IT IS OVERDUE.** Every hard hour this workstream has spent on a
  // device began with a launch that decided a tier and said nothing about it: `resolveProbeClass`
  // logs its own verdict, but the CHEAP paths — a player pin, one config, an iOS model id, a GPU
  // table hit — published in silence, so "the probe did not run" and "the probe ran and found
  // nothing" and "a tier was decided from an empty config" all looked identical in logcat. That
  // ambiguity cost a full rebuild-and-measure cycle on a Galaxy A23 on 2026-08-13, and the same
  // shape (a device that "emitted not one line about what happened next") is written up twice
  // already in `resolveProbeClass`'s own comments.
  //
  // ⭐ **UNGATED, AND THE OWNER APPROVED IT UNGATED (2026-08-13)** — recorded here because a line
  // that prints on every release launch is exactly the kind of thing a later review flags as an
  // oversight, and re-deciding it would cost the argument twice.
  //
  // One line per process: this runs from `resolveActiveTierOnce` only, and `resolveActiveTier`
  // early-outs once a tier exists, so a second surface (the editor mounts two) does not repeat it.
  // The live promote/demote path logs separately, through `tierCalibration`.
  //
  // A RELEASE build is exactly where an unexplained tier is hardest to diagnose — gating it to
  // debug builds would remove it from the only situation that cannot be reproduced locally. It
  // also matches what this subsystem already does: `resolveProbeClass` and `tierCalibration` both
  // log their decisions ungated, and the cheap paths (player pin, single-config, iOS model id, GPU
  // table hit) were the one gap in that convention.
  //
  // Declined alternatives, so they are not re-proposed: `console.info` instead of `warn` (would
  // stop it looking like a warning in browser devtools on a public demo — offered, not taken);
  // gating to `areDebugHandlesEnabled()`; gating out of playable ads.
  console.warn(`[qualityTier] ${res.tier} via ${res.source} — ${res.reason}`);
}

async function resolveActiveTierOnce(setting: QualityTierSetting, only2D: boolean): Promise<void> {
  // The player's stored choice outranks everything, including a pinned project setting — see
  // playerQualityTier.ts. Read before the early-out so a pin cannot hide it.
  const playerChoice = getPlayerQualityTier();
  if (playerChoice || setting !== 'auto') {
    // No caps, and that is SOUND HERE — unlike the identical-looking call in playerQualityTier.ts,
    // which was a bug (#155). This branch runs only when a player choice or a project pin exists,
    // and both are decided by `resolveTier` BEFORE it ever consults `formFactor`/`gpuRenderer`. So
    // the facts omitted here cannot change the answer. Add a resolver branch above those two and
    // this becomes wrong — feed it `getDeviceCapsSync()` then.
    publishActiveTier(resolveTier({ platform: '', playerChoice, projectSetting: setting }));
    return;
  }

  // ⭐ ONE CONFIG ⇒ NO PROBE (owner, 2026-08-11; plan §2.2). Stated as a property rather than an
  // optimisation: the probe's ONLY job is to choose between configs, so when a project authored
  // just the default there is nothing to choose and the ~0.5-2.6 s of blocked launch buys a
  // verdict that cannot change a single pixel. (An A23/S22 pays 0.5-0.8 s, an iPhone 8
  // 1964-2619 ms, a Y6 ~2.2 s cold — and the verdict refines over three launches, so a device
  // can pay it three times.)
  //
  // It sits ABOVE `getDeviceCaps()` deliberately, so the caps-probe renderer is not built either,
  // and above the iOS model table + desktop carve-out because with one config all three would
  // pick a tier NAME that decides nothing — reporting `mid` from a model id while rendering
  // completely unclamped is a more confusing answer than reporting the truth.
  //
  // Two whole classes fall out of the rule instead of needing their own special cases:
  //   - A PLAYABLE AD never probes. It could not have probed usefully anyway — `deviceModel`
  //     comes from the `GameDebug` native plugin and a playable is a plugin-less web bundle, so
  //     it always resolved `calibrating` and always ran the FULL probe, on every impression,
  //     since a one-shot ad webview never accumulates the three launches a verdict needs.
  //   - The EDITOR never probes: one config, on a desktop.
  const tiers = getRenderSettings().three.tiers;
  if (configCount(tiers) <= 1) {
    publishActiveTier({
      tier: 'high',
      source: 'single-config',
      // `high` names the UNCLAMPED default, which is what one config means — every tier resolves
      // to the same overrides here, so the name is reporting, not policy.
      reason: 'this project authored one quality config — nothing to measure between',
    });
    return;
  }

  let caps: Awaited<ReturnType<typeof getDeviceCaps>> | null = null;
  try {
    caps = await getDeviceCaps();
  } catch {
    // A probe failure must not block rendering. resolveTier with no facts falls through to
    // "unrecognised device → start low", which is the safe direction (see its doc).
  }
  // Through the shared builder, so a field added to `TierResolveInput` cannot reach the boot path
  // and miss `choosePlayerQualityTier`'s re-resolution (or the reverse — which is the drift that
  // made "Auto" throw away the probe's verdict). `formFactor` absent on a failed probe is read by
  // `resolveTier` as "handheld" — the safe side.
  const factsCaps = caps;

  // Resolve WITHOUT the ramp probe first, and only pay for it if nothing cheaper answered.
  //
  // This is what gives the plan's "desktop skips it entirely" for free, and it extends the same
  // courtesy to every other free answer: a player choice, a project pin, an iOS model id, an
  // allowlisted Android GPU. `'calibrating'` is precisely the state that means "nothing here
  // decided" — the state in which, before #188, a device sat on `low` forever because the
  // promotion path never fired on any hardware ever measured.
  const cheap = resolveTier(buildTierResolveInput(factsCaps, setting, { playerChoice, useProbe: false }));
  if (cheap.source !== 'calibrating') {
    // ── MEASURE-AND-LOG (#188) ────────────────────────────────────────────────────────────
    // ⚠️ **iOS HAS NEVER MEASURED ITSELF, AND THAT IS WHY THIS EXISTS.** `resolveTier` answers
    // `source: 'model'` from the iOS model-generation table, which is `!== 'calibrating'`, so this
    // early return is reached and the ramp probe below never runs on any iPhone or iPad. Measured
    // 2026-08-11: an iPhone 8 running postfx-demo natively logged not one probe line across three
    // full uninstall-and-reinstall cycles — it looked exactly like a broken build, and it was the
    // design working as written.
    //
    // The consequence is that every band boundary this workstream derives comes from Android alone,
    // while the thresholds apply to iOS too. The harness page is not a substitute: measured on the
    // SAME three phones both ways, it disagrees with native about the RATIO between devices, not
    // merely the level (S22:A23 on the cpu ramp is 2.1x native and 13.3x on the harness). A number
    // from a different instrument cannot calibrate this one.
    //
    // So a debug build measures anyway and throws the verdict away. Three properties make that
    // safe, and all three are load-bearing:
    //   - the TIER IS UNCHANGED — `cheap` is what gets set, exactly as before;
    //   - it is DEBUG-ONLY, so a release build is byte-for-byte unaffected;
    //   - it EXCLUDES DESKTOP, because `areDebugHandlesEnabled()` is also true in the editor and
    //     desktop reaches this same early return via `formFactor` — without that clause every
    //     editor launch would grow a ramp probe it has no use for.
    // It runs at the same point in boot as the real probe on Android (before the tier is set, on
    // the critical path) precisely so the numbers are comparable to the Android campaign's; a
    // measurement taken under different conditions would be the very thing this comment warns about.
    // ⚠️ `isBootProbeAllowed()` FIRST, and this is the call site that made the flag necessary
    // (#221 W2 item 5): a playable ad exported from one of the ten projects that ship
    // `build.debugBuild: true` would otherwise run the whole probe — now 1.6-1.8 s of blocked
    // launch — purely to LOG a verdict it then discards, in the one build where launch time is
    // the product.
    if (isBootProbeAllowed() && areDebugHandlesEnabled() && caps?.formFactor !== 'desktop') {
      await resolveProbeClass(caps, only2D, cheap.source);
    }
    publishActiveTier(cheap);
    return;
  }

  // ⚠️ **AND THE REAL PATH TOO — "one config ⇒ no probe" is a PROJECT's choice, not the ad
  // format's.** The single-config short-circuit above fires only when the project authored exactly
  // one tier config; a playable exported from a project with two (the scaffolder's default, and
  // every project in this repo) arrives here like anything else. Refusing leaves the ad on
  // `calibrating`, which the live loop corrects within seconds — the same degrade the plan already
  // accepts for the stale-data tail, and far cheaper than the launch it would have cost.
  if (!isBootProbeAllowed()) {
    publishActiveTier(resolveTier(buildTierResolveInput(factsCaps, setting, { playerChoice })));
    return;
  }
  const probed = await resolveProbeClass(caps, only2D);
  publishActiveTier(resolveTier(buildTierResolveInput(factsCaps, setting, {
    playerChoice,
    probeClass: probed?.deviceClass,
    // See `ProbeVerdict.cpuLimited` — the licence `promotionCeiling` reads to allow ONE live
    // promotion step off a measured tier the boot cpu under-estimate held down.
    probeCpuLimited: probed?.cpuLimited,
  })));
}

/** The quantitative tail of a probe run, for the boot log.
 *
 *  ⚠️ **IT IS PRINTED ON THE FAILURE PATH TOO, and that is the whole reason it exists as a
 *  function.** The failing branch used to log a reason string and nothing else, so the single run
 *  that most needed explaining — "fill ramp produced no usable reading" — was the one run whose
 *  numbers were never recorded. Measured on a Galaxy S22 (2026-08-11): every first native launch
 *  fails that way, and three sessions of investigation could not say why, because the log withheld
 *  the interval the whole ramp is scaled against.
 *
 *  The STEP TABLE is the load-bearing part. `status` alone says a ramp did not escape; the steps
 *  say whether it was still vsync-pinned (the device is fast and the ceiling is too low), already
 *  running long (the yardstick is wrong), or never got enough frames to try. Those three want
 *  opposite fixes and are indistinguishable from a verdict. */
function describeProbe(m: ProbeMeasurement): string {
  const ramp = (r: RampReading) =>
    `${r.kind} ${r.status}/${r.bound} [`
    + r.steps.map((s) => `${s.load}:${s.frameMs.toFixed(1)}`
      + (s.gpuMs === undefined ? '' : `/gpu${s.gpuMs.toFixed(1)}`)).join(' ') + ']';
  const ramps = [m.fill, m.shade, m.cpu]
    .filter((r): r is RampReading => r !== undefined).map(ramp).join(', ');
  // ⚠️ THE CLOCK'S IDENTITY LEADS, because without it none of the numbers after it can be compared
  // across devices. A WebGPU `onSubmittedWorkDone` reading and a WebGL2 `fenceSync` reading have
  // different delivery latencies and different noise floors, and the runner has always KNOWN which
  // it used — it just never survived to this line, because a `mark()` is only kept as `lastStage`
  // and the next stage overwrites it. Two phones were ranked against each other for a whole session
  // without anyone being able to say whether they had been timed by the same instrument.
  return `${m.clockKind} clock, interval ${m.intervalMs.toFixed(1)}ms, ${ramps}, `
    + `blocked launch ${m.totalMs.toFixed(0)}ms `
    + `(renderer ${m.rendererMs.toFixed(0)} + compile ${m.compileMs.toFixed(0)}`
    + (m.shadeCompileMs > 0 ? `+${m.shadeCompileMs.toFixed(0)}` : '')
    + ` + ramps), buffer ${(m.bufferPixels / 1_000_000).toFixed(2)}Mpx`
    + (m.shadeRegionPixels > 0 ? `, shade region ${m.shadeRegionPixels}px` : '')
    // The two DERIVED, device-comparable figures. `fill`'s raw unit is screens/ms and `shade`'s is
    // instances/ms; neither means anything across devices until it is normalised, and printing the
    // raw step table without them is what let three sessions compare panel sizes by mistake.
    + `, derived fill ${fillMegapixelsPerMs(m).toFixed(2)}Mpx/ms`
    + (m.shade ? ` shade ${shadeMegaFragmentsPerMs(m).toFixed(2)}Mfrag/ms` : '')
    + (m.cpu ? ` cpu ${(m.cpu.unitsPerMs / 1000).toFixed(1)}k xform/ms` : '')
    // The discarded passes, in order, and the gain from the FIRST of them — the DVFS signal, per
    // device, on every boot log. `cpu` above is the measured pass; these are what the same ramp
    // read before the governor had seen that much sustained work. A gain near 1.0 means the device
    // was already at its clocks, and the sequence says whether it was still climbing when the
    // measured pass ran — which is the question `CPU_WARMUP_RAMPS` is tuned against.
    + (m.cpu && m.cpuWarmups?.length && m.cpuWarmups[0].unitsPerMs > 0
      ? ` (warm-up ${m.cpuWarmups.map((r) => `${(r.unitsPerMs / 1000).toFixed(1)}k`).join('->')}`
        + `, gain ${(m.cpu.unitsPerMs / m.cpuWarmups[0].unitsPerMs).toFixed(2)}x)`
      : '');
}

/** The boot ramp probe's verdict — from cache when we have one for this hardware, otherwise by
 *  running it (#188).
 *
 *  ⚠️ RUNNING IT BLOCKS THE LAUNCH, by owner decision and by necessity: the knobs a tier clamps —
 *  `antialias` above all — are baked into the drawing buffer at renderer creation, so a verdict
 *  that arrives after this point cannot be applied at all. The cache is what keeps that a
 *  once-per-device cost rather than a once-per-launch one.
 *
 *  Never throws: any failure resolves `undefined`, which `resolveTier` reads as "no information"
 *  and answers exactly as it did before this existed. */
async function resolveProbeClass(
  caps: Awaited<ReturnType<typeof getDeviceCaps>> | null,
  /** Run the 2D probe shape — `fill` + `cpu` rather than `shade` + `cpu`. See
   *  `runBootRampProbe`'s `only2D`: a 2D project's only tier-controlled GPU knob is fill-rate
   *  bound, so `shade` would be measuring work it will never issue and charging the launch for it. */
  only2D: boolean,
  /** Set when the tier was ALREADY decided by something cheaper and this run is measure-and-log
   *  only — the value is that decider's `source`, and every line this function logs says so.
   *
   *  ⚠️ The wording is not cosmetic. Without it an iPhone prints `[rampProbe] middle` while its tier
   *  is `high` from the model table, and the only honest reading of that pair is that one of them is
   *  a bug. Naming the decider is what makes the two lines agree with each other. */
  evidenceFor?: string,
): Promise<{ deviceClass: DeviceClass; cpuLimited: boolean } | undefined> {
  const tag = evidenceFor ? `[rampProbe] EVIDENCE ONLY (tier came from '${evidenceFor}')` : '[rampProbe]';
  const fingerprint = probeFingerprint({
    // ⚠️ THE PROBE SHAPE IS PART OF THE FINGERPRINT (#203). A 2D verdict and a 3D verdict are
    // readings on DIFFERENT AXES — `fill` against `shade` — so a device that runs both shapes (an
    // engine developer switching projects, or a shell app that loads a 2D sub-game) must not have
    // one shape's samples medianed into the other's. Same argument as `CLASSIFIER_VERSION`, one
    // level down: that asks "does a reading still mean the same thing", this asks "is it even the
    // same measurement".
    platform: `${caps?.platform ?? ''}${only2D ? ':2d' : ''}`,
    deviceModel: caps?.deviceModel,
    gpuRenderer: caps?.gpuRenderer,
    viewportPx: typeof window === 'undefined' ? 0 : window.innerWidth * window.innerHeight,
  });

  const store = probeVerdictStore.get();
  const cached = store?.read();
  const forThisDevice = cached && cached.fingerprint === fingerprint ? cached : null;
  // SETTLED means never probe again. An UNSETTLED record means the opposite — probe once more and
  // fold the result in — which is the whole of "refine across launches" (owner, 2026-08-09): one
  // probe per launch as before, but the first few launches each pay one instead of only the first.
  // ⚠️ `cpuLimited` is RECOMPUTED from the stored samples, never stored — see
  // `readCachedProbeVerdict` for why (a stored derived field would outlive the thresholds it was
  // derived from). `classifyMedianOf` is the same median the live path takes, so a settled device
  // and a still-refining one cannot disagree about the shape of their own bottleneck.
  if (forThisDevice?.final) {
    return {
      deviceClass: forThisDevice.deviceClass,
      cpuLimited: classifyMedianOf(forThisDevice.samples, only2D ? '2d' : '3d').cpuLimited,
    };
  }

  // ⚠️ THE STAGE BREADCRUMB IS NOT OPTIONAL DIAGNOSTICS — IT IS THE ONLY WITNESS ON THE PATHS THAT
  // RETURN NOTHING. `runBootRampProbe` resolves `null` for every unhappy ending it has — no DOM, no
  // renderer, a throw, an implausible interval — and this function then returned silently, so a
  // device that never classified left a log identical to one that never probed. Measured
  // 2026-08-11: a Galaxy A23 and a Huawei Y6 each loaded the probe module on three launches and
  // emitted not one line about what happened next. The runner has always MARKED every stage; the
  // production caller simply passed no callback and threw the marks away.
  let lastStage = 'start';
  const fallback = () => (forThisDevice
    ? {
      deviceClass: forThisDevice.deviceClass,
      cpuLimited: classifyMedianOf(forThisDevice.samples, only2D ? '2d' : '3d').cpuLimited,
    }
    : undefined);
  try {
    const { runBootRampProbe } = await import('./rampProbeRunner');
    const startedAt = rawNow();
    let samples: readonly ProbeReading[] = forThisDevice?.samples ?? [];
    let deviceClass: DeviceClass = forThisDevice?.deviceClass ?? 'unknown';
    let cpuLimited = false;
    let final = false;
    let passes = 0;
    /** Each pass's verdict ON ITS OWN — the unanimity test below, not diagnostics. */
    const perPass: DeviceClass[] = [];
    /** The FIRST pass's reading, kept apart because it is the only one taken on a cold device and
     *  therefore the only one drawn from the same population the thresholds were derived from. */
    let coldReading: ProbeReading | null = null;

    // ⭐ **REPEATED WITHIN ONE LAUNCH (#221 W2), not once per launch as before.** The verdict has
    // always been the median of {@link PROBE_SAMPLE_TARGET} readings; what changed is WHERE those
    // readings come from. Taking one per launch meant launches 1 and 2 were wrong by construction —
    // and those are the launches a first impression is made on, which is the entire point of the
    // workstream. See the loop's exit conditions below for what it costs.
    while (samples.length < PROBE_SAMPLE_TARGET) {
      // Guarded: the probe constructs a renderer, which re-enters this very resolution path.
      const measurement = await withProbeInFlight(
        () => runBootRampProbe((stage) => { lastStage = stage; }, only2D));
      passes++;
      // Fall back to what earlier passes (and earlier launches) concluded rather than to nothing:
      // a pass that failed does not invalidate readings that succeeded before it. BREAK rather than
      // retry — the failures `runBootRampProbe` resolves `null` for (no DOM, no renderer, a throw)
      // are properties of the environment, so a second attempt would fail the same way and charge
      // the launch twice for it.
      if (!measurement) {
        console.warn(`${tag} pass ${passes} produced no measurement — last stage '${lastStage}'`);
        break;
      }
      const oneRun = classifyDevice(measurement);
      // An unusable ramp yields no READING, so there is nothing to fold in.
      if (oneRun.deviceClass === 'unknown') {
        console.warn(`${tag} pass ${passes} no usable reading — ${oneRun.reason} (${describeProbe(measurement)})`);
        break;
      }
      const reading = readingOf(measurement);
      if (coldReading === null) coldReading = reading;
      perPass.push(oneRun.deviceClass);
      const refined = refineProbeVerdict(samples, reading, measurement.axes);
      samples = refined.samples;
      deviceClass = refined.deviceClass;
      cpuLimited = refined.cpuLimited;
      // ⭐ **UNANIMITY, NOT THE MEDIAN, IS WHAT LICENCES SETTLING IN ONE LAUNCH — and this is a
      // measured correction to W2 as it was written.** `refineProbeVerdict`'s own `final` is the
      // CROSS-LAUNCH rule: three readings, each from a cold device, median them. In-launch passes
      // are not that — they are a WARMING SEQUENCE, and the trend is visible on hardware (a Huawei
      // Y6 read fill 0.94 → 1.17 → 1.36 within one launch, and on another launch 1.37 → 2.11 →
      // 1.69 with an in-launch median of 1.69 against a cross-launch median of 1.10). The bias is
      // UPWARD, which is the unsafe direction: the Y6's warm median sits above the `middle` fill
      // floor of 1.68, and only the cpu floor kept it out of a band that measured 14 fps on that
      // phone. Medianing a warm population against thresholds derived from a cold one is the
      // "number from a different instrument" mistake this workstream has now made three times.
      //
      // So a launch may settle only when every pass in it agreed on the band ANYWAY — in which
      // case the warming did not reach a boundary and the median cannot be wrong about it. When
      // they disagree, the device is near a boundary, which is exactly the case extra launches
      // were always worth paying for: see the `coldReading` write below.
      final = refined.final && perPass.length >= PROBE_SAMPLE_TARGET
        && perPass.every((c) => c === perPass[0]);
      console.warn(
        `${tag} ${refined.deviceClass} — ${refined.reason} `
        + `(pass ${passes} this launch, alone: ${oneRun.deviceClass}; ${describeProbe(measurement)})`,
      );
      if (final) break;
      // ⚠️ **THE BUDGET IS WHAT KEEPS THIS BOUNDED ON HARDWARE SLOWER THAN ANYTHING MEASURED.**
      // When it is spent the loop stops with `final: false`, and the device then refines across the
      // NEXT launches by accumulating one cold reading each until three of them settle it (see the
      // store below) — the old behaviour surviving as the degrade path rather than being replaced,
      // which is a claim this comment made from #221 until #240 made it true.
      if (rawNow() - startedAt > PROBE_IN_LAUNCH_BUDGET_MS) {
        console.warn(
          `${tag} stopping after ${passes} pass(es) — `
          + `${(rawNow() - startedAt).toFixed(0)}ms spent, over the ${PROBE_IN_LAUNCH_BUDGET_MS}ms `
          + `in-launch budget; will refine on the next launch`,
        );
        break;
      }
    }

    // Only a real verdict is worth persisting. Caching `'unknown'` would freeze a device in the
    // state the probe is in TODAY, so that correcting the thresholds later could never reach a
    // device that had already launched once.
    // ⚠️ **AN UNSETTLED RECORD HOLDS COLD READINGS ONLY, ONE PER LAUNCH — AND THEY ACCUMULATE.**
    // Persisting this launch's warm passes would leave the store holding readings that the NEXT
    // launch's cold reading gets medianed against — a mixed population, permanently, in the store.
    // But keeping only the NEWEST cold reading, which is what this line did until #240, throws the
    // accumulation away every launch and makes the cross-launch settle below unreachable: read 1
    // sample, run 2 passes, store 1 sample, forever, on every device whose in-launch passes did
    // not agree. Measured on a Galaxy A23 over three launches, and its cpu reading moved
    // 8977 -> 9230 across one of them — it re-measured the device and discarded the answer.
    // The slice is applied to BOTH branches, not just the appending one: `previous` comes from
    // persisted JSON that outlives engine upgrades and can be hand-edited (see
    // `probeVerdictProvider`), so "a record holds at most `PROBE_SAMPLE_TARGET` samples" is only an
    // invariant if nothing can carry a longer one forward — including the path where this launch
    // measured nothing to add.
    const cachedCold = forThisDevice?.samples ?? [];
    const coldSamples = (coldReading ? [...cachedCold, coldReading] : cachedCold)
      .slice(-PROBE_SAMPLE_TARGET);
    const toStore = final ? samples : coldSamples;
    // ⚠️ The band must DESCRIBE the samples stored beside it, or a later launch reads a verdict its
    // own evidence does not support. On the settled path those are the same thing; on the cold-only
    // path the stored band has to be the cold samples' median, not the lowest of three.
    const storedClass = final ? deviceClass : classifyMedianOf(toStore, only2D ? '2d' : '3d').deviceClass;
    // ⭐ **TWO WAYS TO SETTLE, AND THE SECOND IS THE ONE #221 LOST (#240).** `final` above is the
    // IN-LAUNCH one — three passes in THIS launch that all agreed on the band, see the unanimity
    // note. This is the CROSS-LAUNCH one, and it is the older of the two: three cold readings, one
    // per launch, medianed exactly as `refineProbeVerdict` has always done. #221's
    // `perPass.length >= PROBE_SAMPLE_TARGET` conjunct vetoed it for every device that took it,
    // because a launch that reads a non-empty cache runs FEWER than three passes by construction —
    // so the device paid a launch-blocking probe on every launch for the life of the install and
    // could never settle. That conjunct gates the in-launch shortcut; it must not gate this.
    const settled = final || (toStore.length >= PROBE_SAMPLE_TARGET && storedClass !== 'unknown');
    if (storedClass !== 'unknown' && toStore.length > 0) {
      store?.write({ fingerprint, deviceClass: storedClass, samples: [...toStore], final: settled });
    }
    return deviceClass === 'unknown' ? fallback() : { deviceClass, cpuLimited };
  } catch (e) {
    // Swallowing the tier decision is right — a probe failure must never block rendering — but
    // swallowing the REASON is not. This catch spans a dynamic import, a renderer construction and
    // a PlayerPrefs write; silent, all three failures look the same as no probe at all.
    console.warn(`${tag} threw at stage '${lastStage}' — ${String(e).slice(0, 200)}`);
    return fallback();
  }
}

/** Wall clock the whole in-launch repeat may spend, ms — measured from the first pass's start.
 *
 *  ⚠️ **IT BOUNDS THE REPEAT, NOT A PROBE.** One probe is already bounded by the runner's own
 *  `PROBE_TOTAL_BUDGET_MS` (3.2 s); this stops the LOOP asking for another one it cannot afford.
 *  Without it, `PROBE_SAMPLE_TARGET` passes on the slowest hardware would stack those budgets — a
 *  9.6 s worst case, against the ~6 s the owner set as the outside limit for the probe as a whole.
 *
 *  2500 ms, chosen from measurement rather than from the limit: a Galaxy S22 spends ~570 ms per
 *  pass and an iPhone Air ~490 ms, so both take all three passes and settle in one launch.
 *
 *  ⚠️ **THE "SLOW DEVICE TAKES ONE PASS" SPLIT THIS COMMENT USED TO DESCRIBE IS NOT REAL — the
 *  ~2 s-per-pass Huawei Y6 figure it rested on was already stale when it was written (#240).** The
 *  probe had stopped constructing a renderer nine hours earlier (`8cf61e859`, which names what left
 *  with it: "600-1700 ms of cold renderer creation"), and the draw ramp went 48 minutes later
 *  (`1ff11afaf`). Re-measured 2026-08-18 on the Y6 itself (MRD-LX3, PowerVR Rogue GE8300,
 *  `games/sling` debug): **589 / 478 / 468 ms — 1.54 s for all three passes**, ~4x cheaper than the
 *  number this constant was sized against, and it settles in launch 1 and never probes again. A
 *  Galaxy A23 measures 501 / 621 ms. So the budget stops nothing on any device we own; it is kept
 *  as the bound against hardware slower than anything measured, NOT as a split that shapes
 *  behaviour on the devices it names. Re-measure before quoting a per-pass cost from it again. */
const PROBE_IN_LAUNCH_BUDGET_MS = 2_500;

/** Resolve a tier for a project that will never build a 3D renderer (#203).
 *
 *  The same decision, with the probe — should it be reached at all — running its 2D shape. Exposed
 *  as its own name rather than as a boolean at the call site so the one caller (`tierBoot`) reads
 *  as what it is, and so nothing in the 3D path can pass `true` by accident. */
export function resolveActiveTierForNo3D(): Promise<void> {
  return resolveActiveTier(getRenderSettings().three.qualityTier, true);
}

/** ⭐ Run the ramp probe AGAIN, on demand, and report it — changing nothing (#205).
 *
 *  ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────
 *  `runCpuRamp`'s own doc says it measures **available** CPU rather than peak, because the main
 *  thread is contended at boot, and it asks for exactly one validation: *"a boot reading against a
 *  quiet reading, on the same device."* That validation had never been run, because there was no
 *  way to run the probe outside boot — `resolveProbeClass` is private, and the verdict store
 *  early-outs on `final` so a settled device never probes again however many times it is launched.
 *  This is that missing door, and the Galaxy A23's 5x cpu spread across sessions is what needs it.
 *
 *  ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────────────────────
 *  ⚠️ **It does not write `probeVerdictStore`, and that is load-bearing, not tidiness.** The stored
 *  verdict is a MEDIAN over launch samples (`refineProbeVerdict`), so folding hand-triggered idle
 *  runs into it would let the diagnostic move the very number it was built to measure — and would
 *  do it asymmetrically, since an idle run is exactly the reading that differs from a boot one.
 *  ⚠️ **It does not publish a tier either.** `getActiveQualityTier()` is untouched, so tapping this
 *  cannot change what is on screen; the tier buttons beside it are the control that does that.
 *
 *  The log line is the SAME `describeProbe` format as the boot line on purpose — the whole point is
 *  that the two are read side by side in one logcat capture, so they must be the same instrument
 *  reported the same way. Only the tag differs.
 *
 *  Never throws: a failure is reported in the returned string, like every other path here. */
export async function runProbeForDiagnostics(only2D = false): Promise<string> {
  // A boot probe may still be in flight on a slow device if the menu is opened early. Running a
  // second one concurrently would have them contend for the same GPU and the same main thread,
  // which is precisely the confound this measurement exists to remove.
  if (isProbeInFlight()) return 'a probe is already running — try again in a moment';
  let lastStage = 'start';
  try {
    const { runBootRampProbe } = await import('./rampProbeRunner');
    const measurement = await withProbeInFlight(
      () => runBootRampProbe((stage) => { lastStage = stage; }, only2D));
    if (!measurement) {
      const msg = `produced no measurement — last stage '${lastStage}'`;
      console.warn(`[rampProbe] DIAGNOSTIC (idle) ${msg}`);
      return msg;
    }
    // The one-pass verdict, NOT a refined one: a refinement medians across stored samples, and this
    // run is not stored. Reporting `oneRun` is the honest answer for a single hand-triggered pass.
    const oneRun = classifyDevice(measurement);
    const summary = `${oneRun.deviceClass} — ${describeProbe(measurement)}`;
    console.warn(`[rampProbe] DIAGNOSTIC (idle) ${summary}`);
    return summary;
  } catch (e) {
    const msg = `threw at stage '${lastStage}' — ${String(e).slice(0, 200)}`;
    console.warn(`[rampProbe] DIAGNOSTIC (idle) ${msg}`);
    return msg;
  }
}
