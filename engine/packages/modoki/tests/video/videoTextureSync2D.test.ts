// @vitest-environment jsdom

/** The 2D video surface. Two things here are load-bearing and neither is obvious from
 *  reading the happy path:
 *
 *  1. **`VideoSource.destroy()` kills the element it holds** — `pause(); src=''; load()`.
 *     That element is `videoService`'s, shared with the 3D texture and the cutscene
 *     overlay, so tearing down a 2D binding must not reach it. The detach-before-destroy
 *     ordering in `release()` is the only thing standing between a viewport unmount and
 *     a blacked-out cutscene, so it is asserted directly.
 *  2. **`autoPlay` must be off.** Pixi's own canplay handler calls `resource.play()`,
 *     which would silently restart a clip the engine froze at `timeScale 0`. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld, type World } from 'koota';
import { Texture, type Sprite } from 'pixi.js';
import { VideoPlayer } from '../../src/runtime/traits/VideoPlayer';
import {
  syncVideoTextures2D, disposeVideoTextures2D, videoTextureCount2D, flushPendingVideoDestroy2D,
} from '../../src/runtime/rendering/videoTextureSync2D';

// videoSystem owns the elements; this suite is about what the RENDERER does with one.
const elements = new Map<number, HTMLVideoElement>();
vi.mock('../../src/runtime/video/videoSystem', () => ({
  videoElementFor: (id: number) => elements.get(id),
}));

/** A stand-in for a Scene2D sprite slot — the module only ever touches these two. */
function fakeSprite(): Sprite & { texture: Texture; destroyed: boolean } {
  return { texture: Texture.EMPTY, destroyed: false } as unknown as Sprite & {
    texture: Texture; destroyed: boolean;
  };
}

/** A video element that reports as playing, since that is what gates Pixi's update hook.
 *
 *  jsdom has no `requestVideoFrameCallback`, so by default this exercises the FALLBACK
 *  branch — which is the one that hands the update hook to Pixi and therefore the one
 *  where the detach ordering actually matters. `withRvfc` opts into the primary path. */
function fakeElement(opts: { withRvfc?: boolean; w?: number; h?: number } = {}): HTMLVideoElement {
  const el = document.createElement('video');
  el.play = vi.fn(async () => {});
  el.pause = vi.fn(() => {});
  Object.defineProperty(el, 'paused', { value: false, configurable: true });
  Object.defineProperty(el, 'videoWidth', { value: opts.w ?? 0, configurable: true });
  Object.defineProperty(el, 'videoHeight', { value: opts.h ?? 0, configurable: true });
  if (opts.withRvfc) {
    const pending: (() => void)[] = [];
    let next = 1;
    Object.assign(el, {
      requestVideoFrameCallback: vi.fn((cb: () => void) => { pending.push(cb); return next++; }),
      cancelVideoFrameCallback: vi.fn(),
      // Test-only: run whatever the pump queued, exactly once.
      __presentFrame: () => { const q = pending.splice(0); for (const cb of q) cb(); },
    });
  }
  return el;
}
const present = (el: HTMLVideoElement) =>
  (el as unknown as { __presentFrame: () => void }).__presentFrame();

let world: World;
let surface: object;

beforeEach(() => {
  world = createWorld();
  surface = {};
  elements.clear();
});
afterEach(() => {
  disposeVideoTextures2D(surface);
  // koota allocates world IDs from a pool of 16 and `createWorld` THROWS once it is exhausted
  // (see the identical comment in videoTextureSync.test.ts, which hit this first) — so a suite
  // that only ever creates worlds has a hard ceiling on its own test count.
  world.destroy();
  vi.restoreAllMocks();
});

