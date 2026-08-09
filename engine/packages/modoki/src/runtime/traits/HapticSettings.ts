import { trait } from 'koota';

/**
 * Haptics resource — the singleton knobs for device haptic feedback.
 *
 * Deliberately only TWO fields. The named patterns are NOT here: engine defaults are code
 * constants and a game registers its own in `setup.ts` (see `runtime/haptics/patterns.ts` for why
 * — a pattern is vocabulary with no file behind it, not an asset). What lives here is the part
 * that is genuinely a setting: whether haptics happen at all, and how strong.
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
});
