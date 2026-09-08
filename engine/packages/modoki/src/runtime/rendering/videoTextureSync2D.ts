/** videoTextureSync2D — binds a `VideoPlayer` entity's live `HTMLVideoElement` onto its
 *  PixiJS `Sprite` as a video-backed `Texture`.
 *
 *  The 2D twin of `videoTextureSync.ts`, and the same shape for the same reasons: an
 *  additive pass over the display objects Scene2D has already made, kept out of that
 *  1600-line render loop, with a per-SURFACE binding table so the editor's two 2D
 *  viewports each get their own texture over ONE shared decoder.
 *
 *  ## We adopt the element; we never let Pixi own it
 *
 *  Two places would otherwise take the element away from `videoService`:
 *
 *  1. **`Assets.load` on an `.mp4`.** Pixi has a video loader, so this "works" — by
 *     creating its own second `HTMLVideoElement`. Scene2D therefore routes a video ref
 *     past the still-image path entirely (`isVideoRef`), leaving an EMPTY-textured
 *     Sprite for this module to fill.
 *  2. **`VideoSource.destroy()`**, which does `pause(); src = ''; load()` on its
 *     resource. Called on a shared element that is mid-cutscene, it would black out the
 *     3D screen and the fullscreen overlay at the same time. `release()` below detaches
 *     the resource FIRST — and the ordering there is load-bearing, so it is tested.
 *
 *  ## Why the upload loop is hand-rolled
 *
 *  `VideoSource` will drive its own uploads, but only via `load()` — and `load()` both
 *  awaits an alpha-mode probe (so its continuation dereferences a resource we may have
 *  detached by then: an unhandled rejection on any quick clip swap) and can call
 *  `source.load()` on the element, which RESETS a clip that is already playing. Neither
 *  is acceptable against an element we do not own, so `autoLoad` is off and this module
 *  pumps `update()` from `requestVideoFrameCallback` itself — once per PRESENTED frame,
 *  same as the 3D path, and naturally idle while a `timeScale 0` freeze holds the
 *  element paused. */

import { Sprite, Texture, VideoSource } from 'pixi.js';
import type { World } from 'koota';
import { VideoPlayer } from '../traits/VideoPlayer';
import { videoElementFor } from '../video/videoSystem';

interface Bound {
  texture: Texture;
  source: VideoSource;
  element: HTMLVideoElement;
  sprite: Sprite;
  /** What the Sprite showed before we took it over, restored on teardown so a screen
   *  with a static poster frame doesn't go blank when its clip stops. */
  previousTexture: Texture;
  /** rVFC handle, so the upload pump can be cancelled. 0 = not pumping. */
  rvfcHandle: number;
  cancelled: boolean;
}

/** The rVFC half of an HTMLVideoElement, absent on older browsers. */
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

/** Per-surface state: the live binding table plus textures whose GPU teardown is deferred
 *  one frame (see `detach`/the flush at the top of `syncVideoTextures2D`). Kept per-surface,
 *  not module-global, so a surface that stops rendering can't strand another surface's queue,
 *  and `disposeVideoTextures2D` can drain exactly its own. */
interface SurfaceState {
  table: Map<number, Bound>;
  pendingDestroy: Texture[];
}

/** Per-surface binding table, keyed by the Scene2DRenderer instance. */
const bindings = new WeakMap<object, SurfaceState>();

function makeTexture(el: HTMLVideoElement): { texture: Texture; source: VideoSource } {
  const source = new VideoSource({
    resource: el,
    // Pixi must not touch playback. `videoService` owns play/pause — it is what applies
    // `timeScale`, the autoplay-gesture retry and the presentation/diegetic split. With
    // the default `autoPlay: true`, Pixi's own canplay handler calls `resource.play()`,
    // which would silently un-pause a clip the engine had deliberately frozen.
    autoPlay: false,
    // Off for the reasons in the file header — it is the path that resets the element
    // and that leaks a rejection when the resource is detached mid-load.
    autoLoad: false,
  });
  return { texture: new Texture({ source }), source };
}

/** Pump GPU uploads from presented video frames, and keep the texture sized to the
 *  clip. Dimensions are NOT known at bind time — a clip that is still opening reports
 *  0×0 — so the size is re-checked each frame until it settles rather than read once. */
