/** `@audio` journal events + record-mode handle identity (#289).
 *
 *  Before this, audio was the one subsystem a QA case could not assert on: no
 *  `@audio.*` event existed anywhere, and record mode returned a SHARED handle whose
 *  `ended` was a hardcoded constant — so a test could prove a voice started and
 *  nothing else. These cases pin both halves.
 *
 *  Note the events are asserted through `journalEvents`, i.e. the same surface
 *  `modoki_journal` reads, rather than through the audio log — the point of the
 *  feature is that audio joins the trace every other subsystem is already in. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createWorld, type World } from 'koota';
import { AudioSource } from '../../src/runtime/traits/AudioSource';
import { AudioSettings } from '../../src/runtime/traits/AudioSettings';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { audioSystem, stopEntityAudio, stopWorldAudio } from '../../src/runtime/audio/audioSystem';
import {
  getAudioLog, clearAudioLog, setAudioRecordMode, play, endRecordedVoices,
} from '../../src/runtime/audio/audioService';
import { cueClip, cueSound } from '../../src/runtime/audio/audioCues';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { getPlayState, setPlayState } from '../../src/runtime/core/playState';
import { journalEvents, clearJournal } from '../../src/runtime/core/journal';
import { registerAsset, newGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';

function mintClip(): string {
  const guid = newGuid();
  registerAsset(guid, `/games/x/assets/audio/${guid}.mp3`, 'audio');
  return guid;
}

interface AudioPayload {
  phase: string; entity?: string | number; clip?: string;
  bus?: string; reason?: string; crossfadeSec?: number;
}

let world: World | undefined;
const prevState = getPlayState();

/** The `@audio` payloads recorded on `world`, in emit order. */
const audioEvents = (): AudioPayload[] =>
  journalEvents({ type: '@audio' }, world!).map((e) => e.payload as AudioPayload);
const phases = (): string[] => audioEvents().map((p) => p.phase);

beforeEach(() => {
  setAudioRecordMode(true);
  clearAudioLog();
  setPlayState('playing');
  world = createWorld();
  setCurrentWorld(world);
  clearJournal(world);
});

afterEach(() => {
  // destroy(), not just drop the reference: koota hard-caps at 16 live worlds, so a file
  // with more than 16 cases dies at `createWorld` with a confusing "too many worlds"
  // rather than a test failure.
  if (world) { stopWorldAudio(world); world.destroy(); }
  world = undefined;
  clearManifest();
  setPlayState(prevState);
});

describe('@audio — the lifecycle is traceable end to end', () => {
  it('records start → pause → resume → stop IN ORDER for one source', () => {
    const clip = mintClip();
    const e = world!.spawn(AudioSource({ clip, autoplay: true }), EntityAttributes({ guid: newGuid() }));
    audioSystem(world!);                                      // start
    e.set(AudioSource, { ...e.get(AudioSource)!, playing: false });
    audioSystem(world!);                                      // pause
    e.set(AudioSource, { ...e.get(AudioSource)!, playing: true });
    audioSystem(world!);                                      // resume
    stopEntityAudio(world!, e);                               // stop

    expect(phases()).toEqual(['start', 'pause', 'resume', 'stop']);
    // Every event names the clip and the owning entity — the two things a case needs
    // to tell one source's trace apart from another's.
    for (const p of audioEvents()) {
      expect(p.clip).toBe(clip);
      expect(p.entity).toBeDefined();
    }
    expect(audioEvents()[3].reason).toBe('entity-stop');
  });

  it('distinguishes a clip SWAP from a fresh start, and carries the crossfade', () => {
    const a = mintClip(); const b = mintClip();
    const e = world!.spawn(
      AudioSource({ clip: a, autoplay: true, crossfadeSec: 0.4 }),
      EntityAttributes({ guid: newGuid() }),
    );
    audioSystem(world!);
    e.set(AudioSource, { ...e.get(AudioSource)!, clip: b });
    audioSystem(world!);

    expect(phases()).toEqual(['start', 'swap']);
    expect(audioEvents()[0].clip).toBe(a);
    expect(audioEvents()[1].clip).toBe(b);
    expect(audioEvents()[1].crossfadeSec).toBe(0.4);
  });

  it('a fire-and-forget cue one-shot is recorded WITHOUT an entity', () => {
    const clip = mintClip();
    cueClip(clip, { bus: 'ui' }, world!);
    audioSystem(world!);

    expect(phases()).toEqual(['start']);
    expect(audioEvents()[0].entity).toBeUndefined(); // no owning entity, by design
    expect(audioEvents()[0].clip).toBe(clip);
    expect(audioEvents()[0].bus).toBe('ui');
  });

  it('names WHY a stop happened, so teardown paths are told apart', () => {
    const clip = mintClip();
    world!.spawn(AudioSource({ clip, autoplay: true }), EntityAttributes({ guid: newGuid() }));
    audioSystem(world!);
    setPlayState('stopped');
    audioSystem(world!);                                      // leaving Play

    expect(phases()).toEqual(['start', 'stop']);
    expect(audioEvents()[1].reason).toBe('not-playing');
  });

  it('records a stop when the source ENTITY vanishes mid-play', () => {
    const clip = mintClip();
    const e = world!.spawn(AudioSource({ clip, autoplay: true }), EntityAttributes({ guid: newGuid() }));
    audioSystem(world!);
    e.destroy();
    audioSystem(world!);

    expect(phases()).toEqual(['start', 'stop']);
    expect(audioEvents()[1].reason).toBe('entity-gone');
  });

  it('is scoped to ITS world — a second world does not see the first trace', () => {
    const clip = mintClip();
    world!.spawn(AudioSource({ clip, autoplay: true }), EntityAttributes({ guid: newGuid() }));
    audioSystem(world!);

    const other = createWorld();
    expect(journalEvents({ type: '@audio' }, other)).toHaveLength(0);
    expect(phases()).toEqual(['start']);
    other.destroy();
  });
});

