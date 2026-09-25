/** The journal tap both halves of the recorder drain (#1488) — one rule, so the editor's
 *  `expectedEvents` and the replay's `gameEvents` are comparable at all. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld, type World } from 'koota';
import { TakeJournalTap } from '../../src/runtime/core/takeJournal';
import { emit, setJournalTick } from '../../src/runtime/core/journal';

const worlds: World[] = [];
const world = () => { const w = createWorld(); worlds.push(w); return w; };
afterEach(() => { while (worlds.length) worlds.pop()!.destroy(); });
const types = (list: { type: string }[]) => list.map((e) => e.type);

describe('TakeJournalTap', () => {
  it('keeps an event emitted BETWEEN drains at the same tick — keyed on cap, not tick', () => {
    const w = world();
    const tap = new TakeJournalTap();
    setJournalTick(5, w);
    emit('a', null, w);
    expect(types(tap.drain(w))).toEqual(['a']);
    // A DOM click handler after the frame: same tick as the last drained event.
    emit('b', null, w);
    expect(types(tap.drain(w))).toEqual(['b']);
    expect(tap.drain(w)).toEqual([]);
  });

  it('drains the OLD world once more at a swap, so its last events are not lost with it', () => {
    const w1 = world();
    const w2 = world();
    const tap = new TakeJournalTap();
    tap.drain(w1);
    emit('teardown', null, w1);
    emit('boot', null, w2);
    expect(types(tap.drain(w2))).toEqual(['teardown', 'boot']);
  });

  it('loses neither side of a real swap: the new world\'s @scene-swapped comes BEFORE the old world\'s teardown', () => {
    // SceneManager's order: emit into the promoted world, THEN dispose the old one's managers.
    const w1 = world();
    const w2 = world();
    const tap = new TakeJournalTap();
    tap.drain(w1);
    emit('@scene-swapped', null, w2);
    emit('level.start', null, w2);
    emit('@audio', { stop: true }, w1);
    expect(types(tap.drain(w2))).toEqual(['@scene-swapped', 'level.start', '@audio']);
  });

  it('keeps reading the old world after the swap — its disposal is awaited across frames', () => {
    const w1 = world();
    const w2 = world();
    const tap = new TakeJournalTap();
    tap.drain(w1);
    emit('@scene-swapped', null, w2);
    expect(types(tap.drain(w2))).toEqual(['@scene-swapped']);
    emit('@audio', { stop: true }, w1);
    expect(types(tap.drain(w2))).toEqual(['@audio']);
  });

  it('keeps the game\'s events and the audio/cue/scene engine events, and drops the rest', () => {
    const w = world();
    const tap = new TakeJournalTap();
    for (const t of ['@spawn', '@audio', '@despawn', '@cue', '@scene-loaded', '@scene-swapped', 'court.place']) emit(t, null, w);
    expect(types(tap.drain(w))).toEqual(['@audio', '@cue', '@scene-loaded', '@scene-swapped', 'court.place']);
  });

  it('skipExisting leaves out what the scene emitted before the take began', () => {
    const w = world();
    emit('while-editing', null, w);
    const tap = new TakeJournalTap();
    tap.skipExisting(w);
    emit('played', null, w);
    expect(types(tap.drain(w))).toEqual(['played']);
  });

  it('copies payloads, so a payload mutated later cannot change what was kept', () => {
    const w = world();
    const tap = new TakeJournalTap();
    const payload = { hearts: 3 };
    emit('p', payload, w);
    const [kept] = tap.drain(w);
    payload.hearts = 0;
    expect(kept.payload).toEqual({ hearts: 3 });
  });
});
