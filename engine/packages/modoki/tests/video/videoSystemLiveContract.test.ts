// @vitest-environment jsdom

/** Live-contract REGRESSION SUITE for #431/#432/#433 — this file pins the FIXED behaviour, it
 *  does not reproduce the bugs anymore. A red test here means one of those three fixes
 *  regressed, not that a fix is still pending.
 *
 *  `videoSystemReplay.test.ts` mocks `videoService` with a fake handle, which is fine for
 *  #426's start/end re-arming contract but CANNOT pin these three: two of them are about the
 *  REAL `LiveVideoHandle`'s behaviour (its `loop` property, its async `play()` rejection).
 *  So this file wires the REAL `videoService` into `videoSystem`, exactly the way
 *  `videoService.test.ts` does — `play`/`pause` stubbed on `HTMLMediaElement.prototype`
 *  (jsdom implements neither), with a `playBehaviour: 'allow' | 'block'` switch to model the
 *  autoplay policy. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld, type World } from 'koota';
import { VideoPlayer } from '../../src/runtime/traits/VideoPlayer';
import { setPlayState } from '../../src/runtime/core/playState';
import { videoEvents, clearVideoEventHandlers } from '../../src/runtime/video/VideoEvents';
import {
  videoSystem, videoElementFor, seekEntityVideo, setVideoUrlResolver, __resetVideoSystem,
} from '../../src/runtime/video/videoSystem';
import { __resetVideoService } from '../../src/runtime/video/videoService';
import { resume as audioResume } from '../../src/runtime/audio/audioService';

/** Resolve/reject the next play() — models the autoplay policy, mirroring videoService.test.ts. */
let playBehaviour: 'allow' | 'block' = 'allow';

beforeEach(() => {
  playBehaviour = 'allow';
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    if (playBehaviour === 'block') return Promise.reject(new Error('NotAllowedError'));
    // jsdom won't flip `paused` itself; do it so the service sees a playing element.
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
  });
});

afterEach(() => {
  __resetVideoService();
  vi.restoreAllMocks();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

let world: World | undefined;
let starts: number;
let ends: number;

beforeEach(() => {
  starts = 0; ends = 0;
  __resetVideoSystem();
  clearVideoEventHandlers();
  videoEvents.onStart(() => { starts += 1; });
  videoEvents.onEnd(() => { ends += 1; });
  setPlayState('playing');
  setVideoUrlResolver((guid) => `https://example.test/${guid}.mp4`);
  world = createWorld();
});

afterEach(() => {
  world?.destroy(); world = undefined;
  __resetVideoSystem();
  clearVideoEventHandlers();
  setPlayState('stopped');
});

const CLIP = 'clip-guid-live-contract';

/** Put the element where a finished clip really is, WITHOUT dispatching `ended` — and keep
 *  `ended` a LIVE getter the way a real HTMLMediaElement has it, so a seek back into the clip
 *  un-ends it. A static `Object.defineProperty(el,'ended',{value:true})` cannot clear, which
 *  would make a revived clip look dead for a reason no product bug caused. Mirrors
 *  `videoService.test.ts`'s `atEnd` helper, with `ended` derived instead of stubbed. */
function atEnd(el: HTMLVideoElement, duration = 8): void {
  Object.defineProperty(el, 'duration', { value: duration, configurable: true });
  Object.defineProperty(el, 'currentTime', { value: duration, writable: true, configurable: true });
  Object.defineProperty(el, 'ended', { get: () => el.currentTime >= duration, configurable: true });
}

describe('#433 — VideoPlayer.loop is live-applied, not create-time only', () => {
  it('turning `loop` ON after creation reaches the element on the next reconcile pass', () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true, loop: false }));
    videoSystem(world!);
    expect(videoElementFor(e.id())!.loop).toBe(false);

    e.set(VideoPlayer, { loop: true });
    videoSystem(world!);

    // Pins #433: the live-applied block (`l.handle.setLoop(vp.loop)`) re-applies `loop` every
    // frame alongside volume/muted/rate, so a game or the Inspector flipping it takes effect
    // immediately instead of only on the clip's NEXT handle.
    expect(videoElementFor(e.id())!.loop).toBe(true);
  });

  it('turning `loop` OFF after creation reaches the element too — otherwise the clip could never end', () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true, loop: true }));
    videoSystem(world!);
    expect(videoElementFor(e.id())!.loop).toBe(true);

    e.set(VideoPlayer, { loop: false });
    videoSystem(world!);

    // Pins #433 the other direction.
    expect(videoElementFor(e.id())!.loop).toBe(false);
    // Consequence (not independently asserted here — it follows from the element's `loop`
    // actually flipping): `LiveVideoHandle.ended` is `endedEvent || (!element.loop &&
    // element.ended)`, so BEFORE this fix a looping element could never read as ended, and
    // `@video.end` could never fire for a clip the author just asked to stop looping.
  });

  it('turning `loop` ON after a clip already ended actually RESUMES it, not just flips the flag', async () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true, loop: false }));
    videoSystem(world!);
    videoSystem(world!); // #431: observe the first play() before this test's own concern.
    expect(starts).toBe(1);

    // Reach the end the same way the real element does: dispatch its `ended` event so the
    // private `endedEvent` flag latches — this is the flag `atEnd()`-style static stubs can't
    // reach, and it's the one the bug actually strands.
    const el = videoElementFor(e.id())!;
    Object.defineProperty(el, 'duration', { value: 8, configurable: true });
    Object.defineProperty(el, 'currentTime', { value: 8, writable: true, configurable: true });
    el.dispatchEvent(new Event('ended'));
    videoSystem(world!);
    expect(ends).toBe(1);
    expect(el.paused).toBe(true);

    e.set(VideoPlayer, { loop: true, playing: true });
    videoSystem(world!); // pass 1: play() still refused (loop not yet live-applied ahead of it)
    videoSystem(world!); // pass 2: loop is live-applied now; play() succeeds, element resumes
    expect(el.paused).toBe(false);
    expect(el.loop).toBe(true);

    videoSystem(world!); // pass 3: the successful play() from pass 2 is OBSERVED here (#431)
    expect(starts).toBe(2);
  });
});

