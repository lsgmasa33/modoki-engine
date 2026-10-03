import type { HapticPreset } from '../haptics/patterns';

/**
 * The default Android mapping for each preset — the defaults of `HapticSettings`' seven
 * `android…` fields (#2103). The format and what reads it: `runtime/haptics/platformEffects.ts`.
 *
 * Here, beside the trait, rather than in `haptics/`: `haptics` already imports `traits`, and a
 * trait importing a value back from `haptics` is a cross-folder cycle (`noNewCycles.test.ts`).
 *
 * Starting values, unjudged: nobody has felt these against the old path yet. `success`, `warning`
 * and `error` keep the beat shapes `@capacitor/haptics` asks for today.
 */
export const DEFAULT_ANDROID_EFFECTS: Readonly<Record<HapticPreset, string>> = Object.freeze({
  'impact.light': 'effect:TICK',
  'impact.medium': 'effect:CLICK',
  'impact.heavy': 'effect:HEAVY_CLICK',
  select: 'TICK@0.6',
  success: 'CLICK, CLICK@0.7+65',
  warning: 'CLICK, CLICK+40, CLICK+50',
  error: 'TICK@0.6, THUD+45',
});
