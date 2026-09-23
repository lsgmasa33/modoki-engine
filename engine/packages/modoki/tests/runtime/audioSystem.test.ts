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
import { Transform } from '../../src/runtime/core/traits/Transform';
import { AudioSource } from '../../src/runtime/traits/AudioSource';
import { AudioListener } from '../../src/runtime/traits/AudioListener';
import { audioSystem, stopWorldAudio, rearmAudioAutoplay } from '../../src/runtime/audio/audioSystem';
import { journalEvents } from '../../src/runtime/core/journal';
import { cueSound, cueClip } from '../../src/runtime/audio/audioCues';
import {
  getAudioLog, clearAudioLog, setAudioRecordMode, setBusVolume, resume, dispose, endRecordedVoices,
  holdForFullscreenAd,
} from '../../src/runtime/audio/audioService';
import { getPlayState, setPlayState } from '../../src/runtime/core/playState';
import { setTimelinePreviewActive } from '../../src/runtime/core/timelinePreview';
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

describe('audioSystem — rearmAudioAutoplay (#611 realm-death false alarm)', () => {
  it('re-arms a loop+autoplay source silenced by audioDispose(), restarting it from the top', () => {
    const clip = mintClip();
    world = createWorld();
    const e = world.spawn(Transform(), AudioSource({ clip, autoplay: true, loop: true }));

    audioSystem(world);
    expect(e.get(AudioSource)!.playing).toBe(true);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(1);

    // Realm-death false alarm: `App.tsx`'s `app.cleanup` task calls the audio service's
    // `dispose()` (aliased `audioDispose`) unconditionally, real shutdown or not. Headless
    // record mode (what every test here runs in — no AudioContext exists in node) has no
    // real `LiveHandle`s for `dispose()`'s `stopAll()` to reach, so `endRecordedVoices()`
    // stands in for what it does to a live handle in a real browser: end it.
    dispose();
    endRecordedVoices();

    // Without the fix this is PERMANENT: `autoplayed` still holds this id, so autoplay can
    // never re-declare intent and the source is silent for the rest of the session — exactly
    // the bug this test pins.
    audioSystem(world);
    expect(e.get(AudioSource)!.playing).toBe(false);
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(1);

    rearmAudioAutoplay(world);
    audioSystem(world);
    expect(e.get(AudioSource)!.playing).toBe(true);
    // A restart from the top — a NEW play, not a resume — exactly what a real reload
    // would have produced. `rearmAudioAutoplay` does not attempt to resume mid-track.
    expect(getAudioLog().filter((l) => l.op === 'play')).toHaveLength(2);
  });

  it('is a safe no-op for a world with no audio state yet', () => {
    world = createWorld();
    expect(() => rearmAudioAutoplay(world!)).not.toThrow();
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

describe('audioSystem — recycled entity index (#868)', () => {
  const plays = () => getAudioLog().filter((l) => l.op === 'play');

  it('a same-clip autoplay source respawned on a dead one\'s index between two frames starts its OWN voice', () => {
    const clip = mintClip();
    world = createWorld();
    const a = world.spawn(AudioSource({ clip, autoplay: true, loop: true }));
    audioSystem(world);
    expect(plays()).toHaveLength(1);

    a.destroy();
    const b = world.spawn(AudioSource({ clip, autoplay: true, loop: true }));
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());
    audioSystem(world);

    // Inherited: `autoplayed` already held the index, so `b` never declared intent, and the dead
    // entity's live voice was treated as `b`'s — then paused because `b.playing` stayed false.
    expect(plays()).toHaveLength(2);
    expect(b.get(AudioSource)!.playing).toBe(true);
    expect(getAudioLog().filter((l) => l.op === 'stop')).toHaveLength(1);   // the dead voice
  });

  it('an autoplay guard left by a source that already FINISHED does not silence the next entity on its index', () => {
    // No race needed: a finished one-shot drops its source, and the old sweep only walked `sources`,
    // so the id stayed in `autoplayed` after the entity was gone.
    const clip = mintClip();
    world = createWorld();
    const a = world.spawn(AudioSource({ clip, autoplay: true }));
    audioSystem(world);
    endRecordedVoices();
    audioSystem(world);          // reaps the finished voice
    a.destroy();
    audioSystem(world);          // a frame with the entity gone

    const b = world.spawn(AudioSource({ clip, autoplay: true }));
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());
    audioSystem(world);
    expect(plays()).toHaveLength(2);
  });

  it('a voice that ends naturally journals exactly ONE terminal event', () => {
    const clip = mintClip();
    world = createWorld();
    world.spawn(AudioSource({ clip, autoplay: true }));
    audioSystem(world);
    endRecordedVoices();
    audioSystem(world);             // the reconcile sees the end and journals it
    audioSystem(world);
    const phases = journalEvents({ type: '@audio' }, world).map((e) => (e.payload as { phase: string }).phase);
    expect(phases.filter((p) => p === 'end' || p === 'stop')).toEqual(['end']);
  });

  it('a voice that ended on its own still gets a terminal journal event when its entity vanishes', () => {
    // Every `start` is paired with a terminal event (`end`/`stop`) — docs/audio-plan.md counts them.
    // A one-shot that finishes and whose entity is despawned before the next reconcile sees the end
    // must still close its pair.
    const clip = mintClip();
    world = createWorld();
    const a = world.spawn(AudioSource({ clip, autoplay: true }));
    audioSystem(world);
    endRecordedVoices();
    a.destroy();
    audioSystem(world);
    const events = journalEvents({ type: '@audio' }, world).map((e) => (e.payload as { phase: string }).phase);
    expect(events.filter((p) => p === 'start')).toHaveLength(1);
    expect(events.filter((p) => p === 'end' || p === 'stop')).toHaveLength(1);
  });

  it('the flag maps are pruned to entities still carrying an AudioSource — re-adding the trait re-arms autoplay', () => {
    // Pins the per-pass prune: without it every generation that ever autoplayed stays in
    // `autoplayed` for the life of the world (a bullet-per-frame autoplay sound grows it forever).
    const clip = mintClip();
    world = createWorld();
    const e = world.spawn(AudioSource({ clip, autoplay: true }));
    audioSystem(world);
    endRecordedVoices();
    audioSystem(world);
    e.remove(AudioSource);
    audioSystem(world);
    e.add(AudioSource({ clip, autoplay: true }));
    audioSystem(world);
    expect(plays()).toHaveLength(2);
  });
});

describe('a fullscreen ad holds the cue bus (#1455)', () => {
  afterEach(() => { holdForFullscreenAd(false); });

  it('drops a one-shot cued under the ad, but still starts an entity source — then cues play again after', () => {
    const cue = mintClip();
    const bed = mintClip();
    world = createWorld();
    holdForFullscreenAd(true);
    cueClip(cue, { bus: 'sfx' }, world);
    cueClip(cue, { bus: 'ui' }, world);
    // A scene-owned source is NOT a one-shot: dropping it would leave a non-loop autoplay source
    // never played, and a playlist of buffer clips spinning one track per frame (re-review F2).
    const e = world.spawn(Transform(), AudioSource({ clip: bed, autoplay: true, bus: 'music' }));
    audioSystem(world);
    const plays = getAudioLog().filter((l) => l.op === 'play');
    expect(plays.map((p) => p.clip)).toEqual([bed]);
    expect(e.get(AudioSource)!.playing).toBe(true);

    holdForFullscreenAd(false);
    cueClip(cue, { bus: 'sfx' }, world);
    audioSystem(world);
    expect(getAudioLog().filter((l) => l.op === 'play').map((p) => p.clip)).toEqual([bed, cue]);
  });

  it('journals a DROPPED cue as dropped/ad-hold, never as a start (the journal is the headless observable)', () => {
    const cue = mintClip();
    world = createWorld();
    holdForFullscreenAd(true);
    cueClip(cue, { bus: 'sfx' }, world);
    audioSystem(world);
    const audio = journalEvents({ type: '@audio' }, world).map((e) => e.payload as { phase: string; clip?: string; reason?: string });
    expect(audio.filter((e) => e.clip === cue)).toEqual([expect.objectContaining({ phase: 'dropped', reason: 'ad-hold' })]);
  });
});

