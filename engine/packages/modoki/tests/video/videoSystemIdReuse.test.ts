/** #336 — `videoSystem`'s cross-frame state and koota's recycled entity index.
 *
 *  `videoSystem` holds `live`/`pending`/`progress`/`readyUrls`/`failed` ACROSS frames, keyed by
 *  `entity.id()` — which strips koota's generation. koota's entity index is a LIFO free list, so
 *  a despawn immediately followed by a same-shape respawn reclaims the exact freed index, and the
 *  reconcile then reads the DEAD entity's `live.get(id)` as "already mine". The `seen`-set diff
 *  that would have released it runs at the END of a pass, so a despawn+respawn landing BETWEEN
 *  two passes never gets one.
 *
 *  Same family as QA-ZONE-0003 (`zone2DEvents.test.ts`), but fixed differently: video's id is
 *  also a public ADDRESSING contract (`videoElementFor`, `seekEntityVideo`, `state.ecsObjects`,
 *  the UI tree's `entityId`), so the maps stay id-keyed and the OWNERSHIP is checked instead. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld, type World } from 'koota';

const handles: Array<{ url: string; disposed: boolean; playing: boolean; seeks: number[] }> = [];

vi.mock('../../src/runtime/video/videoService', () => ({
  applyTimeScale: () => {},
  videoFadeGain: () => 1,
  playVideo: (opts: { url: string; timeMode?: 'diegetic' | 'presentation' }) => {
    const rec = {
      url: opts.url, disposed: false, playing: false, seeks: [] as number[],
      timeMode: opts.timeMode ?? 'diegetic' as 'diegetic' | 'presentation',
    };
    handles.push(rec);
    return {
      element: { currentTime: 0, duration: 10, style: {} } as unknown as HTMLVideoElement,
      play: () => { rec.playing = true; },
      pause: () => { rec.playing = false; },
      seek: (s: number) => { rec.seeks.push(s); },
      setVolume: () => {}, setMuted: () => {}, setRate: () => {},
      setLoop: () => {},
      // Models `setTimeMode` by mutating `rec.timeMode`, not a no-op — this test doesn't
      // exercise timeMode itself, but a mock that can't move this field at all would silently
      // pass a `videoSystem` bug that skips the call.
      setTimeMode: (mode: 'diegetic' | 'presentation') => { rec.timeMode = mode; },
      get ended() { return false; },
      get playing() { return rec.playing; },
      get timeMode() { return rec.timeMode; },
      dispose: () => { rec.disposed = true; },
    };
  },
}));

import { VideoPlayer } from '../../src/runtime/traits/VideoPlayer';
import { setPlayState } from '../../src/runtime/core/playState';
import {
  videoSystem, videoElementFor, seekEntityVideo, claimVideoEndEmit, setVideoUrlResolver, __resetVideoSystem,
} from '../../src/runtime/video/videoSystem';

let world: World | undefined;

beforeEach(() => {
  handles.length = 0;
  __resetVideoSystem();
  setPlayState('playing');
  setVideoUrlResolver((guid) => `https://example.test/${guid}.mp4`);
  world = createWorld();
});
afterEach(() => {
  world?.destroy(); world = undefined;
  __resetVideoSystem();
  setPlayState('stopped');
});

describe('videoSystem — recycled entity index', () => {
  it('a same-index respawn on the SAME clip gets its own handle, not the dead entity\'s', () => {
    // The `existing.clip !== vp.clip` check self-heals a DIFFERENT clip, so the same clip is the
    // case that actually bites: a same-clip prefab respawn, or two players streaming one cutscene.
    const CLIP = 'clip-guid-a';
    const a = world!.spawn(VideoPlayer({ clip: CLIP, autoplay: true }));
    videoSystem(world!);
    expect(handles).toHaveLength(1);
    const deadElement = videoElementFor(a.id());
    expect(deadElement).toBeDefined();

    a.destroy();
    const b = world!.spawn(VideoPlayer({ clip: CLIP, autoplay: true }));
    // Preconditions: the index really was reused, but the packed entity differs. Asserted so this
    // test fails loudly rather than passing vacuously if koota's free list ever stops being LIFO.
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());

    videoSystem(world!);

    // `b` must own a FRESH decoder. Before the fix it silently inherited `a`'s: one handle total,
    // never disposed, and `videoElementFor(b.id())` handed the renderer the dead entity's element.
    expect(handles).toHaveLength(2);
    expect(handles[0].disposed).toBe(true);
    expect(handles[1].disposed).toBe(false);
    expect(videoElementFor(b.id())).not.toBe(deadElement);
  });

  it('a same-index respawn does not inherit the dead entity\'s sticky download FAILURE', () => {
    // `failed` is sticky until the clip changes — deliberately, to stop a retry storm. Inherited
    // by a reused index it becomes a permanent refusal to load for an entity that never failed.
    const CLIP = 'clip-guid-b';
    const a = world!.spawn(VideoPlayer({ clip: CLIP, autoplay: true }));
    videoSystem(world!);
    expect(handles).toHaveLength(1);

    a.destroy();
    const b = world!.spawn(VideoPlayer({ clip: CLIP, autoplay: true }));
    expect(b.id()).toBe(a.id());
    videoSystem(world!);
    // A live, playing clip for `b` — the one it created itself.
    expect(handles).toHaveLength(2);
    expect(handles[1].playing).toBe(true);
  });

  it('the by-id readers refuse a DEAD owner\'s handle before the next pass reconciles the index (#868)', () => {
    // `videoElementFor`/`seekEntityVideo`/`claimVideoEndEmit` are the addressing contract the texture
    // surfaces, `UIVideoMount` and the `video.*` actions call with a bare id. The ownership check lives
    // in the reconcile, so between a despawn+respawn and the next pass they used to reach the dead
    // entity\'s decoder: a renderer drew its frame, and a seek aimed at the newcomer moved it.
    const CLIP = 'clip-guid-c';
    const a = world!.spawn(VideoPlayer({ clip: CLIP, autoplay: true }));
    videoSystem(world!);
    expect(handles).toHaveLength(1);
    expect(videoElementFor(a.id())).toBeDefined();

    a.destroy();
    const b = world!.spawn(VideoPlayer({ clip: CLIP, autoplay: true }));
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());

    expect(videoElementFor(b.id())).toBeUndefined();
    seekEntityVideo(b.id(), 5);
    expect(handles[0].seeks).toEqual([]);
    // No live playback for the newcomer yet, so there is nothing to have announced: true, and it must
    // not latch the DEAD entry either.
    expect(claimVideoEndEmit(b.id())).toBe(true);
    expect(claimVideoEndEmit(b.id())).toBe(true);

    videoSystem(world!);
    expect(handles).toHaveLength(2);
    expect(videoElementFor(b.id())).toBeDefined();
  });

  it('a plain despawn stops the by-id readers at once, not at the next pass (#868)', () => {
    const a = world!.spawn(VideoPlayer({ clip: 'clip-guid-d', autoplay: true }));
    videoSystem(world!);
    const id = a.id();
    a.destroy();
    expect(videoElementFor(id)).toBeUndefined();
  });
});
