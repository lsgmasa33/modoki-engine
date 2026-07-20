/** P3 — spatial audio uses WORLD positions for parented sources (hierarchy-and-world-
 *  transform-plan). audioSystem is THREE-free by default (local Transform); the app injects a
 *  world-position resolver (setAudioWorldPositionResolver) reading the worldTransforms cache.
 *  This verifies the injection: a parented source plays at its WORLD position, not its local. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { Transform } from '../../src/runtime/traits/Transform';
import { AudioSource } from '../../src/runtime/traits/AudioSource';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { audioSystem, stopWorldAudio, setAudioWorldPositionResolver } from '../../src/runtime/systems/audioSystem';
import { getAudioLog, clearAudioLog, setAudioRecordMode } from '../../src/runtime/audio/audioService';
import { setPlayState } from '../../src/runtime/systems/playState';
import { registerAsset, newGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';

function mintClip(): string {
  const guid = newGuid();
  registerAsset(guid, `/games/x/assets/sfx/${guid}.mp3`, 'audio');
  return guid;
}

let world: ReturnType<typeof createWorld> | undefined;

beforeEach(() => { setAudioRecordMode(true); clearAudioLog(); setPlayState('playing'); });
afterEach(() => {
  world?.destroy(); world = undefined;
  setAudioRecordMode(false); setPlayState('playing');
  setAudioWorldPositionResolver(null);   // reset injection between tests
  clearManifest();
});

describe('spatial audio world position (P3)', () => {
  it('a parented spatial source plays at its WORLD position via the injected resolver', () => {
    const clip = mintClip();
    world = createWorld();
    // A source at LOCAL (5,0,0), whose "world" the resolver reports as (105,0,0) — as if
    // parented under a group at x=100. The resolver stands in for the worldTransforms cache.
    const src = world.spawn(
      Transform({ x: 5, y: 0, z: 0 }),
      EntityAttributes({ name: 'Src', parentId: 0 }),
      AudioSource({ clip, autoplay: true, spatial: true }),
    );
    setAudioWorldPositionResolver((id) => (id === src.id() ? { x: 105, y: 0, z: 0 } : undefined));

    audioSystem(world);
    const play = getAudioLog().find((l) => l.op === 'play');
    expect(play?.position).toEqual({ x: 105, y: 0, z: 0 }); // WORLD, not local (5)
    stopWorldAudio(world);
  });

  it('falls back to LOCAL Transform when no resolver is injected (THREE-free default)', () => {
    const clip = mintClip();
    world = createWorld();
    world.spawn(
      Transform({ x: 5, y: 0, z: 0 }),
      AudioSource({ clip, autoplay: true, spatial: true }),
    );
    // No resolver set → local Transform is used.
    audioSystem(world);
    const play = getAudioLog().find((l) => l.op === 'play');
    expect(play?.position).toEqual({ x: 5, y: 0, z: 0 });
    stopWorldAudio(world!);
  });
});
