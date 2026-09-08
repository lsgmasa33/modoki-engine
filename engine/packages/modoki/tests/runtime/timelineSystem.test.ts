import { describe, it, expect, afterEach, vi } from 'vitest';
// Side-effect only: wires core provider slots (P7 C14) so the real timeline/prefab caches below resolve correctly.
import '../../src/runtime/loaders/registerProviders';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { OnSequence } from '../../src/runtime/traits/OnSequence';
import { timelineSystem } from '../../src/runtime/timeline/timelineSystem';
import { timelineEvents } from '../../src/runtime/timeline/TimelineEvents';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { drainAudioCues } from '../../src/runtime/audio/audioCues';
import { normalizeTimeline, type TimelineDef } from '../../src/runtime/timeline/types';

// timelineSystem is internally sim-gated; run it at its production tier (ANIMATION-1).
const TIMELINE = { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 };
const PATH = 'seq.timeline.json';
// The engine caps per-tick delta at MAX_DELTA = 1/30; stepping AT the cap means the playhead
// advances exactly 1/30 s per tick (dt=0.1 would clamp to 0.033, not 0.1). So elapsed = ticks/30.
const DT = 1 / 30;

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { timelineEvents.__clear(tw.world); tw.dispose(); tw = undefined; } clearTimelineCache(); });

function seed(def: Partial<TimelineDef>): TimelineDef {
  const norm = normalizeTimeline({ id: 'tl', duration: 1, frameRate: 30, ...def });
  setTimeline(PATH, norm);
  return norm;
}

describe('timelineSystem — markers fire once at the crossing tick', () => {
  it('fires a signal marker exactly once, mid-interval', () => {
    const marks: Array<{ t: number }> = [];
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: { 'seq.mark': ({ params }) => marks.push({ t: (params?.t as number) ?? -1 }) } });
    seed({ tracks: [{ id: 's', name: 'Sig', target: '', type: 'signal', markers: [{ t: 0.45, action: 'seq.mark', params: { t: 0.45 } }] }] });
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(32); // 0 → ~1.0 (clamps)

    expect(marks).toHaveLength(1);
    const journalMarks = tw.events({ type: '@marker' });
    expect(journalMarks).toHaveLength(1);
    expect((journalMarks[0].payload as { action: string; t: number }).t).toBe(0.45);
  });

  it('dispatches a signal marker to its OWN track target, not the Director root', () => {
    // Regression test: applyDirectorFrame's 'signal' case used to hardcode
    // `target: p.entity` (the Director), ignoring `track.target` entirely — so a signal
    // track aimed at a descendant (e.g. a UI label to update) silently updated nothing;
    // only a track authored with target:"" (the root itself, as every other test in this
    // file uses) ever happened to be correct.
    let seenTargetId: number | undefined;
    let seenSelfId: number | undefined;
    tw = createTestWorld({
      dt: DT,
      systems: [TIMELINE],
      actions: { 'seq.mark': (ctx) => { seenTargetId = ctx.target?.id(); seenSelfId = (ctx.params?.self as { id(): number } | undefined)?.id(); } },
    });
    seed({ tracks: [{ id: 's', name: 'Sig', target: 'Child', type: 'signal', markers: [{ t: 0.1, action: 'seq.mark' }] }] });
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    const child = tw.spawn(EntityAttributes({ name: 'Child', parentId: root.id() }));

    tw.step(8); // past t=0.1

    expect(seenTargetId).toBe(child.id());
    expect(seenSelfId).toBe(root.id()); // params.self still identifies the Director, unaffected
  });

  it('emits @sequence start once and end once (non-looping)', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    seed({ tracks: [] });
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(35); // run past the 1.0s duration

    const seq = tw.events({ type: '@sequence' });
    expect(seq.map((e) => (e.payload as { phase: string }).phase)).toEqual(['start', 'end']);
  });

  it('fires an audio cue at its tick (queued for the audio system)', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    seed({ tracks: [{ id: 'a', name: 'Audio', target: '', type: 'audio', cues: [{ t: 0.55, clip: 'guid-sfx' }] }] });
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(15);                           // ~0.5: not yet
    expect(drainAudioCues(tw.world)).toHaveLength(0);
    tw.step(5);                            // ~0.67: crosses 0.55
    const cues = drainAudioCues(tw.world);
    expect(cues).toHaveLength(1);
    expect(cues[0].clip).toBe('guid-sfx');
    expect(tw.events({ type: '@cue' })).toHaveLength(1);
  });
});

describe('timelineSystem — declarative OnSequence', () => {
  it('dispatches onStart / onEnd actions', () => {
    const started = vi.fn();
    const ended = vi.fn();
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: { 'demo.start': started, 'demo.end': ended } });
    seed({ tracks: [] });
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }), OnSequence({ onStart: 'demo.start', onEnd: 'demo.end' }));

    tw.step(1);
    expect(started).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
    tw.step(34);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

