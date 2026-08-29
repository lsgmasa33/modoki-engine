/**
 * `AudioSource.playlist` — walking a clip bank instead of playing only `clip`.
 *
 * The bank was always an engine concept and nothing walked it, so a twelve-track bank shipped
 * twelve tracks and played the first. games/court wrote the missing walker; this is that walker
 * moved where it belonged, with the mode authored on the trait.
 *
 * `nextClip` is pure apart from the shuffle, so the threshold logic is tested directly rather than
 * through a world — jsdom has no audio clock, so a world-level test would feed `null` remaining
 * time to everything and pass vacuously.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { nextClip, buildOrder, shuffleRefs, type PlaylistState } from '../../packages/modoki/src/runtime/audio/playlist';
import { stringifyClipBank } from '../../packages/modoki/src/runtime/audio/clipBank';

const REFS = Array.from({ length: 12 }, (_, i) => `guid-${i}`);
const BANK = stringifyClipBank(REFS.map((ref, i) => ({ key: `t${i}`, ref })));
const FADE = 1.5;

let st: PlaylistState;
beforeEach(() => { st = { order: [], idx: 0, pending: '', bank: '', shuffled: false }; });

/** One frame. Returns the clip the walker wants, or null. */
const tick = (current: string, remaining: number | null, mode: 'off' | 'sequential' | 'shuffle' = 'shuffle') =>
  nextClip(st, BANK, mode, current, remaining, FADE);
/** A clip runs down into its cross-fade, then the new one gets going. */
function runOut(current: string): string {
  const next = tick(current, 0.4);
  expect(next).toBeTruthy();
  tick(next!, 999);         // the new voice is up — clears the in-flight latch
  return next!;
}

describe('the swap threshold', () => {
  it('does nothing while the clip has time left', () => {
    for (let i = 0; i < 50; i++) expect(tick(REFS[0], 60)).toBeNull();
  });

  it('fires when the remainder drops to the cross-fade length — not when it ends', () => {
    // The load-bearing one. Waiting for the end leaves no live voice to fade OUT, so there is
    // nothing to cross-fade and the next clip starts at full volume against silence.
    expect(tick(REFS[0], FADE - 0.01)).toBeTruthy();
  });

  it('treats null as "not knowable yet", never as zero', () => {
    // A stream reports null until its metadata loads; a LOOPING source reports it forever; record
    // mode has no audio clock at all. Read as 0 this swaps on the first frame of every clip.
    for (let i = 0; i < 50; i++) expect(tick(REFS[0], null)).toBeNull();
  });

  it('does not swap again while the previous swap is still in flight', () => {
    // Between the write and the engine starting the new voice, the handle still reports the OLD
    // clip's remainder — below the threshold. Without the latch it tears through the whole bank.
    expect(tick(REFS[0], 0.4)).toBeTruthy();
    for (let i = 0; i < 20; i++) expect(tick(REFS[0], 0.4)).toBeNull();
    expect(st.idx).toBe(1);
  });

  it('is inert when the mode is off — the bank stays a lookup table', () => {
    for (let i = 0; i < 20; i++) expect(tick(REFS[0], 0, 'off')).toBeNull();
  });

  it('is inert on a bank of one — that is not a playlist', () => {
    const one = stringifyClipBank([{ key: 'a', ref: REFS[0] }]);
    expect(nextClip(st, one, 'shuffle', REFS[0], 0, FADE)).toBeNull();
  });
});

describe('the rotation', () => {
  it('plays every clip once before repeating any', () => {
    let cur = REFS[0];
    const seen = [cur];
    for (let i = 0; i < 11; i++) { cur = runOut(cur); seen.push(cur); }
    expect(new Set(seen).size).toBe(12);
  });

  it('never plays the same clip twice in a row across the reshuffle', () => {
    // The one repeat a listener notices, and the one a naive reshuffle produces about one wrap in
    // twelve. Several full laps, so a shuffle that only USUALLY avoids it fails.
    let cur = REFS[0];
    for (let i = 0; i < 12 * 6; i++) {
      const next = runOut(cur);
      expect(next, `repeat at step ${i}`).not.toBe(cur);
      cur = next;
    }
  });

  it('sequential keeps the authored order', () => {
    let cur = REFS[0];
    for (let i = 1; i < 12; i++) {
      const next = nextClip(st, BANK, 'sequential', cur, 0.4, FADE)!;
      nextClip(st, BANK, 'sequential', next, 999, FADE);
      expect(next).toBe(REFS[i]);
      cur = next;
    }
  });
});

describe('the order is keyed on the bank CONTENT, not its length', () => {
  // ⚠️ Two ways a length check ships clips from the wrong bank, and both end the same way.
  const OTHER = stringifyClipBank(
    Array.from({ length: 12 }, (_, i) => ({ key: `o${i}`, ref: `other-${i}` })),
  );

  it('rebuilds when a same-SIZE bank replaces the old one', () => {
    // The editor swapping one entry for another without changing the count. With a length check
    // the stale order survives and the playlist plays a clip the scene no longer ships.
    tick(REFS[0], 999);
    expect(st.order).toContain(REFS[0]);
    nextClip(st, OTHER, 'shuffle', 'other-0', 999, FADE);
    expect(st.order.every((r) => r.startsWith('other-'))).toBe(true);
  });

  it('rebuilds for a RECYCLED entity id carrying a dead source\'s state', () => {
    // koota recycles entity ids, so a new music source can inherit a despawned one's walk. Same
    // size, different bank — every ref in the inherited order belongs to the previous scene.
    tick(REFS[0], 999);
    const stale = [...st.order];
    nextClip(st, OTHER, 'sequential', 'other-3', 999, FADE);
    expect(st.order).not.toEqual(stale);
    expect(st.idx).toBe(0);
    expect(st.pending).toBe('');
  });

  it('does NOT rebuild while the bank is unchanged', () => {
    // The control: rebuilding every frame would reshuffle continuously and never advance.
    tick(REFS[0], 999);
    const order = [...st.order];
    for (let i = 0; i < 10; i++) tick(REFS[0], 999);
    expect(st.order).toEqual(order);
  });
});

describe('buildOrder', () => {
  it('ROTATES to the current clip rather than seeking to it', () => {
    // Both keep a hot reload from restarting the music, but only rotation makes a full lap cover
    // every clip before any repeat — seeking from mid-list wraps early, so a handful of clips get
    // played twice as often as the rest.
    const order = buildOrder(REFS, 'sequential', REFS[7]);
    expect(order[0]).toBe(REFS[7]);
    expect(new Set(order).size).toBe(12);
  });

  it('leaves the order alone when the current clip is not in the bank', () => {
    expect(buildOrder(REFS, 'sequential', 'not-in-bank')).toEqual(REFS);
  });
});

describe('shuffleRefs', () => {
  it('is a permutation, never a subset', () => {
    for (let i = 0; i < 50; i++) expect(new Set(shuffleRefs(REFS)).size).toBe(12);
  });

  it('keeps `avoid` off the front', () => {
    for (let i = 0; i < 200; i++) expect(shuffleRefs(REFS, REFS[3])[0]).not.toBe(REFS[3]);
  });
});
