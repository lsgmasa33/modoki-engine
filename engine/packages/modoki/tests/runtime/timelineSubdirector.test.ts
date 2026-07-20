/** Nested sub-directors (Phase F) — a `subdirector` control clip drives the track target's own
 *  Director SYNCED to the clip: child local time = parentTime − clip.start. The child is SLAVED
 *  (never self-advances); its parent runs its frame, so nested markers / sequence-start-end fire at
 *  the correct GLOBAL ticks and stay deterministic. All headless via the journal. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { timelineSystem } from '../../src/runtime/systems/timelineSystem';
import { setTimeline, clearTimelineCache } from '../../src/runtime/loaders/timelineCache';
import { normalizeTimeline } from '../../src/runtime/timeline/types';

const TIMELINE = { name: 'timeline', fn: timelineSystem, priority: SYSTEM_PRIORITY.ANIMATION - 1 };
const PARENT = 'parent.timeline.json';
const CHILD = 'child.timeline.json';
const DT = 1 / 30;
const NOOP = { childBeat: () => {}, parentBeat: () => {} };

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { tw.dispose(); tw = undefined; } clearTimelineCache(); });

/** Parent (duration 6) with a subdirector control clip at start=2 targeting "Child"; Child (duration
 *  3) with a signal marker "childBeat" at t=1. So the child's marker lands at GLOBAL t = 2 + 1 = 3. */
function authorNested(childDur = 3, clipStart = 2, clipDuration?: number) {
  setTimeline(PARENT, normalizeTimeline({
    id: 'p', name: 'Parent', duration: 6, frameRate: 30,
    tracks: [{ id: 'ctl', name: 'Sub', target: 'Child', type: 'control', clips: [{ start: clipStart, duration: clipDuration, subdirector: true }] }],
  }));
  setTimeline(CHILD, normalizeTimeline({
    id: 'c', name: 'Child', duration: childDur, frameRate: 30,
    tracks: [{ id: 'sig', name: 'Beat', target: '', type: 'signal', markers: [{ t: 1, action: 'childBeat' }] }],
  }));
}

function spawnNested(w: TestWorld) {
  const parent = w.spawn(EntityAttributes({ name: 'Parent', guid: 'parent-guid' }), Director({ timeline: PARENT }));
  const child = w.spawn(EntityAttributes({ name: 'Child', guid: 'child-guid', parentId: parent.id() }), Director({ timeline: CHILD, playing: true }));
  return { parent, child };
}

const phasesOf = (evs: { payload: unknown }[]) => evs.map((e) => (e.payload as { phase: string }).phase);
const bySeq = (w: TestWorld, guid: string) => w.events({ type: '@sequence' }).filter((e) => (e.payload as { director: string }).director === guid);

