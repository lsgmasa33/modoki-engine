/** audioSystem — one-shot cue retry (adversarial-review #8).
 *
 *  A `cueClip` one-shot whose buffer isn't decoded YET must be retried for a bounded window, not
 *  dropped. On iOS the eager scene-load decode is rejected while the AudioContext is suspended and
 *  only completes after the first-gesture resume — and the first shot's cue fires on that same
 *  gesture, before decode lands. Without a retry the first shot is silent.
 *
 *  The default record-mode audio tests can't exercise this: `hasAudioSupport()` is false in node, so
 *  `resolveSpec` never returns null for an undecoded buffer (it resolves immediately). So this file
 *  forces real mode (`hasAudioSupport → true`) + a controllable buffer cache via module mocks, while
 *  keeping `setAudioRecordMode(true)` so `play()` still LOGS instead of touching a real AudioContext
 *  (record logging is gated on `forcedRecord`, independent of `hasAudioSupport`). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';

// `decoded` must exist before the hoisted vi.mock factory runs → declare it via vi.hoisted.
const { decoded } = vi.hoisted(() => ({ decoded: new Set<string>() }));

// Force "a decoder exists" so an undecoded buffer DEFERS (resolveSpec → null) instead of resolving.
vi.mock('../../src/runtime/audio/audioContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/runtime/audio/audioContext')>()),
  hasAudioSupport: () => true,
}));

// Controllable buffer cache: a clip is "decoded" only once it's in the `decoded` set.
vi.mock('../../src/runtime/loaders/audioBufferCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/loaders/audioBufferCache')>();
  return { ...actual, getCachedAudioBuffer: (ref: string) => (decoded.has(ref) ? ({} as AudioBuffer) : undefined) };
});

import { audioSystem } from '../../src/runtime/systems/audioSystem';
import { cueClip } from '../../src/runtime/audio/audioCues';
import { getAudioLog, clearAudioLog, setAudioRecordMode } from '../../src/runtime/audio/audioService';
import { setPlayState } from '../../src/runtime/systems/playState';
import { registerAsset, newGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';

function mintClip(): string {
  const guid = newGuid();
  registerAsset(guid, `/games/x/assets/sfx/${guid}.mp3`, 'audio'); // no loadType → 'buffer' clip
  return guid;
}

let world: ReturnType<typeof createWorld> | undefined;
const plays = () => getAudioLog().filter((l) => l.op === 'play');

beforeEach(() => { setAudioRecordMode(true); clearAudioLog(); setPlayState('playing'); decoded.clear(); });
afterEach(() => { world?.destroy(); world = undefined; setAudioRecordMode(false); clearManifest(); });

describe('audioSystem — one-shot cue retry (undecoded buffer)', () => {
  it('defers a not-yet-decoded cue, then plays it exactly once when the buffer lands', () => {
    const clip = mintClip();
    world = createWorld();
    cueClip(clip, { bus: 'sfx' }, world);

    audioSystem(world);                 // buffer not decoded → deferred, silent
    expect(plays()).toHaveLength(0);
    audioSystem(world);                 // still decoding → still pending, still silent
    expect(plays()).toHaveLength(0);

    decoded.add(clip);                  // first-gesture resume completes the decode
    audioSystem(world);                 // retry fires the deferred one-shot
    expect(plays()).toHaveLength(1);
    expect(plays()[0].clip).toBe(clip);

    audioSystem(world);                 // and does NOT replay it after
    expect(plays()).toHaveLength(1);
  });

  it('ages a never-decoded cue out of the retry window (no infinite retry)', () => {
    const clip = mintClip();
    world = createWorld();
    cueClip(clip, { bus: 'sfx' }, world);
    for (let i = 0; i < 125; i++) audioSystem(world); // > ONE_SHOT_RETRY_FRAMES (120)
    expect(plays()).toHaveLength(0);

    decoded.add(clip);                  // decoding AFTER the window → the cue is already gone
    audioSystem(world);
    expect(plays()).toHaveLength(0);
  });
});
