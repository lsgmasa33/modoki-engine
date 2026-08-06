/** The 1€ filter — adaptive low-pass smoothing for a noisy, interactive signal.
 *
 *  Casiez, Roussel & Vogel, *"1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in
 *  Interactive Systems"* (CHI 2012). The same author as the asynchronous-jitter work that
 *  `pointerPredictedPos` cites, and it solves the other half of the same problem.
 *
 *  ## Why not a fixed EMA
 *
 *  A fixed smoothing constant forces one choice for two opposite requirements: heavy smoothing
 *  kills jitter but lags a fast movement, light smoothing tracks fast movement but leaves a
 *  slow one trembling. Every fixed constant is wrong somewhere — measured here as an A23 that
 *  wanted an 83 ms lead one day and trembled at 33 ms the next, because the EMA's velocity error
 *  turned into a sawtooth once the extrapolation started resampling to absolute time.
 *
 *  The 1€ filter makes the cutoff a function of SPEED: `cutoff = minCutoff + beta × |velocity|`.
 *  Nearly still → low cutoff → heavy smoothing → jitter dies. Moving fast → high cutoff → light
 *  smoothing → no lag where lag is what you would notice. Two parameters, both tuned by feel:
 *
 *  - **`minCutoff`** (Hz) — the floor. LOWER it until a *stationary* signal stops trembling.
 *  - **`beta`** — the speed coupling. RAISE it until a *fast* movement stops lagging.
 *
 *  Tune in that order; they are close to independent, which is the whole reason the filter is
 *  usable by hand. Defaults come from the paper's own starting point (`minCutoff` 1, `beta` 0)
 *  rather than from anything measured here — see `POINTER_FILTER_DEFAULTS`.
 *
 *  ## Contract
 *
 *  Pure and allocation-free per sample: no DOM, no wall-clock (`dt` is passed in), no RNG — so it
 *  is determinism-guard-safe and unit-testable without a device. One instance per SCALAR signal;
 *  a 2D pointer needs two, because filtering x and y jointly would couple the axes.
 */

/** Tunables. See the header — `minCutoff` first, then `beta`. */
export interface OneEuroParams {
  /** Cutoff floor in Hz, applied when the signal is not moving. Lower = less jitter, more lag. */
  minCutoff: number;
  /** Speed coupling. Higher = the cutoff opens up sooner as the signal moves = less lag. */
  beta: number;
  /** Cutoff for the DERIVATIVE's own low-pass, in Hz. The paper's advice is to leave it at 1:
   *  the derivative feeds the adaptive cutoff, so smoothing it heavily makes the filter slow to
   *  notice that the signal started moving. */
  dCutoff: number;
}

export interface OneEuroSample {
  /** The smoothed value. */
  value: number;
  /** The smoothed DERIVATIVE, in units per second — reusable as a velocity estimate, and far
   *  less noisy than a raw two-point difference because it is itself low-passed. */
  derivative: number;
}

export interface OneEuroFilter {
  /** Feed one sample. `dtSec` is the time since the previous sample, in SECONDS. */
  filter(value: number, dtSec: number): OneEuroSample;
  /** Forget all history — call between gestures so one does not smear into the next. */
  reset(): void;
  /** Prime the filter AT a known value without producing an output.
   *
   *  Without this, the first `filter()` call after a `reset()` is consumed as the seed and
   *  reports a derivative of 0 — so a pointer's first move after touch-down would carry no
   *  heading and prediction would take two samples to engage. Seeding at the press coordinates
   *  makes the very first move a real measurement. */
  seed(value: number): void;
}

/**
 * Starting point for pointer smoothing — the paper's own defaults, NOT anything measured here.
 *
 * `beta: 0` means the filter starts as a plain 1 Hz low-pass with no speed coupling at all, which
 * is deliberately the conservative end: it removes jitter and lags a fast drag, and the lag is
 * the symptom you can SEE and therefore tune away. Starting from an aggressive beta would hide
 * the jitter the filter exists to remove and leave you tuning the wrong parameter.
 *
 * Tune per device via debug menu → Input, and record what a device wanted — the same discipline
 * `POINTER_LEAD_MS_DEFAULT` documents, and for the same reason: on this problem, every number
 * guessed from the hardware has so far been wrong.
 */
export const POINTER_FILTER_DEFAULTS: OneEuroParams = { minCutoff: 1, beta: 0, dCutoff: 1 };

/** Smoothing factor for an exponential low-pass at `cutoffHz`, sampled `dtSec` apart. */
export function oneEuroAlpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

/** Guards so a pathological `dt` or cutoff cannot produce NaN/Infinity and poison every later
 *  sample — the filter is recursive, so one bad value never washes out on its own. */
const MIN_DT_SEC = 1e-4;
const MIN_CUTOFF_HZ = 1e-3;

export function createOneEuroFilter(params: OneEuroParams): OneEuroFilter {
  let seeded = false;
  let xPrev = 0;
  let xHat = 0;
  let dxHat = 0;

  return {
    filter(value: number, dtSec: number): OneEuroSample {
      if (!Number.isFinite(value)) return { value: xHat, derivative: dxHat };
      const dt = Math.max(MIN_DT_SEC, Number.isFinite(dtSec) ? dtSec : MIN_DT_SEC);
      // The FIRST sample has no derivative and nothing to smooth against. Seeding with it (rather
      // than with 0) matters: starting from the origin would make the filter sweep across the
      // screen over the first few samples of every gesture.
      if (!seeded) {
        seeded = true; xPrev = value; xHat = value; dxHat = 0;
        return { value, derivative: 0 };
      }
      const dx = (value - xPrev) / dt;
      const aD = oneEuroAlpha(Math.max(MIN_CUTOFF_HZ, params.dCutoff), dt);
      dxHat = aD * dx + (1 - aD) * dxHat;
      // The adaptive step: speed opens the cutoff, so smoothing backs off exactly when lag would
      // be visible and clamps down exactly when jitter would be.
      const cutoff = Math.max(MIN_CUTOFF_HZ, params.minCutoff + params.beta * Math.abs(dxHat));
      const a = oneEuroAlpha(cutoff, dt);
      xHat = a * value + (1 - a) * xHat;
      xPrev = value;
      return { value: xHat, derivative: dxHat };
    },
    reset(): void { seeded = false; xPrev = 0; xHat = 0; dxHat = 0; },
    seed(value: number): void {
      if (!Number.isFinite(value)) return;
      seeded = true; xPrev = value; xHat = value; dxHat = 0;
    },
  };
}
