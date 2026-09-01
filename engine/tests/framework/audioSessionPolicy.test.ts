/**
 * `shouldDuckMusic` — pure decision for auto-ducking music while another app's audio plays (#548).
 * Genuinely pure (no ECS/Web Audio/wall-clock), so every input combination is exercised directly.
 */

import { describe, expect, it } from 'vitest';
import { shouldDuckMusic, type AudioSessionInputs } from '../../packages/modoki/src/runtime/audio/audioSessionPolicy';

const inputs = (otherAudioPlaying: boolean, isForeground: boolean): AudioSessionInputs => ({
  otherAudioPlaying, isForeground,
});

describe('shouldDuckMusic', () => {
  it('ducks when another app is playing audio and we are in the foreground', () => {
    expect(shouldDuckMusic(inputs(true, true))).toBe(true);
  });

  it('does not duck when no other app audio is playing, foreground or not', () => {
    expect(shouldDuckMusic(inputs(false, true))).toBe(false);
    expect(shouldDuckMusic(inputs(false, false))).toBe(false);
  });

  it('does not duck while backgrounded, even with other audio playing — re-evaluated fresh on resume', () => {
    expect(shouldDuckMusic(inputs(true, false))).toBe(false);
  });
});
