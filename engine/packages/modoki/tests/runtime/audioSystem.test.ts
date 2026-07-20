/** Audio subsystem — headless determinism gate. No AudioContext exists in node,
 *  so `audioService` runs in RECORD MODE: every play/stop/bus change is logged
 *  instead of sounded, letting us assert *what would play* deterministically —
 *  with zero dependency on the verification journal.
 *
 *  Covers: audioService record mode, audioSystem autoplay + play-state gating,
 *  the cue bus (named + direct one-shots), and the scene-scoped refcounted
 *  audio-buffer cache. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { Transform } from '../../src/runtime/traits/Transform';
import { AudioSource } from '../../src/runtime/traits/AudioSource';
import { AudioListener } from '../../src/runtime/traits/AudioListener';
import { audioSystem, stopWorldAudio } from '../../src/runtime/systems/audioSystem';
import { cueSound, cueClip } from '../../src/runtime/audio/audioCues';
import {
  getAudioLog, clearAudioLog, setAudioRecordMode, setBusVolume, resume,
} from '../../src/runtime/audio/audioService';
import { getPlayState, setPlayState } from '../../src/runtime/systems/playState';
import { setTimelinePreviewActive } from '../../src/runtime/systems/timelinePreview';
import {
  acquireAudio, releaseAudioForScene, disposeAllAudioBuffers, getAudioCacheStats,
  retryFailedAudioDecodes,
} from '../../src/runtime/loaders/audioBufferCache';
import { registerAsset, newGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';

// A registered audio asset so refToPath resolves (no "unknown guid" warning).
function mintClip(): string {
  const guid = newGuid();
  registerAsset(guid, `/games/x/assets/sfx/${guid}.mp3`, 'audio');
  return guid;
}

let world: ReturnType<typeof createWorld> | undefined;

beforeEach(() => {
  setAudioRecordMode(true);
  clearAudioLog();
  setPlayState('playing');
});

afterEach(() => {
  world?.destroy();
  world = undefined;
  setAudioRecordMode(false);
  setPlayState('playing');
  setTimelinePreviewActive(false);
  disposeAllAudioBuffers();
  clearManifest();
});

describe('audioService — record mode', () => {
  it('logs play / setBusVolume / resume instead of sounding', () => {
    const clip = mintClip();
    resume();
    setBusVolume('music', 0.5);
    const log = getAudioLog();
    expect(log.find((e) => e.op === 'resume')).toBeTruthy();
    expect(log.find((e) => e.op === 'setBusVolume' && e.bus === 'music' && e.volume === 0.5)).toBeTruthy();
    expect(clip).toBeTruthy();
  });
});

describe('audioSystem — autoplay', () => {
  it('plays an autoplay source once, on the right bus, and sets playing=true', () => {
    const clip = mintClip();
    world = createWorld();
    const e = world.spawn(Transform(), AudioSource({ clip, autoplay: true, bus: 'music', volume: 0.8 }));

    audioSystem(world);
    const plays = getAudioLog().filter((l) => l.op === 'play');
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ clip, bus: 'music', volume: 0.8 });
    expect(e.get(AudioSource)!.playing).toBe(true);

    // Second frame must NOT re-trigger the one-shot.
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(1);
  });

  it('does NOT play a non-autoplay source', () => {
    const clip = mintClip();
    world = createWorld();
    world.spawn(Transform(), AudioSource({ clip, autoplay: false }));
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(0);
  });

  it('plays a non-spatial source that has NO Transform (UI/music entity)', () => {
    const clip = mintClip();
    world = createWorld();
    world.spawn(AudioSource({ clip, autoplay: true })); // no Transform
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(1);
  });
});

describe('audioSystem — scene-swap teardown (leak fix)', () => {
  it('stopWorldAudio stops + forgets a world\'s live sources', () => {
    const clip = mintClip();
    world = createWorld();
    world.spawn(Transform(), AudioSource({ clip, autoplay: true, loop: true }));
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(1);

    clearAudioLog();
    stopWorldAudio(world); // teardown clears handles + autoplayed
    // Proof the state was torn down: autoplay is eligible to fire again.
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(1);
  });

  it('fires a Transform-less playOnCue source', () => {
    const clip = mintClip();
    world = createWorld();
    world.spawn(AudioSource({ clip, playOnCue: 'ping' })); // no Transform
    cueSound('ping', world);
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(1);
  });
});

describe('audioSystem — play-state gating', () => {
  it('produces no sound while stopped, and stays silent', () => {
    const clip = mintClip();
    world = createWorld();
    world.spawn(Transform(), AudioSource({ clip, autoplay: true }));
    setPlayState('stopped');
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(0);
    expect(getPlayState()).toBe('stopped');
  });
});

describe('audioSystem — cue bus', () => {
  it('cueSound fires matching playOnCue sources as one-shots', () => {
    const clip = mintClip();
    world = createWorld();
    world.spawn(Transform(), AudioSource({ clip, autoplay: false, playOnCue: 'boom' }));

    // No cue yet → nothing plays.
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(0);

    cueSound('boom', world);
    audioSystem(world);
    const plays = getAudioLog().filter((l) => l.op === 'play');
    expect(plays).toHaveLength(1);
    expect(plays[0].clip).toBe(clip);

    // Cue is drained — no replay next frame.
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(1);
  });

  it('cueClip plays a direct one-shot with no entity', () => {
    const clip = mintClip();
    world = createWorld();
    cueClip(clip, { bus: 'ui', volume: 0.3 }, world);
    audioSystem(world);
    const plays = getAudioLog().filter((l) => l.op === 'play');
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ clip, bus: 'ui', volume: 0.3 });
  });

  it('discards cues raised while not playing', () => {
    const clip = mintClip();
    world = createWorld();
    setPlayState('stopped');
    cueClip(clip, {}, world);
    audioSystem(world); // drains + discards
    setPlayState('playing');
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(0);
  });
});

describe('audioSystem — Timeline preview gate (Phase 6)', () => {
  it('PLAYS a cue while stopped when the Timeline preview flag is active', () => {
    const clip = mintClip();
    world = createWorld();
    setPlayState('stopped');            // editor is not in Play…
    setTimelinePreviewActive(true);     // …but the Timeline panel is previewing forward
    cueClip(clip, {}, world);
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(1);
    expect(getPlayState()).toBe('stopped'); // preview never flips play-state
  });

  it('DISCARDS a cue while stopped without the preview flag (the flag is the only opener)', () => {
    const clip = mintClip();
    world = createWorld();
    setPlayState('stopped');
    setTimelinePreviewActive(false);
    cueClip(clip, {}, world);
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(0);
  });

  it('an autoplay source stays silent when a swap clears the preview flag mid-preview', () => {
    const clip = mintClip();
    world = createWorld();
    world.spawn(Transform(), AudioSource({ clip, autoplay: true }));
    setPlayState('stopped');
    setTimelinePreviewActive(false); // simulates the onWorldSwap reset after a mid-preview scene load
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(0);
  });
});

describe('audio buffer cache — scene-scoped refcount', () => {
  it('acquire registers an owner; releaseAudioForScene drops it', async () => {
    const clip = mintClip();
    await acquireAudio(1, clip, 'buffer');
    let stats = getAudioCacheStats();
    const path = Object.keys(stats.owners)[0];
    expect(stats.owners[path]).toBe(1);

    releaseAudioForScene(1);
    stats = getAudioCacheStats();
    expect(Object.keys(stats.owners)).toHaveLength(0);
  });

  it('a clip shared by two scenes survives releasing the first', async () => {
    const clip = mintClip();
    await acquireAudio(1, clip, 'buffer');
    await acquireAudio(2, clip, 'buffer');
    const path = Object.keys(getAudioCacheStats().owners)[0];
    expect(getAudioCacheStats().owners[path]).toBe(2);

    releaseAudioForScene(1);
    expect(getAudioCacheStats().owners[path]).toBe(1); // scene 2 still holds it

    releaseAudioForScene(2);
    expect(Object.keys(getAudioCacheStats().owners)).toHaveLength(0);
  });

  it("'stream' clips register ownership without decoding", async () => {
    const clip = mintClip();
    await acquireAudio(1, clip, 'stream');
    const stats = getAudioCacheStats();
    expect(Object.values(stats.owners)[0]).toBe(1);
    expect(stats.buffers).toBe(0); // never decoded
  });

  it('retryFailedAudioDecodes is a safe no-op over owned clips (no AudioContext headless)', async () => {
    // On iOS the load-time decodes fail (suspended context); resume() calls this to
    // re-decode. Headless has no context, so it can't decode — but it must not throw
    // and must not leave a phantom buffer.
    const clip = mintClip();
    await acquireAudio(1, clip, 'buffer');
    expect(() => retryFailedAudioDecodes()).not.toThrow();
    expect(getAudioCacheStats().buffers).toBe(0);
  });
});
