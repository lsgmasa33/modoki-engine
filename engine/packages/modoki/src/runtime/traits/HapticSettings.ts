import { trait } from 'koota';
import { DEFAULT_ANDROID_EFFECTS } from './hapticEffectDefaults';

/**
 * Haptics resource — the singleton knobs for device haptic feedback.
 *
 * The named patterns are NOT here: engine defaults are code
 * constants and a game registers its own in `setup.ts` (see `runtime/haptics/patterns.ts` for why
 * — a pattern is vocabulary with no file behind it, not an asset). What lives here is the part
 * that is genuinely a setting: whether haptics happen at all, how strong, and (Android, #2103)
 * which of the vibrator's own effects each preset asks for.
 *
 * `enabled` is a PLAYER preference, so a game that exposes an on/off control should persist it
 * through PlayerPrefs and write it back here on load — the trait is the live value, PlayerPrefs is
 * the durable one. It is authored in the scene so a designer can ship a game with haptics off by
 * default without a code change.
 */
export const HapticSettings = trait({
  /** Master switch. False = the game as if haptics did not exist. */
  enabled: true,
  /**
   * 0..1. ⚠️ Currently a GATE, not a scale: below 0.05 nothing plays, and above it every pattern
   * plays at its authored strength. Presets carry fixed strengths and no platform in range lets us
   * scale one, so anything in between would be a lie. The field exists because a player-facing
   * strength slider is the obvious next ask and should not require a trait migration the day a
   * backend can finally honour it.
   */
  masterIntensity: 1,
  /**
   * Android only (#2103): play presets as the vibrator's own predefined effects and primitives
   * where it reports them, instead of `@capacitor/haptics`' timed amplitude steps. OFF by default:
   * nobody has judged the new feel yet, so this is an A/B switch, not a shipped behaviour. No
   * effect on iOS, or on a vibrator that reports none (the Galaxy A23).
   */
  platformEffects: false,
  /**
   * What each preset asks an Android vibrator for when `platformEffects` is on. One string per
   * preset, in the format `runtime/haptics/platformEffects.ts` documents (`effect:TICK`,
   * `TICK@0.6`, `CLICK, CLICK@0.7+65`). Empty = that preset keeps the old call. `hapticsSystem`
   * reads all seven by walking `ANDROID_EFFECT_FIELDS`.
   */
  androidImpactLight: DEFAULT_ANDROID_EFFECTS['impact.light'],
  androidImpactMedium: DEFAULT_ANDROID_EFFECTS['impact.medium'],
  androidImpactHeavy: DEFAULT_ANDROID_EFFECTS['impact.heavy'],
  androidSelect: DEFAULT_ANDROID_EFFECTS.select,
  androidSuccess: DEFAULT_ANDROID_EFFECTS.success,
  androidWarning: DEFAULT_ANDROID_EFFECTS.warning,
  androidError: DEFAULT_ANDROID_EFFECTS.error,
});