function driveUploads(b: Bound): void {
  const el = b.element as FrameCallbackVideo;
  const pump = () => {
    if (b.cancelled) return;
    const w = b.element.videoWidth, h = b.element.videoHeight;
    if (w && h) {
      if (b.source.width !== w || b.source.height !== h) b.source.resize(w, h);
      b.source.update();
    }
    b.rvfcHandle = el.requestVideoFrameCallback!(pump);
  };
  if (typeof el.requestVideoFrameCallback !== 'function') {
    // No rVFC (older Safari/Firefox): fall back to Pixi's own ticker-driven update,
    // which costs an upload per RENDER frame rather than per presented frame.
    b.source.autoUpdate = false;
    b.source.autoUpdate = true;
    return;
  }
  b.rvfcHandle = el.requestVideoFrameCallback(pump);
}

/** Undo the bind, EXCEPT the final GPU teardown of `b.texture` — the caller queues that
 *  separately (see `syncVideoTextures2D`'s flush and `disposeVideoTextures2D`). Splitting
 *  it out is hardening, not a bug fix: `detach` runs from inside `syncVideoTextures2D`,
 *  which Scene2D calls mid-pass (after the sprite pass, before `pool.renderAll(...)` →
 *  `renderer.render(...)`), and `texture.destroy(true)` is a real GPU teardown of the
 *  `VideoSource` — destroying one inside the pass about to render it is the #455 bug
 *  class. Not observed to fail here, since this function re-points the sprite off the
 *  doomed texture BEFORE any destroy — but a render that reaches for state Pixi just
 *  freed is exactly the class of bug #455 was, so the destroy is deferred one frame
 *  regardless of whether this particular call site could reach it this frame. */
function detach(b: Bound): void {
  // ORDER IS LOAD-BEARING. `VideoSource.destroy()` ends with
  //   resource.pause(); resource.src = ''; resource.load();
  // on whatever element it still holds — i.e. it would tear down the ONE element that
  // videoService owns and that the 3D texture + the cutscene overlay are also using.
  //
  //  1. Stop our own pump, and set `autoUpdate = false` WHILE the resource is still
  //     attached — destroy() calls `_configureAutoUpdate()`, which dereferences the
  //     resource unless `_autoUpdate` is already false to short-circuit it.
  //  2. Detach the resource, so destroy()'s cleanup block finds nothing to kill.
  //  3. Destroy — now purely GPU-side. (Queued by the caller; see above.)
  b.cancelled = true;
  if (b.rvfcHandle) {
    const el = b.element as FrameCallbackVideo;
    try { el.cancelVideoFrameCallback?.(b.rvfcHandle); } catch { /* noop */ }
  }
  b.source.autoUpdate = false;
  (b.source as { resource?: HTMLVideoElement }).resource = undefined;
  if (!b.sprite.destroyed) {
    // ⚠️ `previousTexture` was captured at BIND time and can have been DESTROYED since — Scene2D
    // swaps a slot's framed wrapper on a LIVE sprite and destroys the old one (the re-slice branch
    // in `Scene2D.tsx`, `oldTex.destroy(false)`), which leaves this holding a corpse. Restoring it
    // blind puts a destroyed texture on an in-graph sprite that the `pool.renderAll` at the end of
    // this same pass then renders — the #455 class. EMPTY is the honest fallback: the sprite shows
    // nothing for a frame instead of taking the renderer down with it.
    b.sprite.texture = b.previousTexture.destroyed ? Texture.EMPTY : b.previousTexture;
  }
}

/** Flush a surface's deferred video-texture destroys. By the time this runs, a full render
 *  pass has completed since the textures were queued (`detach`, below) — so nothing in the
 *  display graph or the batcher still names these sources, and the GPU teardown is safe.
 *
 *  Called from TWO places, deliberately: the top of `syncVideoTextures2D` (the common case,
 *  once the queue was filled during THAT same call last frame) and the top of Scene2D's
 *  `renderFrame`, ABOVE the idle-frame skip — mirroring `flushPendingMaskDestroy` there for
 *  the same reason. Without the second call site, a clip that ends right before the sim
 *  goes idle queues its texture and then never reaches `syncVideoTextures2D` again (that idle
 *  skip returns before line 2035), stranding a pinned decoder + its GPU texture until the
 *  surface is torn down. No-ops cleanly when the surface has no state yet (nothing was ever
 *  bound, so nothing can be pending). */
