/**
 * `capacitor-modoki-audio` — the native `AVAudioSession` bridge for iOS (#548).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * iOS sets no audio session category anywhere in this repo, so every game inherits the default
 * `.soloAmbient` — which DEACTIVATES whatever another app (Apple Music, a podcast) was playing
 * the moment our own audio starts. The owner wants the opposite: let other apps' audio keep
 * playing, and duck our own music while it does.
 *
 * `.ambient` + `.mixWithOthers` is the category that mixes instead of interrupting. Once set,
 * iOS's *automatic* ducking (`.duckOthers`-style behaviour on THEIR side) is not something we
 * control — what this plugin adds is the signal the engine needs to duck ITS OWN music in
 * response: `AVAudioSession.silenceSecondaryAudioHintNotification`, Apple's purpose-built event
 * for exactly this case, plus a boot/foreground snapshot for the state the notification cannot
 * describe (it only reports transitions, never "what is true right now").
 *
 * Android carries no equivalent — audio there is 100% WebView (Web Audio) with no native audio
 * code, and Chromium owns focus. The Android/web sides of this plugin are permanent no-ops:
 * `shouldSilenceSecondaryAudio()` always resolves `{ silence: false }` and `secondaryAudioHint` is never
 * emitted.
 */

/** The `AVAudioSession.Category` this plugin supports. Both mix with other apps' audio —
 *  `'ambient'` (default) additionally silences ours when the *ring/silent switch* is on, matching
 *  what a casual game normally wants; `'playback'` keeps playing through it, for a game whose
 *  music is the point. Deliberately a small subset of the real enum: these are the only two
 *  categories that make sense alongside `.mixWithOthers`. */
export type AudioSessionCategory = 'ambient' | 'playback';

export interface ModokiAudioPlugin {
  /**
   * Set the `AVAudioSession` category, with `.mixWithOthers` always applied. A no-op on
   * Android/web.
   *
   * Rejects when `category` is not one of `AudioSessionCategory`'s values, naming the allowed
   * set — this is config-driven from `project.config.json` (`capacitor.audioSessionCategory`),
   * and a bad value should fail loudly here rather than reach `AVAudioSession` as a string it
   * does not recognize.
   */
  configure(options: { category: AudioSessionCategory }): Promise<void>;

  /**
   * A BOOT/FOREGROUND SNAPSHOT of `AVAudioSession.sharedInstance().secondaryAudioShouldBeSilencedHint`
   * — the documented companion of the hint notification, so snapshot and event answer the SAME
   * question. Deliberately NOT `isOtherAudioPlaying`, which is broader and would duck on a
   * transition no `.end` ever follows. Needed
   * because `secondaryAudioHint` (below) only reports TRANSITIONS and cannot describe the state
   * the app launched or foregrounded into. Always `{ silence: false }` on Android/web.
   */
  shouldSilenceSecondaryAudio(): Promise<{ silence: boolean }>;

  /**
   * Fires on `AVAudioSession.silenceSecondaryAudioHintNotification` — Apple's purpose-built
   * signal for "another app's audio just started/stopped playing alongside yours". `silence:
   * true` on `.begin` (duck our music now), `false` on `.end` (safe to come back up). Never
   * emitted on Android/web.
   */
  addListener(
    eventName: 'secondaryAudioHint',
    listener: (event: { silence: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}
