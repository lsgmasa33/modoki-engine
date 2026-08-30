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
import { emitVideoStart, emitVideoEnd, emitVideoBlocked, type VideoEventPayload } from './VideoEvents';
import { getTimeScale } from '../core/getTime';

/** Live handle per entity, plus the clip it was created for (so a `clip` change is
 *  detectable without asking the element for its URL, which may be variant-resolved). */
interface Live {
  handle: VideoHandle;
  clip: string;
  /** True once `autoplay` has been honoured, so it fires once rather than every frame. */
  autoplayed: boolean;
  /** `@video.start` is emitted once the handle is OBSERVED playing — not at handle creation,
   *  which can precede playback by a whole download, and not on the pass that merely ASKS the
   *  clip to play. Guards one playback, not the `Live` entry's whole lifetime:
   *  `seekEntityVideo` clears it on a rewind to 0, so a replayed clip (same GUID, same `Live`
   *  entry) fires `@video.start` again. A mid-clip pause/resume or seek leaves it set —
   *  that's the same playback continuing.
   *
   *  #431: `LiveVideoHandle.attemptPlay()` can have `element.play()` rejected by the autoplay
   *  policy (it sets a private `blocked` flag), and `retryBlockedPlay()` later starts the real
   *  playback entirely outside this system's reconcile — so latching this at REQUEST time (the
   *  pass that calls `handle.play()`) announced a start for a cold-boot cutscene that never
   *  rendered a frame, and never announced the real one once a gesture unblocked it. Fixed by
   *  reading `handle.playing` BEFORE this pass's own `handle.play()` call: a request that is
   *  about to succeed is only observed on the FOLLOWING pass (one frame later — the accepted
   *  cost, see `videoSystem`'s comment at the call site), and a request that gets blocked is
   *  never observed until it genuinely starts, however that happens. */
  startEmitted: boolean;
  /** `@video.end` is emitted from the RECONCILE, when the handle is first observed to have
   *  ended — not from the element's `ended` event. The event is a promptness hint that can be
   *  missed entirely (see `LiveVideoHandle.ended`); a game listening for `@video.end` to
   *  advance a cutscene must not be able to hang on a lost DOM event. Guards one observed end,
   *  not the `Live` entry's whole lifetime: the reconcile re-arms it the moment `handle.ended`
   *  goes false again, so a rewind-and-replay of the SAME clip fires `@video.end` again too. */
  endEmitted: boolean;
  /** `@video.blocked` is announced ONCE per refused PLAY REQUEST, not once per frame — the
   *  reconcile calls `play()` every frame while the trait says `playing`, so an unguarded report
   *  would spam the console for the whole span. Cleared on either edge out of that state: the
   *  handle unblocking (a gesture got it running), or `playing` going false (the span ended) —
   *  see the reset beside `handle.pause()`. Both are needed, because a `pause()` leaves `blocked`
   *  set, so the unblock edge alone never fires on a device that never receives a gesture. */
  blockedReported: boolean;
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
//
// The id is the MASKED index — `entity.id()` strips koota's generation — and every map below
// holds state ACROSS frames, so a reclaimed index would otherwise hand a new entity the dead
// one's decoder. `owner` is what makes that detectable; see its own comment.
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

/** Which PACKED entity (`entity.valueOf()` — generation included) currently owns each id's slot
 *  in the maps above. #336, the sibling of QA-ZONE-0003: koota's `entity.id()` masks the
 *  generation off, and its entity index is a LIFO free list, so a despawn immediately followed by
 *  a same-shape respawn reclaims the exact freed index. The `seen`-set sweep that would have
 *  released the dead entity's state runs at the END of a pass, so a despawn+respawn landing
 *  BETWEEN two passes never gets one — the reconcile just reads `live.get(id)` and concludes
 *  "already mine". The `existing.clip !== vp.clip` hard-swap below self-heals a DIFFERENT clip;
 *  a SAME-clip respawn (a prefab re-instantiated, two players streaming one intro) inherits the
 *  dead entity's decoder, progress and sticky download failure instead of starting its own.
 *
 *  Why an ownership check rather than the zone fix's packed KEY: video's id is also a public
 *  ADDRESSING contract — `videoElementFor`/`seekEntityVideo` are called by the 3D and 2D texture
 *  surfaces, by `UIVideoMount` off the UI tree's `entityId`, and by the `video.*` actions, all of
 *  which hold a masked id and nothing else. Re-keying the maps would have to re-key that whole
 *  chain. Keying stays as it is; only the TRUST changes. */
const owner = new Map<number, number>();

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

/** Drop EVERY trace of an id — the handle and the download, plus the bookkeeping `release`
 *  deliberately leaves behind (`progress`/`readyUrls`/`failed` outlive a Stop so a sticky
 *  download failure isn't retried on the next Play). Used only when the id's owner changed:
 *  the new entity must inherit nothing, sticky failure included. */
function forget(entityId: number): void {
  release(entityId);
  progress.delete(entityId);
  readyUrls.delete(entityId);
  failed.delete(entityId);
}

/** Tear down every clip (leaving Play, scene swap, world teardown). */
export function stopWorldVideo(): void {
  for (const e of [...live.keys()]) release(e);
  for (const [e, p] of pending) { p.cancelled = true; pending.delete(e); }
}

// A scene swap invalidates every entity handle — drop them all rather than leak
// elements pointing at a world that no longer exists.
//
// `owner` is dropped here but NOT in `stopWorldVideo`, and the difference matters. Leaving Play
// keeps the same world, so an entity's packed value is unchanged and its sticky download failure
// should survive to the next Play (that is what `failed` is for). A swap replaces the world, and
// index spaces are PER-WORLD — a new entity can be handed the same packed value an old one had,
// which would match a stale `owner` entry and skip the purge, silently inheriting the previous
// scene's `failed`/`progress`/`readyUrls`. Clearing here makes every entity in the new world
// first-sight, so it inherits nothing.
onWorldSwap(() => { stopWorldVideo(); owner.clear(); });

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

