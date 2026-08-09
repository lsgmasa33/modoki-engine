/** videoSystem — presentation-tier system that turns `VideoPlayer` traits into
 *  playback via `videoService`, and keeps every live clip's rate in step with the
 *  engine's `timeScale`.
 *
 *  Mirrors `audioSystem`'s contract deliberately, because the failure modes are the
 *  same shape:
 *   - registered ONLY in the app pipeline, never in `createTestWorld`, so the
 *     headless harness stays deterministic (video runs on the browser's media clock
 *     and cannot be stepped);
 *   - DECLARATIVE — the system reconciles each entity's live handle from its trait
 *     fields, so a game controls video by editing traits, not by hand-driving the
 *     service;
 *   - "not playing → no video": clips only run while the game is Playing, and
 *     leaving Play tears every handle down. A frozen last frame is the correct look
 *     for a stopped editor, not a still-advancing movie.
 *
 *  The element itself is exposed via `videoElementFor(entity)` so a RENDERER can
 *  upload its frames (3D material texture / 2D sprite). That keeps this system
 *  THREE-free and Pixi-free: it owns playback, the renderers own pixels. */

import type { World } from 'koota';
import { VideoPlayer } from '../traits/VideoPlayer';
import { EntityAttributes } from '../core/traits/EntityAttributes';
import { getPlayState } from '../core/playState';
import { onWorldSwap } from '../core/ecs/world';
import { playVideo, applyTimeScale, videoFadeGain, type VideoHandle } from './videoService';
import { emitVideoStart, emitVideoEnd } from './VideoEvents';
import { getTimeScale } from '../core/getTime';

/** Live handle per entity, plus the clip it was created for (so a `clip` change is
 *  detectable without asking the element for its URL, which may be variant-resolved). */
interface Live {
  handle: VideoHandle;
  clip: string;
  /** True once `autoplay` has been honoured, so it fires once rather than every frame. */
  autoplayed: boolean;
  /** `@video.start` is emitted on the first frame the clip actually plays — not at
   *  handle creation, which can precede playback by a whole download. */
  startEmitted: boolean;
  /** `@video.end` is emitted from the RECONCILE, when the handle is first observed to have
   *  ended — not from the element's `ended` event. The event is a promptness hint that can be
   *  missed entirely (see `LiveVideoHandle.ended`); a game listening for `@video.end` to
   *  advance a cutscene must not be able to hang on a lost DOM event. */
  endEmitted: boolean;
}

/** A clip being downloaded before it can play. Tracked separately from `live` so the
 *  reconcile does NOT start a second download every frame while the first is running —
 *  the single most expensive mistake this system could make. */
interface Pending {
  clip: string;
  cancelled: boolean;
}

// Keyed by entity ID, not by the Entity object: koota hands out a fresh Entity
// wrapper per query iteration, so an object key would never match on the next frame
// (every clip would be recreated every frame, and none ever released).
const live = new Map<number, Live>();
const pending = new Map<number, Pending>();
/** Download progress per entity (0..1). Written by the async fetch, COPIED into the
 *  trait by the synchronous pass — never written to the trait directly (see below). */
const progress = new Map<number, number>();
/** A finished download waiting for the next frame to turn it into a handle. */
const readyUrls = new Map<number, { clip: string; url: string }>();
/** Clips whose download FAILED, per entity. Without this the reconcile — which runs
 *  every frame — immediately starts another attempt the moment one fails, producing a
 *  retry storm against a host that is already refusing us (measured: a new request
 *  every ~4s, forever, on a CORS failure). A failure is sticky until the clip changes,
 *  so recovery is an explicit act rather than an accident. */
const failed = new Map<number, string>();

/** Resolver injected by the app: GUID → playable URL. Kept as an injection rather
 *  than an import so this module doesn't pull the loader stack (and so a test can
 *  substitute a plain URL). Without one, a GUID is used verbatim — which is wrong,
 *  and loudly so, rather than silently loading nothing. */
type UrlResolver = (clipGuid: string) => string | undefined;
let resolveUrl: UrlResolver = (guid) => guid;

/** Inject the manifest-backed GUID → URL resolver (app wiring). */
export function setVideoUrlResolver(fn: UrlResolver): void { resolveUrl = fn; }

/** What the playback layer needs to fetch a clip. Mirrors loaders/videoUrl's
 *  `VideoSource`, redeclared structurally so this module keeps NO loader import. */
export interface ResolvedVideoSource {
  url: string;
  policy: 'stream' | 'download';
  cacheKey: string;
  bytes?: number;
}
type SourceResolver = (clipGuid: string) => ResolvedVideoSource | undefined;
let resolveSource: SourceResolver | null = null;

