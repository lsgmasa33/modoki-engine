/** The gameplay recorder's JOURNAL TAP (#1488): the journal events a take keeps, drained the same
 *  way on both halves.
 *
 *  The editor recorder drains it while the owner plays, and stores the game's own events in the take
 *  as `expectedEvents`. The replay driver drains it after every step and reports the same events in
 *  `render.json`. The CLI then compares the two (`compareTakeEvents` in `editor/recorder/take.ts`).
 *  That comparison only means something if both halves collect with ONE rule, so the rule lives here
 *  and not in either half.
 *
 *  What the rule is, and why:
 *  - **Keyed on the journal's `cap`, not its tick.** An event emitted BETWEEN frames (a DOM click
 *    handler, a promise continuation) carries the previous frame's tick, so a tick-keyed dedupe drops
 *    it for good. `cap` is process-global and strictly increasing.
 *  - **Drained on every frame, from EVERY world seen, with a cap per world.** The journal belongs to
 *    a world, and every scene load spawns a new one, so reading it once at the end loses everything
 *    from before the last load. And the two worlds overlap at a swap: `SceneManager` emits
 *    `@scene-swapped` into the promoted world FIRST, then awaits the old world's manager disposal,
 *    which emits into the OLD world (a teardown's `@audio stop`) — possibly across several frames.
 *    One cap shared by both worlds dropped whichever side drained second (review of #1488 reproduced
 *    both orders). So each world keeps its own last cap, every world seen this take is drained each
 *    time, and the result is merged back into emission order by `cap`.
 *  - **Engine events filtered to the few worth keeping.** `@spawn`/`@despawn` run to hundreds per
 *    scene load. The game's own events are always kept. */

import type { World } from 'koota';
import { journalEvents } from './journal';

/** Engine journal events a take keeps: the audio, cue and scene events a soundtrack or an edit is
 *  built from. Every event the game emits itself (no `@` prefix) is kept too. */
const KEEP_ENGINE_EVENTS: ReadonlySet<string> = new Set(['@audio', '@cue', '@scene-loaded', '@scene-swapped']);

/** One kept journal event, detached from the world it was emitted in. */
export interface TappedEvent {
  tick: number;
  type: string;
  /** A JSON copy: a payload that is mutated later, or holds an entity, cannot change what was kept. */
  payload: unknown;
}

export class TakeJournalTap {
  /** Every world seen this take → the cap of the last event taken from it. Kept for the tap's
   *  lifetime (one take or one render — a handful of scene loads), because an old world can still
   *  be emitting its teardown frames after the swap. */
  private readonly lastCap = new Map<World, number>();

  /** Mark everything already in `world`'s journal as seen, so the next drain returns only what is
   *  emitted from now on. The editor calls this at the Play press: what the scene emitted while it
   *  was being edited is not part of the take. */
  skipExisting(world: World): void {
    let last = this.lastCap.get(world) ?? -1;
    for (const e of journalEvents(undefined, world)) if (e.cap > last) last = e.cap;
    this.lastCap.set(world, last);
  }

  /** Every kept event emitted since the last drain, in emission order. `world` is the CURRENT world;
   *  every world drained before is read again too. */
  drain(world: World): TappedEvent[] {
    if (!this.lastCap.has(world)) this.lastCap.set(world, -1);
    const taken: { cap: number; e: TappedEvent }[] = [];
    for (const [w, last] of this.lastCap) {
      let max = last;
      for (const e of journalEvents(undefined, w)) {
        if (e.cap <= last) continue;
        if (e.cap > max) max = e.cap;
        if (e.type.startsWith('@') && !KEEP_ENGINE_EVENTS.has(e.type)) continue;
        taken.push({ cap: e.cap, e: { tick: e.tick, type: e.type, payload: JSON.parse(JSON.stringify(e.payload ?? null)) } });
      }
      this.lastCap.set(w, max);
    }
    return taken.sort((a, b) => a.cap - b.cap).map((t) => t.e);
  }
}
