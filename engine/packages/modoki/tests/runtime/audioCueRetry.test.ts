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
// audioSystem now reaches audio-asset lookups via the audio/audioAssetProvider slot (P7 C12)
// rather than importing loaders/audioBufferCache directly, so the provider is mocked here
// instead — real resolveAudioUrl/retryFailedAudioDecodes/getAudioLoadType underneath.
vi.mock('../../src/runtime/audio/audioAssetProvider', async () => {
  const { resolveAudioUrl, retryFailedAudioDecodes } = await import('../../src/runtime/loaders/audioBufferCache');
  const { getAudioLoadType } = await import('../../src/runtime/loaders/assetManifest');
  const impl = {
    getCachedAudioBuffer: (ref: string) => (decoded.has(ref) ? ({} as AudioBuffer) : undefined),
    resolveAudioUrl, retryFailedAudioDecodes, getAudioLoadType,
  };
  return { audioAssetProvider: { get: () => impl } };
});

import { audioSystem } from '../../src/runtime/audio/audioSystem';
import { cueClip } from '../../src/runtime/audio/audioCues';
import { getAudioLog, clearAudioLog, setAudioRecordMode } from '../../src/runtime/audio/audioService';
import { setPlayState } from '../../src/runtime/core/playState';
import { registerAsset, newGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';
import { AudioSource } from '../../src/runtime/traits/AudioSource';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { journalEvents, clearJournal } from '../../src/runtime/core/journal';

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

/** The two `@audio` warn phases (#289 close-out review). Both are UNREACHABLE from the
 *  record-mode journal tests for the reason this file's header gives — `resolveSpec` never
 *  returns null in node — so they need this file's real-decoder mock, not that file's. */
describe('audioSystem — the failures that used to leave no trace at all', () => {
  it('warns ONCE for an AudioSource clip that will never resolve, not never and not per-frame', () => {
    const clip = mintClip();            // minted but never added to `decoded` → never resolves
    world = createWorld();
    setCurrentWorld(world);
    clearJournal(world);
    world.spawn(AudioSource({ clip, autoplay: true }), EntityAttributes({ guid: newGuid() }));

    // startOrSwap retries an unresolvable clip EVERY frame, forever, with no bound.
    for (let i = 0; i < 10; i++) audioSystem(world);

    const warns = journalEvents({ type: '@audio', level: 'warn' }, world);
    expect(warns).toHaveLength(1);      // once per (entity, clip) — not 10, and not 0
    const p = warns[0].payload as { phase: string; clip?: string; entity?: unknown };
    expect(p.phase).toBe('unresolved');
    expect(p.clip).toBe(clip);
    expect(p.entity).toBeDefined();
    // The source never actually started, and the trace now says so rather than staying blank.
    expect(plays()).toHaveLength(0);
  });

  it('re-arms that warn when the clip CHANGES, so a second bad ref is not swallowed', () => {
    const first = mintClip(); const second = mintClip();
    world = createWorld();
    setCurrentWorld(world);
    clearJournal(world);
    const e = world.spawn(AudioSource({ clip: first, autoplay: true }), EntityAttributes({ guid: newGuid() }));
    audioSystem(world);
    e.set(AudioSource, { ...e.get(AudioSource)!, clip: second });
    audioSystem(world);

    const clips = journalEvents({ type: '@audio', level: 'warn' }, world)
      .map((ev) => (ev.payload as { clip?: string }).clip);
    expect(clips).toEqual([first, second]);
  });

  it('emits `dropped` for a cue discarded by the retry-list CAP, not just for one that ages out', () => {
    world = createWorld();
    setCurrentWorld(world);
    clearJournal(world);
    // 33 distinct undecoded cues in ONE frame: the first 32 fill pendingCues, the 33rd is
    // discarded outright. That overflow was the last silent drop left in the subsystem.
    const clips = Array.from({ length: 33 }, () => mintClip());
    for (const c of clips) cueClip(c, { bus: 'sfx' }, world);
    audioSystem(world);

    const dropped = journalEvents({ type: '@audio', level: 'warn' }, world)
      .map((ev) => ev.payload as { phase: string; reason?: string; clip?: string })
      .filter((p) => p.phase === 'dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe('retry-overflow');
    expect(dropped[0].clip).toBe(clips[32]);
    expect(plays()).toHaveLength(0);
  });
});