describe('timelineSystem — loop wrap fires markers without double/skip', () => {
  it('fires a marker once per pass across a loop wrap', () => {
    const marks: number[] = [];
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: { 'm': () => marks.push(1) } });
    seed({ duration: 1, tracks: [{ id: 's', name: 'Sig', target: '', type: 'signal', markers: [{ t: 0.45, action: 'm' }] }] });
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH, loop: true }));

    tw.step(75); // 2.5 durations → passes 0.45 at 0.45, 1.45, 2.45

    expect(marks).toHaveLength(3);
    expect(tw.events({ type: '@sequence' }).map((e) => (e.payload as { phase: string }).phase)).toEqual(['start']); // loop never ends
  });

  it('fires a marker in the freshly-WRAPPED region (post-wrap clause `t>=0 && t<=cur`)', () => {
    // A marker at t=0.02 lands in the small post-wrap slice each lap — the 0.45 marker above only ever
    // hits the mid-lap `(prev,cur]` branch, so this covers the OTHER half of the loop-wrap crossing.
    const marks: number[] = [];
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: { 'm': () => marks.push(1) } });
    seed({ duration: 1, tracks: [{ id: 's', name: 'Sig', target: '', type: 'signal', markers: [{ t: 0.02, action: 'm' }] }] });
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH, loop: true }));

    tw.step(75); // 2.5 laps → fires at 0.02, 1.02, 2.02 (each via a prev>cur wrap after the first)

    expect(marks).toHaveLength(3); // once per lap, no drop across the wrap
  });
});

describe('timelineSystem — t=0 edges', () => {
  it('fires a t=0 marker on the first frame (justStarted left-closed interval)', () => {
    const marks: number[] = [];
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: { 'm0': () => marks.push(0), 'm1': () => marks.push(1) } });
    seed({ tracks: [{ id: 's', name: 'Sig', target: '', type: 'signal', markers: [{ t: 0, action: 'm0' }, { t: 0.5, action: 'm1' }] }] });
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(1);
    expect(marks).toEqual([0]);                          // the t=0 marker fired; the t=0.5 one has not
    expect(tw.events({ type: '@marker' })).toHaveLength(1);
  });

  it('a director frozen at start (timeScale=0) DEFERS its t=0 edges until it advances (review C6)', () => {
    const marks: number[] = [];
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: { 'm0': () => marks.push(0) } });
    seed({ tracks: [{ id: 's', name: 'Sig', target: '', type: 'signal', markers: [{ t: 0, action: 'm0' }] }] });
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.setTimeScale(0);
    tw.step(5); // frozen at the start: nothing consumed
    expect(marks).toHaveLength(0);
    expect(tw.events({ type: '@sequence' })).toHaveLength(0);         // not started while frozen
    expect((root.get(Director) as { started: boolean }).started).toBe(false);

    tw.setTimeScale(1);
    tw.step(1); // first ADVANCING frame → start + the t=0 marker fire together, once
    expect(marks).toEqual([0]);
    expect(tw.events({ type: '@sequence' }).map((e) => (e.payload as { phase: string }).phase)).toEqual(['start']);
  });

  it('a speed=0 director stays frozen and fires nothing (not started)', () => {
    const marks: number[] = [];
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: { 'm0': () => marks.push(0), 'm1': () => marks.push(1) } });
    seed({ tracks: [{ id: 's', name: 'Sig', target: '', type: 'signal', markers: [{ t: 0, action: 'm0' }, { t: 0.5, action: 'm1' }] }] });
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH, speed: 0 }));

    tw.step(60);
    expect(marks).toHaveLength(0);
    expect(tw.events({ type: '@sequence' })).toHaveLength(0);
    expect((root.get(Director) as { time: number; started: boolean }).time).toBe(0);
    expect((root.get(Director) as { started: boolean }).started).toBe(false);
  });
});

describe('timelineSystem — extreme speed + reverse guards', () => {
  it('does not silently drop a marker when a single frame advances a full lap or more', () => {
    const marks: number[] = [];
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: { 'm': () => marks.push(1) } });
    // duration 0.1 with speed 10 → per-frame advance ≈ 0.33 ≥ duration → multiple laps/frame.
    seed({ duration: 0.1, tracks: [{ id: 's', name: 'Sig', target: '', type: 'signal', markers: [{ t: 0.05, action: 'm' }] }] });
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH, loop: true, speed: 10 }));

    tw.step(5);
    // Previously the modulo collapsed the lap and the marker was dropped (0). Now it fires
    // at least once per frame — never silently skipped.
    expect(marks.length).toBeGreaterThanOrEqual(5);
  });

  it('reverse playback (speed<0) does not spuriously re-fire markers every frame', () => {
    const marks: number[] = [];
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: { 'm': () => marks.push(1) } });
    seed({ duration: 1, tracks: [{ id: 's', name: 'Sig', target: '', type: 'signal', markers: [{ t: 0.45, action: 'm' }] }] });
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH, loop: true, speed: -1 }));

    tw.step(20);
    expect(marks).toHaveLength(0); // forward-only in v1 — reverse fires nothing (no refire storm)
  });
});