describe('sub-directors (nested timelines)', () => {
  it('fires the child marker at the parent-synced GLOBAL tick, exactly once', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: NOOP });
    authorNested();
    spawnNested(tw);

    tw.step(200); // past the whole parent (duration 6 → tick 180)
    const beats = tw.events({ type: '@marker' }).filter((e) => (e.payload as { action: string }).action === 'childBeat');
    expect(beats).toHaveLength(1);
    // clip start 2 + child marker 1 = global 3.0 → tick 91 (crossed on the frame reaching t=3).
    expect(beats[0].tick).toBe(91);
    expect((beats[0].payload as { director: string }).director).toBe('child-guid');
  });

  it('slaves the child — it does NOT self-advance on its own clock', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: NOOP });
    authorNested();
    spawnNested(tw);

    tw.step(200);
    const beatTicks = tw.events({ type: '@marker' }).filter((e) => (e.payload as { action: string }).action === 'childBeat').map((e) => e.tick);
    // If the child self-ran, its t=1 marker would fire at global tick ~31 (its own clock from t=0).
    // Slaved, it fires ONLY at the parent-synced tick 91.
    expect(beatTicks).toEqual([91]);
    // The child's sequence-start is the parent entry (tick 61 = t2), never tick 1.
    const starts = bySeq(tw, 'child-guid').filter((e) => (e.payload as { phase: string }).phase === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0].tick).toBe(61);
  });

  it('fires the child sequence-start on clip entry and sequence-end at the child duration', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: NOOP });
    authorNested(); // clip start 2, child duration 3 → child plays [2,5] global
    spawnNested(tw);

    tw.step(200);
    const child = bySeq(tw, 'child-guid');
    expect(phasesOf(child)).toEqual(['start', 'end']);
    expect(child[0].tick).toBe(61);  // enters at global t=2
    expect(child[1].tick).toBe(151); // ends at global t=5 (2 + child duration 3)
    // The parent runs its own full length independently.
    const parent = bySeq(tw, 'parent-guid');
    expect(phasesOf(parent)).toEqual(['start', 'end']);
  });

  it('is deterministic — two identical runs journal identically', () => {
    const run = () => {
      const w = createTestWorld({ dt: DT, systems: [TIMELINE], actions: NOOP });
      authorNested();
      spawnNested(w);
      w.step(200);
      const trace = w.events().filter((e) => e.type === '@marker' || e.type === '@sequence')
        .map((e) => `${e.tick}:${e.type}:${JSON.stringify(e.payload)}`);
      w.dispose(); clearTimelineCache();
      return trace;
    };
    expect(run()).toEqual(run());
  });

  it('does not fire the child before the clip starts or after it ends', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: NOOP });
    authorNested();
    spawnNested(tw);

    tw.step(50); // t ≈ 1.67 — before the clip start (2.0)
    expect(tw.events({ type: '@marker' })).toHaveLength(0);
    expect(bySeq(tw, 'child-guid')).toHaveLength(0);

    tw.step(150); // now past the child end (global 5 → tick 150)
    const before = tw.events({ type: '@marker' }).length + bySeq(tw, 'child-guid').length;
    tw.step(40); // t past 6 — no child re-fire
    const after = tw.events({ type: '@marker' }).length + bySeq(tw, 'child-guid').length;
    expect(after).toBe(before);
  });

  // ── review C2: the child's sequence-END fires EXACTLY once regardless of clip-vs-child length ──

  it('fires the child sequence-END once when the clip is LONGER than the child (review C2)', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: NOOP });
    // clip [0,6) drives a child of duration 3 → child ends at global 3, the clip end is global 6.
    // Old bug: end fired at t=3 (child hit cDur) AND again at t=6 (parent crossed clipEnd).
    setTimeline(PARENT, normalizeTimeline({
      id: 'p', name: 'Parent', duration: 6, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'Sub', target: 'Child', type: 'control', clips: [{ start: 0, duration: 6, subdirector: true }] }],
    }));
    setTimeline(CHILD, normalizeTimeline({
      id: 'c', name: 'Child', duration: 3, frameRate: 30,
      tracks: [{ id: 'sig', name: 'Beat', target: '', type: 'signal', markers: [{ t: 1, action: 'childBeat' }] }],
    }));
    spawnNested(tw);
    tw.step(200);
    expect(phasesOf(bySeq(tw, 'child-guid'))).toEqual(['start', 'end']); // NOT ['start','end','end']
  });

  it('truncates the child when the clip is SHORTER, ending once and dropping beyond-span markers (review C2)', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: NOOP });
    // clip [1,2) drives a child of duration 3 → the child plays local [0,1] only.
    setTimeline(PARENT, normalizeTimeline({
      id: 'p', name: 'Parent', duration: 6, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'Sub', target: 'Child', type: 'control', clips: [{ start: 1, duration: 1, subdirector: true }] }],
    }));
    setTimeline(CHILD, normalizeTimeline({
      id: 'c', name: 'Child', duration: 3, frameRate: 30,
      tracks: [{ id: 'sig', name: 'Beat', target: '', type: 'signal', markers: [{ t: 2, action: 'childBeat' }] }], // local 2 → beyond the 1s span
    }));
    spawnNested(tw);
    tw.step(200);
    expect(phasesOf(bySeq(tw, 'child-guid'))).toEqual(['start', 'end']); // ends once, at the truncated clip end
    const beats = tw.events({ type: '@marker' }).filter((e) => (e.payload as { action: string }).action === 'childBeat');
    expect(beats).toHaveLength(0); // the marker beyond the truncated span never fires
  });

  // ── review C3: a child reached by two subdirector edges in one frame is driven ONCE ──

  it('drives a shared child ONCE per frame when two clips target it — no double sinks (review C3)', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: NOOP });
    setTimeline(PARENT, normalizeTimeline({
      id: 'p', name: 'Parent', duration: 6, frameRate: 30,
      tracks: [
        { id: 'ctlA', name: 'SubA', target: 'Child', type: 'control', clips: [{ start: 0, subdirector: true }] },
        { id: 'ctlB', name: 'SubB', target: 'Child', type: 'control', clips: [{ start: 0, subdirector: true }] },
      ],
    }));
    setTimeline(CHILD, normalizeTimeline({
      id: 'c', name: 'Child', duration: 3, frameRate: 30,
      tracks: [{ id: 'sig', name: 'Beat', target: '', type: 'signal', markers: [{ t: 1, action: 'childBeat' }] }],
    }));
    spawnNested(tw);
    tw.step(200);
    const beats = tw.events({ type: '@marker' }).filter((e) => (e.payload as { action: string }).action === 'childBeat');
    expect(beats).toHaveLength(1); // driven once, not once-per-edge
    expect(phasesOf(bySeq(tw, 'child-guid'))).toEqual(['start', 'end']); // single start/end, not doubled
  });

  // ── review (muted-track consistency): a muted subdirector track frees the child ──

  it('a MUTED subdirector track lets the child run on its OWN clock, not frozen', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: NOOP });
    setTimeline(PARENT, normalizeTimeline({
      id: 'p', name: 'Parent', duration: 6, frameRate: 30,
      tracks: [{ id: 'ctl', name: 'Sub', target: 'Child', type: 'control', muted: true, clips: [{ start: 2, subdirector: true }] }],
    }));
    setTimeline(CHILD, normalizeTimeline({
      id: 'c', name: 'Child', duration: 3, frameRate: 30,
      tracks: [{ id: 'sig', name: 'Beat', target: '', type: 'signal', markers: [{ t: 1, action: 'childBeat' }] }],
    }));
    spawnNested(tw);
    tw.step(200);
    const beats = tw.events({ type: '@marker' }).filter((e) => (e.payload as { action: string }).action === 'childBeat');
    expect(beats).toHaveLength(1);
    // Self-advanced: the child's t=1 marker lands on the child's OWN clock (~tick 31), NOT the parent-
    // synced global tick 91 it would hit if slaved to the clip at start=2.
    expect(beats[0].tick).toBeLessThan(61);
    const starts = bySeq(tw, 'child-guid').filter((e) => (e.payload as { phase: string }).phase === 'start');
    expect(starts[0].tick).toBe(1); // started on its own from t=0
  });

  it('keeps a slaved child FROZEN when its parent is not playing', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: NOOP });
    authorNested(); // non-muted subdirector clip → the child is slaved by the (idle) parent
    const parent = tw.spawn(EntityAttributes({ name: 'Parent', guid: 'parent-guid' }), Director({ timeline: PARENT, playing: false }));
    const child = tw.spawn(EntityAttributes({ name: 'Child', guid: 'child-guid', parentId: parent.id() }), Director({ timeline: CHILD, playing: true }));
    tw.step(200);
    // Parent never advances → never drives the child; slaving still blocks self-advance → frozen.
    expect(tw.events({ type: '@marker' })).toHaveLength(0);
    expect(bySeq(tw, 'child-guid')).toHaveLength(0);
    expect((child.get(Director) as { time: number }).time).toBe(0);
  });

  it('a self-referencing subdirector clip is a guarded no-op (director still plays normally)', () => {
    tw = createTestWorld({ dt: DT, systems: [TIMELINE], actions: NOOP });
    // A director whose control track targets ITSELF ("") — must not recurse infinitely nor slave itself.
    setTimeline(PARENT, normalizeTimeline({
      id: 'p', name: 'Self', duration: 4, frameRate: 30,
      tracks: [
        { id: 'ctl', name: 'Self', target: '', type: 'control', clips: [{ start: 1, subdirector: true }] },
        { id: 'sig', name: 'Beat', target: '', type: 'signal', markers: [{ t: 2, action: 'parentBeat' }] },
      ],
    }));
    tw.spawn(EntityAttributes({ name: 'Self', guid: 'self-guid' }), Director({ timeline: PARENT }));

    expect(() => tw!.step(150)).not.toThrow(); // no infinite recursion
    // The director still played its own timeline (its own marker fired once).
    const beats = tw.events({ type: '@marker' }).filter((e) => (e.payload as { action: string }).action === 'parentBeat');
    expect(beats).toHaveLength(1);
    expect(beats[0].tick).toBe(61); // t=2 → tick 61
  });
});
