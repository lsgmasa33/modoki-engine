/**
 * Whether the music bus should be ducked because another app's audio is playing (#548).
 *
 * Pure module: no ECS, no Web Audio, no wall-clock — same discipline as
 * `games/court/runtime/adPolicy.ts`. The native audio-session state (is another app's audio
 * currently playing) and the foreground state are both observed by the caller and handed in
 * here as an explicit snapshot; that is what keeps this trivially testable and keeps the
 * platform listener itself free of policy logic.
 */

export interface AudioSessionInputs {
  /** True when the OS/native layer reports another app's audio is currently playing (iOS
   *  `AVAudioSession` "other audio is playing" / interruption, Android AudioFocus loss). */
  otherAudioPlaying: boolean;
  /** True when THIS app is in the foreground. */
  isForeground: boolean;
}

/**
 * Duck the music bus when another app is playing audio AND we are in the foreground.
 *
 * The foreground term is what makes a stale duck decision on resume impossible to write:
 * `otherAudioPlaying` is a snapshot from whenever it was last observed, which — while
 * backgrounded — can be arbitrarily stale by the time the app resumes (our own audio isn't
 * audible while backgrounded anyway, so ducking it has no effect the player could hear).
 * Gating on `isForeground` forces the state to be re-evaluated fresh on every foreground
 * transition rather than replaying whatever `otherAudioPlaying` happened to read while away.
 */
export function shouldDuckMusic(inputs: AudioSessionInputs): boolean {
  return inputs.otherAudioPlaying && inputs.isForeground;
}