describe('#432 — an @video.end / @video.start handler CAN write VideoPlayer', () => {
  it('an @video.end handler\'s entity.set(VideoPlayer, ...) survives koota\'s write-back', () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true, loop: false }));
    videoSystem(world!);
    // #431: `@video.start` now latches on OBSERVED playback, checked BEFORE this pass's own
    // `play()` call — so a fresh handle's first successful play() is only observed on the
    // FOLLOWING pass. A second pass is needed here just to get to "playing", which is the
    // precondition this test (about #432, not #431) actually cares about.
    videoSystem(world!);
    expect(starts).toBe(1);

    videoEvents.onEnd(() => {
      seekEntityVideo(e.id(), 0);
      e.set(VideoPlayer, { playing: true });
    });

    // Fake the element reaching its end without dispatching the `ended` event.
    const el = videoElementFor(e.id())!;
    atEnd(el);

    videoSystem(world!);
    expect(ends).toBe(1);

    // Pins #432: `videoSystem` runs inside `world.query(VideoPlayer).updateEach`, which
    // snapshots `vp` into a local BEFORE the callback and writes that snapshot back
    // UNCONDITIONALLY after the callback returns — including after the callback itself already
    // set `vp.playing = false` for the end. `emitVideoEnd`'s emits are now DEFERRED (the
    // `emits` array flushed after `updateEach` returns — see `videoSystem.ts`), so the
    // handler's `entity.set(VideoPlayer, { playing: true })`, called synchronously from that
    // deferred `fire()`, lands AFTER koota's write-back instead of being overwritten by it.
    expect(e.get(VideoPlayer)!.playing).toBe(true);
  });

  it('the resumed clip actually plays on a following pass', () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true, loop: false }));
    videoSystem(world!);
    // #431: see the comment in the previous test — a second pass is needed to observe the
    // first play() actually take hold before this test's own (#432) concern applies.
    videoSystem(world!);
    expect(starts).toBe(1);

    videoEvents.onEnd(() => {
      seekEntityVideo(e.id(), 0);
      e.set(VideoPlayer, { playing: true });
    });

    const el = videoElementFor(e.id())!;
    atEnd(el);
    videoSystem(world!);

    // A second reconcile pass reads whatever the trait ACTUALLY holds now.
    videoSystem(world!);

    // Pins #432 as a consequence of the fix above: the handler's restart took hold, so the
    // clip is still playing on the following pass, not clobbered back to false.
    expect(e.get(VideoPlayer)!.playing).toBe(true);
  });

  it('an @video.start handler\'s entity.set(VideoPlayer, ...) is likewise preserved', () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true, loop: false, volume: 1 }));

    videoEvents.onStart(() => {
      e.set(VideoPlayer, { volume: 0.25 });
    });

    videoSystem(world!);
    // #431: the first pass only REQUESTS play — the start is observed (and thus fires) on
    // this second pass, once `handle.playing` reflects it.
    videoSystem(world!);
    expect(starts).toBe(1);

    // Pins #432 via the same deferred-emit mechanism as the onEnd case above — the handler's
    // write lands after koota's write-back instead of being overwritten by it.
    expect(e.get(VideoPlayer)!.volume).toBe(0.25);
  });
});