describe('the gaps close-out review found — a voice that is invisible to the trace', () => {
  it('a crossfade TAIL is traced too, so starts and stops balance', () => {
    const a = mintClip(); const b = mintClip();
    const e = world!.spawn(
      AudioSource({ clip: a, autoplay: true, crossfadeSec: 0.4 }),
      EntityAttributes({ guid: newGuid() }),
    );
    audioSystem(world!);                                       // start A
    e.set(AudioSource, { ...e.get(AudioSource)!, clip: b });
    audioSystem(world!);                                       // swap → A becomes a tail
    stopWorldAudio(world!);                                    // teardown reaps the tail

    // Two voices existed (A, then B), so two teardowns must appear. Before the fix the
    // tail vanished unobserved and this read 1 — which is what made a voice COUNT
    // underreport by one per crossfade.
    const started = phases().filter((p) => p === 'start' || p === 'swap').length;
    const finished = phases().filter((p) => p === 'stop' || p === 'end').length;
    expect(started).toBe(2);
    expect(finished).toBe(2);
    // The tail's own stop names the clip it belonged to, not the clip that replaced it.
    const tail = audioEvents().find((p) => p.phase === 'stop' && p.clip === a);
    expect(tail).toBeDefined();
    expect(tail!.reason).toBe('world-teardown');
  });

  // The `unresolved` and `retry-overflow` phases can only be reached with a real decoder
  // present (record mode's resolveSpec never returns null), so they live in
  // audioCueRetry.test.ts, which already mocks hasAudioSupport → true.
});

