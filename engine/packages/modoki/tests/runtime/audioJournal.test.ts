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
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { audioSystem, stopEntityAudio, stopWorldAudio } from '../../src/runtime/audio/audioSystem';
import {
  getAudioLog, clearAudioLog, setAudioRecordMode, play,
} from '../../src/runtime/audio/audioService';
import { cueClip } from '../../src/runtime/audio/audioCues';
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
  if (world) stopWorldAudio(world);
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
