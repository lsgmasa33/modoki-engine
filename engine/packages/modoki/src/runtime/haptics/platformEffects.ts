/**
 * Platform haptic effects — what a preset asks an Android vibrator for when the phone can do
 * better than a timed buzz (#2103).
 *
 * `@capacitor/haptics` sends every preset to Android as plain amplitude steps (`select` is 100ms
 * at 39%), which a motor renders as a buzz. A vibrator that reports predefined effects or
 * composition primitives has maker-tuned taps of ~20ms instead. This file is the mapping from a
 * preset to one of those, and the small text format it is authored in.
 *
 * ── Why a TEXT format on the trait ─────────────────────────────────────────────
 * Which effect a preset maps to, a primitive's scale and the gap between two beats are all things
 * the owner will want different after FEELING them, so they are authored data on `HapticSettings`
 * rather than constants here. A trait field is a flat value, so each preset gets one string:
 *
 *   effect:TICK              a predefined effect (CLICK, DOUBLE_CLICK, TICK, HEAVY_CLICK)
 *   TICK@0.6                 one primitive at scale 0.6
 *   CLICK, CLICK@0.7+65      two primitives; the second at scale 0.7, 65ms after the first ends
 *   (empty)                  no mapping: this preset keeps the `@capacitor/haptics` call
 *
 * The defaults below are the trait's defaults, so the Inspector shows the value in force.
 *
 * ⚠️ Still PRESETS, not a waveform asset: no file, no GUID, no iOS change. docs/haptics.md
 * § "Why presets, and not a custom-waveform plugin" stands.
 */

import type { HapticPreset } from './patterns';

export const ANDROID_HAPTIC_EFFECTS = ['CLICK', 'DOUBLE_CLICK', 'TICK', 'HEAVY_CLICK'] as const;
export const ANDROID_HAPTIC_PRIMITIVES = [
  'CLICK', 'THUD', 'SPIN', 'QUICK_RISE', 'SLOW_RISE', 'QUICK_FALL', 'TICK', 'LOW_TICK',
] as const;

export interface PlatformHapticPrimitive {
  id: string;
  /** 0..1 — the primitive's own strength scale. */
  scale: number;
  /** Gap in ms after the PREVIOUS primitive ends (Android's `addPrimitive` delay). */
  delayMs: number;
}

export type PlatformHapticEffect =
  | { kind: 'effect'; effect: string }
  | { kind: 'primitives'; primitives: readonly PlatformHapticPrimitive[] };

/** The `HapticSettings` field that carries each preset's mapping. A `Record` over the preset
 *  union on purpose: adding a preset without a field here is a type error, and `hapticsSystem`
 *  reads the trait by walking this table, so no field can be authored and left unread. */
export const ANDROID_EFFECT_FIELDS = {
  'impact.light': 'androidImpactLight',
  'impact.medium': 'androidImpactMedium',
  'impact.heavy': 'androidImpactHeavy',
  select: 'androidSelect',
  success: 'androidSuccess',
  warning: 'androidWarning',
  error: 'androidError',
} as const satisfies Record<HapticPreset, string>;

export type AndroidEffectField = (typeof ANDROID_EFFECT_FIELDS)[HapticPreset];

/** The default mapping per preset. Defined beside the trait whose defaults it is. */
export { DEFAULT_ANDROID_EFFECTS, DEFAULT_PLATFORM_EFFECTS } from '../traits/hapticEffectDefaults';

/**
 * Which vibration usage a preset is sent under. NOT tunable: these are the usages Android infers
 * for today's waveforms (measured on the S22: the impacts and `select` land in TOUCH, the three
 * notifications in MEDIA), so the phone's own touch-feedback setting gates the same presets on
 * both paths. Android 13 and later only: below API 33 the native side sends every preset as
 * touch whatever this says (#2122, docs/haptics.md § "What the phone's vibration settings gate").
 */
export const PRESET_VIBRATION_USAGE: Readonly<Record<HapticPreset, 'touch' | 'media'>> = Object.freeze({
  'impact.light': 'touch',
  'impact.medium': 'touch',
  'impact.heavy': 'touch',
  select: 'touch',
  success: 'media',
  warning: 'media',
  error: 'media',
});

const EFFECT_PREFIX = 'effect:';
const BEAT = /^([A-Z_]+)(?:@(\d*\.?\d+))?(?:\+(\d+))?$/;
const has = (list: readonly string[], name: string): boolean => list.includes(name);

/**
 * Parse one authored mapping. `null` for an empty string (no mapping, by choice) AND for a string
 * that is not valid — `isAndroidEffectSpecValid` tells the two apart for whoever wants to warn.
 */
export function parseAndroidEffect(text: string): PlatformHapticEffect | null {
  const src = text.trim();
  if (src === '') return null;
  if (src.startsWith(EFFECT_PREFIX)) {
    const effect = src.slice(EFFECT_PREFIX.length).trim();
    return has(ANDROID_HAPTIC_EFFECTS, effect) ? { kind: 'effect', effect } : null;
  }
  const primitives: PlatformHapticPrimitive[] = [];
  for (const part of src.split(',')) {
    const m = BEAT.exec(part.trim());
    if (!m || !has(ANDROID_HAPTIC_PRIMITIVES, m[1])) return null;
    const scale = m[2] === undefined ? 1 : Number(m[2]);
    if (!(scale >= 0 && scale <= 1)) return null;
    primitives.push({ id: m[1], scale, delayMs: m[3] === undefined ? 0 : Number(m[3]) });
  }
  return { kind: 'primitives', primitives };
}

/** True for an empty string and for one that parses; false only for an authored mistake. */
export function isAndroidEffectSpecValid(text: string): boolean {
  return text.trim() === '' || parseAndroidEffect(text) !== null;
}
