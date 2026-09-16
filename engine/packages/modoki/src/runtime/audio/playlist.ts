/** Playlist walking for an `AudioSource`'s clip bank.
 *
 *  The bank has always been an engine concept — `AudioSource.clips` is "an AudioSource + an array
 *  of AudioClips indexed by name" — but nothing walked it: a source plays the ONE guid in `clip`,
 *  so a twelve-track bank shipped twelve tracks and played the first. Every game wanting
 *  background music had to write the same walker, and games/court did, before this replaced it.
 *
 *  ⚠️ **The swap fires BEFORE the current clip ends, not at it.** Waiting for the end is too late:
 *  by then there is no live voice left to fade OUT, so there is nothing to cross-fade and the next
 *  track starts at full volume against silence. The trigger is `remainingSec <= crossfadeSec`,
 *  which means the source's authored crossfade decides both HOW LONG the blend is and WHEN it
 *  starts — one number, no second knob to keep in step.
 *
 *  Consequently a playlist source must NOT loop: a looping source never runs out, and
 *  `remainingSec()` reports `null` for one precisely so nothing mistakes it for a clip about to
 *  end. `AudioSource.playlist` documents that, and `audioSystem` warns once if the two disagree.
 */

import { parseClipBank } from './clipBank';

export type PlaylistMode = 'off' | 'sequential' | 'shuffle';

export interface PlaylistState {
  /** The refs in the order they will play. For 'sequential' this is the authored bank order. */
  order: string[];
  idx: number;
  /** The ref the last swap asked for, while the engine is still winding up that voice. */
  pending: string;
  /** Whether `order` was built by shuffling — so a wrap reshuffles rather than replaying the
   *  same permutation forever. Stored rather than re-derived so `advance` needs no mode argument. */
  shuffled: boolean;
  /** The bank string `order` was built from. ⚠️ Comparing the bank's LENGTH is not enough, for
   *  two reasons that both end with clips from the wrong bank being played: the editor can swap
   *  one entry for another without changing the count, and koota RECYCLES entity ids, so a new
   *  source can inherit a dead one's state whose bank happened to be the same size. */
  bank: string;
}

/** Fisher-Yates. `avoid` is the clip that just played: a reshuffle that puts it first would play
 *  it twice in a row across the wrap, which is the one repeat a listener actually notices.
 *
 *  ⚠️ `Math.random`, and this file is the ONE entry in the determinism guard's `ALLOW_RANDOM`.
 *  It is cosmetic by construction — a playlist order reaches no game state, no journal event and
 *  no replay. Drawing from the seeded RNG instead would be actively WRONG: it would consume the
 *  same stream gameplay draws from, so which track plays would change which level is generated. */
export function shuffleRefs(refs: readonly string[], avoid?: string): string[] {
  const out = refs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (avoid !== undefined && out.length > 1 && out[0] === avoid) [out[0], out[1]] = [out[1], out[0]];
  return out;
}

/** The bank entry a `shuffleStart` source opens on, or `null` when the bank cannot offer a choice
 *  (fewer than two entries — the same floor `nextClip` uses, since one clip is not a playlist).
 *
 *  Separate from `buildOrder` because it answers a different question at a different time: this one
 *  fires ONCE, when autoplay starts the source, and the walk order is then rotated to whatever it
 *  returned — so the first lap still covers every clip exactly once.
 *
 *  ⚠️ `Math.random` for the reason `shuffleRefs` documents: which track opens reaches no game state,
 *  and drawing from the seeded RNG would consume the stream gameplay draws from, so the bed that
 *  played would change which level is generated. */
export function randomStartClip(clips: unknown): string | null {
  const refs = parseClipBank(clips).map((c) => c.ref);
  if (refs.length < 2) return null;
  return refs[Math.floor(Math.random() * refs.length)] ?? null;
}

/** Build the walk order for a bank, rotated so `current` is at the front.
 *
 *  ROTATED rather than sought-to: both keep a hot reload from restarting the music, but only
 *  rotation makes a full lap cover every clip before any repeat — seeking from a mid-list position
 *  wraps early, so a handful of clips get played twice as often as the rest. */
export function buildOrder(refs: readonly string[], mode: PlaylistMode, current: string): string[] {
  return rotateTo(mode === 'shuffle' ? shuffleRefs(refs) : refs.slice(), current);
}

/** Put `current` at the front, keeping the rest in their existing cycle. Returns `order` unchanged
 *  when `current` is already first or is not in it at all. Shared with the re-derive in `nextClip`
 *  so "rotate to" has ONE definition — the two callers must agree about what a lap is. */
function rotateTo(order: string[], current: string): string[] {
  const at = order.indexOf(current);
  return at > 0 ? order.slice(at).concat(order.slice(0, at)) : order;
}

/**
 * Decide the next clip, or `null` to leave the source alone this frame. Pure apart from the
 * shuffle — `state` is mutated in place, which is what makes it testable without a world.
 *
 * `remaining` is `null` when it is not knowable: a looping source, a stream whose metadata has not
 * arrived, or record mode, which has no audio clock. ⚠️ It must be read as "do not act yet", never
 * as 0 — the latter swaps on the first frame of every clip and so plays none of them.
 *
 * ⚠️ `ended` is the SECOND trigger and it is not optional. `remaining <= crossfadeSec` has to be
 * OBSERVED on a frame, so it is a window that can be missed: at the default `crossfadeSec: 0` the
 * window is the single instant `remaining === 0`, which a 60 Hz tick essentially never samples, and
 * even at 1.5 s anything that stops rAF across a clip boundary — a phone backgrounding the app, a
 * long asset hitch — steps straight over it. Landing past the end used to mean `playing = false`
 * and, with autoplay already spent, silence for the rest of the session with nothing on screen to
 * explain it. So a clip that HAS ended advances unconditionally: no threshold, no latch.
 */
