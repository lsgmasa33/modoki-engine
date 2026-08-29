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

/** Build the walk order for a bank, rotated so `current` is at the front.
 *
 *  ROTATED rather than sought-to: both keep a hot reload from restarting the music, but only
 *  rotation makes a full lap cover every clip before any repeat — seeking from a mid-list position
 *  wraps early, so a handful of clips get played twice as often as the rest. */
export function buildOrder(refs: readonly string[], mode: PlaylistMode, current: string): string[] {
  const base = mode === 'shuffle' ? shuffleRefs(refs) : refs.slice();
  const at = base.indexOf(current);
  return at > 0 ? base.slice(at).concat(base.slice(0, at)) : base;
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

  // The recovery path, before the latch: whatever we were waiting for, the clip is over.
  if (ended) { state.pending = ''; return advance(state); }

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