describe('timelineSystem — determinism', () => {
  it('two runs at identical seed/dt produce identical semantic journals', () => {
    const run = () => {
      const w = createTestWorld({ dt: DT, seed: 7, systems: [TIMELINE], actions: { 'a': () => {}, 'b': () => {} } });
      setTimeline(PATH, normalizeTimeline({ id: 'tl', duration: 1, tracks: [
        { id: 's', name: 'Sig', target: '', type: 'signal', markers: [{ t: 0.25, action: 'a' }, { t: 0.65, action: 'b' }] },
        { id: 'au', name: 'Audio', target: '', type: 'audio', cues: [{ t: 0.35, clip: 'g' }] },
      ] }));
      w.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
      w.step(35);
      const proj = w.events().map((e) => ({ tick: e.tick, type: e.type, p: JSON.stringify(e.payload) }));
      timelineEvents.__clear(w.world);
      w.dispose();
      return proj;
    };
    const a = run();
    const b = run();
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });
});

describe('timelineSystem — a deactivated entity FREEZES its Director', () => {
  /** Measured bug: `EntityAttributes.isActive: false` did nothing to a Director. The playhead
   *  kept advancing (2.7434 → 2.7566 frame to frame) and its signal markers kept firing, so a
   *  demo flipped through its stations while it was supposed to be held still. Every renderer
   *  honours `isActive`; the sequencer did not. */
  it('does not advance the playhead while the entity is inactive', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    seed({ duration: 10, tracks: [] });
    const e = tw.spawn(EntityAttributes({ name: 'root', isActive: false }), Director({ timeline: PATH }));

    tw.step(10);

    expect(e.get(Director)!.time).toBe(0);
    expect(e.get(Director)!.started).toBe(false);
  });

  it('fires no markers while inactive', () => {
    const marks: number[] = [];
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: { 'm': () => marks.push(1) } });
    seed({ duration: 1, tracks: [{ id: 's', name: 'Sig', target: '', type: 'signal', markers: [{ t: 0.2, action: 'm' }] }] });
    tw.spawn(EntityAttributes({ name: 'root', isActive: false }), Director({ timeline: PATH }));

    tw.step(20); // well past t=0.2

    expect(marks).toHaveLength(0);
    expect(tw.events({ type: '@marker' })).toHaveLength(0);
    expect(tw.events({ type: '@sequence' })).toHaveLength(0); // not even the start edge
  });

  it('FREEZES rather than stops — reactivating resumes from where it was', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    seed({ duration: 10, tracks: [] });
    const e = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(6);
    const before = e.get(Director)!.time;
    expect(before).toBeGreaterThan(0);

    e.set(EntityAttributes, { ...e.get(EntityAttributes)!, isActive: false });
    tw.step(30);
    expect(e.get(Director)!.time).toBe(before); // held, not rewound and not advanced

    e.set(EntityAttributes, { ...e.get(EntityAttributes)!, isActive: true });
    tw.step(3);
    expect(e.get(Director)!.time).toBeGreaterThan(before); // picks up where it left off
  });

  it('freezes a Director whose ANCESTOR is inactive (the cascade, not just self)', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    seed({ duration: 10, tracks: [] });
    const parent = tw.spawn(EntityAttributes({ name: 'parent', isActive: false }));
    const child = tw.spawn(EntityAttributes({ name: 'child', parentId: parent.id() }), Director({ timeline: PATH }));

    tw.step(10);

    expect(child.get(Director)!.time).toBe(0);
  });

  it('leaves an ACTIVE sibling Director running (the guard is per-entity)', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    seed({ duration: 10, tracks: [] });
    const off = tw.spawn(EntityAttributes({ name: 'off', isActive: false }), Director({ timeline: PATH }));
    const on = tw.spawn(EntityAttributes({ name: 'on' }), Director({ timeline: PATH }));

    tw.step(8);

    expect(off.get(Director)!.time).toBe(0);
    expect(on.get(Director)!.time).toBeGreaterThan(0);
  });

  it('survives a parentId CYCLE without recursing forever', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    seed({ duration: 10, tracks: [] });
    const a = tw.spawn(EntityAttributes({ name: 'a' }));
    const b = tw.spawn(EntityAttributes({ name: 'b', parentId: a.id() }), Director({ timeline: PATH }));
    a.set(EntityAttributes, { ...a.get(EntityAttributes)!, parentId: b.id() }); // A→B→A

    expect(() => tw!.step(4)).not.toThrow();
    expect(b.get(Director)!.time).toBeGreaterThan(0); // cycle breaks to "active"
  });
});

