/** Percept Phase 6 — Watch sampler: change-detection, ring cap, summary stats,
 *  despawn freeze. Drives the sampler synchronously via the test hook (normally the
 *  frameDriver rAF callback runs it). */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { registerTrait, setCurrentWorld, EntityAttributes, Time } from '@modoki/engine/runtime';
import { createWorld, trait } from 'koota';
import { startWatch, readWatch, listWatches, clearWatch, __tickWatchesForTest } from '../../app/debug/watch';

let w: ReturnType<typeof createWorld>;
let timeEnt: ReturnType<ReturnType<typeof createWorld>['spawn']>;

// A dedicated koota trait for the watched entity, with a numeric + a string field.
const WPos = trait({ x: 0, y: 0, label: '' });

beforeAll(() => {
  registerTrait({ name: 'Time', trait: Time, category: 'resource', fields: { frame: { type: 'number' }, elapsed: { type: 'number' }, delta: { type: 'number' } } });
  registerTrait({ name: 'WPos', trait: WPos, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' } } });
});

afterEach(() => clearWatch());

function setup() {
  w = createWorld();
  setCurrentWorld(w);
  timeEnt = w.spawn(Time({ frame: 0 }));
  return w;
}
function tick(nextFrame: number, mutate?: () => void) {
  timeEnt.set(Time, { ...timeEnt.get(Time)!, frame: nextFrame });
  mutate?.();
  __tickWatchesForTest();
}

describe('Watch — change-detection + stats', () => {
  it('records only when a field moves beyond epsilon; computes stats', () => {
    setup();
    const e = w.spawn(EntityAttributes({ guid: 'ball', name: 'Ball' }), WPos({ x: 0 }));
    const started = startWatch({ component: 'WPos', guids: ['ball'], fields: ['x'], epsilon: 0.5 });
    expect(started.ok).toBe(true);

    tick(1);                                   // first sample: x=0 recorded
    tick(2, () => e.set(WPos, { ...e.get(WPos)!, x: 0.1 })); // +0.1 < eps → NOT recorded
    tick(3, () => e.set(WPos, { ...e.get(WPos)!, x: 5 }));   // +4.9 > eps → recorded
    tick(4, () => e.set(WPos, { ...e.get(WPos)!, x: 2 }));   // moved → recorded

    const r = readWatch(started.id!) as { series: { guid: string; field: string; count: number; samples: { value: number }[]; stats: { first: number; last: number; min: number; max: number; delta: number } }[] };
    const s = r.series.find((x) => x.field === 'x')!;
    expect(s.samples.map((p) => p.value)).toEqual([0, 5, 2]); // 0.1 dropped by change-detection
    expect(s.stats).toMatchObject({ first: 0, last: 2, min: 0, max: 5, delta: 2 });
  });

  it('ring-caps the series at maxSamples', () => {
    setup();
    const e = w.spawn(EntityAttributes({ guid: 'r', name: 'R' }), WPos({ x: 0 }));
    const started = startWatch({ component: 'WPos', guids: ['r'], fields: ['x'], epsilon: 0.001, maxSamples: 3 });
    for (let i = 1; i <= 6; i++) tick(i, () => e.set(WPos, { ...e.get(WPos)!, x: i * 10 }));
    const r = readWatch(started.id!) as { series: { field: string; samples: { value: number }[] }[] };
    const s = r.series.find((x) => x.field === 'x')!;
    expect(s.samples.length).toBe(3);
    expect(s.samples.map((p) => p.value)).toEqual([40, 50, 60]); // oldest dropped
  });

  it('freezes a despawned entity series with a despawnedAt marker', () => {
    setup();
    const e = w.spawn(EntityAttributes({ guid: 'gone', name: 'G' }), WPos({ x: 0 }));
    const started = startWatch({ component: 'WPos', guids: ['gone'], fields: ['x'], epsilon: 0.001 });
    tick(1);
    tick(2, () => e.set(WPos, { ...e.get(WPos)!, x: 9 }));
    tick(3, () => (e as unknown as { destroy(): void }).destroy()); // entity gone
    const r = readWatch(started.id!) as { series: { field: string; despawnedAt?: number }[] };
    const s = r.series.find((x) => x.field === 'x')!;
    expect(s.despawnedAt).toBe(3);
  });

  // REGRESSION (Phase 6 review) — a guid that disappears then rejoins (e.g. across a
  // play-reload world swap) must UN-FREEZE, not stay stamped despawned forever.
  it('un-freezes despawnedAt when a guid rejoins after absence', () => {
    setup();
    const e = w.spawn(EntityAttributes({ guid: 'rj', name: 'RJ' }), WPos({ x: 0 }));
    const started = startWatch({ component: 'WPos', guids: ['rj'], fields: ['x'], epsilon: 0.001 });
    tick(1);
    tick(2, () => (e as unknown as { destroy(): void }).destroy()); // gone → despawnedAt=2
    let r = readWatch(started.id!) as { series: { despawnedAt?: number }[] };
    expect(r.series[0].despawnedAt).toBe(2);
    w.spawn(EntityAttributes({ guid: 'rj', name: 'RJ' }), WPos({ x: 9 })); // respawn, same guid
    tick(3);
    r = readWatch(started.id!) as { series: { despawnedAt?: number; samples: { value: number }[] }[] };
    expect(r.series[0].despawnedAt).toBeUndefined();        // un-frozen
    expect(r.series[0].samples.map((p) => p.value)).toEqual([0, 9]); // series continued
  });

  // C7 re-audit: a bogus/stale guid used to start ok:true then record nothing forever, which
  // reads back identically to "settled, didn't move" — a silent false-negative. Now start fails.
  it('fails to start when NO guid resolves to a live entity carrying the component', () => {
    setup();
    w.spawn(EntityAttributes({ guid: 'real', name: 'R' }), WPos({ x: 0 }));
    const started = startWatch({ component: 'WPos', guids: ['ghost', 'stale'], fields: ['x'] }) as { ok: boolean; error?: string; unmatchedGuids?: string[] };
    expect(started.ok).toBe(false);
    expect(started.error).toMatch(/stale|resolved|no live entity/i);
    expect(started.unmatchedGuids).toEqual(['ghost', 'stale']);
  });

  it('starts but reports the partial miss when SOME guids resolve', () => {
    setup();
    w.spawn(EntityAttributes({ guid: 'real', name: 'R' }), WPos({ x: 0 }));
    const started = startWatch({ component: 'WPos', guids: ['real', 'ghost'], fields: ['x'] }) as { ok: boolean; matched?: string[]; unmatchedGuids?: string[] };
    expect(started.ok).toBe(true);
    expect(started.matched).toEqual(['real']);
    expect(started.unmatchedGuids).toEqual(['ghost']);
  });

  it('fails when a guid resolves to an entity that LACKS the watched component', () => {
    setup();
    w.spawn(EntityAttributes({ guid: 'bare', name: 'B' })); // exists, but no WPos
    expect((startWatch({ component: 'WPos', guids: ['bare'], fields: ['x'] }) as { ok: boolean }).ok).toBe(false);
  });

  // Batch 3 A — NAME scoping: the handle for a runtime-spawned, fresh-guid, short-lived entity.
  it('name-scopes a watch and AUTO-JOINS a later spawn matching the name', () => {
    setup();
    const started = startWatch({ component: 'WPos', names: ['puck'], fields: ['x'] }) as { ok: boolean; matchedNow?: number; id?: string };
    expect(started.ok).toBe(true);
    expect(started.matchedNow).toBe(0); // nothing named "puck" yet — legit, it spawns later
    tick(1);
    const puck = w.spawn(EntityAttributes({ guid: 'puck-fresh-guid', name: 'Puck' }), WPos({ x: 0 }));
    tick(2);
    tick(3, () => puck.set(WPos, { ...puck.get(WPos)!, x: 5 }));
    const r = readWatch(started.id!) as { series: { name?: string; field: string; samples: { value: number }[] }[] };
    const s = r.series.find((x) => x.field === 'x');
    expect(s?.name).toBe('Puck');                       // D: series identity carries the name
    expect(s?.samples.map((p) => p.value)).toEqual([0, 5]);
  });

  // Batch 3 B — a screen of static entities does NOT consume the mover budget.
  it('static entities do not consume the mover cap, so a late mover still records', () => {
    setup();
    w.spawn(EntityAttributes({ guid: 's1', name: 'S1' }), WPos({ x: 0 }));
    w.spawn(EntityAttributes({ guid: 's2', name: 'S2' }), WPos({ x: 0 }));
    const started = startWatch({ component: 'WPos', fields: ['x'], maxSeries: 1, epsilon: 0.001 }) as { ok: boolean; id?: string };
    tick(1); // s1,s2 baselines — neither counts toward maxSeries (never moved)
    const mover = w.spawn(EntityAttributes({ guid: 'm', name: 'Mover' }), WPos({ x: 0 }));
    tick(2);
    tick(3, () => mover.set(WPos, { ...mover.get(WPos)!, x: 9 }));
    const r = readWatch(started.id!) as { series: { guid: string; samples: { value: number }[] }[] };
    const m = r.series.find((x) => x.guid === 'm');
    expect(m?.samples.map((p) => p.value)).toEqual([0, 9]); // recorded despite maxSeries:1 + 2 statics
  });

  it('caps the number of MOVING series at maxSeries and flags truncated', () => {
    setup();
    const a = w.spawn(EntityAttributes({ guid: 'a', name: 'A' }), WPos({ x: 0 }));
    const b = w.spawn(EntityAttributes({ guid: 'b', name: 'B' }), WPos({ x: 0 }));
    const started = startWatch({ component: 'WPos', fields: ['x'], maxSeries: 1, epsilon: 0.001 }) as { ok: boolean; id?: string };
    tick(1);
    tick(2, () => { a.set(WPos, { ...a.get(WPos)!, x: 5 }); b.set(WPos, { ...b.get(WPos)!, x: 7 }); });
    const r = readWatch(started.id!) as { truncated?: boolean; series: { samples: { value: number }[] }[] };
    expect(r.series.filter((s) => s.samples.length >= 2)).toHaveLength(1); // only one became a mover
    expect(r.truncated).toBe(true);
  });

  // Batch 3 D — read-side filters + identity.
  it('read filters by name / guids / limit and reports the full match count', () => {
    setup();
    w.spawn(EntityAttributes({ guid: 'p1', name: 'Puck' }), WPos({ x: 0 }));
    w.spawn(EntityAttributes({ guid: 'f1', name: 'Fish' }), WPos({ x: 0 }));
    w.spawn(EntityAttributes({ guid: 'f2', name: 'Fish' }), WPos({ x: 0 }));
    const started = startWatch({ component: 'WPos', fields: ['x'], epsilon: 0.001 }) as { ok: boolean; id?: string };
    tick(1);
    const byName = readWatch(started.id!, { name: 'puck' }) as { series: { guid: string; name?: string }[] };
    expect(byName.series.map((s) => s.guid)).toEqual(['p1']);
    expect(byName.series[0].name).toBe('Puck');
    const byGuid = readWatch(started.id!, { guids: ['f1'] }) as { series: { guid: string }[] };
    expect(byGuid.series.map((s) => s.guid)).toEqual(['f1']);
    const limited = readWatch(started.id!, { limit: 1 }) as { series: unknown[]; seriesTotal: number; seriesTruncated?: boolean };
    expect(limited.series).toHaveLength(1);
    expect(limited.seriesTotal).toBe(3);
    expect(limited.seriesTruncated).toBe(true);
  });

  it('lists and clears watches', () => {
    setup();
    const a = startWatch({ component: 'WPos', fields: ['x'] });
    expect((listWatches() as { watches: unknown[] }).watches.length).toBe(1);
    clearWatch(a.id);
    expect((listWatches() as { watches: unknown[] }).watches.length).toBe(0);
  });

  it('rejects an unknown component / no numeric fields', () => {
    setup();
    expect((startWatch({ component: 'Nope' }) as { ok: boolean; error?: string }).ok).toBe(false);
  });
});
