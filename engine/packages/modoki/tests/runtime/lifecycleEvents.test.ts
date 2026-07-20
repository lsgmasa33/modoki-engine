/** Percept Phase 4 (J3d) — @spawn/@despawn lifecycle journal events. The load-flood
 *  guard is the load-bearing bit: a registration into a STAGING world (≠ the active
 *  world, as during scene load) must NOT emit, so bulk scene loads don't flood. */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { registerEntity, unregisterEntity, setCurrentWorld } from '../../src/runtime/ecs/world';
import { journalEvents, clearJournal, setJournalEnabled } from '../../src/runtime/systems/journal';

beforeEach(() => { setJournalEnabled(true); });

describe('lifecycle journal — @spawn / @despawn', () => {
  it('emits @spawn (GUID-referenced) for a registration into the ACTIVE world', () => {
    const w = createWorld();
    setCurrentWorld(w);
    clearJournal(w);
    const e = w.spawn(EntityAttributes({ guid: 'spawn-1', name: 'X' }));
    registerEntity(e, w);
    const evs = journalEvents({ type: '@spawn' }, w);
    expect(evs).toHaveLength(1);
    expect(evs[0].payload).toEqual({ entity: 'spawn-1' });
  });

  it('does NOT emit @spawn for a staging (non-active) world — load-flood guard', () => {
    const active = createWorld();
    setCurrentWorld(active);
    const staging = createWorld(); // e.g. SceneManager's nextWorld during load
    clearJournal(staging);
    const e = staging.spawn(EntityAttributes({ guid: 'staged', name: 'Y' }));
    registerEntity(e, staging);
    expect(journalEvents({ type: '@spawn' }, staging)).toHaveLength(0);
  });

  it('emits @despawn on unregister from the active world', () => {
    const w = createWorld();
    setCurrentWorld(w);
    const e = w.spawn(EntityAttributes({ guid: 'gone', name: 'Z' }));
    registerEntity(e, w);
    clearJournal(w);
    unregisterEntity(e, w);
    const evs = journalEvents({ type: '@despawn' }, w);
    expect(evs).toHaveLength(1);
    expect(evs[0].payload).toEqual({ entity: 'gone' });
  });
});