describe('the sfx voice cap — oldest-first stealing (owner policy, 2026-08-21)', () => {
  /** Fire `n` distinct one-shot cues and run one frame. Record mode never ends a voice on
   *  its own, so every shot stays "live" and the cap engages deterministically. */
  function fire(n: number, bus: 'sfx' | 'ui' | 'music' = 'sfx'): string[] {
    const clips = Array.from({ length: n }, () => mintClip());
    for (const c of clips) cueClip(c, { bus }, world!);
    audioSystem(world!);
    return clips;
  }
  const stolen = () => audioEvents().filter((p) => p.phase === 'stolen');

  it('holds at the authored limit, stealing the OLDEST first', () => {
    world!.spawn(AudioSettings({ sfxVoiceLimit: 4 }));
    const clips = fire(6);

    // Six fired, four may sound: the two stolen are the two OLDEST, in age order.
    expect(stolen().map((p) => p.clip)).toEqual([clips[0], clips[1]]);
    expect(stolen()[0].reason).toBe('voice-cap');
    // Every shot still reports `start` — a stolen voice DID play, it was cut short.
    expect(audioEvents().filter((p) => p.phase === 'start')).toHaveLength(6);
  });

  it('reads the limit from the SCENE, not from a constant — 2 steals sooner than 4', () => {
    world!.spawn(AudioSettings({ sfxVoiceLimit: 2 }));
    const clips = fire(3);
    expect(stolen().map((p) => p.clip)).toEqual([clips[0]]);
  });

  it('treats a limit of 0 as UNCAPPED, not as silence', () => {
    world!.spawn(AudioSettings({ sfxVoiceLimit: 0 }));
    fire(10);
    expect(stolen()).toHaveLength(0);
    expect(audioEvents().filter((p) => p.phase === 'start')).toHaveLength(10);
  });

  it('never caps MUSIC or the ui bus — only sfx', () => {
    world!.spawn(AudioSettings({ sfxVoiceLimit: 2 }));
    fire(6, 'music');
    fire(6, 'ui');
    expect(stolen()).toHaveLength(0);
  });

  it('never steals an entity-owned AudioSource, even a looping one on the sfx bus', () => {
    world!.spawn(AudioSettings({ sfxVoiceLimit: 2 }));
    const ambience = mintClip();
    world!.spawn(
      AudioSource({ clip: ambience, autoplay: true, loop: true, bus: 'sfx' }),
      EntityAttributes({ guid: newGuid() }),
    );
    audioSystem(world!);              // the loop starts, and is now the OLDEST voice
    fire(6);                          // plenty to blow past the cap

    // Under naive oldest-first the campfire would be the first thing killed. It must not be.
    expect(stolen().map((p) => p.clip)).not.toContain(ambience);
    // and it is still playing
    expect(phases().filter((p) => p === 'stop' || p === 'end')).toHaveLength(0);
  });

  it('counts a NAMED cue fan-out against the cap — those are one-shots too', () => {
    world!.spawn(AudioSettings({ sfxVoiceLimit: 2 }));
    const clip = mintClip();
    for (let i = 0; i < 4; i++) {
      world!.spawn(
        AudioSource({ clip, playOnCue: 'hit', bus: 'sfx' }),
        EntityAttributes({ guid: newGuid() }),
      );
    }
    cueSound('hit', world!);
    audioSystem(world!);

    // Four sources match one cue → four one-shots → two stolen at a limit of 2.
    expect(stolen()).toHaveLength(2);
  });

  it('a finished one-shot frees its slot, and says so, instead of holding it', () => {
    // This must drive the per-frame reap sweep specifically. An earlier version of this
    // test used `stopWorldAudio` to "end" the voices — which empties `oneShots` wholesale
    // and therefore passed identically with the sweep DELETED. `endRecordedVoices` ends the
    // handles the way a real non-looping source self-reaps, leaving the sweep as the only
    // thing that can free the slots.
    world!.spawn(AudioSettings({ sfxVoiceLimit: 2 }));
    const first = fire(2);
    expect(stolen()).toHaveLength(0);

    endRecordedVoices();              // both voices finish naturally
    audioSystem(world!);              // the sweep reaps them
    expect(audioEvents().filter((p) => p.phase === 'end').map((p) => p.clip)).toEqual(first);

    const second = fire(2);
    expect(stolen()).toHaveLength(0); // the freed slots were reused, nothing stolen
    expect(second).toHaveLength(2);
  });

  it('ramps a stolen voice over the AUTHORED fade, not a hardcoded one', () => {
    // The fade length is a feel value, so like the limit it has to come from the scene.
    // Record mode logs the ramp (op:'fade'), which is the only way to tell an authored
    // 250 ms from the 10 ms default — a no-op fade() cannot distinguish them.
    world!.spawn(AudioSettings({ sfxVoiceLimit: 1, sfxStealFadeSec: 0.25 }));
    const clips = fire(2);

    expect(stolen().map((p) => p.clip)).toEqual([clips[0]]);
    const fades = getAudioLog().filter((l) => l.op === 'fade');
    expect(fades).toHaveLength(1);
    expect(fades[0].clip).toBe(clips[0]);   // the stolen voice, not the new one
    expect(fades[0].volume).toBe(0);        // ramped to silence
    expect(fades[0].durationSec).toBe(0.25);
  });

  it('honours an authored fade of 0 as a HARD CUT — no ramp scheduled at all', () => {
    world!.spawn(AudioSettings({ sfxVoiceLimit: 1, sfxStealFadeSec: 0 }));
    const clips = fire(2);

    expect(stolen().map((p) => p.clip)).toEqual([clips[0]]);
    // 0 must mean "cut", not "ramp over 0s" — scheduling a zero-length ramp would be a
    // pointless AudioParam event, and the guard for that is that none is scheduled.
    expect(getAudioLog().filter((l) => l.op === 'fade')).toHaveLength(0);
  });

  it('balances a STOLEN voice too — one terminal event each, never zero and never two', () => {
    // The crossfade-tail fix established this invariant; the steal path has to hold it as
    // well, or a voice count drifts by one per steal in the opposite direction.
    world!.spawn(AudioSettings({ sfxVoiceLimit: 1, sfxStealFadeSec: 0.25 }));
    fire(3);
    stopWorldAudio(world!);   // force-stop anything still ramping

    const started = phases().filter((p) => p === 'start' || p === 'swap').length;
    const terminal = phases().filter((p) => p === 'stop' || p === 'end' || p === 'stolen').length;
    expect(started).toBe(3);
    expect(terminal).toBe(3);
    // and specifically NOT double-counted: a stolen voice must not also report end/stop.
    expect(phases().filter((p) => p === 'stolen')).toHaveLength(2);
  });

  it('keeps a ramping stolen voice force-stoppable instead of orphaning it', () => {
    world!.spawn(AudioSettings({ sfxVoiceLimit: 1, sfxStealFadeSec: 0.25 }));
    const clips = fire(2);    // clips[0] is stolen and is now ramping down

    // Record mode cannot fire the audio-clock stopAfter, so if the steal dropped its last
    // reference the handle would sit ended:false forever with a play and no stop. Teardown
    // must still be able to reach it.
    expect(getAudioLog().filter((l) => l.op === 'stop')).toHaveLength(0);
    stopWorldAudio(world!);
    const stops = getAudioLog().filter((l) => l.op === 'stop');
    expect(stops.map((l) => l.clip)).toContain(clips[0]);
  });

  it('floors a fractional authored limit instead of silently capping one higher', () => {
    // The Inspector's number box accepts a typed fraction; `while (n >= 2.5)` settles at 3.
    world!.spawn(AudioSettings({ sfxVoiceLimit: 2.5 }));
    const clips = fire(4);
    // Floored to 2 → the two oldest of four are stolen. Unfloored it would steal only one.
    expect(stolen().map((p) => p.clip)).toEqual([clips[0], clips[1]]);
  });

  it('falls back to the trait default when no scene entity authors AudioSettings', () => {
    const clips = fire(5);            // default is 4
    expect(stolen().map((p) => p.clip)).toEqual([clips[0]]);
  });
});

