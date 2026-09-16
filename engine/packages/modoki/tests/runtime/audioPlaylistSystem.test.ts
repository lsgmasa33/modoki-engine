/** `AudioSource.playlist` driven the way PRODUCTION drives it — through `audioSystem`, not by
 *  calling `nextClip` directly.
 *
 *  `engine/tests/framework/audioPlaylist.test.ts` owns the decision logic (thresholds, rotation,
 *  the in-flight latch) as a pure unit. What it cannot see is the seam: whether `audioSystem`
 *  actually reaches that code, hands it the right arguments, and writes the result back onto the
 *  trait. That gap is where this repo's bugs live, so it gets its own file.
 *
 *  ⚠️ What this CANNOT cover, stated rather than faked: node has no AudioContext, so the service
 *  runs in RECORD MODE, and a `RecordingHandle` has no playhead — `remainingSec()` returns `null`
 *  by design. So the swap THRESHOLD cannot fire here, and making a fixture report a fake remaining
 *  time would be modelling behaviour nothing has. The threshold is pinned by the unit suite and was
 *  confirmed live in the editor (`@audio phase:"swap"`). What IS covered here is everything else
 *  the system half owns — and the `null` path below is the more valuable half anyway, because it
 *  is the one that would silently shred a playlist.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { AudioSource } from '../../src/runtime/traits/AudioSource';
import { audioSystem, rearmAudioAutoplay } from '../../src/runtime/audio/audioSystem';
import { setAudioRecordMode, clearAudioLog, endRecordedVoices, dispose } from '../../src/runtime/audio/audioService';
import { setPlayState } from '../../src/runtime/core/playState';
import { stringifyClipBank } from '../../src/runtime/audio/clipBank';
import { registerAsset, newGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';

function mintClip(): string {
  const guid = newGuid();
  registerAsset(guid, `/games/x/assets/music/${guid}.mp3`, 'audio');
  return guid;
}

let world: ReturnType<typeof createWorld> | undefined;
let refs: string[];
let bank: string;

beforeEach(() => {
  setAudioRecordMode(true);
  clearAudioLog();
  setPlayState('playing');
  world = createWorld();
  refs = Array.from({ length: 4 }, () => mintClip());
  bank = stringifyClipBank(refs.map((ref, i) => ({ key: `t${i}`, ref })));
});
afterEach(() => {
  world?.destroy(); world = undefined;
  setAudioRecordMode(false); setPlayState('playing'); clearManifest();
  vi.restoreAllMocks();
});

describe('a playlist source, driven through audioSystem', () => {
  it('does not advance while the remaining time is unknowable', () => {
    // The whole failure mode in one assertion. `remainingSec()` is `null` in record mode, and a
    // reader that treated `null` as 0 would swap on EVERY frame — burning the bank in four frames
    // and playing none of it. Fifty frames, one clip.
    const e = world!.spawn(AudioSource({
      clip: refs[0], bus: 'music', clips: bank, playlist: 'shuffle', autoplay: true, crossfadeSec: 1.5,
    }));
    for (let i = 0; i < 50; i++) audioSystem(world!);
    expect(e.get(AudioSource)!.clip).toBe(refs[0]);
  });

  it('leaves a playlist:off source alone entirely', () => {
    // The control: proves the assertion above is caused by the `null` guard and not by the
    // playlist block being unreachable from `audioSystem` in the first place.
    const e = world!.spawn(AudioSource({
      clip: refs[0], bus: 'music', clips: bank, playlist: 'off', autoplay: true,
    }));
    for (let i = 0; i < 10; i++) audioSystem(world!);
    expect(e.get(AudioSource)!.clip).toBe(refs[0]);
  });
});

describe('playlist + loop is a contradiction the system must SAY', () => {
  it('warns once — not once per frame — when both are set', () => {
    // A looping clip never runs out, so the playlist can never advance and clip one plays forever.
    // Nothing else would report it: the bank is valid, the source plays, the Inspector looks right.
    // Warning per frame would be worse than silence, so the once-ness is part of the fix.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    world!.spawn(AudioSource({
      clip: refs[0], bus: 'music', clips: bank, playlist: 'shuffle', loop: true, autoplay: true,
    }));
    for (let i = 0; i < 20; i++) audioSystem(world!);
    const mine = warn.mock.calls.filter((c) => String(c[0]).includes('playlist'));
    expect(mine).toHaveLength(1);
    expect(String(mine[0][0])).toMatch(/never (ends|advance)/);
  });

  it('stays quiet when the two are used correctly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    world!.spawn(AudioSource({ clip: refs[0], bus: 'music', clips: bank, playlist: 'shuffle', autoplay: true }));
    world!.spawn(AudioSource({ clip: refs[1], bus: 'music', clips: bank, loop: true, autoplay: true }));
    for (let i = 0; i < 20; i++) audioSystem(world!);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('playlist'))).toHaveLength(0);
  });
});

describe('a clip that ENDS advances the playlist — the recovery path', () => {
  /** ⚠️ This is the defect that would have shipped, and the default config walks straight into it.
   *
   *  The cross-fade trigger `remaining <= crossfadeSec` is a WINDOW that has to be observed on a
   *  frame. At the trait default `crossfadeSec: 0` that window is the single instant
   *  `remaining === 0`, which a 60 Hz tick essentially never samples; and even at Court's 1.5 s,
   *  anything that stops rAF across a clip boundary (a phone backgrounding the app, a long asset
   *  hitch) steps over it. Landing past the end used to set `playing = false`, and with autoplay
   *  already spent NOTHING restarted it — silence for the rest of the session, `playing: false` in
   *  the Inspector, and no warning anywhere.
   *
   *  `endRecordedVoices()` is what makes this reachable headlessly: record mode has no audio clock
   *  and no `onended`, so a voice never finishes on its own. */
  const spawnPlaylist = (crossfadeSec: number) => world!.spawn(AudioSource({
    clip: refs[0], bus: 'music', clips: bank, playlist: 'sequential', autoplay: true, crossfadeSec,
  }));

  it.each([0, 1.5])('at crossfadeSec %s, an ended clip takes the next one instead of going silent', (fade) => {
    const e = spawnPlaylist(fade);
    audioSystem(world!);                       // clip 1 is playing
    expect(e.get(AudioSource)!.playing).toBe(true);

    endRecordedVoices();                       // the window was missed; the clip is simply over
    audioSystem(world!);

    expect(e.get(AudioSource)!.playing, 'a playlist source must not fall silent when a clip ends').toBe(true);
    expect(e.get(AudioSource)!.clip, 'it should be on the NEXT clip').toBe(refs[1]);
  });

  it('keeps walking across several ended clips rather than stalling on the second', () => {
    const e = spawnPlaylist(0);
    audioSystem(world!);
    const seen = [e.get(AudioSource)!.clip];
    for (let i = 0; i < 3; i++) {
      endRecordedVoices();
      audioSystem(world!);
      seen.push(e.get(AudioSource)!.clip);
    }
    expect(seen).toEqual([refs[0], refs[1], refs[2], refs[3]]);
  });

  it('a NON-playlist source still falls silent when its clip ends', () => {
    // The control, and the contract this must not have widened: `playing = false` on a finished
    // one-shot or a single-clip source is correct and every other test in the suite relies on it.
    const e = world!.spawn(AudioSource({ clip: refs[0], bus: 'sfx', autoplay: true }));
    audioSystem(world!);
    endRecordedVoices();
    audioSystem(world!);
    expect(e.get(AudioSource)!.playing).toBe(false);
  });
});

