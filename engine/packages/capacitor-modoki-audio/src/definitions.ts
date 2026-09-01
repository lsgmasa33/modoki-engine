/**
 * `capacitor-modoki-audio` — the native `AVAudioSession` bridge for iOS (#548).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * iOS sets no audio session category anywhere in this repo, so every game inherits the default
 * `.soloAmbient` — which DEACTIVATES whatever another app (Apple Music, a podcast) was playing
 * the moment our own audio starts. The owner wants the opposite: let other apps' audio keep
 * playing alongside ours.
 *
 * `.ambient` + `.mixWithOthers` is the category that mixes instead of interrupting.
 *
 * Android carries no equivalent — audio there is 100% WebView (Web Audio) with no native audio
 * code, and Chromium owns focus. The Android/web side of this plugin is a permanent no-op.
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
}