/** Inject the manifest-backed delivery resolver. Without it every clip is treated as
 *  a plain streamed URL — correct for bundled video, which is the common case. */
export function setVideoSourceResolver(fn: SourceResolver): void { resolveSource = fn; }

/** Downloads a clip into the local cache and returns its local URL. Injected so this
 *  module depends on neither the cache implementation nor storage APIs. */
type Downloader = (
  key: string, url: string, onProgress?: (received: number, total?: number) => void,
) => Promise<string | undefined>;
let download: Downloader | null = null;

export function setVideoDownloader(fn: Downloader | null): void { download = fn; }

/** The `HTMLVideoElement` currently backing an entity, for renderers that upload its
 *  frames. Undefined when the entity has no live clip. */
export function videoElementFor(entityId: number): HTMLVideoElement | undefined {
  return live.get(entityId)?.handle.element;
}

/** Tear down one entity's clip. */
function release(entityId: number): void {
  // Mark any in-flight download dead FIRST, so a fetch that resolves after this point
  // doesn't resurrect a handle for an entity that is gone.
  const p = pending.get(entityId);
  if (p) { p.cancelled = true; pending.delete(entityId); }
  const l = live.get(entityId);
  if (!l) return;
  l.handle.dispose();
  live.delete(entityId);
}

/** Tear down every clip (leaving Play, scene swap, world teardown). */
export function stopWorldVideo(): void {
  for (const e of [...live.keys()]) release(e);
  for (const [e, p] of pending) { p.cancelled = true; pending.delete(e); }
}

// A scene swap invalidates every entity handle — drop them all rather than leak
// elements pointing at a world that no longer exists.
onWorldSwap(() => { stopWorldVideo(); });