describe('shuffleStart — the opening clip (#921)', () => {
  /** The seam, not the picker: `engine/tests/framework/audioPlaylist.test.ts` owns whether
   *  `randomStartClip` varies. What this covers is whether `audioSystem` CALLS it, on the right
   *  frame, and writes the answer onto the trait — the wiring that would otherwise be the one line
   *  nothing fails for (the #1069 class). */
  it('opens on a bank entry other than the authored clip when it rolls one', () => {
    // Forced rather than sampled: Math.random is the only non-determinism, so pinning it makes the
    // assertion exact instead of "probably different". 0.99 * 4 = index 3.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const e = world!.spawn(AudioSource({
      clip: refs[0], bus: 'music', clips: bank, playlist: 'shuffle', shuffleStart: true, autoplay: true,
    }));
    audioSystem(world!);
    expect(e.get(AudioSource)!.clip).toBe(refs[3]);
  });

  it('leaves the authored clip alone without the flag — the control', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const e = world!.spawn(AudioSource({
      clip: refs[0], bus: 'music', clips: bank, playlist: 'shuffle', autoplay: true,
    }));
    audioSystem(world!);
    expect(e.get(AudioSource)!.clip).toBe(refs[0]);
  });

  it('needs a playlist: a bank used as a lookup table still opens on its authored clip', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const e = world!.spawn(AudioSource({
      clip: refs[0], bus: 'music', clips: bank, playlist: 'off', shuffleStart: true, autoplay: true,
    }));
    audioSystem(world!);
    expect(e.get(AudioSource)!.clip).toBe(refs[0]);
  });

  it('picks ONCE, not on every frame', () => {
    // The failure this guards against is a re-roll each frame, which would restart the music
    // constantly. The mock moves after the first frame; the clip must not follow it.
    const rolls = [0.99, 0.01, 0.01, 0.01, 0.01];
    let i = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => rolls[Math.min(i++, rolls.length - 1)]);
    const e = world!.spawn(AudioSource({
      clip: refs[0], bus: 'music', clips: bank, playlist: 'shuffle', shuffleStart: true, autoplay: true,
    }));
    for (let f = 0; f < 5; f++) audioSystem(world!);
    expect(e.get(AudioSource)!.clip).toBe(refs[3]);
  });
});

