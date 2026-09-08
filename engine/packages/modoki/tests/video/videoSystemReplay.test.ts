/** #426 — `@video.start` / `@video.end` must fire again on a REPLAY of the same clip, not
 *  just once per `Live` entry's lifetime.
 *
 *  `startEmitted`/`endEmitted` guard ONE playback each, not the whole entry — the entry is
 *  only recreated when the clip GUID changes or the entity despawns, so a looping Director
 *  video track (or a hand-driven `video.stop` + `video.play` on the SAME clip) reused the
 *  same `Live` entry and, before this fix, never fired either event a second time. A game
 *  waiting on `@video.end` to advance a cutscene hangs — the exact softlock class
 *  `video.skip` (see videoEvents.test.ts) was written to avoid. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld, type World } from 'koota';

interface MockHandle {
  element: { currentTime: number; duration: number; loop: boolean; ended: boolean; style: Record<string, unknown> };
  playing: boolean;
  endedEvent: boolean;
  timeMode: 'diegetic' | 'presentation';
}
let mock: MockHandle | undefined;

// Deliberately mirrors three subtle `LiveVideoHandle` behaviours (`videoService.ts`) that the
// old mock glossed over and let #426's fix pass on assumptions rather than on the real contract:
//   1. `play()` early-returns on a finished clip (`if (this.disposed || this.ended) return;`) —
//      a mock that sets `playing = true` unconditionally can't discriminate A1's guard.
//   2. `ended` is `endedEvent || (!element.loop && element.ended)` — a bare flag can't express a
//      LOOPING clip, which must never read as ended.
//   3. `seek()` clamps to `[0, duration]` and clears `endedEvent` only when `t < duration` — a
//      seek TO the duration (or past it) must not un-end the clip.
//
// ⚠️ What this mock does NOT model: the real element pauses ITSELF at the end (native `paused`
// flips true, then `onEnded` calls `handle.pause()`) — here `rec.playing` only ever changes from
// an explicit `play()`/`pause()` call, so `mock!.element.ended = true` alone (as several tests
// below do) leaves `rec.playing` still `true` underneath the `ended()` mask. That means this
// mock reaches "started" (`handle.playing` true) ONE RECONCILE PASS SOONER than production would
// after a real pause — the `videoSystem(world!)` call counts below (e.g. "a second pass is
// needed") encode the #431 observation lag against THIS mock's latency, not necessarily
// production's. Don't lift a pass count from this file into a real-handle test (like
// `videoSystemLiveContract.test.ts`) without re-checking it against the real element.
vi.mock('../../src/runtime/video/videoService', () => ({
  applyTimeScale: () => {},
  videoFadeGain: () => 1,
  playVideo: (opts: { url: string; loop?: boolean; timeMode?: 'diegetic' | 'presentation' }) => {
    const rec: MockHandle = {
      element: { currentTime: 0, duration: 10, loop: !!opts.loop, ended: false, style: {} },
      playing: false,
      endedEvent: false,
      timeMode: opts.timeMode ?? 'diegetic',
    };
    mock = rec;
    const ended = () => rec.endedEvent || (!rec.element.loop && rec.element.ended);
    return {
      element: rec.element,
      play: () => {
        if (ended()) return; // mirrors LiveVideoHandle.play()'s `if (this.ended) return;`
        rec.playing = true;
      },
      pause: () => { rec.playing = false; },
      // Mirrors `LiveVideoHandle.seek`: clamp to [0, duration]; only a rewind BEFORE the
      // duration clears the event flag. A real `HTMLMediaElement.ended` also clears itself
      // the instant `currentTime` moves off the end (that's native DOM behaviour, not
      // something `LiveVideoHandle.seek` has to do explicitly) — this fake element has to be
      // told to do the same, or a test-authored `element.ended = true` would stick forever.
      seek: (seconds: number) => {
        const t = Math.max(0, Math.min(seconds, rec.element.duration));
        rec.element.currentTime = t;
        if (t < rec.element.duration) { rec.endedEvent = false; rec.element.ended = false; }
      },
      setVolume: () => {}, setMuted: () => {}, setRate: () => {},
      setLoop: (loop: boolean) => { rec.element.loop = loop; },
      // Mutates the tracked field rather than a no-op, so a test CAN model a timeMode change —
      // a mock that swallows this call silently passes a `videoSystem` bug that skips it.
      setTimeMode: (mode: 'diegetic' | 'presentation') => { rec.timeMode = mode; },
      get ended() { return ended(); },
      // Mirrors `LiveVideoHandle.playing` (`!paused && !blocked && !ended`): this fake element
      // has no autoplay-policy `blocked` state, so `rec.playing` (set by `play()`/`pause()`
      // below) alone stands in for `!paused`.
      get playing() { return rec.playing && !ended(); },
      get timeMode() { return rec.timeMode; },
      dispose: () => {},
    };
  },
}));

import { VideoPlayer } from '../../src/runtime/traits/VideoPlayer';
import { setPlayState } from '../../src/runtime/core/playState';
import { videoEvents, clearVideoEventHandlers } from '../../src/runtime/video/VideoEvents';
import {
  videoSystem, seekEntityVideo, setVideoUrlResolver, __resetVideoSystem,
} from '../../src/runtime/video/videoSystem';

let world: World | undefined;
let starts: number;
let ends: number;
let skips: number;

beforeEach(() => {
  mock = undefined;
  starts = 0; ends = 0; skips = 0;
  __resetVideoSystem();
  clearVideoEventHandlers();
  videoEvents.onStart(() => { starts += 1; });
  videoEvents.onEnd(() => { ends += 1; });
  videoEvents.onSkip(() => { skips += 1; });
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

const CLIP = 'clip-guid-replay';

describe('videoSystem — replay re-arms start/end (#426)', () => {
  it('a stop + replay of the SAME clip fires @video.start a second time', () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true }));
    videoSystem(world!);
    // #431: `@video.start` now latches on OBSERVED playback, checked before this pass's own
    // play() request — a fresh handle's first successful play() is only observed one pass
    // later, so a second pass is needed to reach "started" before this test's own concern.
    videoSystem(world!);
    expect(starts).toBe(1);

    // "video.stop" is seek(0) + pause, driven by the action layer — reproduced directly here.
    seekEntityVideo(e.id(), 0);
    e.set(VideoPlayer, { playing: false });
    videoSystem(world!);

    e.set(VideoPlayer, { playing: true });
    videoSystem(world!);
    // #431: this resume goes through a genuine pause (rec.playing flipped false above), so —
    // like the fresh handle at the top of this test — the new play() request is only OBSERVED
    // as started on the pass after this one.
    videoSystem(world!);
    expect(starts).toBe(2);
  });

  it('a clip that ends, is rewound, and plays again fires @video.end a second time', () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true }));
    videoSystem(world!);
    // #431: see the comment in the previous test.
    videoSystem(world!);
    expect(starts).toBe(1);

    mock!.element.ended = true;
    videoSystem(world!);
    expect(ends).toBe(1);
    expect(e.get(VideoPlayer)?.playing).toBe(false);

    seekEntityVideo(e.id(), 0);
    e.set(VideoPlayer, { playing: true });
    videoSystem(world!);
    expect(starts).toBe(2);

    mock!.element.ended = true;
    videoSystem(world!);
    expect(ends).toBe(2);
  });

  // Passes under both the old and the fixed code — it discriminates nothing about #426's fix.
  // Kept anyway as a real regression guard for whatever touches this path next.
  it('a mid-clip pause -> resume fires @video.start only ONCE', () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true }));
    videoSystem(world!);
    // #431: see the first test in this file.
    videoSystem(world!);
    expect(starts).toBe(1);

    e.set(VideoPlayer, { playing: false });
    videoSystem(world!);
    e.set(VideoPlayer, { playing: true });
    videoSystem(world!);
    expect(starts).toBe(1);
  });

  it('a mid-clip seek does NOT re-arm @video.start', () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true }));
    videoSystem(world!);
    // #431: see the first test in this file.
    videoSystem(world!);
    expect(starts).toBe(1);

    seekEntityVideo(e.id(), 5);
    videoSystem(world!);
    expect(starts).toBe(1);
  });

  // Pins A2: a resume out of the ended state via a MID-clip seek (not a rewind to 0) must
  // still count as a new playback — both the second start AND its paired second end.
  it('a second @video.end pairs with a second @video.start on a mid-clip (non-zero) seek', () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true }));
    videoSystem(world!);
    // #431: see the first test in this file.
    videoSystem(world!);
    expect(starts).toBe(1);

    mock!.element.ended = true;
    videoSystem(world!);
    expect(ends).toBe(1);

    seekEntityVideo(e.id(), 5); // NOT 0 — the old start-only re-arm was seek(0)-only
    e.set(VideoPlayer, { playing: true });
    videoSystem(world!);
    expect(starts).toBe(2);

    mock!.element.ended = true;
    videoSystem(world!);
    expect(ends).toBe(2);

    expect(starts).toBe(2);
    expect(ends).toBe(2);
  });

  // Pins A1: setting `playing = true` on an already-ended clip with NO seek must not
  // announce a start that `LiveVideoHandle.play()` will refuse to honour.
  it('playing = true on an ended clip with no seek emits NO start', () => {
    const e = world!.spawn(VideoPlayer({ clip: CLIP, playing: true }));
    videoSystem(world!);
    // #431: see the first test in this file.
    videoSystem(world!);
    expect(starts).toBe(1);

    mock!.element.ended = true;
    videoSystem(world!);
    expect(ends).toBe(1);

    e.set(VideoPlayer, { playing: true });
    videoSystem(world!);
    videoSystem(world!);
    videoSystem(world!);
    expect(starts).toBe(1);
    expect(ends).toBe(1);
  });

  // Pins the new `else { l.endEmitted = false; }` re-arm's own risk: nothing previously
  // asserted that @video.end stays a ONE-TIME event across repeated reconcile passes while
  // the handle is still sitting at its end.
  it('@video.end fires exactly once across several reconcile passes while ended stays true', () => {
    world!.spawn(VideoPlayer({ clip: CLIP, playing: true }));
    videoSystem(world!);
    // #431: see the first test in this file.
    videoSystem(world!);
    expect(starts).toBe(1);

    mock!.element.ended = true;
    videoSystem(world!);
    videoSystem(world!);
    videoSystem(world!);
    videoSystem(world!);
    expect(ends).toBe(1);
  });

  // The approved semantics: a LOOPING clip never fires @video.end per lap, and its single
  // @video.start is never re-armed by the loop wrapping `currentTime` back to 0. Only
  // expressible with the mock's `element.loop`/`element.ended` split (B1).
  it('a looping clip fires @video.start once and @video.end never', () => {
    world!.spawn(VideoPlayer({ clip: CLIP, playing: true, loop: true }));
    videoSystem(world!);
    // #431: see the first test in this file.
    videoSystem(world!);
    expect(starts).toBe(1);
    expect(mock!.element.loop).toBe(true);

    // Simulate several laps: the element wraps back to 0 and briefly reports `ended` at the
    // boundary the way a real looping <video> can, but `loop:true` must mask it either way.
    for (let i = 0; i < 4; i++) {
      mock!.element.currentTime = 0;
      mock!.element.ended = true;
      videoSystem(world!);
    }

    expect(starts).toBe(1);
    expect(ends).toBe(0);
  });
});

describe('videoSystem — video.stop + video.setClip re-arms via the real action layer (#426)', () => {
  it('dispatching video.stop then video.setClip (same clip) through the action registry fires a second @video.start/@video.end', async () => {
    const { dispatchUIAction, unregisterUIAction, getUIActionNames } =
      await import('../../src/runtime/core/actionRegistry');
    const { registerVideoControls } = await import('../../src/runtime/actions/videoControls');
    const { EntityAttributes } = await import('../../src/runtime/core/traits/EntityAttributes');
    const { setCurrentWorld, getCurrentWorld } = await import('../../src/runtime/core/ecs/world');

    const priorWorld = getCurrentWorld();
    try {
      setCurrentWorld(world!);
      registerVideoControls();
      const guid = 'video-actions-guid';
      world!.spawn(
        EntityAttributes({ guid }),
        VideoPlayer({ clip: CLIP, playing: true }),
      );
      videoSystem(world!);
      // #431: see the first test in this file.
      videoSystem(world!);
      expect(starts).toBe(1);

      mock!.element.ended = true;
      videoSystem(world!);
      expect(ends).toBe(1);

      // video.stop: seeks to 0 + pauses — exactly what `video.stop`'s handler does in
      // `videoControls.ts` (`seekEntityVideo(target.id(), 0); patch(target, { playing: false });`).
      expect(getUIActionNames()).toContain('video.stop');
      dispatchUIAction('video.stop', { targetGuid: guid });

      // video.setClip to the SAME clip: this is the seam #426 actually lives on — deleting
      // `video.stop`'s seek(0) call would regress silently here while unit tests stay green.
      expect(getUIActionNames()).toContain('video.setClip');
      dispatchUIAction('video.setClip', { targetGuid: guid, params: { clip: CLIP } });

      videoSystem(world!);
      expect(starts).toBe(2);

      mock!.element.ended = true;
      videoSystem(world!);
      expect(ends).toBe(2);
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

// Third pass on #423/#426's close-out: `video.skip` bypasses the `Live.endEmitted` guard by
// emitting `@video.end` itself (`emitVideoSkip`), so a skip pressed AFTER the clip already ended
// fired a SECOND, unpaired `@video.end` — a cutscene-advance listener double-fires. Closed by
// `claimVideoEndEmit`, which lets `video.skip`'s handler consult and latch the same guard.
describe('videoSystem — video.skip closes the @video.end pairing hole (#426 finding 2)', () => {
  async function withVideoControls<T>(fn: () => Promise<T> | T): Promise<T> {
    const { registerVideoControls } = await import('../../src/runtime/actions/videoControls');
    const { unregisterUIAction } = await import('../../src/runtime/core/actionRegistry');
    const { setCurrentWorld, getCurrentWorld } = await import('../../src/runtime/core/ecs/world');
    const priorWorld = getCurrentWorld();
    try {
      setCurrentWorld(world!);
      registerVideoControls();
      return await fn();
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
  }

  it('video.skip on an ALREADY-ENDED clip emits @video.skip but not a second @video.end', async () => {
    const { dispatchUIAction } = await import('../../src/runtime/core/actionRegistry');
    const { EntityAttributes } = await import('../../src/runtime/core/traits/EntityAttributes');

    await withVideoControls(() => {
      const guid = 'video-skip-ended-guid';
      world!.spawn(EntityAttributes({ guid }), VideoPlayer({ clip: CLIP, playing: true }));
      videoSystem(world!);
      // #431: see the first test in this file.
      videoSystem(world!);
      expect(starts).toBe(1);

      mock!.element.ended = true;
      videoSystem(world!);
      expect(ends).toBe(1);

      dispatchUIAction('video.skip', { targetGuid: guid });
      expect(skips).toBe(1);
      expect(ends).toBe(1);
    });
  });

  it('video.skip on a PLAYING (not yet ended) clip still emits @video.end exactly once', async () => {
    const { dispatchUIAction } = await import('../../src/runtime/core/actionRegistry');
    const { EntityAttributes } = await import('../../src/runtime/core/traits/EntityAttributes');

    await withVideoControls(() => {
      const guid = 'video-skip-playing-guid';
      world!.spawn(EntityAttributes({ guid }), VideoPlayer({ clip: CLIP, playing: true }));
      videoSystem(world!);
      // #431: see the first test in this file.
      videoSystem(world!);
      expect(starts).toBe(1);
      expect(mock!.element.ended).toBe(false);

      dispatchUIAction('video.skip', { targetGuid: guid });
      expect(skips).toBe(1);
      expect(ends).toBe(1);

      // The reconcile must not announce a second @video.end on a later pass — the skip's
      // seek(0) takes the element off `ended`, so `Live.endEmitted` re-arms for the NEXT
      // real end, not this already-announced one.
      videoSystem(world!);
      videoSystem(world!);
      expect(ends).toBe(1);
    });
  });

  it('video.skip on an entity with NO live handle still emits @video.end', async () => {
    const { dispatchUIAction } = await import('../../src/runtime/core/actionRegistry');
    const { EntityAttributes } = await import('../../src/runtime/core/traits/EntityAttributes');

    await withVideoControls(() => {
      const guid = 'video-skip-no-handle-guid';
      // Spawned but never reconciled by videoSystem() — no `Live` entry exists for it.
      world!.spawn(EntityAttributes({ guid }), VideoPlayer({ clip: CLIP, playing: false }));

      dispatchUIAction('video.skip', { targetGuid: guid });
      expect(skips).toBe(1);
      expect(ends).toBe(1);
    });
  });
});