export function videoSystem(world: World): void {
  // "Not playing → no video." Mirrors skeletal animation and audio: a stopped editor
  // shows a frozen frame, it does not keep running the movie.
  if (getPlayState() !== 'playing') {
    if (live.size) stopWorldVideo();
    return;
  }

  // Push timeScale once for every live clip — diegetic clips scale, presentation
  // clips only respond to a full stop (see VideoTimeMode).
  applyTimeScale(getTimeScale(world));

  const seen = new Set<number>();

  world.query(VideoPlayer).updateEach(([vp], entity) => {
    const id = entity.id();
    // Captured once per pass: event payloads carry the stable GUID, never the runtime
    // id, which is reassigned on every scene hot-reload.
    const entityGuid = entity.get(EntityAttributes)?.guid;
    seen.add(id);
    const existing = live.get(id);

    // No clip authored → nothing to play; release anything left over.
    if (!vp.clip) {
      if (existing) release(id);
      if (vp.playing) vp.playing = false;
      return;
    }

    // Clip changed → hard swap. (A crossfade equivalent would need two decoders
    // running at once; deliberately not attempted until something asks for it.)
    if (existing && existing.clip !== vp.clip) {
      release(id);
    }
    // A different clip is a fresh chance — drop a stale failure for this entity.
    if (failed.has(id) && failed.get(id) !== vp.clip) failed.delete(id);

    let l = live.get(id);
    if (!l) {
      // A finished download from a previous frame: create the handle NOW, in the
      // system's own synchronous pass, using the trait's current values.
      const done = readyUrls.get(id);
      let localUrl: string | undefined;
      if (done && done.clip === vp.clip) {
        readyUrls.delete(id);
        vp.loadProgress = 1;
        localUrl = done.url;
      } else {
        // Already downloading this clip? Do nothing — emphatically do NOT start
        // another. This reconcile runs every frame, so a missing guard here would
        // launch 60 downloads a second of the same file.
        const p = pending.get(id);
        if (p && p.clip === vp.clip) { vp.loadProgress = progress.get(id) ?? 0; return; }
        if (p) { p.cancelled = true; pending.delete(id); } // clip changed mid-download

        // This clip already failed for this entity — do NOT try again every frame.
        if (failed.get(id) === vp.clip) return;

        const src = resolveSource?.(vp.clip);
        // `download` policy: fetch into the local cache first, then play from disk.
        // NOTHING here writes to `vp` asynchronously — koota's updateEach proxy is
        // only valid for the duration of this callback, so a write from a .then()
        // would be silently dropped. The async side records into module maps and the
        // NEXT frame's pass copies them into the trait.
        if (src && src.policy === 'download' && download) {
          const rec: Pending = { clip: vp.clip, cancelled: false };
          pending.set(id, rec);
          progress.set(id, 0);
          vp.loadProgress = 0;
          const clip = vp.clip;
          void download(src.cacheKey, src.url, (received, total) => {
            if (rec.cancelled) return;
            // Unknown total → leave progress at 0 rather than inventing a fraction;
            // a bar that lies is worse than one that waits.
            if (total) progress.set(id, Math.min(1, received / total));
          }).then((localUrl) => {
            if (rec.cancelled) return;
            pending.delete(id);
            progress.set(id, 1);
            if (localUrl) readyUrls.set(id, { clip, url: localUrl });
          }).catch((e) => {
            if (rec.cancelled) return;
            pending.delete(id);
            progress.set(id, 0);
            failed.set(id, clip);
            // Loud ONCE, not once per frame. A refused/failed download is a real
            // problem (budget, network, CORS) and silently showing nothing is how it
            // goes unnoticed — but a log per retry is its own kind of unnoticeable.
            console.error(`[video] download failed for ${clip} (will not retry until the clip changes):`, e);
          });
          return;
        }
      }

      // Either a just-finished download's local URL, or the direct/streamed one.
      const url = localUrl ?? resolveSource?.(vp.clip)?.url ?? resolveUrl(vp.clip);
      if (!url) return; // unresolvable GUID — the manifest layer logs it
      const handle = playVideo({
        url,
        loop: vp.loop,
        muted: vp.muted,
        volume: vp.volume,
        bus: vp.bus,
        timeMode: vp.timeMode,
        // Start paused; the `playing`/`autoplay` reconcile below decides. Otherwise a
        // clip authored with autoplay=false would play for one frame on spawn.
        autoplay: false,
        onEnded: () => {
          // Pause promptly, from the element's own event. The `@video.end` EVENT is emitted by
          // the reconcile below instead, so it cannot be lost with this callback (measured: an
          // iPhone 8 played a clip to the end repeatedly and never once fired `ended`).
          live.get(id)?.handle.pause();
        },
      });
      l = { handle, clip: vp.clip, autoplayed: false, startEmitted: false, endEmitted: false };
      live.set(id, l);
      // A bundled/streamed clip never downloads, so it is loaded by definition.
      // Without this it would report 0 forever and any bound progress bar would stick.
      vp.loadProgress = 1;
    }

    // `autoplay` sets `playing` ONCE on first appearance — after that `playing` is
    // the control input, so a game pausing the clip isn't overridden next frame.
    if (!l.autoplayed) {
      l.autoplayed = true;
      if (vp.autoplay && !vp.playing) vp.playing = true;
    }

    if (vp.playing) {
      l.handle.play();
      if (!l.startEmitted) { l.startEmitted = true; emitVideoStart({ entity: entityGuid, clip: vp.clip }); }
    } else l.handle.pause();

    // Live-applied fields. The end-fade is a MULTIPLIER computed from the element's own
    // clock, never a write back into `vp.volume` — that field is the authored target the
    // ramp descends from, and tweening it would make the fade permanent (a replay or a
    // seek backwards would start silent) as well as unreadable in the Inspector.
    l.handle.setVolume(vp.volume * videoFadeGain(
      l.handle.element.currentTime, l.handle.element.duration, vp.fadeOutSec,
    ));
    l.handle.setMuted(vp.muted);
    l.handle.setRate(vp.rate);

    // A finished non-looping clip: reflect it into the trait so game logic and the Inspector
    // see it stopped without polling the element, and journal `@video.end` exactly once.
    // Both keyed off `handle.ended`, which reads the ELEMENT rather than trusting the event.
    if (l.handle.ended) {
      if (vp.playing) vp.playing = false;
      if (!l.endEmitted) { l.endEmitted = true; emitVideoEnd({ entity: entityGuid, clip: l.clip }); }
    }
  });

  // Entities that lost the trait (or were despawned) leak their decoder otherwise.
  for (const e of [...live.keys()]) {
    if (!seen.has(e)) release(e);
  }
  // Same for an entity that vanished mid-download, plus its bookkeeping — release()
  // cancels the fetch, these drop the state it would have landed in.
  for (const e of [...pending.keys()]) if (!seen.has(e)) release(e);
  for (const e of [...progress.keys()]) if (!seen.has(e)) progress.delete(e);
  for (const e of [...readyUrls.keys()]) if (!seen.has(e)) readyUrls.delete(e);
  for (const e of [...failed.keys()]) if (!seen.has(e)) failed.delete(e);
}

/** Seek an entity's live clip, if it has one. Used by the declarative `video.seek` /
 *  `video.stop` / `video.skip` actions, which act on an ENTITY rather than a handle. */
export function seekEntityVideo(entityId: number, seconds: number): void {
  live.get(entityId)?.handle.seek(seconds);
}

/** Test hook — drop all state. */
export function __resetVideoSystem(): void {
  stopWorldVideo();
  progress.clear();
  readyUrls.clear();
  failed.clear();
  resolveUrl = (guid) => guid;
  resolveSource = null;
  download = null;
}