describe('#431 — @video.start fires on OBSERVED playback, not on request', () => {
  it('an unmuted autoplay clip announces NO @video.start while play() is blocked and nothing renders', async () => {
    playBehaviour = 'block';
    const e = world!.spawn(VideoPlayer({ clip: CLIP, autoplay: true, muted: false }));
    videoSystem(world!);
    await flush();

    // Pins #431: `startEmitted` latches only once `handle.playing` is OBSERVED true, checked
    // BEFORE this pass's own `play()` call — not on the synchronous pass that merely CALLS
    // `play()` — so no start is announced for a clip that never rendered a frame.
    expect(starts).toBe(0);
    // Document the real element state alongside the correct event count: nothing is playing.
    expect(videoElementFor(e.id())!.paused).toBe(true);
  });

  it('continuing from a blocked autoplay: unblocking via the gesture fires the start once it actually happens', async () => {
    playBehaviour = 'block';
    const e = world!.spawn(VideoPlayer({ clip: CLIP, autoplay: true, muted: false }));
    videoSystem(world!);
    await flush();
    const startsAfterBlockedAttempt = starts;

    playBehaviour = 'allow';
    audioResume(); // the single "user has interacted" signal, shared with audio
    await flush();

    // `retryBlockedPlay()` runs from the gesture-unlock hook inside `videoService`, entirely
    // outside `videoSystem`'s reconcile — it never latched `startEmitted` (the blocked attempt
    // didn't either, since `handle.playing` was never observed true). So the NEXT reconcile
    // pass reads `handle.playing` as true for the first time and fires the real start here.
    videoSystem(world!);

    // Pins #431: `starts` grows past the (correctly zero) count from the blocked attempt,
    // once playback has genuinely begun.
    expect(starts).toBeGreaterThan(startsAfterBlockedAttempt);
    // Document the real element state: it IS playing now.
    expect(videoElementFor(e.id())!.paused).toBe(false);
  });

  it('video.skip on an autoplay-blocked clip emits @video.end with NO preceding @video.start — deliberate', async () => {
    // `@video.start` / `@video.end` are NOT matched pairs (docs/video.md) — each is
    // individually true. A skip must ALWAYS announce the end, even one nothing ever started,
    // or a skippable cutscene that the player dismisses before the autoplay gesture arrives
    // softlocks whatever is waiting on "the cutscene is over".
    playBehaviour = 'block';
    const { dispatchUIAction, unregisterUIAction } = await import('../../src/runtime/core/actionRegistry');
    const { registerVideoControls } = await import('../../src/runtime/actions/videoControls');
    const { EntityAttributes } = await import('../../src/runtime/core/traits/EntityAttributes');
    const { setCurrentWorld, getCurrentWorld } = await import('../../src/runtime/core/ecs/world');
    const priorWorld = getCurrentWorld();
    try {
      setCurrentWorld(world!);
      registerVideoControls();
      const guid = 'video-skip-blocked-guid';
      world!.spawn(EntityAttributes({ guid }), VideoPlayer({ clip: CLIP, autoplay: true, muted: false }));
      videoSystem(world!);
      videoSystem(world!);
      await flush();
      // The clip really never played — see the sibling test above.
      expect(starts).toBe(0);

      dispatchUIAction('video.skip', { targetGuid: guid });
      expect(ends).toBe(1);
      expect(starts).toBe(0);
    } finally {
      unregisterUIAction('video.play');
      unregisterUIAction('video.pause');
      unregisterUIAction('video.toggle');
      unregisterUIAction('video.stop');
      unregisterUIAction('video.skip');
      unregisterUIAction('video.seek');
      unregisterUIAction('video.setClip');
      setCurrentWorld(priorWorld);
    }
  });
});
