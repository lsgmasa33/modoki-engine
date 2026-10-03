import type { HapticPreset } from '../haptics/patterns';

/**
 * The default Android mapping for each preset — the defaults of `HapticSettings`' seven
 * `android…` fields (#2103). The format and what reads it: `runtime/haptics/platformEffects.ts`.
 *
 * Here, beside the trait, rather than in `haptics/`: `haptics` already imports `traits`, and a
 * trait importing a value back from `haptics` is a cross-folder cycle (`noNewCycles.test.ts`).
 *
 * `success`, `warning` and `error` keep the beat shapes `@capacitor/haptics` asked for. The owner
 * felt the set as a whole on the Galaxy S22 and judged it better than the old path (2026-10-03);
 * no preset was judged on its own.
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

/**
 * `HapticSettings.platformEffects`' default, and what the service runs at with no `HapticSettings`
 * in the scene. ON since the owner's verdict on the S22 (2026-10-03, *"make it default"*). One
 * constant, so the trait and the service cannot disagree about what an unauthored game gets.
 */
export const DEFAULT_PLATFORM_EFFECTS = true;