describe('binding', () => {
  it('puts a video-backed texture on the entity sprite', () => {
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    const el = fakeElement();
    elements.set(e.id(), el);
    const sp = fakeSprite();

    const ids = syncVideoTextures2D(world, surface, () => sp);

    expect(ids).toEqual([e.id()]);
    expect(sp.texture).not.toBe(Texture.EMPTY);
    expect(sp.texture.source.resource).toBe(el);
    expect(videoTextureCount2D(surface)).toBe(1);
  });

  it('leaves Pixi with NO say over playback', () => {
    // The whole autoplay/timeScale/gesture policy lives in videoService. If Pixi's
    // VideoSource is allowed to autoPlay, a clip paused by `timeScale 0` restarts
    // itself the moment the texture is (re)bound — a time-stop that leaks video.
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    const el = fakeElement();
    elements.set(e.id(), el);

    syncVideoTextures2D(world, surface, () => fakeSprite());

    expect(el.play).not.toHaveBeenCalled();
  });

  it('is idempotent — a steady clip does not rebuild its texture every frame', () => {
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    const sp = fakeSprite();

    syncVideoTextures2D(world, surface, () => sp);
    const first = sp.texture;
    syncVideoTextures2D(world, surface, () => sp);

    expect(sp.texture).toBe(first);
    expect(videoTextureCount2D(surface)).toBe(1);
  });

  it('rebinds when the clip swaps to a different element', () => {
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    const sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);
    const first = sp.texture;

    elements.set(e.id(), fakeElement());          // clip changed
    syncVideoTextures2D(world, surface, () => sp);

    expect(sp.texture).not.toBe(first);
    expect(videoTextureCount2D(surface)).toBe(1); // rebound, not accumulated
  });

  it('rebinds when Scene2D rebuilt the slot under us', () => {
    // A ref/kind change disposes the slot and makes a FRESH Sprite whose texture is
    // EMPTY again. Keying only on the element would leave that sprite blank forever.
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    let sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);

    sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);

    expect(sp.texture).not.toBe(Texture.EMPTY);
  });

  it('ignores an entity with no 2D body', () => {
    // A 3D-only or cutscene-only VideoPlayer reaches this pass every frame.
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    expect(syncVideoTextures2D(world, surface, () => null)).toEqual([]);
  });

  it('gives each surface its own texture over the SAME element', () => {
    // Two viewports, one decoder — sharing a texture would upload into one renderer's
    // context and show black in the other.
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    const el = fakeElement();
    elements.set(e.id(), el);
    const a = fakeSprite(); const b = fakeSprite();
    const other = {};

    syncVideoTextures2D(world, surface, () => a);
    syncVideoTextures2D(world, other, () => b);

    expect(a.texture).not.toBe(b.texture);
    expect(a.texture.source.resource).toBe(el);
    expect(b.texture.source.resource).toBe(el);
    disposeVideoTextures2D(other);
  });
});

describe('upload pump', () => {
  it('uploads once per PRESENTED frame, and sizes the texture to the clip', () => {
    // Dimensions are 0×0 at bind time for a clip that is still opening, so the size has
    // to be picked up from the pump — reading it once at bind leaves the texture at its
    // default dims and the sprite scaled to nothing.
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    const el = fakeElement({ withRvfc: true });
    elements.set(e.id(), el);
    const sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);

    const src = sp.texture.source;
    const update = vi.spyOn(src, 'update');
    Object.defineProperty(el, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(el, 'videoHeight', { value: 360, configurable: true });
    present(el);

    expect(src.width).toBe(640);
    expect(src.height).toBe(360);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('does not upload a clip with no frame yet', () => {
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    const el = fakeElement({ withRvfc: true });          // 0×0
    elements.set(e.id(), el);
    const sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);

    const update = vi.spyOn(sp.texture.source, 'update');
    present(el);
    expect(update).not.toHaveBeenCalled();
  });

  it('stops pumping once released', () => {
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    const el = fakeElement({ withRvfc: true, w: 640, h: 360 });
    elements.set(e.id(), el);
    syncVideoTextures2D(world, surface, () => fakeSprite());

    disposeVideoTextures2D(surface);

    expect(el.cancelVideoFrameCallback).toHaveBeenCalled();
    // The callback already queued must also no-op — cancel and an in-flight frame race.
    expect(() => present(el)).not.toThrow();
  });
});

describe('release', () => {
  it('does NOT tear down the shared element', () => {
    // VideoSource.destroy() ends with pause(); src=''; load() on its resource. Reaching
    // videoService's element there would kill the 3D texture and the fullscreen overlay
    // along with this sprite.
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    const el = fakeElement();
    el.src = 'blob:keep-me';
    elements.set(e.id(), el);
    syncVideoTextures2D(world, surface, () => fakeSprite());

    disposeVideoTextures2D(surface);

    expect(el.pause).not.toHaveBeenCalled();
    expect(el.src).toContain('keep-me');
  });

  it('restores whatever the sprite showed before', () => {
    const poster = new Texture();
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    const sp = fakeSprite();
    sp.texture = poster;

    syncVideoTextures2D(world, surface, () => sp);
    expect(sp.texture).not.toBe(poster);

    elements.delete(e.id());                       // clip stopped
    syncVideoTextures2D(world, surface, () => sp);

    expect(sp.texture).toBe(poster);
    expect(videoTextureCount2D(surface)).toBe(0);
    poster.destroy(true);
  });

  it('unbinds a despawned entity', () => {
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    syncVideoTextures2D(world, surface, () => fakeSprite());
    expect(videoTextureCount2D(surface)).toBe(1);

    e.destroy();
    expect(syncVideoTextures2D(world, surface, () => fakeSprite())).toEqual([]);
    expect(videoTextureCount2D(surface)).toBe(0);
  });

  it('survives a sprite Scene2D already destroyed', () => {
    // stop() disposes video bindings BEFORE the slots for this reason — but the
    // world-swap ordering has been got wrong before, so the path must not throw.
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    const sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);

    sp.destroyed = true;
    expect(() => disposeVideoTextures2D(surface)).not.toThrow();
  });
});