describe('timelineSystem — self-deactivation is a ONE-WAY DOOR, and says so', () => {
  /** The hazard the freeze guard introduces, pinned deliberately rather than special-cased: an
   *  activation track whose target resolves to its OWN Director root (target "" IS the root)
   *  switches that entity off, and a deactivated entity freezes its Director — so the playhead
   *  stops at that instant and can never reach the span that would switch it back on. Making
   *  activation tracks mean something different when they point at the Director would be worse
   *  than the foot-gun; a SILENT soft-lock would not be. Hence: it happens, and it is reported. */
  const selfDeactTimeline = () => seed({
    duration: 5,
    tracks: [{ id: 'a', name: 'Act', target: '', type: 'activation', spans: [{ start: 0, end: 0.2 }] }],
  });

  it('freezes permanently once the track switches its own root off', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    selfDeactTimeline();
    const e = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(12); // past the 0.2s span end
    expect(e.get(EntityAttributes)!.isActive).toBe(false);
    const frozenAt = e.get(Director)!.time;
    expect(frozenAt).toBeGreaterThan(0.2);

    tw.step(60); // two more seconds of ticking
    expect(e.get(Director)!.time).toBe(frozenAt); // never reaches the next span — one-way door
  });

  it('WARNS once, and journals it, instead of soft-locking silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    selfDeactTimeline();
    tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));

    tw.step(40);

    const msgs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('targets its OWN Director'));
    expect(msgs).toHaveLength(1);                       // once, not every frame
    expect(msgs[0]).toContain('cannot re-activate itself');
    expect(tw.events({ type: '@timeline-selfdeact' })).toHaveLength(1);
    warn.mockRestore();
  });

  it('does NOT warn for an activation track aimed at another entity (the normal case)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    seed({ duration: 5, tracks: [{ id: 'a', name: 'Act', target: 'Prop', type: 'activation', spans: [{ start: 0, end: 0.2 }] }] });
    const root = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    const prop = tw.spawn(EntityAttributes({ name: 'Prop', parentId: root.id() }));

    tw.step(40);

    expect(prop.get(EntityAttributes)!.isActive).toBe(false); // the track still works
    expect(root.get(Director)!.time).toBeGreaterThan(1);      // and the Director keeps running
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('targets its OWN Director'))).toHaveLength(0);
    warn.mockRestore();
  });

  it('re-warns for a NEW Director that inherits a RECYCLED root id (#738)', () => {
    // `_warnedSelfDeact` was keyed by `entity.id()` alone — koota's free list is LIFO, so a
    // despawn+respawn WITHIN one world hands the newcomer the dead Director's id, and an
    // id-only warn-once would silently suppress the newcomer's own genuine self-deactivation
    // warning. Same fix, same idiom as `_warnedSubCycle` below and `_defaultBaseCache` (#336).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    selfDeactTimeline();
    const msgs = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('targets its OWN Director'));

    const a = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    tw.step(40);
    expect(msgs()).toHaveLength(1);

    a.destroy();
    const b = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    // Precondition: the id really was reused, but it's a different packed entity — fail loudly
    // rather than pass vacuously if koota's free list stops being LIFO.
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());
    tw.step(40);
    expect(msgs()).toHaveLength(2); // the newcomer's OWN warning fired — not suppressed
    warn.mockRestore();
  });
});

describe('timelineSystem — sub-director cycle warns once, keyed by (id, generation) (#738)', () => {
  const selfSubdirectorTimeline = () => seed({
    duration: 5,
    tracks: [{ id: 'c', name: 'Control', target: '', type: 'control', clips: [{ start: 0, duration: 1, subdirector: true }] }],
  });

  it('re-warns for a NEW Director that inherits a RECYCLED root id', () => {
    // `_warnedSubCycle` was keyed by `childId` alone (here childId === rootId, the self-reference
    // case) — same recycling hazard as `_warnedSelfDeact` above.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tw = createTestWorld({ dt: DT, systems: [TIMELINE] });
    selfSubdirectorTimeline();
    const msgs = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('cycle/self-reference'));

    const a = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    tw.step(2);
    expect(msgs()).toHaveLength(1);

    a.destroy();
    const b = tw.spawn(EntityAttributes({ name: 'root' }), Director({ timeline: PATH }));
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());
    tw.step(2);
    expect(msgs()).toHaveLength(2);
    warn.mockRestore();
  });
});