describe('record mode returns a handle PER PLAY, not a shared singleton', () => {
  it('stop() ends only the handle it was called on', () => {
    const one = play({ buffer: null, clip: 'a' });
    const two = play({ buffer: null, clip: 'b' });
    expect(one.ended).toBe(false);
    expect(two.ended).toBe(false);

    one.stop();

    // The bug this pins: with a shared handle, `two.ended` flipped as well — so
    // audioSystem's per-source reap check was answered by a process-wide constant.
    expect(one.ended).toBe(true);
    expect(two.ended).toBe(false);
  });

  it('stop() is provable from the audio log, and does not double-log', () => {
    const h = play({ buffer: null, clip: 'x' });
    expect(getAudioLog().filter((l) => l.op === 'stop')).toHaveLength(0);

    h.stop();
    h.stop(); // idempotent

    const stops = getAudioLog().filter((l) => l.op === 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].clip).toBe('x');
  });

  it('a stopped source is reaped by audioSystem instead of lingering forever', () => {
    const clip = mintClip();
    const e = world!.spawn(AudioSource({ clip, autoplay: true }), EntityAttributes({ guid: newGuid() }));
    audioSystem(world!);
    stopEntityAudio(world!, e);
    // playing must have been cleared by the teardown reconcile, not left true.
    e.set(AudioSource, { ...e.get(AudioSource)!, playing: false });
    audioSystem(world!);

    expect(getAudioLog().filter((l) => l.op === 'stop')).toHaveLength(1);
    expect(phases()).toEqual(['start', 'stop']);
  });
});
