/** Declarative audio control — the reconciling audioSystem (play/pause/clip-swap/
 *  crossfade driven by AudioSource trait fields) + the built-in `audio.*` actions.
 *  Record mode logs *what would play*, so we assert on the play log + trait state. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { AudioSource } from '../../src/runtime/traits/AudioSource';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { audioSystem } from '../../src/runtime/systems/audioSystem';
import {
  getAudioLog, clearAudioLog, setAudioRecordMode,
} from '../../src/runtime/audio/audioService';
import { registerAudioControls, useAudioMixStore } from '../../src/runtime/audio/audioControls';
import { dispatchUIAction } from '../../src/runtime/ui/actionRegistry';
import { setCurrentWorld } from '../../src/runtime/ecs/world';
import { getPlayState, setPlayState } from '../../src/runtime/systems/playState';
import { registerAsset, newGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';

function mintClip(): string {
  const guid = newGuid();
  registerAsset(guid, `/games/x/assets/audio/${guid}.mp3`, 'audio');
  return guid;
}

const plays = () => getAudioLog().filter((e) => e.op === 'play');

let world: ReturnType<typeof createWorld> | undefined;
const prevState = getPlayState();

beforeEach(() => {
  setAudioRecordMode(true);
  clearAudioLog();
  setPlayState('playing');
  registerAudioControls(); // idempotent
  world = createWorld();
  setCurrentWorld(world); // cueClip (audio.playOneShot) enqueues to the current world
});

afterEach(() => {
  world = undefined;
  clearManifest();
  setPlayState(prevState);
});

describe('reconcile — playing gates playback', () => {
  it('does NOT play a non-autoplay source until playing flips true', () => {
    const clip = mintClip();
    const e = world!.spawn(AudioSource({ clip, autoplay: false }));
    audioSystem(world!);
    expect(plays()).toHaveLength(0);

    e.set(AudioSource, { ...e.get(AudioSource)!, playing: true });
    audioSystem(world!);
    expect(plays()).toHaveLength(1);
    expect(plays()[0].clip).toBe(clip);
  });

  it('audio.stop STICKS on an autoplay source — it does not re-fire autoplay', () => {
    const clip = mintClip();
    const e = world!.spawn(AudioSource({ clip, autoplay: true }), EntityAttributes({ guid: newGuid() }));
    audioSystem(world!);            // autoplay starts it
    expect(plays()).toHaveLength(1);
    dispatchUIAction('audio.stop', { target: e, world });
    expect(e.get(AudioSource)!.playing).toBe(false);
    audioSystem(world!);           // must NOT restart via autoplay
    audioSystem(world!);
    expect(plays()).toHaveLength(1);
    expect(e.get(AudioSource)!.playing).toBe(false);
  });

  it('autoplay starts once and sets playing=true', () => {
    const clip = mintClip();
    const e = world!.spawn(AudioSource({ clip, autoplay: true }));
    audioSystem(world!);
    expect(plays()).toHaveLength(1);
    expect(e.get(AudioSource)!.playing).toBe(true);
    // A second tick must NOT restart it.
    audioSystem(world!);
    expect(plays()).toHaveLength(1);
  });
});

describe('reconcile — clip swap', () => {
  it('hard-cut swap (crossfadeSec 0) starts the new clip', () => {
    const a = mintClip(), b = mintClip();
    const e = world!.spawn(AudioSource({ clip: a, autoplay: true }));
    audioSystem(world!);
    e.set(AudioSource, { ...e.get(AudioSource)!, clip: b });
    audioSystem(world!);
    const clips = plays().map((p) => p.clip);
    expect(clips).toEqual([a, b]);
  });

  it('crossfade swap (crossfadeSec > 0) also starts the new clip', () => {
    const a = mintClip(), b = mintClip();
    const e = world!.spawn(AudioSource({ clip: a, autoplay: true, crossfadeSec: 1 }));
    audioSystem(world!);
    e.set(AudioSource, { ...e.get(AudioSource)!, clip: b });
    audioSystem(world!);
    expect(plays().map((p) => p.clip)).toEqual([a, b]);
  });
});

describe('built-in audio.* actions', () => {
  it('audio.toggle flips AudioSource.playing on the target', () => {
    const e = world!.spawn(AudioSource({ clip: mintClip(), playing: true }), EntityAttributes({ guid: newGuid() }));
    dispatchUIAction('audio.toggle', { target: e });
    expect(e.get(AudioSource)!.playing).toBe(false);
    dispatchUIAction('audio.toggle', { target: e });
    expect(e.get(AudioSource)!.playing).toBe(true);
  });

  it('audio.setClip sets clip + playing on the target', () => {
    const clip = mintClip();
    const e = world!.spawn(AudioSource({ clip: '', playing: false }), EntityAttributes({ guid: newGuid() }));
    dispatchUIAction('audio.setClip', { target: e, params: { clip } });
    expect(e.get(AudioSource)!.clip).toBe(clip);
    expect(e.get(AudioSource)!.playing).toBe(true);
  });

  it('audio.setClip resolves a bank KEY → ref on the target', () => {
    const groove = mintClip(), prefunk = mintClip();
    const e = world!.spawn(
      AudioSource({ clip: groove, playing: false, clips: JSON.stringify([
        { key: 'groove', ref: groove }, { key: 'prefunk', ref: prefunk },
      ]) }),
      EntityAttributes({ guid: newGuid() }),
    );
    dispatchUIAction('audio.setClip', { target: e, params: { key: 'prefunk' } });
    expect(e.get(AudioSource)!.clip).toBe(prefunk);
    expect(e.get(AudioSource)!.playing).toBe(true);
  });

  it('audio.setClip with an unknown bank key is a safe no-op', () => {
    const groove = mintClip();
    const e = world!.spawn(
      AudioSource({ clip: groove, playing: false, clips: JSON.stringify([{ key: 'groove', ref: groove }]) }),
      EntityAttributes({ guid: newGuid() }),
    );
    dispatchUIAction('audio.setClip', { target: e, params: { key: 'nope' } });
    expect(e.get(AudioSource)!.clip).toBe(groove); // unchanged
  });

  it('audio.playOneShot resolves a bank KEY on the target + fires on the given bus', () => {
    const click = mintClip();
    const bank = world!.spawn(
      AudioSource({ clip: '', bus: 'sfx', playing: false, clips: JSON.stringify([{ key: 'click', ref: click }]) }),
      EntityAttributes({ guid: newGuid() }),
    );
    dispatchUIAction('audio.playOneShot', { target: bank, params: { key: 'click', bus: 'ui' }, world });
    audioSystem(world!);
    expect(getAudioLog().some((e) => e.op === 'play' && e.clip === click && e.bus === 'ui')).toBe(true);
  });

  it('audio.toggleCrossfade flips crossfadeSec between 0 and seconds', () => {
    const e = world!.spawn(AudioSource({ clip: mintClip(), crossfadeSec: 0 }), EntityAttributes({ guid: newGuid() }));
    dispatchUIAction('audio.toggleCrossfade', { target: e, params: { seconds: 1.2 } });
    expect(e.get(AudioSource)!.crossfadeSec).toBe(1.2);
    dispatchUIAction('audio.toggleCrossfade', { target: e, params: { seconds: 1.2 } });
    expect(e.get(AudioSource)!.crossfadeSec).toBe(0);
  });

  it('audio.setBusVolume updates the mixer store + logs the bus change', () => {
    dispatchUIAction('audio.setBusVolume', { params: { bus: 'music' }, payload: 40, world });
    expect(useAudioMixStore.getState().audioMusic).toBe(40);
    expect(useAudioMixStore.getState().audioMusicPct).toBe('40%');
    expect(getAudioLog().some((e) => e.op === 'setBusVolume' && e.bus === 'music' && e.volume === 0.4)).toBe(true);
  });

  it('audio.playOneShot fires a one-shot cue on the given bus', () => {
    const clip = mintClip();
    // Cues are drained by audioSystem — dispatch, then tick.
    dispatchUIAction('audio.playOneShot', { params: { clip, bus: 'ui' }, world });
    audioSystem(world!);
    expect(getAudioLog().some((e) => e.op === 'play' && e.clip === clip && e.bus === 'ui')).toBe(true);
  });
});