  // #432: collected here and flushed AFTER `updateEach` returns, rather than emitted inline.
  // koota snapshots `vp` into a local before the callback runs and writes that snapshot back
  // UNCONDITIONALLY once the callback returns — so a game handler's `entity.set(VideoPlayer,
  // ...)`, called synchronously from an emit fired INSIDE the callback, would land during the
  // callback only to be clobbered by koota's own post-callback write-back of the stale
  // pre-callback snapshot. Deferring the call past `updateEach` puts it past that write-back
  // too, so the handler's write is the last one and sticks. Declared per-call (not module
  // scope) so it can't leak state across worlds or a re-entrant call.
  const emits: Array<{ kind: 'start' | 'end'; payload: VideoEventPayload }> = [];
  // Same #432 reason as `emits` above: deferred past `updateEach`'s post-callback write-back.
  const blocked: VideoEventPayload[] = [];

  world.query(VideoPlayer).updateEach(([vp], entity) => {
    const id = entity.id();
    // A reclaimed index (see `owner`): purge the previous occupant's state before reading any of
    // it. On an entity's FIRST sight there is nothing to purge, so this is a no-op then.
    const packed = entity.valueOf();
    if (owner.get(id) !== packed) { forget(id); owner.set(id, packed); }
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
      l = {
        handle, clip: vp.clip, autoplayed: false, startEmitted: false, endEmitted: false,
        blockedReported: false,
      };
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
      // #447: a refused play request is otherwise COMPLETELY silent — post-#431 a blocked clip
      // correctly emits no `@video.start`, and if a timeline pauses it at the span end it never
      // emits `@video.end` either, so a cutscene that never played leaves no trace at all. Read
      // BEFORE this pass's own `play()` for the same reason the start check is (see below): the
      // flag is only set when the play PROMISE rejects, a microtask after `play()` returns.
      if (l.handle.autoplayBlocked) {
        if (!l.blockedReported) {
          l.blockedReported = true;
          console.warn(`[video] playback of clip ${vp.clip} was refused by the browser (autoplay policy) — it is waiting for a user gesture.`);
          blocked.push({ entity: entityGuid, clip: vp.clip });
        }
      } else l.blockedReported = false;

      // #431: the OBSERVED-playback check runs BEFORE `l.handle.play()` is called below, and
      // that ordering is the fix, not incidental — resist "cleaning it up" into a single
      // check-and-play. A real `element.play()` sets `element.paused = false` SYNCHRONOUSLY as
      // part of its own algorithm and only rejects the returned promise LATER if the autoplay
      // policy blocks it — so checking `handle.playing` AFTER calling `play()` would still
      // read "playing" for one frame on a clip that is about to be blocked and render nothing.
      // Checking before means a genuine, successful play request is only OBSERVED as started
      // on the FOLLOWING reconcile pass (one frame later — accepted, see the callers this
      // pushed a second pass onto), while a blocked one is never announced until the handle
      // truly starts, however that happens (including via `retryBlockedPlay()`, which runs
      // entirely outside this system on the next gesture-unlock sweep).
      //
      // `LiveVideoHandle.play()` early-returns on a finished clip (`if (this.ended) return;`),
      // but the end-emit below re-arms `startEmitted` the moment `@video.end` fires — so
      // `playing = true` on a still-ended clip with NO intervening seek would otherwise
      // announce a start for a playback that can never happen: `play()` refuses to actually
      // run it, so the announced start would never be followed by a single frame of real
      // playback. `@video.start` means observed playback (#431), and closing that gap is what
      // removed the cutscene hang #426 set out to fix. `handle.playing` already excludes an
      // ended handle, but the explicit `!l.handle.ended` keeps that intent readable here too.
      if (!l.startEmitted && !l.handle.ended && l.handle.playing) {
        l.startEmitted = true;
        emits.push({ kind: 'start', payload: { entity: entityGuid, clip: vp.clip } });
      }
      l.handle.play();
    } else {
      l.handle.pause();
      // #447: re-arm on the way OUT of a play request too, not only when the handle unblocks.
      // `pause()` does NOT clear `blocked` — only a SUCCESSFUL `attemptPlay` does — so on a
      // device where no gesture ever arrives, `autoplayBlocked` stays true across the gap
      // between two spans. Without this reset the latch set by the first refused span would
      // still be set for the second, and every later cutscene on this entity would be silent:
      // exactly the failure #447 exists to make findable.
      l.blockedReported = false;
    }

    // Live-applied fields. The end-fade is a MULTIPLIER computed from the element's own
    // clock, never a write back into `vp.volume` — that field is the authored target the
    // ramp descends from, and tweening it would make the fade permanent (a replay or a
    // seek backwards would start silent) as well as unreadable in the Inspector.
    l.handle.setVolume(vp.volume * videoFadeGain(
      l.handle.element.currentTime, l.handle.element.duration, vp.fadeOutSec,
    ));
    l.handle.setMuted(vp.muted);
    l.handle.setRate(vp.rate);
    l.handle.setLoop(vp.loop);
    l.handle.setTimeMode(vp.timeMode);

    // A finished non-looping clip: reflect it into the trait so game logic and the Inspector
    // see it stopped without polling the element, and journal `@video.end` exactly once.
    // Both keyed off `handle.ended`, which reads the ELEMENT rather than trusting the event.
    if (l.handle.ended) {
      if (vp.playing) vp.playing = false;
      if (!l.endEmitted) {
        l.endEmitted = true;
        // Re-arm the START too: a finished clip can only resume via a seek (`play()` refuses
        // one), and that resume is a NEW observed playback wherever it starts from —
        // `@video.start` means observed playback (#431), so this playback earns its own start
        // event. Without this, `video.seek` to mid-clip out of the ended state re-arms
        // `endEmitted` (the `else` below) and the clip would resume playing with no
        // `@video.start` ever announcing that it did.
        l.startEmitted = false;
        emits.push({ kind: 'end', payload: { entity: entityGuid, clip: l.clip } });
      }
    } else {
      // Re-arm: `endEmitted` guards ONE observed end, not the whole `Live` entry's lifetime.
      l.endEmitted = false;
    }
  });

  // #432: flush the deferred emits now that koota's post-callback write-back has already
  // happened for every entity above — see the comment where `emits` is declared. Order is
  // preserved (entity order as iterated, start-before-end within one entity) simply by
  // flushing in push order; nothing here needs to re-sort.
  for (const e of emits) {
    if (e.kind === 'start') emitVideoStart(e.payload);
    else emitVideoEnd(e.payload);
  }
  for (const p of blocked) emitVideoBlocked(p);

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
  // Ownership outlives nothing else — an id whose entity is gone must not keep claiming it, or
  // a LATER respawn on that index would match the dead owner and skip its purge.
  for (const e of [...owner.keys()]) if (!seen.has(e)) owner.delete(e);
}