describe('deferred GPU teardown (#476)', () => {
  // `syncVideoTextures2D` runs mid-pass in Scene2D — after the sprite pass, before
  // `pool.renderAll`/`renderer.render`. Destroying a VideoSource's GPU state in that same
  // pass is the #455 bug class, so the texture destroy is queued and only flushed at the
  // TOP of the NEXT call, once a full render has happened in between.

  it('a stopped clip detaches the sprite immediately but defers the texture destroy', () => {
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    const sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);
    const videoTexture = sp.texture;

    elements.delete(e.id());                       // clip stopped
    syncVideoTextures2D(world, surface, () => sp);

    expect(sp.texture).not.toBe(videoTexture);      // detached immediately
    expect(videoTexture.destroyed).toBe(false);     // but NOT torn down yet
  });

  it('destroys the deferred texture on the NEXT sync call for that surface, without growing the queue', () => {
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    const sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);
    const videoTexture = sp.texture;

    elements.delete(e.id());                       // clip stopped
    syncVideoTextures2D(world, surface, () => sp);
    expect(videoTexture.destroyed).toBe(false);

    syncVideoTextures2D(world, surface, () => sp);  // next frame: flush
    expect(videoTexture.destroyed).toBe(true);

    // Repeated calls afterward must not re-destroy or accumulate anything.
    expect(() => syncVideoTextures2D(world, surface, () => sp)).not.toThrow();
    expect(() => syncVideoTextures2D(world, surface, () => sp)).not.toThrow();
  });

  it('defers the destroy on the rebind path too (clip swap / new Sprite)', () => {
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    const sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);
    const first = sp.texture;

    elements.set(e.id(), fakeElement());            // clip swapped -> new element
    syncVideoTextures2D(world, surface, () => sp);

    expect(sp.texture).not.toBe(first);
    expect(first.destroyed).toBe(false);             // deferred, not destroyed yet

    syncVideoTextures2D(world, surface, () => sp);   // next frame: flush
    expect(first.destroyed).toBe(true);
  });

  it('defers the destroy when Scene2D rebuilds the slot (new Sprite)', () => {
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    let sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);
    const first = sp.texture;

    sp = fakeSprite();                               // Scene2D rebuilt the slot
    syncVideoTextures2D(world, surface, () => sp);

    expect(first.destroyed).toBe(false);

    syncVideoTextures2D(world, surface, () => sp);
    expect(first.destroyed).toBe(true);
  });

  it('flushPendingVideoDestroy2D alone drains a queued destroy — the idle-skip path (#476 follow-up)', () => {
    // Scene2D's renderFrame returns early on an idle+clean frame BEFORE it ever reaches
    // syncVideoTextures2D, so a clip that stops right before the sim goes idle must not
    // depend on another syncVideoTextures2D call to free its texture — only on this flush,
    // called unconditionally at the top of renderFrame, above that idle skip.
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    const sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);
    const videoTexture = sp.texture;

    elements.delete(e.id());                       // clip stopped
    syncVideoTextures2D(world, surface, () => sp);  // detaches, queues the destroy
    expect(videoTexture.destroyed).toBe(false);

    flushPendingVideoDestroy2D(surface);            // NO syncVideoTextures2D call in between
    expect(videoTexture.destroyed).toBe(true);

    expect(() => flushPendingVideoDestroy2D(surface)).not.toThrow(); // repeat: empty queue, no-op
  });

  it('flushPendingVideoDestroy2D no-ops on a surface with no bindings yet', () => {
    expect(() => flushPendingVideoDestroy2D({})).not.toThrow();
  });

  it('disposeVideoTextures2D destroys pending textures immediately instead of leaking them', () => {
    const e = world.spawn(VideoPlayer({ clip: 'c1', playing: true }));
    elements.set(e.id(), fakeElement());
    const sp = fakeSprite();
    syncVideoTextures2D(world, surface, () => sp);
    const videoTexture = sp.texture;

    elements.delete(e.id());                        // clip stopped -> destroy queued
    syncVideoTextures2D(world, surface, () => sp);
    expect(videoTexture.destroyed).toBe(false);

    disposeVideoTextures2D(surface);
    expect(videoTexture.destroyed).toBe(true);
  });
});