/**
 * #1281 — the walk position is re-derived when `clip` is written from OUTSIDE the playlist.
 *
 * The unit suite owns the rotation itself. What only the seam can answer is whether the two REAL
 * writers reach it: the `audio.setClip` action / a debug bed picker writing the trait directly, and
 * `rearmAudioAutoplay` — the mobile `pagehide` backstop (#611) — re-arming a `shuffleStart` source
 * while its playlist state survives untouched. Both used to leave the walk pointing at its old
 * position, so the next advance served the wrong clip, and could serve the one just playing.
 *
 * `sequential` throughout: `shuffle` would need the order pinned as well as the opener, and the
 * question here is the SEAM, not which permutation came out.
 */
describe('a clip written from outside the walk (#1281)', () => {
  it('advances from the clip that was written, not from where the walk was', () => {
    const e = world!.spawn(AudioSource({
      clip: refs[0], bus: 'music', clips: bank, playlist: 'sequential', autoplay: true,
    }));
    audioSystem(world!);
    expect(e.get(AudioSource)!.clip).toBe(refs[0]);

    e.set(AudioSource, { clip: refs[2] });     // the setClip action / a debug picker
    audioSystem(world!);
    endRecordedVoices();
    audioSystem(world!);

    expect(e.get(AudioSource)!.clip, 'the successor of refs[2] is refs[3] — the stale order served refs[1]')
      .toBe(refs[3]);
  });

  it('does not serve the same clip twice when the write picks the one coming next', () => {
    const e = world!.spawn(AudioSource({
      clip: refs[0], bus: 'music', clips: bank, playlist: 'sequential', autoplay: true,
    }));
    audioSystem(world!);

    e.set(AudioSource, { clip: refs[1] });     // exactly the clip the walk was about to play
    audioSystem(world!);
    endRecordedVoices();
    audioSystem(world!);

    expect(e.get(AudioSource)!.clip, 'refs[1] must not play twice in a row').toBe(refs[2]);
  });

  it('a shuffleStart re-arm walks the order from its NEW opener', () => {
    // The half that reaches production: `rearmAudioAutoplay` fires from the mobile pagehide
    // backstop, clears the autoplay guard but not the playlist state, and `shuffleStart` then rolls
    // a fresh opener into a walk that never noticed. Both rolls are pinned so the assertion is
    // exact: 0.5 * 4 = index 2 to open on, then 0.0 = index 0 after the re-arm.
    //
    // ⚠️ `dispose()` + `endRecordedVoices()` are what make this the PRODUCTION sequence, and the
    // first version of this test omitted them. `App.tsx`'s `app.cleanup` task calls `audioDispose()`
    // — which ends every live handle — and only then does `onRealmSurvived` re-arm, so the re-arm
    // frame ALWAYS arrives with the clip already ended. Without them the test re-armed over a live
    // voice, a state production never reaches, and it passed while the real path was broken: the
    // ended clip's advance stepped straight past the opener `randomStartClip` had just rolled and
    // the source started on its successor. (Record mode has no real handles for `dispose()`'s
    // `stopAll()` to reach, so `endRecordedVoices()` stands in for what it does to a live one —
    // the idiom `audioSystem.test.ts`'s own re-arm test uses.)
    const roll = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const e = world!.spawn(AudioSource({
      clip: refs[0], bus: 'music', clips: bank, playlist: 'sequential', shuffleStart: true, autoplay: true,
    }));
    audioSystem(world!);
    expect(e.get(AudioSource)!.clip, 'opens on refs[2]').toBe(refs[2]);

    dispose();
    endRecordedVoices();                       // the realm-death false alarm ends every handle…
    rearmAudioAutoplay(world!);                // …and then re-arms
    roll.mockReturnValue(0);                   // …and the re-roll opens on refs[0]
    audioSystem(world!);
    expect(e.get(AudioSource)!.clip, 're-opens on refs[0] — and PLAYS it, rather than advancing past it')
      .toBe(refs[0]);

    endRecordedVoices();
    audioSystem(world!);
    expect(e.get(AudioSource)!.clip, 'the successor of refs[0] is refs[1] — the stale order served refs[3]')
      .toBe(refs[1]);
  });
});