export function flushPendingVideoDestroy2D(surface: object): void {
  const state = bindings.get(surface);
  if (!state || state.pendingDestroy.length === 0) return;
  for (const tex of state.pendingDestroy) {
    // `destroy(true)` — take the source down with the wrapper. Safe (and required, or the
    // VideoSource leaks) precisely BECAUSE this source is ours alone: unlike a sprite slot,
    // nothing here borrows from the shared Assets cache.
    tex.destroy(true);
  }
  state.pendingDestroy.length = 0;
}

/** Bind/unbind video textures for one 2D surface. Call once per frame from
 *  `renderFrame`, AFTER the sprite pass (it reads the slots that pass creates).
 *
 *  `spriteFor` hands back the entity's live Sprite, or null when it has no 2D body —
 *  a 3D-only or UI-only video consumer lands here every frame and must cost nothing.
 *
 *  Returns the entity ids currently showing video. The caller needs them, not just a
 *  dirty flag: Scene2D renders a canvas only when something on it CHANGED, and a video
 *  changes every frame without any ECS write to notice — so a bound clip has to keep
 *  its own canvas dirty or the picture freezes on frame one. */
export function syncVideoTextures2D(
  world: World,
  surface: object,
  spriteFor: (entityId: number) => Sprite | null,
): number[] {
  let state = bindings.get(surface);
  if (!state) { state = { table: new Map(), pendingDestroy: [] }; bindings.set(surface, state); }
  const { table, pendingDestroy } = state;

  // Flush LAST frame's deferred destroys, first thing. Usually a no-op here: `renderFrame`
  // already flushed this surface's queue before the idle-skip check, at the top of its own
  // pass — see `flushPendingVideoDestroy2D`. Kept here too so this function stays correct
  // standalone (tests, or any future caller that doesn't route through Scene2D's flush).
  flushPendingVideoDestroy2D(surface);

  const seen = new Set<number>();

  for (const entity of world.query(VideoPlayer)) {
    const id = entity.id();
    const sprite = spriteFor(id);
    if (!sprite || sprite.destroyed) continue;
    const el = videoElementFor(id);
    if (!el) continue;                       // no live clip right now
    seen.add(id);

    const existing = table.get(id);
    // Rebind when EITHER end moved: a clip swap gives a new element, and a Scene2D slot
    // rebuild (ref/kind change) gives a new Sprite whose texture is EMPTY again.
    if (existing && existing.element === el && existing.sprite === sprite) continue;
    if (existing) {
      detach(existing);
      pendingDestroy.push(existing.texture);
      table.delete(id);
    }

    const { texture, source } = makeTexture(el);
    const previousTexture = sprite.texture ?? Texture.EMPTY;
    const bound: Bound = {
      texture, source, element: el, sprite, previousTexture,
      rvfcHandle: 0, cancelled: false,
    };
    sprite.texture = texture;
    driveUploads(bound);
    table.set(id, bound);
  }

  // Clips that stopped, entities that lost the trait or were despawned.
  for (const [id, b] of [...table]) {
    if (!seen.has(id)) {
      detach(b);
      pendingDestroy.push(b.texture);
      table.delete(id);
    }
  }

  return [...table.keys()];
}

/** Drop every binding for a surface (viewport stop / world swap). Destroys immediately
 *  rather than deferring — both call sites run outside a render pass: `stop()` tears the
 *  surface down (nothing will render it again), and the `onWorldSwap` handler runs between
 *  frames, before the new world's first `renderFrame` — so there is no in-flight pass for a
 *  same-frame destroy to corrupt either way. */
export function disposeVideoTextures2D(surface: object): void {
  const state = bindings.get(surface);
  if (!state) return;
  for (const b of state.table.values()) {
    detach(b);
    b.texture.destroy(true); // `destroy(true)` — see the note in `flushPendingVideoDestroy2D`.
  }
  for (const tex of state.pendingDestroy) tex.destroy(true);
  state.table.clear();
  state.pendingDestroy.length = 0;
  bindings.delete(surface);
}

/** Test/inspection hook — how many bindings a surface holds. */
export function videoTextureCount2D(surface: object): number {
  return bindings.get(surface)?.table.size ?? 0;
}
