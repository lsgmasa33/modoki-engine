import { trait } from 'koota';

/** The trait's own default, re-exported so `audioSystem` can fall back to it when no scene
 *  entity carries `AudioSettings` — rather than duplicating the number as a second constant
 *  that would silently drift from the authored default. */
export const AUDIO_SETTINGS_DEFAULT_LIMIT = 4;

/**
 * Audio resource — the singleton mixer knobs that are genuinely SETTINGS rather than
 * per-source state (which lives on `AudioSource`) or player volume (which lives in the
 * mix store / `PlayerPrefs`).
 *
 * Authored in the scene, not hardcoded, because `sfxVoiceLimit` is exactly the kind of
 * value whose right answer is only knowable after hearing it: too low and a busy moment
 * eats sounds the designer wanted, too high and the mix clips. A designer must be able to
 * retune it in the Inspector without an engine change — the same reason `HapticSettings`
 * exists rather than a pair of constants.
 */
export const AudioSettings = trait({
  /**
   * Max concurrent FIRE-AND-FORGET one-shots on the `sfx` bus. Past it, the OLDEST such
   * voice is stolen to make room (see `audioSystem`'s `stealOldestSfx`).
   *
   * Three deliberate exemptions, all of which are the point of the policy rather than
   * omissions — see `docs/audio-plan.md` § "The sfx voice cap":
   *  - **Music is never capped or stolen.** It is on its own bus and is sustained by design.
   *  - **Entity-owned `AudioSource` voices are never stolen**, even on the `sfx` bus. A
   *    looping campfire crackle is the OLDEST voice essentially forever, so oldest-first
   *    stealing would kill it the instant four one-shots fired. The cap is for disposable
   *    sounds; an entity source is something the game deliberately keeps alive.
   *  - **The `ui` bus is uncapped.** UI sounds are user-triggered and inherently low-rate;
   *    a click that goes silent because gameplay is busy is a bug, not mix protection.
   *
   * `<= 0` means UNCAPPED — the escape hatch for a game that would rather have the old
   * behaviour than lose a sound. It does NOT mean "silence the sfx bus".
   */
  sfxVoiceLimit: AUDIO_SETTINGS_DEFAULT_LIMIT,
});