/** Seek an entity's live clip, if it has one. Used by the declarative `video.seek` /
 *  `video.stop` / `video.skip` actions, which act on an ENTITY rather than a handle. */
export function seekEntityVideo(entityId: number, seconds: number): void {
  const l = live.get(entityId);
  if (!l) return;
  l.handle.seek(seconds);
  // A rewind to the start begins a NEW playback, so `@video.start` must fire again for it.
  // Only the start: `endEmitted` re-arms itself from the reconcile's `handle.ended` edge.
  if (seconds <= 0) l.startEmitted = false;
}

/** Claim this entity's `@video.end` announcement for the current playback, latching the guard so
 *  the reconcile does not announce it a second time. Returns false when the end was ALREADY
 *  announced — the caller must then stay silent.
 *
 *  Exists for `video.skip`, which announces the end itself so a game waiting on "the cutscene is
 *  over" fires exactly once whether the clip was watched or dismissed. Without this claim, a skip
 *  pressed AFTER the clip already ended emits a second, redundant `@video.end` for a playback
 *  that was already announced over.
 *
 *  An entity with no live handle claims successfully: a skip must always announce (that is the
 *  softlock this action exists to prevent), and there is no guard to double-fire against. */
export function claimVideoEndEmit(entityId: number): boolean {
  const l = live.get(entityId);
  if (!l) return true;
  if (l.endEmitted) return false;
  l.endEmitted = true;
  return true;
}

/** Test hook — drop all state. */
export function __resetVideoSystem(): void {
  stopWorldVideo();
  progress.clear();
  readyUrls.clear();
  failed.clear();
  owner.clear();
  resolveUrl = (guid) => guid;
  resolveSource = null;
  download = null;
}
