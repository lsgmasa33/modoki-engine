/** Declarative audio control — the reconciling audioSystem (play/pause/clip-swap/
 *  crossfade driven by AudioSource trait fields) + the built-in `audio.*` actions.
 *  Record mode logs *what would play*, so we assert on the play log + trait state. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { AudioSource } from '../../src/runtime/traits/AudioSource';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { audioSystem } from '../../src/runtime/audio/audioSystem';
import {
  getAudioLog, clearAudioLog, setAudioRecordMode,
} from '../../src/runtime/audio/audioService';
import { registerAudioControls, useAudioMixStore } from '../../src/runtime/actions/audioControls';
import { dispatchUIAction } from '../../src/runtime/core/actionRegistry';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { getPlayState, setPlayState } from '../../src/runtime/core/playState';
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
  // destroy(), not just drop the reference: koota hard-caps at 16 live worlds, so this file died at
  // `createWorld` ("Too many worlds created") the moment #1074's cases took it past 16.
  world?.destroy();
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
    dispatchUIAction('audio.stop', { target: e });
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

  it('audio.setClip with an EMPTY `clip` takes the event value (#1075)', () => {
    const clip = mintClip();
    const e = world!.spawn(AudioSource({ clip: '', playing: false }), EntityAttributes({ guid: newGuid() }));
    dispatchUIAction('audio.setClip', { target: e, params: { clip: '' }, payload: clip });
    expect(e.get(AudioSource)!.clip).toBe(clip);
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
    dispatchUIAction('audio.playOneShot', { target: bank, params: { key: 'click', bus: 'ui' } });
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

  it('audio.setBusVolume with an EMPTY `value` takes the slider payload (#1075)', () => {
    // 25, not a value an earlier test in this file leaves in the (global) mixer store.
    dispatchUIAction('audio.setBusVolume', { params: { bus: 'music', value: '' }, payload: 25 });
    expect(useAudioMixStore.getState().audioMusic).toBe(25);
  });

  it('audio.setBusVolume updates the mixer store + logs the bus change', () => {
    dispatchUIAction('audio.setBusVolume', { params: { bus: 'music' }, payload: 40 });
    expect(useAudioMixStore.getState().audioMusic).toBe(40);
    expect(useAudioMixStore.getState().audioMusicPct).toBe('40%');
    expect(getAudioLog().some((e) => e.op === 'setBusVolume' && e.bus === 'music' && e.volume === 0.4)).toBe(true);
  });

  // ── #1074 — `bus` is a DOCUMENT string (scene binding params, agent dispatch payloads), not the
  //    Inspector's enum. Every case below goes through `dispatchUIAction`, never `setBusVolume`
  //    directly: the service's own refusal was already tested, and the defect was the handler's
  //    store write that ran BEFORE it (#1069 — a helper proven while its caller is not).
  const busWrites = () => getAudioLog().filter((e) => e.op === 'setBusVolume');

  it.each(['musik', 'constructor', 'toString'])('audio.setBusVolume REFUSES bus %s — the mixer store is untouched too (#1074)', (bus) => {
    const before = { ...useAudioMixStore.getState() };
    expect(() => dispatchUIAction('audio.setBusVolume', { params: { bus }, payload: 40 })).not.toThrow();
    // Whole-state equality, not "no audioMusik key": a handler that wrote a KNOWN bus instead would
    // pass a key-absence check.
    expect(useAudioMixStore.getState()).toEqual(before);
    expect(busWrites()).toEqual([]);
  });

  it.each([
    // Distinct percentages per row, and neither is master's default of 100 — so a row cannot pass
    // on a value an earlier case (or the initial store) left behind.
    ['""', { bus: '' }, 37],
    ['absent', {}, 53],
  ])('audio.setBusVolume with bus %s is UNSET — it sets master, and does not throw (#1074)', (_label, params, pct) => {
    expect(() => dispatchUIAction('audio.setBusVolume', { params, payload: pct })).not.toThrow();
    expect(useAudioMixStore.getState().audioMaster).toBe(pct);
    expect(useAudioMixStore.getState().audioMasterPct).toBe(`${pct}%`);
    expect(busWrites()).toEqual([{ op: 'setBusVolume', bus: 'master', volume: pct / 100 }]);
  });

  it.each([
    ['""', { bus: '' }],
    ['absent', {}],
  ])('audio.playOneShot with bus %s falls back to the TARGET\'s bus (#1074)', (_label, busParam) => {
    // `''` is not nullish, so `params.bus ?? target.bus` used to keep the empty string, skip the
    // target's bus, and let `resolveBus('')` warn and play it on sfx.
    const click = mintClip();
    const bank = world!.spawn(
      AudioSource({ clip: '', bus: 'music', playing: false, clips: JSON.stringify([{ key: 'click', ref: click }]) }),
      EntityAttributes({ guid: newGuid() }),
    );
    dispatchUIAction('audio.playOneShot', { target: bank, params: { key: 'click', ...busParam } });
    audioSystem(world!);
    expect(plays().filter((e) => e.clip === click).map((e) => e.bus)).toEqual(['music']);
  });

  it('audio.playOneShot fires a one-shot cue on the given bus', () => {
    const clip = mintClip();
    // Cues are drained by audioSystem — dispatch, then tick.
    dispatchUIAction('audio.playOneShot', { params: { clip, bus: 'ui' } });
    audioSystem(world!);
    expect(getAudioLog().some((e) => e.op === 'play' && e.clip === clip && e.bus === 'ui')).toBe(true);
  });
});