export function nextClip(
  state: PlaylistState, clips: unknown, mode: PlaylistMode, current: string,
  remaining: number | null, crossfadeSec: number, ended = false,
): string | null {
  if (mode === 'off') return null;
  const refs = parseClipBank(clips).map((c) => c.ref);
  if (refs.length < 2) return null;   // one clip (or none) is not a playlist

  const bankKey = String(clips ?? '');
  if (state.bank !== bankKey) {
    state.bank = bankKey;
    state.order = buildOrder(refs, mode, current);
    state.shuffled = mode === 'shuffle';
    state.idx = 0;
    state.pending = '';
  }

  // The clip moved out from under the walk (#1281). `order`/`idx` is a CACHE of where we are, and
  // until now it was re-derived only when the BANK changed — so every other writer of `clip` left
  // it pointing at the old position and the next advance followed the stale order. Two reachable
  // ways in, one divergence: the `audio.setClip` action and any debug bed picker, and
  // `rearmAudioAutoplay`'s re-armed `shuffleStart`, which rolls a fresh opener while this state
  // survives untouched. Symptom either way is the wrong successor — and when the outside write
  // happens to pick the clip the walk was ABOUT to play, the same track twice in a row, the one
  // repeat `shuffleRefs`'s `avoid` exists to prevent.
  //
  // Detected rather than announced: the walk already knows what it believes is playing, so it can
  // notice the disagreement itself. That covers every writer, including ones not written yet — a
  // `rotatePlaylistTo` seam every caller had to remember would be one `a.clip = …` away from
  // reopening this. The existing order is ROTATED, never rebuilt: a reshuffle here would discard
  // the rest of the lap, and a lap is what guarantees every clip plays once before any repeats.
  //
  // ⚠️ A clip that is NOT in the bank leaves the walk alone. A source may author a `clip` outside
  // its own bank (an intro sting, say), and rotating to something the order does not contain would
  // mean re-deriving on every single frame forever.
  //
  // ⚠️ And NOT while a swap is in flight (`pending`), which is the one window where `clip` lagging
  // behind the walk is normal rather than an outside write: we have just asked for the next clip
  // and the caller may not have applied it yet. Re-deriving there rotates back to the clip still
  // playing, clears the latch, and swaps again on the very next frame — the bank-tearing the latch
  // exists to prevent. The latch clears itself on the remainder climbing back, so a write that
  // lands during the window is picked up one frame later instead. (Caught by
  // `does not swap again while the previous swap is still in flight`, which this broke.)
  //
  // ⚠️ The one shape that costs: a clip whose WHOLE duration is under `crossfadeSec` is never above
  // the threshold, so its latch only ever clears on `ended` — a write mid-clip is then adopted at
  // the next clip boundary rather than at once. Nothing authored hits it (a bed is minutes against
  // a 4 s fade, and a sub-fade clip cannot cross-fade in the first place), so it is a stated limit
  // rather than a case to complicate this for.
  // ⚠️ `ended` clears the latch FIRST. The clip is over, so there is nothing in flight left to
  // protect — and leaving it set would suppress the check on the one frame that needs it most: the
  // `rearmAudioAutoplay` path arrives with the handle already ended (`audioDispose()` ends every
  // live handle before `onRealmSurvived` re-arms), so if the app was backgrounded mid-crossfade the
  // stale `pending` would send it straight to `advance` and the old order.
  if (ended) state.pending = '';
  const adopted = !state.pending
    && state.order[state.idx] !== current
    && state.order.includes(current);
  if (adopted) {
    state.order = rotateTo(state.order, current);
    state.idx = 0;
    // ⚠️ The adopted clip has NOT played yet, so it takes the same in-flight latch one of our own
    // swaps would: its voice is still winding up. Without this the very next decision in this same
    // call steps straight past it — `ended` advances, or the threshold fires because the handle
    // still reports the OLD clip's remainder — and the clip somebody just asked for is never heard.
    // That is the whole `shuffleStart` re-arm path: `randomStartClip` rolls an opener, the walk
    // adopts it, and the source would start on its SUCCESSOR instead.
    state.pending = current;
  }

  // The recovery path, before the latch: whatever we were waiting for, the clip is over. Unless we
  // just adopted a clip — then the thing that ended is the clip we were adopted AWAY from, and the
  // new one is owed its turn.
  if (ended) return adopted ? null : advance(state);

  const fade = Math.max(0, crossfadeSec);
  // ⚠️ The in-flight latch clears on the REMAINING TIME climbing back, never on `current` matching
  // what we asked for — the caller writes that field, so it matches on the very next frame while
  // the engine is still winding up the new voice and the handle still reports the OLD clip's
  // remainder, which is below the threshold. Comparing the clip makes the latch a no-op and the
  // playlist tears through the whole bank in a handful of frames.
  if (state.pending) {
    if (remaining === null || remaining > fade) state.pending = '';
    return null;
  }
  if (remaining === null || remaining > fade) return null;
  return advance(state);
}

/** Step to the next clip, reshuffling on wrap. Shared by the cross-fade trigger and the
 *  ended-clip recovery so the two can never disagree about what "next" means. */
function advance(state: PlaylistState): string {
  const justPlayed = state.order[state.idx];
  state.idx += 1;
  if (state.idx >= state.order.length) {
    state.order = state.shuffled ? shuffleRefs(state.order, justPlayed) : state.order;
    state.idx = 0;
  }
  state.pending = state.order[state.idx];
  return state.pending;
}
