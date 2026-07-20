import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { OnSequence } from '../../src/runtime/traits/OnSequence';
import { timelineSystem } from '../../src/runtime/systems/timelineSystem';
import { timelineEvents } from '../../src/runtime/managers/TimelineEvents';
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
